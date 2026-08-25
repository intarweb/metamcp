# SPEC: Background tools-sync + reap (make the tool list converge automatically)

**Status:** ready for implementation
**For:** Sindri / perf team
**Depends on:** serve-from-DB (Layer 0) — this makes the DB the authoritative store and keeps it fresh.

## Problem

Today the `tools` table only converges **on-demand** (when a `tools/list` runs) and **weakly**:

- **Additions** converge on the next `tools/list` for that namespace.
- **Removals** often DON'T converge: the `toolsSyncCache.hasChanged()` guard uses an in-memory
  per-server hash. If a server's tool-set is stable between runs, `hasChanged` returns `false`,
  `sync()` returns early, and `deleteObsoleteTools` never runs — stale tools linger in the DB
  indefinitely (and the hash cache resets on restart).
- **No background upkeep**: if nobody calls `tools/list`, nothing syncs or reaps.

## Goal

Make the `tools` table converge to the true backend tool-set **automatically, on a timer**,
for both additions and removals — without blocking any request.

## Design

### 1. Background loop (new module `background-tools-sync.ts`)

```
start() // called once at boot (initializeIdleServers) or on first request
  every MCP_TOOLS_SYNC_INTERVAL_MS (default 60s):
    for each namespace (from namespaces repo, ACTIVE):
      serverParams = getMcpServers(ns, includeInactiveServers=false)  // DB, ACTIVE only
      for each (serverUuid, params):
        if isFresh(serverUuid): continue          // synced recently
        if circuitBreaker.isOpen(serverUuid): continue
        syncServer(serverUuid, params, ns)
```

- **Idempotent / non-blocking**: runs off the request path; never awaited by tools/list.
- **Bounded spawns**: reuse `MCP_SPAWN_CONCURRENCY` gate so the loop can't cold-start 45
  processes at once.
- **`syncServer`**:
  1. Fetch tools/list for the server (bounded by `MCP_STDIO_CONNECT_TIMEOUT_MS`, reusing a
     pooled connection when possible).
  2. `filterOutOverrideTools(tools, ns, serverName)` (existing).
  3. `toolsRepository.syncTools({ tools, mcpServerUuid })` — **upserts current AND deletes
     obsolete** (existing `deleteObsoleteTools`). This is the reap.
  4. `toolsSyncCache.update(serverUuid, toolNames)` — mark synced.
  5. Record `lastSyncedAt[serverUuid] = now` for the freshness tracker.

### 2. Freshness tracker (TTL)

- Per-server `lastSyncedAt` in memory; TTL `MCP_TOOLS_TTL_MS` (default 60s).
- **stale** = `now - lastSyncedAt > TTL` → serve last-known from DB + refresh in bg.
- **absent** = no rows for the server → one-off bounded fetch (fallback) on request.

### 3. Fix the reap (critical)

The `toolsSyncCache.hasChanged()` guard currently short-circuits `sync()` BEFORE
`deleteObsoleteTools`. Fix: **always run `syncTools` (which reaps) on the background pass**,
regardless of the hash guard. The hash cache is only an optimization for the *upsert*; the
*delete-obsolete* must always run so removals converge.

Option A (minimal): in `syncServer`, call `toolsRepository.syncTools()` unconditionally
(not gated by `hasChanged`). The upsert is idempotent; the delete catches removals.

Option B (better): make `syncTools` always reap obsolete, and keep the hash only as a
fast-path to skip the *upsert* when unchanged:
```
if hasChanged: upsert (bulkUpsert)
always: deleteObsoleteTools(currentToolNames)   // reap regardless
```

### 4. Wire into serve-from-DB

`tools/list` reads the DB (Layer 0). The background loop keeps that DB fresh. When a server is
stale/absent, `tools/list` flags it `_meta.pending` and calls
`backgroundToolsSync.ensureFresh(serverUuid, params, ns)` (debounced, non-blocking) — the
request still returns immediately from DB.

## Config / env

| Env | Default | Purpose |
|---|---|---|
| `MCP_TOOLS_SYNC_INTERVAL_MS` | 60000 | Background loop interval |
| `MCP_TOOLS_TTL_MS` | 60000 | Staleness TTL for serve-from-DB |
| `MCP_STDIO_CONNECT_TIMEOUT_MS` | (existing) | Per-server fetch timeout in the loop |

## Verification

- Start the loop at boot; confirm `[tools-sync]` logs show per-pass syncing.
- Add a tool to a backend → appears in `tools` within one interval, no `tools/list` call.
- Remove a tool from a backend → disappears from `tools` within one interval (reap fires).
- `tools/list` returns from DB in ms; stale/absent servers flagged `_meta.pending`.
- Confirm no spawn storm: loop respects `MCP_SPAWN_CONCURRENCY`.

## Notes / non-goals

- Reuse `filterOutOverrideTools`, `toolsRepository.syncTools`, `toolsSyncCache`, `getMcpServers`,
  `configService` — all exist.
- Do NOT change the client-facing tool-name format (`server__tool`).
- The reap must NOT remove tools from a server that is simply INACTIVE (only ACTIVE servers
  are synced, and `deleteObsoleteTools` only runs for servers the loop actively syncs).
- This is the mechanism that makes the 398-saved / 0-from-MetaMCP UI mismatch go away:
  the DB stays correct, and serve-from-DB serves it.
