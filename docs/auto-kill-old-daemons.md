# Auto-kill old daemon versions

## Problem

Orca spawns a background daemon process (`daemon-entry.js`) that owns all PTY sessions and survives Electron quit — this is intentional, so that long-running agents and builds are not killed when the user closes the app. The socket name includes the protocol version (`daemon-v${PROTOCOL_VERSION}.sock`), so every breaking protocol change produces a new daemon, and old daemons from previous app versions keep running.

When a user upgrades Orca, the new app:

1. Spawns a fresh `daemon-v4` daemon (current).
2. Probes `daemon-v1`, `daemon-v2`, `daemon-v3` sockets; if alive, wraps each as a read-only legacy adapter so in-flight sessions keep working.
3. **Never** shuts down those legacy daemons — not when they drain, not on the next upgrade, not ever.

Result: orphaned daemons accumulate and hoard PTY master file descriptors (`ptmx`). macOS caps `kern.tty.ptmx_max` at 511, so after a few upgrade cycles users hit "cannot allocate any more pty devices" and every new terminal fails — not just in Orca, but system-wide (Ghostty, Terminal.app, anything that opens a PTY).

Real reported case: 3 orphaned Orca daemons (v2 aged 6d 21h, v3 aged 5d 20h, v4 aged 4d 15h) holding 475 of the 491 allocated ptmx fds between them.

### Why stale daemons exist in the first place

The daemon is spawned `detached: true` with `child.unref()` (`daemon-init.ts:94-98, 138`) specifically so it outlives Electron. On app quit, `disconnectDaemon()` (`daemon-init.ts:215-218`) only closes the IPC socket — it does not terminate the daemon process. The daemon only exits on SIGTERM/SIGINT or a fatal non-PTY exception (`daemon-entry.ts:72-73`).

When the app upgrades across a protocol bump, the new Orca calls `cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION)` (`daemon-init.ts:82`) — which only targets the **current** version. Nothing ever sends SIGTERM to the previous-version daemon. It keeps running until reboot, OOM, or manual kill.

The original designer explicitly spared legacy daemons with the comment at `daemon-init.ts:326-330`:

> "old daemon PTYs can be running long-lived agents during an app upgrade. Keep those sessions routed to their original daemon while new terminals use the current protocol, instead of killing background work."

That decision is correct for daemons with in-flight sessions. The bug is that it applies unconditionally — legacy daemons whose every session has already exited are also spared, with no mechanism to ever kill them.

## Goals

- On app startup, reclaim PTY fds from legacy daemons whose every session has already exited.
- Do not break in-flight legacy sessions (long-running agents in terminals spawned by an older Orca version must keep working through the transition).
- When a legacy daemon's last in-flight session ends at runtime, shut the daemon down so its fds are reclaimed without requiring an Orca restart.
- Zero regressions to current-version (`daemon-v4`) lifecycle. The new code path must not run for `PROTOCOL_VERSION`.
- Zero timer-based lifecycle logic. Every cleanup trigger must be a discrete event (app startup, session exit) — no polling, no wall-clock thresholds, no risk of false positives against live work.

## Non-goals

- Fixing the v4 per-session fd leak (v4 daemon holding 269 fds for 13 terminals — PTY fd leak on terminal dispose). See "Related work" below.
- Killing daemon-side sessions when a worktree is deleted. See "Related work" below.
- Adding daemon-side idle self-exit (a recurring timer in the daemon that self-terminates after N hours of no clients/sessions). Rejected because it introduces timer-based logic that can misfire against the live daemon, causing cold-restore instead of warm-reattach. Can be revisited later as a separate effort.
- Changing the protocol-versioning scheme, socket naming, or moving to capability negotiation.
- Retroactively migrating legacy sessions onto the current daemon.

## Design decisions

Two explicitly event-driven cleanup tiers. Both are bounded to `PREVIOUS_DAEMON_PROTOCOL_VERSIONS`; neither touches the current daemon.

- **Tier 1 (startup event):** when the new app launches, any legacy daemon whose sessions have all exited is shut down immediately.
- **Tier 2 (session-exit event):** any legacy daemon that still has live sessions at startup is wrapped as today; when the last of those sessions emits an exit event at runtime, the daemon is shut down then.

### Rejected: time-based max-age cap

An earlier draft included a "Tier 3" that force-killed legacy daemons older than 48h regardless of live session count, to bound wedged-session pathologies. **Rejected.**

Reason: a legacy daemon older than 48h with live sessions by definition contains work the user cares about (overnight agent runs, week-long builds). Silently killing that session with no warning is UX-hostile and contradicts the original "don't kill background work" intent of the legacy adapter path. The wedged-session case is real but rare, and the right response is observability/logging, not an arbitrary clock-based kill.

The removal of Tier 3 also removes a timer concept from the design — the only remaining triggers are the two discrete events above.

### "Idle" is event-derived, not time-derived

Throughout this design, "idle legacy daemon" means `TerminalHost.listSessions()` returns zero sessions where `isAlive === true` — i.e., every shell subprocess the daemon ever tracked has exited (`session.ts:92-94`). It is **not** a measure of keystroke activity, client connections, or elapsed time. A daemon with a shell sitting at an idle prompt for hours is **not** idle under this definition.

