# Codex Account Switching Design

**Status:** Draft
**Date:** 2026-04-17

## Summary

Orca's current Codex account switcher swaps the entire `CODEX_HOME` for each managed account. That isolates authentication, but it also unintentionally forks config, permissions, history, sessions, memories, skills, and other local Codex state. The result is that account switching feels like switching between separate Codex installs instead of switching which account powers the same Codex environment.

The recommended design is:

- Keep `~/.codex` as the shared runtime `CODEX_HOME` for all Codex user state.
- Store only `auth.json` per managed account in Orca-owned storage.
- Introduce a dedicated main-process runtime-home owner that materializes the selected account's `auth.json` into the shared runtime home before any Codex launch, login, or rate-limit fetch.
- Restart live Codex panes after switch; newly launched panes use the new account while preserving the shared Codex state.

This matches the intended product behavior: account switching is for authentication and usage limits, not for creating separate Codex worlds. It also matches how manual Codex account switching already behaves outside Orca: logging out and back in mutates the same `~/.codex` state the user sees in terminal Codex.

## Motivation

The current managed-account design causes user-visible problems:

- `config.toml` diverges per account, so permissions and sandbox defaults reset unexpectedly.
- `history.jsonl` and `sessions/` are scoped per managed home, so chat history appears to disappear after account switches.
- `memories`, `skills`, `rules`, and likely sqlite-backed local state drift per account.
- Live sessions require restart because the active terminal process keeps using the old `CODEX_HOME`.

We already patched the first symptom by syncing `config.toml` into managed homes. That is a tactical fix, not the right long-term model. The full-home-per-account design still leaves history and session continuity split across accounts.

The deeper issue is ownership. Orca currently has no single component that owns Codex runtime state preparation. `CodexAccountService`, `pty.ts`, rate-limit fetchers, and usage scanning each participate in path or environment decisions. The long-term fix must therefore be a runtime-home ownership refactor, not just a storage-layout tweak.

## Current State

### Orca behavior today

- Managed accounts are created under `app.getPath('userData')/codex-accounts/<id>/home`.
- Orca selects an account by updating `settings.activeCodexManagedAccountId`.
- New Codex PTYs inherit the selected managed home's path as `CODEX_HOME`.
- Codex rate-limit fetches also use that selected managed home.

Relevant code:

- [src/main/codex-accounts/service.ts](/Users/jinwoohong/orca/workspaces/orca/codex-fix-2/src/main/codex-accounts/service.ts)
- [src/main/ipc/pty.ts](/Users/jinwoohong/orca/workspaces/orca/codex-fix-2/src/main/ipc/pty.ts)
- [src/main/codex-usage/scanner.ts](/Users/jinwoohong/orca/workspaces/orca/codex-fix-2/src/main/codex-usage/scanner.ts)

### Codex state observed on disk

On a typical install, `CODEX_HOME` contains at least:

- `auth.json`
- `config.toml`
- `history.jsonl`
- `sessions/`
- `memories/`
- `skills/`
- `rules/`
- `shell_snapshots/`
- `models_cache.json`
- `logs_2.sqlite`
- `state_5.sqlite`
- `installation_id`
- `version.json`

Because Orca currently swaps the whole home, all of that becomes account-scoped.

## Goals

- Make Codex account switching feel like swapping credentials, not swapping environments.
- Preserve one continuous Codex history and session store across accounts.
- Keep permissions, sandbox defaults, MCP config, memories, and other user state stable across account changes.
- Preserve Orca's existing account-switch UX: one selected active account at a time, with restart prompts for live Codex panes.
- Keep the solution cross-platform across macOS, Linux, and Windows.

## Non-Goals

- Supporting simultaneous live Codex sessions under different accounts in the same Orca instance.
- Changing Codex upstream behavior or requiring first-class multi-account support from Codex.
- Building a replication system that continuously merges multiple independent `CODEX_HOME` trees.

## Constraints

### Codex does not currently expose a separate auth path

From local CLI inspection, Codex supports:

- `CODEX_HOME`
- config overrides via `-c key=value`

It does not currently expose a first-class "shared config/home plus separate auth profile" interface. There is an upstream feature request for auth profiles, which suggests Orca cannot rely on such a feature today.

### Orca is cross-platform

The design must work on macOS, Linux, and Windows. That rules out relying on symlink-heavy designs as the primary solution:

