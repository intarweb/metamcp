# SPEC: Make MetaMCP solid — all fixes for production

**Status:** ready for implementation
**For:** Sindri / perf team
**Depends on:** serve-from-DB (Layer 0) — this is the foundation; the rest harden it.

## The core problem

Bifrost polls MetaMCP's `tools/list` for 4 endpoints on a ~40s cadence with 5 retries. Because
MetaMCP's `tools/list` is slow and flaky (backend fan-out, cold-start, session churn), Bifrost
enters a self-defeating reconnect loop: ~1,400 failed fetches, an hour with zero tools, random
tool counts. **This is all MetaMCP's fault — Bifrost is polling faithfully.**

The single fix that breaks the whole loop: **make `tools/list` return fast, complete, and
stable** — then Bifrost's retries never trigger.

---

## Fix 1 — Serve `tools/list` from the DB (Layer 0) — THE foundation

**Status: built (my PR #1), on `deploy/layer0-all`.** Make the hot path a fast DB read.

- `readToolsForNamespace()` — one indexed query joining `tools` × `namespace_tool_mappings`,
  scoped to ACTIVE servers.
- Background sync loop keeps the `tools` table fresh (see Fix 4).
- `tools/list` returns from DB in **ms**; stale/absent servers flagged `_meta.pending` +
  background refresh; falls back to bounded fan-out only when nothing cached.

**Why:** kills H1 (Bifrost storm) + H2 (random counts) — never returns 0 for a warm namespace.

---

## Fix 2 — Never return 0 tools for a warm namespace

Even without serve-from-DB, `tools/list` must never return 0 when the namespace has tools.
- If DB has cached tools → serve them (Layer 0).
- If DB empty but backends exist → return `_meta.pending` with the *last-known* tools, not 0.
- A 0-tool response should be impossible for a namespace with ACTIVE servers + tools in DB.

---

## Fix 3 — Session reuse (kill the spawn churn, M1)

The fan-out creates a session per request and the deadline races the spawn, orphaning children
(`memory-justin` spawned 5×, `bambu` 4× in 9 min).

- Reuse pooled connections (the pool already holds idle sessions — don't spawn per request).
- On the 10s `getSession` deadline, DON'T abandon the in-flight spawn — let it complete and
  recycle to the pool instead of leaving an orphan.
- Bound total spawns (respect `MCP_SPAWN_CONCURRENCY`); a session is never orphaned.

**Why:** kills M1 — no more process explosion / pool thrashing (`10 idle → 12 → 19 idle/31 active`).

---

## Fix 4 — Background sync + reap (make the list converge automatically)

**Status: spec'd separately (`SPEC-background-tools-sync.md`).** Keep the DB correct over time.

- Background loop (60s) syncs every namespace/server on a timer.
- **Fix the reap guard**: `toolsSyncCache.hasChanged()` currently short-circuits `sync()` before
  `deleteObsoleteTools`, so removals don't converge. Always run `syncTools` (reap) on the loop;
  use the hash only to skip the *upsert*.
- Additions + removals both converge within one interval, with no `tools/list` traffic.

**Why:** makes the DB the authoritative store, so serve-from-DB always serves correct tools.

---

## Fix 5 — Session cleanup on invalidation (kill the roon orphan, M2)

When a session is invalidated/recreated, the OLD child process must be terminated. The roon
spawn found pid 1544 *still holding the Core pairing lock* — a zombie that can never pair.

- On `invalidateIdleSession` / session recreation, SIGTERM the previous child before spawning.
- Track the child PID per session; kill on cleanup/eviction.

**Why:** kills M2 — no orphaned processes holding locks, roon actually pairs.

---

## Fix 6 — Health-check must match real liveness (kill the apprise loop, M3)

The idle health-check failed every 60s on a server (apprise) that successfully answered
`tools/list` in 6ms in between — a false-negative recreate loop on a working server.

- Health-check should use the same transport/liveness as real requests, not a ping that
  doesn't reflect the session's actual state.
- Don't recreate a session that just served a request (check `lastUsedAt`).
- Add a cooldown so a false-negative doesn't trigger immediate recreate.

**Why:** kills M3 — no churning a working server.

---

## Fix 7 — Bounded fan-out (never run to the 10s ceiling)

Even as a fallback (absent servers), the fan-out shouldn't hit the deadline on every call.

- Per-server timeout on `tools/list` (already in my Layer 0).
- **Total deadline** across the aggregate so a namespace always returns within a bounded window.
- `_meta.pending` for stragglers (already present).

**Why:** kills M4 — no 10s-per-call ceiling; fast or degraded, never slow.

---

## Fix 8 — Circuit breaker (Layer 2) — don't hammer dead backends

**Status: built (my PR #1).** A backend that times out N times → cooldown window → half-open
probe. Wired into background sync + tools/call.

**Why:** prevents the sync loop / requests from retrying a genuinely dead backend forever.

---

## Fix 9 — Per-namespace isolation (Layer 1)

**Status: built (my PR #1).** Per-namespace connection cap (`MAX_CONNECTIONS_PER_NAMESPACE`) so
a busy `shared` (23 servers) can't starve `general`; per-namespace timeout override
(`MCP_TIMEOUT_<NS>_MS`).

**Why:** one slow namespace doesn't poison the others.

---

## Fix 10 — Quiet DEGRADED logging

**Status: built (my PR #1).** `tools/list` DEGRADED once per 60s per namespace; pool cap WARN
once per 30s per server.

**Why:** a healthy system has quiet logs; a broken one is loud.

---

## Fix 11 — Roon (specific) — pair once, reuse

Roon is the one server with a hard external pairing requirement. Beyond the orphan fix (Fix 5):
- The pairing state (`config.json`, `instance.lock`) should be **persisted on the NFS volume**
  so a recreate doesn't force re-pairing.
- Ensure only ONE roon child ever runs (lock + pool single-session).

---

## Fix 12 — Persist npx/uv caches on a volume

Cold-start is dominated by `npx`/`uvx` re-downloading packages. Persist `~/.npm`, `~/.cache/uv`
on the NFS volume so cold spawns hit warm caches. (Trivial; planned separately.)

**Why:** shrinks the cold-start window that feeds H1/H2.

---

## Priority order (for Sindri)

1. **Fix 1 (serve-from-DB)** — the foundation; already built.
2. **Fix 4 (background sync + reap)** — makes DB correct automatically.
3. **Fix 3 (session reuse)** + **Fix 5 (orphan cleanup)** — kill the churn.
4. **Fix 6 (health-check)** — kill the false-negative loop.
5. **Fix 7 (bounded fan-out)** — never slow.
6. **Fixes 8-10** — hardening (already built in my PR).
7. **Fixes 11-12** — roon + cache persistence.

## What NOT to change

- Bifrost (its retry cadence is fine; MetaMCP must stop being slow).
- Client-facing tool-name format (`server__tool`).
- The pool's existing LRU eviction / spawn-concurrency machinery — build on it.

## Verification (post-deploy)

- `tools/list` on `general` + `shared` returns in **ms** with the full cached toolset.
- Bifrost's `Failed to retrieve tools` / reconnect churn drops to ~0.
- Tool counts stable across consecutive polls (no 289 → 0 → 80 flapping).
- No `memory-justin` / `bambu` respawn churn.
- Roon pairs and stays paired.
- Apprise doesn't loop on health-check.
- `[tools-sync]` logs show periodic syncing; adding/removing a tool converges within an interval.
