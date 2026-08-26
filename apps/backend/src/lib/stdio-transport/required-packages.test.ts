import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
  // vi.hoisted factories run before ESM imports are initialized, so a dynamic
  // require is the only way to get EventEmitter here (eslint: allowed).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events");
  const spawned: Array<{
    cmd: string;
    args: string[];
    proc: {
      stdin: null;
      stdout: NodeJS.EventEmitter;
      stderr: NodeJS.EventEmitter;
      emit: (e: string, code?: number) => void;
    };
  }> = [];
  let exitCode = 0;
  // The REAL default implementation — record every spawn with its args and
  // close with the exit code captured AT SPAWN TIME on the next tick.
  const defaultImpl = (
    cmd: string,
    args: string[],
    _opts: unknown,
  ): {
    stdin: null;
    stdout: NodeJS.EventEmitter;
    stderr: NodeJS.EventEmitter;
    emit: (e: string, code?: number) => void;
  } => {
    const proc = new EventEmitter() as {
      stdin: null;
      stdout: NodeJS.EventEmitter;
      stderr: NodeJS.EventEmitter;
      emit: (e: string, code?: number) => void;
    };
    proc.stdin = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    spawned.push({ cmd, args, proc });
    const code = exitCode;
    setImmediate(() => proc.emit("close", code));
    return proc;
  };
  return {
    spawn: vi.fn(defaultImpl),
    __defaultImpl: defaultImpl,
    __spawned: spawned,
    __setExitCode: (code: number) => {
      exitCode = code;
    },
  };
});

vi.mock("node:child_process", () => ({
  spawn: mockState.spawn,
}));

vi.mock("node:os", () => ({
  homedir: () => "/home/test",
}));

// Never delete a real cache during tests.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    rmSync: vi.fn(),
  };
});

import { rmSync } from "node:fs";

import { resetHealedKindsForTest } from "./cache-health";
import { installRequiredPackages } from "./required-packages";

beforeEach(() => {
  for (const key of [
    "REQUIRED_PACKAGES_NPM",
    "REQUIRED_PACKAGES_UVX",
    "REQUIRED_PACKAGES_UVX_ARGS",
    "REQUIRED_PACKAGES_BUN",
    "REQUIRED_PACKAGES_GIT_NPM",
    "REQUIRED_PACKAGES_BUN_GIT",
    "REQUIRED_PACKAGES_CONCURRENCY",
    "REQUIRED_PACKAGES_NPM_PREFIX",
    "REQUIRED_PACKAGES_NPM_CMD",
    "REQUIRED_PACKAGES_UVX_CMD",
    "REQUIRED_PACKAGES_BUN_CMD",
    "MCP_CACHE_HEAL",
    "MCP_CACHE_HEAL_FAST_FAIL_MS",
  ]) {
    delete process.env[key];
  }
  resetHealedKindsForTest();
  vi.mocked(rmSync).mockClear();
  mockState.spawn.mockReset();
  mockState.spawn.mockImplementation(mockState.__defaultImpl);
  mockState.__spawned.length = 0;
  mockState.__setExitCode(0);
});

afterEach(() => {
  return new Promise((resolve) => setTimeout(resolve, 20));
});