- Windows symlink/junction behavior is more fragile.
- Atomic copy + rename is simpler and more portable.
- Node path utilities should be used everywhere.

### Orca's current mental model is single selected account

The current switcher already assumes one active account at a time and uses restart prompts for live Codex panes. The recommended design leans into that model rather than trying to support concurrent mixed-account sessions.

## Options Considered

### Option 1: Keep full per-account homes and sync everything

Each managed account keeps its own full `CODEX_HOME`, and Orca syncs:

- `config.toml`
- `history.jsonl`
- `sessions/`
- sqlite state
- memories, skills, rules

**Pros**

- Minimal conceptual change from the current design.
- Per-account auth isolation stays simple.

**Cons**

- Orca becomes a replication system for Codex state.
- `history.jsonl` is mergeable, but `sessions/` and sqlite-backed files are much harder to reconcile safely.
- Concurrent activity can easily cause stale-copy or overwrite bugs.
- More code, more edge cases, weaker guarantees.

**Verdict**

Not recommended. This is the highest-complexity path for the weakest product result.

### Option 2: Shared runtime home, per-account `auth.json`

Keep a single shared runtime `CODEX_HOME` and store one `auth.json` per managed account. On switch, Orca copies the selected account's `auth.json` into the shared runtime home before launching or restarting Codex sessions.

**Pros**

- Cleanest mapping to the product intent.
- `config.toml`, history, sessions, memories, skills, rules, and local state are naturally shared.
- No state replication logic.
- Cross-platform implementation is straightforward with normal file copy and rename.

**Cons**

- Does not support simultaneous different-account live sessions in the same runtime home.
- Existing live sessions still likely need restart because Codex may read auth only at startup.

**Verdict**

Recommended.

### Option 3: Wait for upstream Codex auth profiles

If Codex eventually supports a true auth-profile model, Orca could delegate account isolation to Codex itself.

**Pros**

- Best long-term upstream integration.
- Less Orca-specific state management.

**Cons**

- Not available today.
- Does not solve Orca's user-facing problems now.

**Verdict**

Good future migration target, not a current solution.

## Recommended Design

### High-level model

Introduce two separate concepts:

1. **Shared runtime home**
   The single `CODEX_HOME` used for all Codex launches inside Orca. For this design, the canonical shared runtime home is `~/.codex`.

2. **Per-account auth store**
   Orca-managed storage that keeps one `auth.json` per account.

3. **Codex runtime-home owner**
   A dedicated main-process component that prepares active Codex runtime state before any Codex subprocess, rate-limit fetch, or login flow touches it.

At runtime:

- Orca picks the selected managed account.
- The runtime-home owner copies that account's `auth.json` into `~/.codex/auth.json`.
- All Codex entry points consume the runtime-home owner's resolved home path instead of reasoning about Codex paths independently.
- Orca launches Codex with `CODEX_HOME` pointing to `~/.codex`.

### Shared vs per-account state

**Shared runtime home**

- `config.toml`
- `history.jsonl`
- `sessions/`
- `memories/`
- `skills/`
- `rules/`
- `shell_snapshots/`
- `models_cache.json`
- `logs_2.sqlite`
- `state_5.sqlite`
- `installation_id`
- `version.json`
- transient caches and temp dirs, unless we later discover they must be treated specially

**Per-account storage**

- `auth.json`
- Orca account metadata already stored in Orca settings

### Why this is the right split

`auth.json` is the only file we explicitly know needs to vary by account. The rest of the files represent user environment, session continuity, and local Codex behavior. If those are split by account, the switcher does not feel seamless.

## Detailed Design

### Storage layout

Recommended paths:

- Shared runtime home:
  - `~/.codex`
- Per-account auth store:
  - `app.getPath('userData')/codex-accounts/<id>/home/auth.json`

The important part is the separation of concerns, not the exact path choice.

### Ownership and API

The design should introduce a dedicated main-process owner for runtime-home preparation. A representative API shape:

```ts
type PreparedCodexRuntime = {
  homePath: string
  activeAccountId: string | null
}

interface CodexRuntimeHomeService {
  prepareForAccountSwitch(accountId: string | null): PreparedCodexRuntime
  prepareForCodexLaunch(): PreparedCodexRuntime
  prepareForRateLimitFetch(): PreparedCodexRuntime
  prepareForLogin(accountId: string): { loginHomePath: string }
}
```

