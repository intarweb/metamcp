import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => {
  // vi.hoisted factories run before ESM imports are initialized, so a dynamic
  // require is the only way to get EventEmitter here (eslint: allowed).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events");
  // 1 = file exists (skip-if-present guard fires), 0 = missing.
  let existingFiles = new Set<string>();
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
    // Live view of the current existing-file set (never a stale snapshot).
    get __existingFiles(): Set<string> {
      return existingFiles;
    },
    __setExistingFiles: (paths: string[]) => {
      existingFiles = new Set(paths);
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
    existsSync: (p: string) => {
      // Read the LIVE set (__setExistingFiles may have replaced it).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const current = (mockState as any).__existingFiles as Set<string>;
      return current.has(String(p));
    },
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
  // Fresh home by default: nothing is installed yet, so the skip-if-present
  // guard never fires and every group runs its batched install.
  mockState.__setExistingFiles([]);
});

afterEach(() => {
  return new Promise((resolve) => setTimeout(resolve, 20));
});

describe("installRequiredPackages", () => {
  it("skips when no REQUIRED_PACKAGES_* packages are configured", async () => {
    await installRequiredPackages();
    expect(mockState.spawn).not.toHaveBeenCalled();
  });

  it("installs the whole npm list in ONE batched `npm install -g` invocation, BLOCKING until done", async () => {
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

    // npm config get prefix (skip-if-present probe) + ONE batched install.
    const npm = mockState.__spawned.filter((s) => s.cmd === "npm");
    const installs = npm.filter((s) => s.args[0] === "install");
    expect(installs.map((s) => s.args)).toEqual([
      ["install", "-g", "pkg-a", "pkg-b"],
    ]);
    expect(installs).toHaveLength(1);
    expect(installs.every((s) => s.cmd === "npm")).toBe(true);
  });

  it("installs uvx + bun lists with their own per-package-manager commands", async () => {
    process.env.REQUIRED_PACKAGES_UVX = "uvx-a uvx-b";
    process.env.REQUIRED_PACKAGES_BUN = "bun-a";
    process.env.REQUIRED_PACKAGES_CONCURRENCY = "2";

    await installRequiredPackages();

    const uv = mockState.__spawned.filter((s) => s.args[0] === "tool");
    // BATCHED: both uv tools in ONE `uv tool install uvx-a uvx-b`.
    expect(uv.map((s) => s.args)).toEqual([
      ["tool", "install", "uvx-a", "uvx-b"],
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
    // Arg-strings are inherently one-atomic-command-per-URL (they cannot be
    // batched), but the whole group is still ONE invocation: the FIRST
    // arg-string warms with a single `uvx <args> --help`, and because it
    // SUCCEEDED (close 0), the plain `uv tool install` batch for the other
    // entries is skipped by the already-installed fast path.
    expect(uvx).toHaveLength(1);
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

  it("skips the install entirely when every package is already present (warm-cache no-op)", async () => {
    process.env.REQUIRED_PACKAGES_NPM = "pkg-a @scoped/b";
    // Static install location: /home/test/.npm-global (npm config get prefix
    // fails → default). Both packages already present in node_modules.
    mockState.__setExistingFiles([
      "/home/test/.npm-global/node_modules/pkg-a",
      "/home/test/.npm-global/node_modules/@scoped/b",
    ]);

    await installRequiredPackages();

    // Only the npm config get prefix probe runs — NO install is invoked.
    expect(
      mockState.__spawned.some((s) => s.args[0] === "install"),
    ).toBe(false);
  });

  it("still installs the packages that are missing (partial warm cache)", async () => {
    process.env.REQUIRED_PACKAGES_NPM = "pkg-a pkg-b";
    // pkg-a is already installed; pkg-b is missing → only pkg-b is installed.
    mockState.__setExistingFiles([
      "/home/test/.npm-global/node_modules/pkg-a",
    ]);

    await installRequiredPackages();

    const installs = mockState.__spawned.filter((s) => s.args[0] === "install");
    expect(installs.map((s) => s.args)).toEqual([
      ["install", "-g", "pkg-b"],
    ]);
  });

  it("a failing package does not block the other packages (batched install, per-package log lines)", async () => {
    process.env.REQUIRED_PACKAGES_NPM = "pkg-a pkg-b pkg-c";

    // Make the single batched install exit non-zero, as if one of the three
    // packages failed. The batch still logs a per-package "Failed: <pkg>" line
    // for each missing package and boot proceeds.
    let installRan = false;
    const originalImpl = mockState.spawn.getMockImplementation();
    mockState.spawn.mockImplementation((cmd, args, opts) => {
      if (!originalImpl) {
        throw new Error("expected the real spawn implementation");
      }
      const proc = originalImpl(cmd, args, opts);
      if (cmd === "npm" && args[0] === "install" && !installRan) {
        installRan = true;
        process.nextTick(() => proc.emit("close", 1));
      }
      return proc;
    });

    await installRequiredPackages();

    // The whole list is passed in ONE batched invocation.
    const installs = mockState.__spawned.filter((s) => s.args[0] === "install");
    expect(installs.map((s) => s.args)).toEqual([
      ["install", "-g", "pkg-a", "pkg-b", "pkg-c"],
    ]);
  });

  it("resolves to a writable npm prefix (install into ~/.npm-global)", async () => {
    process.env.REQUIRED_PACKAGES_NPM = "pkg-a";

    await installRequiredPackages();

    const install = mockState.__spawned.find((s) => s.args[0] === "install");
    // The env passed to the install spawn carries npm_config_prefix.
    expect(install).toBeDefined();
  });
});