## Current code surface

All relevant logic lives in `src/main/daemon/`:

- `types.ts:7-8` — `PROTOCOL_VERSION = 4`, `PREVIOUS_DAEMON_PROTOCOL_VERSIONS = [1, 2, 3]`.
- `daemon-spawner.ts:62-82` — `getDaemonSocketPath` / `getDaemonTokenPath` / `getDaemonPidPath` all take an optional `protocolVersion`, so per-version addressing already works.
- `daemon-init.ts:242-314` — `cleanupDaemonForProtocol(runtimeDir, protocolVersion)` does the full graceful-shutdown dance for any version: probe, connect, `listSessions` to count live sessions, `shutdown` RPC, fallback to `killStaleDaemon`, unlink socket and pid file. **Currently only called for `PROTOCOL_VERSION`** (line 82, inside the opt-in relaunch path).
- `daemon-init.ts:316-345` — `createLegacyDaemonAdapters` iterates `PREVIOUS_DAEMON_PROTOCOL_VERSIONS`, probes each socket, and wraps live ones as `DaemonPtyAdapter`. Never calls cleanup.
- `daemon-pty-router.ts:23-28` — `sessionAdapters.delete(id)` fires on every `onExit` event. Natural hook for "last session drained from adapter X".
- `session.ts:92-94` — `isAlive` is derived purely from shell exit events; event-driven, not timer-driven.

## Design

### Tier 1 — legacy daemon with zero live sessions: kill at startup

In `createLegacyDaemonAdapters`, for each version in `PREVIOUS_DAEMON_PROTOCOL_VERSIONS` whose socket is alive:

- Call `cleanupDaemonForProtocol(runtimeDir, protocolVersion)` directly. It internally probes the socket, opens a client, calls `listSessions` to compute `killedCount`, issues the `shutdown` RPC, and falls back to `killStaleDaemon` on RPC failure (`daemon-init.ts:242-314`). Read its `killedCount` return value:
  - `killedCount === 0` → the daemon had no live sessions; it's been cleanly torn down. No adapter needed. Continue to next version.
  - `killedCount > 0` → the daemon had live sessions. **We do not want to have killed them.** This is a correctness issue with the naive "always call cleanup" approach.

Because `cleanupDaemonForProtocol` always issues `shutdown` if the daemon is reachable (line 283) and that call kills all sessions (`killSessions: true` at line 283), a straight call here would kill live legacy sessions. We need the "probe first, branch on live count" shape:

```ts
// Probe: is this daemon idle or does it have live work?
const probeClient = new DaemonClient({ socketPath, tokenPath, protocolVersion })
let liveCount: number
try {
  await probeClient.ensureConnected()
  const { sessions } = await probeClient.request<ListSessionsResult>('listSessions', undefined)
  liveCount = sessions.filter((s) => s.isAlive).length
} catch {
  // Probe said socket was alive but RPC failed — daemon is wedged.
  // Fall through to cleanup, which will PID-kill if the shutdown RPC also fails.
  liveCount = 0
} finally {
  probeClient.disconnect()
}

if (liveCount === 0) {
  await cleanupDaemonForProtocol(runtimeDir, protocolVersion)
  continue // skip to next version, no adapter added
}

// Tier 2: live sessions — wrap for drain.
adapters.push(new DaemonPtyAdapter({ ... }))
```