Why: today path/runtime ownership is fragmented across `CodexAccountService`, PTY spawn env injection, rate-limit fetches, and usage scanning. A single owner prevents those code paths from drifting again.

### Serialization contract

Because `~/.codex/auth.json` is shared mutable state, the runtime-home owner must be the only component allowed to mutate active Codex auth. It must serialize these operations behind one coordination primitive:

- `prepareForAccountSwitch`
- `prepareForCodexLaunch`
- `prepareForRateLimitFetch`
- `prepareForLogin`
- any future reauth or logout helpers

Required contract:

- account switch auth materialization is exclusive
- launch and rate-limit preparation must either observe the auth state from before the switch or the fully committed auth state from after the switch
- they must never observe an in-progress partial write
- login preparation must not mutate the active runtime auth in place

Why: without this contract, PTY launch, quota fetch, and auth swap can still race and intermittently bind work to the wrong account.

### Account switch flow

1. User selects a managed account.
2. Orca validates that account's stored `auth.json`.
3. The runtime-home owner writes the selected `auth.json` into `~/.codex/auth.json`.
4. Orca refreshes Codex rate-limit state using the same prepared runtime home.
5. Orca prompts restart for live Codex panes, marks them stale until restarted, and blocks further Codex execution from those panes.
6. New or restarted Codex panes launch with:
   - `CODEX_HOME=~/.codex`
   - shared config/history/session state
   - selected account auth

Interaction states that must be explicit in product/UI copy:

- **Switch in progress**: selection disabled while auth materialization and rate-limit refresh run.
- **Switch complete, restart required**: existing live Codex panes are stale, must show a restart affordance, and must not be allowed to submit further Codex work until restarted.
- **Switch failed**: active account remains unchanged and stale restart notices are not applied.
- **Switch to system default**: Orca clears managed-account selection and restores the system-default auth snapshot into `~/.codex`.

### System default source of truth

This design treats “System default” as a first-class auth source, not as “whatever happens to be left in `~/.codex/auth.json`.”

Rules:

- On first startup of the new architecture, before any managed-account switch mutates `~/.codex/auth.json`, Orca captures a `system-default` auth snapshot from the current `~/.codex/auth.json` when present.
- That snapshot is stored in Orca-owned storage separately from managed account auth blobs.
- Switching to “System default” restores `~/.codex/auth.json` from that stored snapshot.
- If the user changes external Codex auth outside Orca and wants Orca’s “System default” target to follow it, Orca should expose an explicit refresh/import action or perform refresh only at startup before any managed account takes ownership in the current app session.

Why: without a defined snapshot-and-restore model, switching back to “System default” is nondeterministic and can leave the last managed account active or overwrite the user’s expected external Codex auth.

### New account add flow

1. Orca prepares a temporary login home that inherits the current shared config baseline but does not dirty the active runtime state on failure.
2. Orca runs `codex login` against that temporary login home.
3. Orca captures the resulting `auth.json`.
4. Orca stores only that `auth.json` under the managed account's storage.
5. Orca does not change the active runtime home until the user selects that account or explicitly makes it active on completion.

Why: a failed or aborted login must not poison the currently active `~/.codex` runtime state.

### Legacy managed-home migration

Migration of existing managed-home history and sessions is required, not optional.

Rules:

- On first startup after the new architecture lands, Orca scans legacy managed homes for:
  - `history.jsonl`
  - `sessions/`
- Orca imports legacy history into `~/.codex/history.jsonl` using append/merge semantics that avoid dropping existing shared-home history.
- Orca imports legacy sessions into `~/.codex/sessions/` with an explicit collision policy:
  - import non-conflicting legacy session files directly
  - for conflicting session files, merge turns when Orca can prove the files represent the same logical session with append-only divergence
  - if Orca cannot safely merge a conflicting session file, preserve both copies under deterministic names and emit a diagnostic record rather than silently dropping either side
- Orca records migration completion so the import does not repeat on every startup.

Why: shared history/session continuity is a core goal of the design. Leaving legacy managed-home data unresolved would make the upgrade look like history loss for users who previously used managed accounts.

### Live session behavior

The safe assumption is:

- switching accounts affects new Codex launches
- existing live Codex sessions should still restart
- stale live Codex panes are blocked from further execution until restart completes

If future validation shows Codex hot-reloads `auth.json`, Orca can relax this. The architecture should not rely on hot-reload behavior today.