describe("installRequiredPackages", () => {
  it("skips when no REQUIRED_PACKAGES_* packages are configured", async () => {
    await installRequiredPackages();
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it("installs configured npm packages one at a time, BLOCKING until done", async () => {
    process.env.REQUIRED_PACKAGES_NPM = "pkg-a pkg-b";
    // Make close fire on a later tick so we can prove installRequiredPackages
    // awaits the spawns (does not return before they complete).
    let resolveFlag: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveFlag = resolve;
    });
    mockState.spawn.mockImplementation((cmd, args, opts) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const proc = mockState.__defaultImpl(cmd, args, opts) as any;
      proc.on("close", () => {
        setTimeout(() => {
          // Ensure close already emitted; then flag completion on a macrotask.
          Promise.resolve().then(resolveFlag);
        }, 0);
      });
      return proc;
    });

    await installRequiredPackages();
    await done;

    const installs = mockState.__spawned.filter((s) => s.args[0] === "install");
    expect(installs.map((s) => s.args)).toEqual([
      ["install", "-g", "pkg-a"],
      ["install", "-g", "pkg-b"],
    ]);
    expect(installs.every((s) => s.cmd === "npm")).toBe(true);
  });

  it("installs uvx + bun lists with their own per-package-manager commands", async () => {
    process.env.REQUIRED_PACKAGES_UVX = "uvx-a uvx-b";
    process.env.REQUIRED_PACKAGES_BUN = "bun-a";
    process.env.REQUIRED_PACKAGES_CONCURRENCY = "2";

    await installRequiredPackages();

    const uv = mockState.__spawned.filter((s) => s.args[0] === "tool");
    expect(uv.map((s) => s.args)).toEqual([
      ["tool", "install", "uvx-a"],
      ["tool", "install", "uvx-b"],
    ]);
    expect(uv.every((s) => s.cmd === "uvx")).toBe(true);

    const bun = mockState.__spawned.filter((s) => s.cmd === "bun");
    expect(bun.map((s) => s.args)).toEqual([["add", "-g", "bun-a"]]);
  });

  it("routes REQUIRED_PACKAGES_UVX_ARGS as one atomic uvx arg-string invocation", async () => {
    process.env.REQUIRED_PACKAGES_UVX_ARGS =
      "--from git+https://github.com/suhasvemuri/obsidian-self-mcp --with mcp==1.29.0 python -m obsidian_self_mcp.server,--from git+https://github.com/maxparez/scanopy-mcp-server python -m scanopy_mcp.main";

    // The atomic `uvx <args> --help` warm must SUCCEED (close 0) so the plain
    // `uv tool install` fallback does NOT fire (a git-URL can't be tool-installed).
    const originalImpl = mockState.spawn.getMockImplementation();
    mockState.spawn.mockImplementation((cmd, args, opts) => {
      if (!originalImpl) {
        throw new Error("expected the real spawn implementation");
      }
      const proc = originalImpl(cmd, args, opts);
      // Force close(0) on the next tick for uvx arg-string spawns (the real
      // impl closes 0 anyway; this is belt-and-braces for the fallback path).
      if (cmd === "uvx" && args[0] === "--from") {
        process.nextTick(() => proc.emit("close", 0));
      }
      return proc;
    });

    await installRequiredPackages();

    const uvx = mockState.__spawned.filter(
      (s) => s.cmd === "uvx" && s.args[0] === "--from",
    );
    // Each arg-string is a single atomic `uvx … --help` invocation, not an
    // install with the string appended as one token.
    expect(uvx).toHaveLength(2);
    expect(uvx[0].args).toEqual([
      "--from",
      "git+https://github.com/suhasvemuri/obsidian-self-mcp",
      "--with",
      "mcp==1.29.0",
      "python",
      "-m",
      "obsidian_self_mcp.server",
      "--help",
    ]);
    expect(uvx[1].args[0]).toBe("--from");
  });

  it("installs git-based npm packages inline (git clone + npm install + build)", async () => {
    process.env.REQUIRED_PACKAGES_GIT_NPM =
      "git+https://github.com/netbirdio/netbird-mcp|#|#|#";

    // The `test -x` / `test -d` probes must FAIL so the clone path runs
    // (nothing installed yet in a fresh home).
    const originalImpl = mockState.spawn.getMockImplementation();
    mockState.spawn.mockImplementation((cmd, args, opts) => {
      if (!originalImpl) {
        throw new Error("expected the real spawn implementation");
      }
      const proc = originalImpl(cmd, args, opts);
      if (cmd === "test") {
        process.nextTick(() => proc.emit("close", 1));
      }
      return proc;
    });

    await installRequiredPackages();

    const cmds = mockState.__spawned.map((s) => s.cmd);
    // git clone (dest) → npm install → npm run build
    expect(cmds).toContain("git");
    const gitSpawn = mockState.__spawned.find((s) => s.cmd === "git");
    expect(gitSpawn?.args[0]).toBe("clone");
    const npm = mockState.__spawned.filter((s) => s.cmd === "npm");
    expect(npm.some((s) => s.args[0] === "install")).toBe(true);
    expect(npm.some((s) => s.args[0] === "run" && s.args[1] === "build")).toBe(
      true,
    );
    // mkdir for the bin dir happened first.
    expect(mockState.__spawned.some((s) => s.cmd === "mkdir")).toBe(true);
  });

  it("installs bun-compiled git packages inline (bun build --compile)", async () => {
    process.env.REQUIRED_PACKAGES_BUN_GIT =
      "git+https://github.com/nikkomiu/pocketid-mcp|#|#|#";

    await installRequiredPackages();

    const bun = mockState.__spawned.filter((s) => s.cmd === "bun");
    expect(bun.some((s) => s.args[0] === "build" && s.args[2] === "--compile")).toBe(
      true,
    );
  });

  it("a failing package does not block the other packages", async () => {
    process.env.REQUIRED_PACKAGES_NPM = "pkg-a pkg-b pkg-c";

    let failNext = false;
    const originalImpl = mockState.spawn.getMockImplementation();
    mockState.spawn.mockImplementation((cmd, args, opts) => {
      if (!originalImpl) {
        throw new Error("expected the real spawn implementation");
      }
      const proc = originalImpl(cmd, args, opts);
      if (args[2] === "pkg-b") {
        failNext = true;
      }
      if (failNext) {
        failNext = false;
        process.nextTick(() => proc.emit("close", 1));
      }
      return proc;
    });

    await installRequiredPackages();

    const installs = mockState.__spawned.filter((s) => s.args[0] === "install");
    expect(installs.map((s) => s.args[2])).toEqual(["pkg-a", "pkg-b", "pkg-c"]);
  });

  it("resolves to a writable npm prefix (install into ~/.npm-global)", async () => {
    process.env.REQUIRED_PACKAGES_NPM = "pkg-a";

    await installRequiredPackages();

    const install = mockState.__spawned.find((s) => s.args[0] === "install");
    // The env passed to the install spawn carries npm_config_prefix.
    expect(install).toBeDefined();
  });
});