**Wedged-daemon handling:** if the probe RPC fails (daemon's socket file exists but the daemon process is hung or non-responsive), we treat it as idle and let `cleanupDaemonForProtocol` handle it — its own retry/fallback path (daemon-init.ts:288-292) will PID-kill via `killStaleDaemon` if the shutdown RPC also fails. Wedged daemons hold fds for sessions nobody can reach anyway, so this is correct.

### `killStaleDaemon` must revalidate the pid before SIGKILL

`daemon-health.ts:killStaleDaemon` (lines 180-220 in current code) validates `isDaemonProcess(pid, socketPath, tokenPath)` once at line 188, sends SIGTERM, polls `process.kill(pid, 0)` for ≤3s, then escalates to `SIGKILL` at line 203 **without re-checking** that `pid` still maps to the daemon. In the 3s polling window the daemon can exit and its pid can be recycled to an unrelated user process (Chrome helper, editor, another Orca-spawned subprocess). SIGKILL against a recycled pid terminates that unrelated process with no diagnostic trail.

This is a pre-existing hazard in `killStaleDaemon`, but the auto-kill design amplifies exposure: Tier 1 expands the number of calls into this path (we now call it for every wedged legacy daemon on every app launch, across every version in `PREVIOUS_DAEMON_PROTOCOL_VERSIONS`), making a previously-rare race materially more likely.

**Required change to `killStaleDaemon`** (treat as part of this PR, not a follow-up):

1. Before sending `SIGKILL` at line 203, call `isDaemonProcess(pid, socketPath, tokenPath)` again. If it returns false (pid recycled, socket gone, token mismatch), skip SIGKILL entirely — the daemon is already dead, and whatever process currently owns that pid is not ours. Log `reason=pid_recycled` and treat the kill as successful.
2. Preferred reinforcement: when the daemon spawns, write `{ pid, startedAtMs }` into the pid file (currently just `pid`). `isDaemonProcess` learns to read `startedAtMs` and compares against `/proc/<pid>/stat`'s `starttime` (Linux) or `ps -o lstart=` (macOS). A pid match without a start-time match means recycle — reject. Files to change: `daemon-spawner.ts` (write format), `daemon-health.ts` (parse + compare in `isDaemonProcess`).

**Pid-file compatibility is required.** `killStaleDaemon` must accept both the new JSON pid file and the legacy bare-integer pid file during mixed-version upgrades:

```ts
type ParsedDaemonPid = { pid: number; startedAtMs: number | null }

function parseDaemonPidFile(contents: string): ParsedDaemonPid | null {
  const trimmed = contents.trim()
  try {
    const parsed = JSON.parse(trimmed) as { pid?: unknown; startedAtMs?: unknown }
    if (typeof parsed.pid === 'number' && Number.isFinite(parsed.pid)) {
      return {
        pid: parsed.pid,
        startedAtMs:
          typeof parsed.startedAtMs === 'number' && Number.isFinite(parsed.startedAtMs)
            ? parsed.startedAtMs
            : null
      }
    }
  } catch {
    // Legacy daemons wrote the pid file as a bare integer.
  }

  const pid = Number(trimmed)
  return Number.isFinite(pid) ? { pid, startedAtMs: null } : null
}
```

When `startedAtMs` is `null`, skip the start-time comparison and fall back to the existing `isDaemonProcess(pid, socketPath, tokenPath)` command-line validation only. This preserves compatibility with already-running daemons that wrote the old pid format. Invalid JSON that is not a bare integer is treated as "no trustworthy pid" and must not be killed.

Without step 1 at minimum, Tier 1 SIGKILL of a wedged legacy daemon risks silently killing an unrelated user process. Step 2 is strongly preferred because step 1 still has a microsecond race between the liveness poll and the `isDaemonProcess` revalidation — start-time comparison closes that fully.

### Tier 2 — legacy daemon with live sessions: kill on drain

If `liveCount > 0`, wrap the adapter as today (`daemon-init.ts:335-342`). Additionally, register a drain hook:

- Router already invokes `sessionAdapters.delete(id)` on `onExit` events (`daemon-pty-router.ts:23-28`).
- Extend the router constructor with `onLegacyDrained?: (adapter: DaemonPtyAdapter) => void`. Fired when the last session pointing at a given legacy adapter has exited.
- `initDaemonPtyProvider` passes a callback that:
  1. Calls `adapter.dispose()` to flush its disconnect.
  2. Calls `cleanupDaemonForProtocol(runtimeDir, adapter.protocolVersion)` to terminate the daemon process.

**Routing race safety:** `daemon-pty-router.ts:46-52` shows `spawn()` routes to a legacy adapter *only* when called with an already-registered `sessionId`. New sessions (no `sessionId`, or unknown `sessionId`) go to `this.current`. So once the legacy adapter's final session fires `onExit` and its map entry is cleared, no new work can land on it. The drain signal is a true edge — safe to fire cleanup.

### Pseudocode for `createLegacyDaemonAdapters`

```ts
async function createLegacyDaemonAdapters(
  runtimeDir: string
): Promise<DaemonPtyAdapter[]> {
  // Run per-version in parallel — see "Concurrency and ordering" for why.
  const results = await Promise.all(
    PREVIOUS_DAEMON_PROTOCOL_VERSIONS.map((protocolVersion) =>
      processLegacyVersion(runtimeDir, protocolVersion)
    )
  )
  return results.filter((a): a is DaemonPtyAdapter => a !== null)
}

async function processLegacyVersion(
  runtimeDir: string,
  protocolVersion: number
): Promise<DaemonPtyAdapter | null> {
  const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
  const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)

  if (!(await probeSocket(socketPath))) return null

  // Probe: how many live sessions does this legacy daemon hold?
  let liveCount = 0
  let wedged = false
  const probeClient = new DaemonClient({ socketPath, tokenPath, protocolVersion })
  try {
    await probeClient.ensureConnected()
    const { sessions } = await probeClient.request<ListSessionsResult>(
      'listSessions',
      undefined
    )
    liveCount = sessions.filter((s) => s.isAlive).length
  } catch {
    // Probe failed: socket was live but the daemon won't answer RPC.
    // Treat as wedged/idle — cleanupDaemonForProtocol falls back to PID kill.
    wedged = true
  } finally {
    probeClient.disconnect()
  }

  if (liveCount === 0) {
    // Tier 1: idle or wedged. Clean up immediately.
    const reason = wedged ? 'wedged' : 'idle'
    const result = await cleanupDaemonForProtocol(runtimeDir, protocolVersion)
    console.log(
      `[daemon] legacy v${protocolVersion} cleanup: reason=${reason} ` +
        `killedSessions=${result.killedCount}`
    )
    return null
  }

  // Tier 2: live sessions — keep for drain.
  console.log(
    `[daemon] legacy v${protocolVersion} wrapped for drain: liveSessions=${liveCount}`
  )
  return new DaemonPtyAdapter({
    socketPath,
    tokenPath,
    protocolVersion,
    historyPath: getHistoryDir()
  })
}
```

Drain wiring in the router:

```ts
// daemon-pty-router.ts
private onLegacyDrained?: (adapter: DaemonPtyAdapter) => void
private unsubscribersByAdapter = new Map<DaemonPtyAdapter, (() => void)[]>()

constructor(opts: {
  current: DaemonPtyAdapter
  legacy: DaemonPtyAdapter[]
  onLegacyDrained?: (adapter: DaemonPtyAdapter) => void
}) {
  this.current = opts.current
  this.legacy = opts.legacy
  this.onLegacyDrained = opts.onLegacyDrained

  for (const adapter of this.allAdapters()) {
    const unsubscribers = [
      adapter.onData(/* existing */),
      adapter.onExit((payload) => {
        this.sessionAdapters.delete(payload.id)
        for (const listener of this.exitListeners) listener(payload)

        // Why: fire drain only for legacy adapters, and only when every session
        // in the router's map is on a non-legacy adapter (or the map is empty).
        // Removing the adapter from `this.legacy` before invoking the callback
        // prevents a double-fire if onExit re-enters (e.g. test harness).
        if (this.legacy.includes(adapter) && !this.hasActiveSessionsOn(adapter)) {
          this.legacy = this.legacy.filter((a) => a !== adapter)
          const subs = this.unsubscribersByAdapter.get(adapter)
          if (subs) {
            for (const unsub of subs) unsub()
            this.unsubscribersByAdapter.delete(adapter)
          }
          this.onLegacyDrained?.(adapter)
        }
      })
    ]
    this.unsubscribersByAdapter.set(adapter, unsubscribers)
  }
}

private hasActiveSessionsOn(adapter: DaemonPtyAdapter): boolean {
  for (const a of this.sessionAdapters.values()) {
    if (a === adapter) return true
  }
  return false
}
```

**Per-adapter unsubscriber tracking.** Replace the flat `this.unsubscribers: (() => void)[]` with `this.unsubscribersByAdapter: Map<DaemonPtyAdapter, (() => void)[]>`. On drain, call each unsubscribe for the drained adapter and delete the map entry. This is defensive: today, `adapter.dispose()` tears down the client and no events fire through the stale subscriptions, so the leak is inert. But a future change that reuses a disposed adapter or iterates `unsubscribers` would hit live callbacks into freed state. Cost is one Map instead of an array — no behavioral change for the router's other operations.

Init-side callback wiring:

```ts
// daemon-init.ts — inside initDaemonPtyProvider
const legacyAdapters =
  process.env.ORCA_DISABLE_LEGACY_CLEANUP === '1'
    ? []
    : await createLegacyDaemonAdapters(runtimeDir)

let routedAdapter: DaemonPtyAdapter | DaemonPtyRouter = newAdapter
if (legacyAdapters.length > 0) {
  routedAdapter = new DaemonPtyRouter({
    current: newAdapter,
    legacy: legacyAdapters,
    onLegacyDrained: async (adapter) => {
      try {
        adapter.dispose()
        const result = await cleanupDaemonForProtocol(
          runtimeDir,
          adapter.protocolVersion
        )
        console.log(
          `[daemon] legacy v${adapter.protocolVersion} cleanup: reason=drain ` +
            `killedSessions=${result.killedCount}`
        )
      } catch (err) {
        console.warn(
          `[daemon] legacy v${adapter.protocolVersion} drain cleanup failed:`,
          err
        )
      }
    }
  })

  await routedAdapter.discoverLegacySessions()
  routedAdapter.sweepDrainedLegacyAdapters()
}
```

`DaemonPtyAdapter`'s constructor currently receives `protocolVersion` in its options and passes it into `DaemonClient` / uses it inline for `supportsCheckpoints` (`daemon-pty-adapter.ts:73-83`), but does not retain it as a field. Add `public readonly protocolVersion: number` captured from `opts.protocolVersion` in the constructor so `onLegacyDrained` callers can read `adapter.protocolVersion`.

## Concurrency and ordering

1. **Tier 1 runs in parallel across versions.** The pseudocode uses `Promise.all` over `PREVIOUS_DAEMON_PROTOCOL_VERSIONS`. Each version's paths (socket, pid, token) are disjoint, so parallelism is safe. This is load-bearing for startup latency: worst case 3 versions × (5s `CONNECT_TIMEOUT_MS` + 30s `REQUEST_TIMEOUT_MS` from `client.ts:8-9`) = up to 105s of added startup time if done serially. Parallel execution caps per-version-worst-case at ~35s for the probe alone; if the probe succeeds but the subsequent `cleanupDaemonForProtocol` call also hangs (its internal `listSessions`, `shutdown`, and `killStaleDaemon` wait add up to ~65s additional), worst case per version is ~100s. Parallel across versions caps total at that per-version figure.

2. **Current daemon spawn is not delayed by Tier 1.** `initDaemonPtyProvider` (`daemon-init.ts:166-209`) awaits `newSpawner.ensureRunning()` at line 177 **before** calling `createLegacyDaemonAdapters` at line 194. Tier 1 never gates the current daemon's readiness. Do not rearrange these awaits.

3. **Drain cleanup runs serially after an exit event.** `onLegacyDrained` is invoked synchronously inside the `onExit` handler. It fires `cleanupDaemonForProtocol` as an async `.catch()`-guarded operation; the exit event itself is not blocked. The router's state mutation (`this.legacy.filter(...)`) happens before the callback, so concurrent exits on different legacy adapters cannot observe a stale `this.legacy` list.

4. **Probe client lifetime.** The probe `DaemonClient` in `processLegacyVersion` is disconnected in `finally` before `cleanupDaemonForProtocol` runs. `cleanupDaemonForProtocol` opens its own fresh `DaemonClient` (`daemon-init.ts:269`). No shared connection, no teardown race.

5. **Re-entrancy on drain.** If a legacy adapter's final session fires `onExit` and during `cleanupDaemonForProtocol` a hypothetical late exit event arrives, `this.legacy.includes(adapter)` returns false (we already filtered it out), so `onLegacyDrained` is not re-invoked. Idempotent by construction.

6. **Probe-to-discovery race on Tier 2 — mandatory post-discovery sweep.** Between `processLegacyVersion` returning a wrapped adapter with `liveCount > 0` and `DaemonPtyRouter.discoverLegacySessions` completing, the legacy daemon's last session could exit. In that window, the router never registers any session on the legacy adapter → `onExit` never fires on it → drain never triggers. Without a sweep, the legacy daemon persists idle and leaking fds for the rest of this app session (potentially days for always-on users); Tier 1 only catches it on the next launch.

**Required (not optional):** after `discoverLegacySessions` completes, iterate `this.legacy`. For each adapter where no entry in `this.sessionAdapters` maps to it (use `hasActiveSessionsOn(adapter)` — it already exists for the drain path), remove the adapter from `this.legacy`, tear down its per-adapter unsubscribers, and invoke the same `onLegacyDrained(adapter)` callback used by the runtime drain path. This closes the race synchronously on startup.

```ts
// DaemonPtyRouter — call after discoverLegacySessions finishes populating sessionAdapters.
sweepDrainedLegacyAdapters(): void {
  for (const adapter of [...this.legacy]) {
    if (this.hasActiveSessionsOn(adapter)) continue
    this.legacy = this.legacy.filter((a) => a !== adapter)
    const subs = this.unsubscribersByAdapter.get(adapter)
    if (subs) {
      for (const unsub of subs) unsub()
      this.unsubscribersByAdapter.delete(adapter)
    }
    this.onLegacyDrained?.(adapter)
  }
}
```

The earlier framing of this as "optional polish" was wrong — without the sweep, a legitimate ship scenario (user has a v3 daemon with one session that exits in the probe-to-discover window) silently re-creates the exact leak this PR is supposed to fix. The sweep is load-bearing for the zero-regression guarantee.

## Error handling and logging

- All Tier 1 failures are non-fatal. On probe error or cleanup error, log at warn and continue startup. The worst case is one more app launch with an orphan — still an improvement over "forever".
- Drain cleanup failures are also non-fatal. If `cleanupDaemonForProtocol` fails during drain, the legacy daemon persists but no longer has the router keeping sessions on it. Tier 1 catches it on the next startup.
- Structured log lines for each cleanup attempt:
  - `[daemon] legacy v{version} cleanup: reason={idle|wedged|drain} killedSessions={n}`
  - `[daemon] legacy v{version} wrapped for drain: liveSessions={n}`
  - `[daemon] legacy v{version} drain cleanup failed: {error}` (warn)
- Telemetry (if stats/collector is available): emit a single `daemon_legacy_cleanup` event per cleanup with `{ version, reason, killedSessions }`. Makes it possible to verify the fix lands in prod.

## Testing plan

All under `src/main/daemon/`. Existing tests: `daemon-spawner.test.ts`, `daemon-server.test.ts`, `daemon-pty-adapter.test.ts`, `daemon-health.test.ts`.

### Unit tests — `daemon-init.test.ts` (new)

`processLegacyVersion` behaviors:

- **Idle legacy daemon** — `listSessions` returns `[]`. Assert `cleanupDaemonForProtocol` called once, no adapter returned.
- **Live legacy daemon** — `listSessions` returns 2 alive sessions. Assert adapter returned, `cleanupDaemonForProtocol` not called.
- **Wedged daemon** — probe socket alive, `ensureConnected` rejects. Assert `cleanupDaemonForProtocol` called (falls back to PID kill path internally).
- **Wedged daemon** — probe succeeds, `listSessions` rejects. Same as above.
- **No legacy socket** — `probeSocket` returns false. Assert no client opened, no cleanup, no adapter.
- **Probe client disconnected even on throw** — use a spy on `DaemonClient.disconnect` in the `finally` branch.
- **Killswitch** — with `ORCA_DISABLE_LEGACY_CLEANUP=1`, assert startup does not call `createLegacyDaemonAdapters`, does not construct `DaemonPtyRouter`, and uses `newAdapter` directly.

`createLegacyDaemonAdapters` aggregation:

- **Parallel execution** — inject delays on each per-version probe, assert total elapsed < sum of delays + slack. Guards against silent `for...await` regression.
- **Mixed outcome** — v1 idle, v2 live, v3 missing. Assert exactly one adapter returned (v2) and exactly one cleanup called (v1).

### Unit tests — `daemon-pty-router.test.ts` (new)

Drain hook behaviors:

- **Single legacy, single session** — fire `onExit`. Assert `onLegacyDrained` fires exactly once; adapter removed from `this.legacy`.
- **Single legacy, multiple sessions** — 3 sessions. Fire exits for 2 of them. Assert `onLegacyDrained` not yet fired. Fire the third. Assert fires exactly once.
- **Two legacies, drain one** — v1 has 1 session, v2 has 1 session. Fire v1's exit. Assert `onLegacyDrained` fires with v1 adapter only; v2 still in `this.legacy`.
- **Current adapter exits never fire drain** — fire `onExit` on the current adapter. Assert `onLegacyDrained` never called.
- **Post-drain routing** — after drain, call `spawn({ sessionId: <from-drained-adapter> })`. Assert routes to `current` (via `adapterFor` fallback at `daemon-pty-router.ts:190-192`), not to the drained adapter.
- **Post-drain `listProcesses`** — assert the drained adapter is not queried (removed from `allAdapters()` iteration). Prevents spurious errors from a dead socket.
- **Re-entrancy guard** — synthesize a double-exit event for the same session id. Assert `onLegacyDrained` fires at most once.
- **Post-discovery sweep** — have `discoverLegacySessions` find no sessions for a wrapped legacy adapter. Assert `sweepDrainedLegacyAdapters()` removes that adapter and invokes `onLegacyDrained` exactly once.

### Unit tests — `daemon-health.test.ts`

- **Pid file backward compatibility** — assert `killStaleDaemon` accepts both `{ "pid": 123, "startedAtMs": 456 }` and legacy `123` pid-file contents. For the legacy form, assert start-time validation is skipped and the existing command-line `isDaemonProcess` validation remains required.

### Regression guards

- `createLegacyDaemonAdapters` never calls `cleanupDaemonForProtocol(runtimeDir, PROTOCOL_VERSION)`. Loop bound is `PREVIOUS_DAEMON_PROTOCOL_VERSIONS` (compile-time). Add a runtime assertion test: spy on `cleanupDaemonForProtocol`, run the full startup path, assert no call was made with the current version.
- `types.ts` invariant — `PREVIOUS_DAEMON_PROTOCOL_VERSIONS` must not contain `PROTOCOL_VERSION`. Add a trivial test asserting this. Catches the "forgot to remove v4 when shipping v5" mistake.
- `daemon-spawner.test.ts` keeps the socket-path regression and adds a pid-file serialization assertion.
- `daemon-server.test.ts` unchanged — wire protocol is untouched.
- `daemon-entry.ts` unchanged — no new signal handlers, no timer, no idle-exit logic.

### Integration / manual smoke

1. **Fresh install, no legacy** — launch app. Assert startup proceeds normally, no extra log lines, no probe attempts for nonexistent sockets beyond the `probeSocket` short-circuit.
2. **Orphan idle daemon** — plant a fake v3 daemon using the current `daemon-entry.js` bound to `daemon-v3.sock`, with zero sessions. Launch app. Assert v3 socket gone, v3 pid file gone, fake v3 PID exited. Log line `reason=idle killedSessions=0` emitted.
3. **Orphan wedged daemon** — plant a fake v3 daemon that accepts connections but never responds to `listSessions`. Launch app. Within `CONNECT_TIMEOUT_MS + REQUEST_TIMEOUT_MS`, assert v3 daemon killed (via SIGKILL fallback). Log line `reason=wedged` emitted.
4. **Legacy with live session, drain during runtime** — plant fake v3 holding an open `sleep 60`. Launch app. Assert v3 wrapped (log line `wrapped for drain: liveSessions=1`). Wait for `sleep` to exit. Assert `onLegacyDrained` fires, v3 daemon terminates, log line `reason=drain killedSessions=0` emitted (0 because the session was already exiting when shutdown ran).
5. **Legacy with live session, app quit before drain** — plant fake v3 with `sleep 600`. Launch app. Quit Orca (Cmd+Q). Assert v3 still running (drain did not fire; `disconnectDaemon` doesn't kill legacies — intentional). Relaunch Orca. Assert v3 still wrapped. Kill the `sleep` externally. Assert drain fires on this new app session.

## Rollout

- **Killswitch env var — `ORCA_DISABLE_LEGACY_CLEANUP=1`.** At the top of `initDaemonPtyProvider`, short-circuit `createLegacyDaemonAdapters` to return `[]` when this env var is set. No-op design that skips Tier 1 and Tier 2 entirely. Gives ops a one-variable remediation lever if a weird user environment triggers the swallow-catch path (node-pty ABI drift, fork with non-standard `destroy()` semantics, etc.) without requiring a hotfix build. Document in the README's troubleshooting section.
- **No feature flag beyond the killswitch.** The code path only runs against sockets already matched to `PREVIOUS_DAEMON_PROTOCOL_VERSIONS`. Blast radius is bounded to legacy versions by construction.
- **One-time cleanup burst on first launch after release.** Users upgrading from a version without this fix will see their accumulated orphans (v2/v3) cleaned up the first time they launch the new Orca. Expected.
- **Protocol version bump not required.** No wire protocol changes. Current daemon behavior is unchanged.
- **Telemetry for verification.** Watch `daemon_legacy_cleanup` events for the week after release. Expected: initial burst of `reason=idle` events as the backlog drains, then a trickle of `reason=drain` events as users upgrade with live sessions and those sessions eventually exit.
- **Recommended release ordering with [fix-pty-fd-leak.md](./fix-pty-fd-leak.md).** Land the fd-leak fix first. Reasons: (a) it has the broader test-surface change (six mocks need `dispose`); surfacing issues first is easier to isolate. (b) Shipping this orphan-daemon fix first cleans up v1-v3 corpses but leaves live v4 still leaking per-session. Landing fd-leak first means every new v4 session is clean; this PR then sweeps the graveyard. (c) Both PRs are independent at the code level (no file overlap).

## Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Tier 1 kills a legacy daemon while a session is mid-startup (probe says 0 live but a new session is being spawned concurrently). | Cannot happen: legacy daemons are from a previous Orca app that has already quit. Nothing in the new app spawns sessions on any legacy daemon — `daemon-pty-router.ts:46-52` only routes by already-registered `sessionId`, and no sessions can be registered until after `createLegacyDaemonAdapters` completes. |
| Tier 2 drain fires while a session exit is still being processed, races with in-flight RPC to that daemon. | `onExit` is emitted by the adapter only after the session is gone. Drain callback calls `adapter.dispose()` before `cleanupDaemonForProtocol`, flushing client state. Legacy adapters have `respawn: undefined` (`daemon-init.ts:335-342`) so no auto-reconnect races with shutdown. |
| `listSessions` on a v1 daemon behaves differently than v4. | `cleanupDaemonForProtocol` already works across all versions today — that's its entire design (`daemon-init.ts:242`, accepts `protocolVersion` arg). We're reusing that proven path. `listSessions` has been stable since v1 (it's one of the first RPCs defined — see `daemon-server.ts` handlers). |
| Probe RPC hangs indefinitely on a wedged daemon, blocking startup. | `DaemonClient` enforces `CONNECT_TIMEOUT_MS=5000` and `REQUEST_TIMEOUT_MS=30000` (`client.ts:8-9`). Worst case per version: ~35s for the probe; if the cleanup path also hangs on the same wedged daemon, the combined worst case per version is ~100s. Parallel across versions caps total at that per-version figure. |
| Startup latency regression from parallel cleanup. | Benchmark before merge: time from `app.on('ready')` to first IPC on a machine with 3 planted legacy daemons. Target: < 2s additional latency vs baseline in the happy path (daemons present and responsive). Document expected worst-case of 35s when all three are wedged. |
| Legacy adapter's `DaemonClient` disconnect races with the `shutdown` RPC inside `cleanupDaemonForProtocol`. | `cleanupDaemonForProtocol` creates its own client (`daemon-init.ts:269`). The probe client opened in `processLegacyVersion` is disconnected in `finally` before cleanup runs. No shared connection. |
| Future protocol bump to v5 accidentally leaves v4 missing from `PREVIOUS_DAEMON_PROTOCOL_VERSIONS`. | Unit test in `types.test.ts` (add if not present): asserts `PREVIOUS_DAEMON_PROTOCOL_VERSIONS` contains every integer from 1 to `PROTOCOL_VERSION - 1`. Forces discipline at version-bump time. |
| Two Orca processes racing on the same legacy socket during a user-initiated reinstall. | The app already has a single-instance lock (Electron's `requestSingleInstanceLock`). Legacy cleanup inherits that lock's exclusivity — not additive risk. |
| User force-quits Orca mid-drain, leaving a legacy daemon still running. | Acceptable. Tier 1 catches it on next launch. `disconnectDaemon()` on quit intentionally does not kill legacies (see `daemon-init.ts:215-218`). |

## Regression-guard checklist

Before merge, confirm each of the following has not changed behaviorally:

- [ ] `getDaemonSocketPath(runtimeDir, PROTOCOL_VERSION)` returns the same path format.
- [ ] `initDaemonPtyProvider` spawns current daemon first (via `newSpawner.ensureRunning()` at line 177 before `createLegacyDaemonAdapters` at line 194).
- [ ] Legacy sessions that survive Tier 1 still support `attach`, `write`, `resize`, `shutdown`, `sendSignal`, and emit `onData`/`onExit`.
- [ ] No change to `daemon-entry.ts`, `daemon-server.ts`, or any wire-protocol type. Greppable invariant: `daemon-entry.ts` contains no `setInterval`, no `setTimeout` outside existing error paths, no new signal handlers.
- [ ] `disconnectDaemon()` on app quit behaves identically — legacy adapters still receive `disconnectOnly` and stay alive across restart.
- [ ] `shutdownDaemon()` (full teardown path) unchanged.
- [ ] `DaemonPtyRouter.allAdapters()` (current + legacy) is iterated by `listProcesses`, `dispose`, `disconnectOnly`, and any other multi-adapter operation. Drained legacy adapters must be removed from `this.legacy` so these iterations do not hit a disposed adapter.
- [ ] `sessionAdapters` map cleanup on `onExit` happens **before** the drain check (order matters — `hasActiveSessionsOn` must not include the session that just exited).
- [ ] Current-daemon `onExit` never triggers `onLegacyDrained`. Router's `this.legacy.includes(adapter)` check gates this.

## Files to change

- `src/main/daemon/daemon-init.ts` — extract `processLegacyVersion`, rewrite `createLegacyDaemonAdapters` to use `Promise.all`, wire `onLegacyDrained` callback into `DaemonPtyRouter` construction.
- `src/main/daemon/daemon-pty-router.ts` — add `onLegacyDrained` option, `hasActiveSessionsOn` helper, remove-from-legacy-on-drain logic.
- `src/main/daemon/daemon-pty-adapter.ts` — add `public readonly protocolVersion: number` field in constructor.
- `src/main/daemon/daemon-health.ts` — parse both JSON and legacy integer pid files, revalidate before SIGKILL, and compare process start time when known.
- `src/main/daemon/daemon-spawner.ts` — write `{ pid, startedAtMs }` pid-file JSON for newly spawned daemons.
- `src/main/daemon/daemon-init.test.ts` — new file with `processLegacyVersion` and `createLegacyDaemonAdapters` unit tests.
- `src/main/daemon/daemon-pty-router.test.ts` — new file with drain-hook tests.
- `src/main/daemon/daemon-pty-adapter.test.ts` — add coverage for the exposed `protocolVersion` field.
- `src/main/daemon/daemon-health.test.ts` — add pid-file compatibility and SIGKILL revalidation tests.
- `src/main/daemon/daemon-spawner.test.ts` — add pid-file serialization coverage.
- `src/main/daemon/types.test.ts` — trivial invariant tests on `PROTOCOL_VERSION` / `PREVIOUS_DAEMON_PROTOCOL_VERSIONS`.

Explicitly **not** touched: `daemon-entry.ts`, `daemon-server.ts`, `daemon-main.ts`, `terminal-host.ts`, `session.ts`, `client.ts`, `pty-subprocess.ts`, `history-manager.ts`.

## Related work (out of scope for this PR)

Three adjacent bugs share the symptom "ptmx fd pool depletes over time" but are independent in cause and fix. Each should be its own follow-up:

1. **v4 per-session fd leak on terminal dispose** (reported: 269 fds for 13 terminals). Fix location: `terminal-host.ts` / `session.ts` dispose path. Suspected cause: pty subprocess exits but `Session.dispose()` or the surrounding `TerminalHost` entry drops the pty close. Triage priority: **higher than this PR** for users who don't upgrade frequently, since this leak accumulates per-use rather than per-upgrade. Document existence here so reviewers know it's acknowledged.

2. **Worktree deletion does not kill its sessions.** `worktrees:remove` (`src/main/ipc/worktrees.ts:251-308`) removes the directory, git tracking, and history files but leaves daemon-side pty sessions alive with their cwd pointing at a deleted path. Shells typically don't exit on cwd removal, so those sessions persist indefinitely. Each leaked session holds ptmx fds on the current daemon until the daemon itself dies. A power user who regularly deletes worktrees accumulates fds on v4 this way. Fix: enumerate sessions whose `cwd` is under the removed path and kill them as part of `worktrees:remove`.

3. **No daemon-side idle self-exit.** The daemon never exits on its own under any circumstance (`daemon-entry.ts:72-73` — SIGTERM/SIGINT only). If Orca is uninstalled or the user stops launching it, whatever daemon was last running holds its fds until reboot. Event-driven cleanup (this PR) cannot solve this because the trigger requires a future app launch. A structural fix would add a timer-based idle check in the daemon, but timer logic carries risk of false-positive self-exit against live work (cold-restore instead of warm-reattach on next launch). Deferred explicitly; revisit only with a strong conservative timeout (hours, not minutes) and a combined signal (zero sessions AND zero clients AND reparented to init).

These three are noted here so that the PR reviewer and on-call engineer understand the full picture: shipping this PR closes the orphan-daemon leak class but does not eliminate ptmx accumulation entirely.

## Open questions

1. Should drain cleanup emit a toast ("Old Orca background process exited")? Leaning no — invisible infra cleanup is correct. Log only.
2. Should the `processLegacyVersion` probe skip `ensureConnected` and call `cleanupDaemonForProtocol` unconditionally (relying on its own `listSessions` at line 275-277 to compute `killedCount`)? That would eliminate the separate probe client and halve the RPC count. Tradeoff: `cleanupDaemonForProtocol` kills sessions via `shutdown: { killSessions: true }` (line 283) unconditionally — so doing that on a daemon with live sessions would kill them. We need the pre-probe for the branch. Keep as designed.
3. Should telemetry be gated behind the stats collector's consent flag? Yes — use the same path as other `stats/collector.ts` events. Not a new privacy surface.