### Startup and recovery behavior

The design must explicitly cover startup and error handling:

- If `~/.codex` exists but has no `history.jsonl` or `sessions/`, Orca should launch cleanly and let Codex create them lazily.
- If the selected managed account's stored `auth.json` is missing or corrupt, Orca should:
  - log a recoverable warning,
  - fall back to system-default semantics,
  - clear or mark invalid the selected managed account,
  - avoid leaving rate-limit UI bound to the wrong identity.
- If a rate-limit refresh fails after account switch, Orca should keep the account switch result but show quota fetch failure separately rather than rolling back auth materialization implicitly.

## Why `~/.codex` Is The Shared Home

This document explicitly chooses `~/.codex` as the canonical shared runtime home.

Reasons:

- It matches the user's existing Codex mental model inside and outside Orca.
- It avoids split-brain between Orca Codex usage and terminal Codex usage.
- It matches what manual account switching already does today: logout/login mutates the same shared Codex state.

Tradeoff:

- Orca account switching will mutate the same Codex state used outside Orca.

That is acceptable for this product direction. Orca is acting as an automated frontend for the user's existing Codex environment, not a separate Codex silo.

## Migration Plan

### Phase 1: Preserve the config sync patch

Keep the existing `config.toml` sync patch as a tactical fix while the broader migration is in progress.

### Phase 2: Introduce runtime-home owner

- Add a dedicated main-process runtime-home owner/service.
- Route PTY spawning, rate-limit fetches, and login preparation through it.
- Make `~/.codex` the explicit resolved runtime home for those flows.

### Phase 3: Move managed accounts to auth-only semantics

- Update account add/reauth logic to persist only the account's `auth.json`.
- Stop treating per-account homes as full runtime environments.

### Phase 4: Account switch writes auth into shared runtime home

- On select, materialize the chosen account's `auth.json` into `~/.codex`.
- Keep the existing restart notice flow for live Codex panes.

### Phase 5: Cleanup / compatibility

- Run the one-time legacy managed-home migration into `~/.codex`.
- Mark old full-home-per-account storage as legacy.
- Remove code paths that assume managed homes are full `CODEX_HOME`s.

## Risks

### Concurrent mixed-account sessions

This design assumes one selected active account at a time. If Orca ever needs simultaneous live sessions under different accounts, a single shared runtime home with one `auth.json` will not be sufficient.

### Unknown Codex coupling

We know `auth.json` is account-specific. We infer that most other files are environment/user-state and should be shared. If Codex later proves that some sqlite or cache files are also account-coupled, Orca may need to carve out a small additional per-account subset. That is still far simpler than syncing whole homes.

### Mutating the shared runtime home

This design intentionally updates `~/.codex/auth.json`. That means Orca and terminal Codex outside Orca share one Codex world. This is a deliberate product choice, not an accidental side effect.

## Testing Strategy

### Unit tests

- account selection writes the selected `auth.json` into `~/.codex`
- PTY spawn uses `~/.codex` instead of the managed account home
- config/history/session paths resolve from `~/.codex`
- invalid or unreadable account auth does not corrupt the shared runtime home
- startup with missing shared runtime files is repaired gracefully
- rate-limit fetches and PTY launches consume the same runtime-home owner output

### Integration tests

- add account A, launch Codex, verify `~/.codex` gets history
- switch to account B, restart pane, verify history remains available
- verify `config.toml` and permissions do not change across account switches
- verify only `auth.json` differs across account switches

### Manual verification

1. Start a Codex session under account A and create visible history.
2. Switch to account B.
3. Restart the Codex pane.
4. Verify the session uses account B for auth/rate limits.
5. Verify history, sessions, config, memories, and skills remain available.

## Open Questions

- Do `logs_2.sqlite` and `state_5.sqlite` behave correctly when fully shared across account switches? This is the expected design, but should be validated during rollout.
- How should Orca expose refresh of the stored `system-default` auth snapshot when the user logs into Codex outside Orca?

## Recommendation

Adopt **`~/.codex` as the shared runtime `CODEX_HOME`, plus per-account `auth.json` only**, and implement it through a dedicated runtime-home owner in the main process.

This is the simplest design that:

- matches the intended account-switching UX,
- avoids fragile replication logic,
- works cross-platform,
- and leaves room to adopt upstream Codex auth-profile support later if it becomes available.
