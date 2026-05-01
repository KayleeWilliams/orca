# Design: Fix persistent-terminal cursor landing below TUI after restart

**Branch:** `Jinwoo-H/cursor-bug`
**Author:** Jinwoo Hong
**Status:** Draft

## Problem

When Orca restarts with an alt-screen TUI running in a persistent terminal (most commonly Claude Code, but the same class also covers vim, lazygit, htop, btop, k9s, etc.), the terminal repaints correctly but the xterm visible cursor lands on a blank row **below** the TUI's rendered UI — outside the Claude input box, beneath the "bypass permissions on" status line. Typing still delivers to the TUI because keyboard input flows to the PTY (which is unaffected), so the bug is purely a visual desync of the rendered cursor cell.

Screenshot: cursor is one or two rows below where Claude's input prompt expects it; first keystroke appears in the correct place and the cursor snaps back.

## Architecture: two restore paths

There are two code paths that can write into the xterm instance after a restart. They run in sequence, and most restart cases go through both:

```
                    ┌────────────────────────────────────┐
                    │  renderer: hydrate from disk       │
                    │  savedBuffers (SerializeAddon out) │
                    └────────────────┬───────────────────┘
                                     │
                      Path A (local pre-paint)
                                     │
                                     ▼
          ┌──────────────────────────────────────────────┐
          │ layout-serialization.ts                      │
          │   restoreScrollbackBuffers(...)              │
          │     replayIntoTerminal(buf)                  │
          │     replayIntoTerminal(POST_REPLAY_MODE_...) │
          └──────────────────────────┬───────────────────┘
                                     │
                                     │   xterm now shows last-known frame
                                     │   (this is the "pre-paint")
                                     │
                      Path B (daemon / SSH authoritative)
                                     │
                                     ▼
          ┌──────────────────────────────────────────────┐
          │ pty-connection.ts                            │
          │   handleReattachResult(connectResult)        │
          │     if coldRestore → clear + write + reset   │
          │     if snapshot    → clear + write + reset   │
          │     if replay      → write                   │
          │     else           → (no write; rely on A)   │
          └──────────────────────────────────────────────┘
```

Path A runs first from disk-serialized state and is meant to give the user something to look at with no latency. Path B runs when the reattach async resolves and is authoritative when it has data. The bug is that Path A was mutating cursor state in a way that survived into the one case where Path B does not overwrite it (the `else` branch above) — and, even when Path B does overwrite, there was a window where the wrong cursor was visible.

## Root cause

Two cooperating bugs in `src/renderer/src/components/terminal-pane/layout-serialization.ts#restoreScrollbackBuffers` (lines 236–284), combined with a restoration pipeline that pre-paints before the authoritative live snapshot arrives.

### Bug 1 — alt-screen trim amputates the cursor-positioning tail

`SerializeAddon.serialize()` (xterm addon source) emits, in order:
1. Normal-buffer rows, ending with a relative-cursor-move tail positioning xterm's cursor at the normal-buffer's captured `(cursorX, cursorY)`.
2. If alt buffer was active at capture: `\x1b[?1049h\x1b[H`, then alt-buffer rows, then a relative-cursor-move tail for the alt-buffer's captured `(cursorX, cursorY)`.
3. Mode bits from `_serializeModes` (`?1h / ?66h / ?2004h / ?1004h / ?25l` etc.).
4. Scroll region (DECSTBM) if non-default.

Per `@xterm/addon-serialize/src/SerializeAddon.ts:593-618` and `_serializeString:441-466`, the cursor-move tail is emitted INSIDE `_serializeString` PER BUFFER (so at the end of normal-buffer content AND at the end of alt-buffer content), and mode bits + scroll region are concatenated AFTER both buffer serializations in `serialize()`.

The alt-screen trim slices at `lastIndexOf('\x1b[?1049h')` — discarding in one cut: the alt-buffer content, the alt-buffer's cursor tail, the mode bits, and the scroll region.

`restoreScrollbackBuffers` has this heuristic for TUIs that were mid-run at shutdown:

```ts
// layout-serialization.ts:260-264
const lastOn  = buf.lastIndexOf('\x1b[?1049h')
const lastOff = buf.lastIndexOf('\x1b[?1049l')
if (lastOn > lastOff) {
  buf = buf.slice(0, lastOn)    // discards alt-screen section
}
```

The stated intent is "if the buffer ends in alt-screen mode, exit alt-screen so the user sees a usable terminal." But the slice happens *before* the reattach path writes anything, and it throws away:

- The alt-buffer contents (Claude's rendered UI)
- The trailing mode bits
- **The cursor-positioning escapes**

After the trim, `buf` now ends wherever the main-screen scrollback ended — typically the blank row below the previous prompt. That is literally the "one row below" the user sees in the screenshot.

### Bug 2 — unconditional `\r\n` pushes the cursor one more line down

```ts
// layout-serialization.ts:272-274
replayIntoTerminal(pane, replayingPanesRef, buf)
replayIntoTerminal(pane, replayingPanesRef, '\r\n')   // "PROMPT_EOL_MARK protection"
```

The comment cites zsh's `PROMPT_EOL_MARK` (`%` indicator when a line has no trailing newline). That concern only applies when a **fresh shell is about to print a new prompt** — i.e. true cold spawn. In every reattach path in `pty-connection.ts` (`coldRestore`, `snapshot`, `replay`), the branch already issues `\x1b[2J\x1b[3J\x1b[H` *before* writing its authoritative content, which erases any PROMPT_EOL concern. So the `\r\n` protects against a case that no live code path hits, and in the bug scenario it adds a second row of cursor drift on top of Bug 1.

### Why the downstream snapshot write doesn't fix it

In `pty-connection.ts:583-592` the `snapshot` branch (daemon live-session reattach) does:

```ts
replayIntoTerminal(pane, …, '\x1b[2J\x1b[3J\x1b[H')        // clear
replayIntoTerminal(pane, …, connectResult.snapshot)         // authoritative state
replayIntoTerminal(pane, …, POST_REPLAY_FOCUS_REPORTING_RESET)  // \e[?25h\e[?1004l — no cursor move
…
window.api.pty.signal(ptyId, 'SIGWINCH')                    // prompt TUI to repaint
```

This *would* re-place the cursor if `connectResult.snapshot` contained explicit cursor-positioning bytes or if the TUI's SIGWINCH-triggered repaint emitted an absolute `CSI H`. The daemon snapshot is captured from the headless emulator (`src/main/daemon/headless-emulator.ts`) which uses the same SerializeAddon, so it *does* emit the same relative-move tail — but by the time this path writes, xterm's cursor is already sitting at the wrong row thanks to Bugs 1+2, and SerializeAddon's `_serializeString` computes moves **relative to its own last-written cell**, not relative to xterm's current cursor. After the `\x1b[2J\x1b[3J\x1b[H` clear the cursor is at (0,0); SerializeAddon's snapshot writes content and then moves to its captured `(cursorX, cursorY)` — which should land correctly.

That means the snapshot path *does* correct the cursor if it runs. But there are cases where it doesn't run or is racy:

1. **No daemon snapshot available** — the connect returns neither `snapshot` nor `coldRestore` nor `replay` (fresh reattach, daemon scrollback not yet populated). In this case Bugs 1+2 are the only cursor writes, and they land below the UI. SIGWINCH triggers Claude's repaint, which paints content into the (now-wrong) alt screen state, but Claude's repaint does not emit an absolute cursor move — it typically restores cursor via DECRC or leaves it wherever its last render put it.
2. **The alt-screen trim in Bug 1 discarded `\x1b[?1049h`** — so when the snapshot path later writes its alt-screen content, xterm is still in normal-screen mode because we never re-entered alt. The daemon snapshot *does* include a leading `\x1b[?1049h\x1b[H` (SerializeAddon adds it when the alt buffer is serialized), so this is self-healing. Verified by reading the addon source.

The dominant failure mode is (1): persistent terminal with a live process, but the daemon snapshot path doesn't run (because the daemon already gave the renderer all it had via pty attach) or the replay path writes something that ends with the cursor relative-moved to a location that intersects a still-stale xterm cursor position. Either way, the bug originates in `restoreScrollbackBuffers`; cleaning that up removes the source of the drift.

## Fix

**Make `restoreScrollbackBuffers` idempotent with the reattach path and stop clobbering cursor state.**

Two principles:

1. The serialized xterm buffer from disk is a **pre-paint** for perceived latency. It should match what the reattach path will overwrite, not fight it.
2. Whenever a live daemon session is about to supply an authoritative snapshot, skip the local pre-paint entirely. The daemon snapshot is always at least as fresh and uses the same SerializeAddon format.

### Changes

#### A. `layout-serialization.ts#restoreScrollbackBuffers` — remove unsafe manipulations

- **Remove the alt-screen trim** (lines 258–264). Writing the full SerializeAddon output, including `\x1b[?1049h` and the alt-screen body, is correct: when xterm replays the snapshot the TUI's rendered frame is visible. If the TUI process is truly dead (process exited between capture and restore), the downstream coldRestore branch in `pty-connection.ts:557-582` will clear and replace anyway — the trim never added safety, only corruption.
- **Remove the `\r\n` nudge** (lines 272–274). PROMPT_EOL_MARK only matters for cold-spawn of a fresh interactive shell; no current reattach path in `pty-connection.ts` relies on this. For cold-spawn, the new prompt is printed *after* this function returns, and zsh's `PROMPT_EOL_MARK` will correctly detect the prior buffer's trailing state.
- **Keep** `POST_REPLAY_MODE_RESET` — it's the mode-sanitization for crashed TUIs and is still needed.
- **Replace the existing block comment at `layout-serialization.ts:229-235`** (which describes the old alt-trim behavior being removed) with a new contract comment above `restoreScrollbackBuffers` that codifies the invariant a future maintainer needs to know. The new comment REPLACES the old one; it does not sit alongside it — leaving both would leave the file self-contradicting. The new comment must explicitly forbid BOTH stripping (Bug 1) AND appending (Bug 2) to the SerializeAddon output. Suggested wording:

  > The serialized buffer from disk is a PRE-PAINT. It is the SerializeAddon output verbatim, including mode bits, the `\x1b[?1049h` alt-screen marker (when captured in alt mode), and the trailing relative-cursor-move tail that positions the cursor at capture time. Write it through `replayIntoTerminal` exactly as-is, followed only by `POST_REPLAY_MODE_RESET`.
  >
  > Do not strip escape sequences from this buffer (the alt-screen trim that used to live here discarded the cursor tail — Bug 1). Do not append synthetic bytes like `\r\n` (the PROMPT_EOL_MARK nudge that used to live here pushed the cursor an extra row down — Bug 2).
  >
  > The reattach path in `pty-connection.ts` is authoritative when it has data and will overwrite this pre-paint; when it doesn't, the verbatim replay is what the user sees.

  This is the comment that would have prevented the original bug, and it's the one piece of new text that must land with this change regardless of everything else.

Net diff shape:

```ts
export function restoreScrollbackBuffers(manager, savedBuffers, restoredPaneByLeafId, replayingPanesRef) {
  if (!savedBuffers) return
  for (const [oldLeafId, buffer] of Object.entries(savedBuffers)) {
    const newPaneId = restoredPaneByLeafId.get(oldLeafId)
    if (newPaneId == null || !buffer) continue
    const pane = manager.getPanes().find(p => p.id === newPaneId)
    if (!pane) continue
    try {
      replayIntoTerminal(pane, replayingPanesRef, buffer)
      replayIntoTerminal(pane, replayingPanesRef, POST_REPLAY_MODE_RESET)
    } catch { /* ignore per-pane */ }
  }
}
```

#### B. `pty-connection.ts` — redundant pre-paint suppression

When the reattach yields `snapshot` (daemon live session) we already do `\x1b[2J\x1b[3J\x1b[H` + authoritative write at lines 587–592. That clears the xterm screen, so the pre-paint from `restoreScrollbackBuffers` was going to be wiped regardless. No change needed here beyond what A delivers — once A stops corrupting cursor state, the snapshot path is already cursor-correct on its own.

For `coldRestore` (lines 557–582) we currently do clear + write + mode reset. The xterm pre-paint from A is overwritten by the clear, so behavior is preserved.

For **no-reattach-result** (fresh spawn, no daemon state), the pre-paint from A is now the only content visible until the shell emits a prompt. That's the right fallback: user sees their last terminal view (correctly, with cursor in place) while the new shell starts. No change needed.

#### C. Test: reproducing the cursor drift

Add to `src/renderer/src/components/terminal-pane/layout-serialization.test.ts` (create if absent):

- Given a buffer captured while alt-screen is active with cursor at (col=15, row=3):
  - **Before fix:** after `restoreScrollbackBuffers`, xterm's `buffer.active.cursorX/Y` differs from (15, 3) by the alt-trim + `\r\n` delta.
  - **After fix:** `cursorX === 15 && cursorY === 3` exactly.
- Given a normal-screen buffer with cursor at end-of-line:
  - After fix, no spurious newline appended; cursor position matches capture-time cursor.

Use `@xterm/headless` for the test terminal (already used in `src/main/daemon/headless-emulator.ts`) so we can assert on `buffer.active.cursorY/X` without DOM. The existing `layout-serialization.test.ts` is pure-logic (mocks `HTMLElement`, never uses xterm) — these new tests must drive a real terminal end-to-end so the bug (which lives in xterm's parsed cursor state) is observable. Scaffolding, following the working pattern in `src/main/daemon/headless-emulator.ts:49-57`:

- Instantiate two `@xterm/headless` `Terminal` instances — one for capture, one for restore — and load `SerializeAddon` on each.
- Build a minimal `ManagedPane`-shaped stub: `{ id: 1, terminal }` where `terminal` is the real headless `Terminal`.
- Build a fake `PaneManager` exposing only `getPanes(): ManagedPane[]` returning `[stub]`.
- `replayingPanesRef` is a plain `{ current: new Map<number, number>() }`.
- Assertions are on `terminal.buffer.active.cursorX/Y` and `terminal.buffer.active.type === 'alternate'` where applicable — NOT on what bytes went through `replayIntoTerminal`. The whole point is to verify xterm's internal cursor state after parsing, because that's where the bug lives.

## Behavior matrix

The renderer's restart flow runs Path A (`restoreScrollbackBuffers`) unconditionally, then Path B (`handleReattachResult`) based on what the daemon/SSH return. There are four cases; the table below shows the observable cursor state before and after this fix.

| # | Case | Path B branch | Pre-fix cursor | Post-fix cursor |
|---|------|---------------|----------------|-----------------|
| 1 | Daemon live reattach with snapshot (happy path) | `snapshot` → clear + write + mode reset | Correct eventually, but wrong for ~1 frame of pre-paint (alt-trim + `\r\n` drift briefly visible) | Correct immediately; pre-paint matches what snapshot will re-assert |
| 2 | Daemon cold restore (process exited while Orca was closed) | `coldRestore` → clear + write + mode reset | Wrong pre-paint, then clear+write overwrites — cursor ends correct | Correct; no behavior change for this case, pre-paint just matches sooner |
| 3 | Reattach returns no snapshot / coldRestore / replay (fresh attach, daemon scrollback empty) | `else` (no write) | **Bug lands here.** Path A's alt-trim + `\r\n` is the only cursor write; xterm cursor sits one or two rows below TUI rendering | Correct; Path A now faithfully replays SerializeAddon's relative-move tail |
| 4 | Reattach errors out (daemon unavailable, connect fails) | Error path, no authoritative write | Bug also lands here, same as case 3 | Correct pre-paint survives until user intervention |

Cases 3 and 4 are where the principal failure mode lived; case 1 was the cosmetic flash the user perceived as "cursor appears wrong then moves."

## Risk analysis

| Risk | Likelihood | Mitigation | Contingent mitigation |
|------|-----------|------------|-----------------------|
| Removing alt-screen trim leaves restored terminal stuck in alt mode when TUI has died | Low — the serialized buffer ends with SerializeAddon's mode bits, which may include `?1049h`. If the TUI died mid-render, on cold restart the reattach branch clears with `\x1b[2J\x1b[3J\x1b[H` which exits alt mode. | If we see stuck-in-alt symptoms in QA, add `\x1b[?1049l` to `POST_REPLAY_MODE_RESET` for cold-restore only (via a second constant, as is already done for `POST_REPLAY_FOCUS_REPORTING_RESET` vs `POST_REPLAY_MODE_RESET`). | — |
| Removing `\r\n` breaks zsh PROMPT_EOL_MARK on fresh cold spawn | Very low — zsh runs after `restoreScrollbackBuffers` returns and is responsible for emitting its own leading newline when needed. The `\r\n` was a speculative cross-shell safety net that isn't load-bearing. | Manually verify cold-restart with zsh and non-newline-terminated scrollback. The new PROMPT_EOL cold-spawn unit test (see Verification → Automated) is the gate: if it fails in practice, we flip to the contingent mitigation. | Restore the `\r\n` **conditionally**: only when the buffer's final cell is not `\n` **and** alt-screen was not active at capture. Implementation: inspect last non-escape byte of `buf` (trim trailing ESC-sequences) and check for the presence of an unpaired `\x1b[?1049h`. Emit `\r\n` only if both conditions hold. This preserves the PROMPT_EOL protection for bare-shell cold-spawn without corrupting alt-screen cursor state. |
| Bash (and other non-zsh shells) cold-spawn with non-newline-terminated prior output will now render the new prompt adjacent to the last character instead of on a fresh line | Low — only visible in the narrow case where the user's last output before shutdown did not end in `\n` **and** the shell is bash/sh/fish (not zsh). zsh's `PROMPT_EOL_MARK` handles this correctly by printing a `%` on its own line; bash has no equivalent and will simply print `user@host:~$ ` immediately after the trailing character. | Documented behavior, not a regression in terminal semantics. The prior `\r\n` was masking this by always inserting a line break; removing it exposes the actual shell behavior, which matches what the user would see if they had quit the shell cleanly and restarted it in a fresh terminal. | If we get user reports, we can gate the `\r\n` on detecting a non-zsh shell (via `process.env.SHELL` at spawn), but this is unlikely to be worth the complexity. |
| SerializeAddon's relative cursor moves overshoot when the replay lands in a terminal with different rows than capture | Medium — FitAddon runs after restore via `queueResizeAll(isActive)` in `use-terminal-pane-lifecycle.ts:789`. | This is orthogonal to the fix: the relative moves are computed during serialization when rows were known, and xterm clamps CUP to viewport. We rely on the same behavior the daemon snapshot path already depends on. | — |
| Alt-screen content previously hidden (via the trim) will now be visible on restore for one frame before reattach clears | Low — it *should* be visible; that's what the user was looking at. The "flash of prior TUI before Claude repaints" is a feature, not a bug. | None. | — |

## Verification plan

### Automated

- Unit test per C above (cursor-drift reproduction with alt-screen buffer).
- **PROMPT_EOL cold-spawn guard test.** In the same `layout-serialization.test.ts`:
  - Capture a buffer from a `@xterm/headless` terminal whose final written cell is **not** `\n` (e.g. write `"echo hi"` with no trailing newline, then `serialize()`).
  - Call `restoreScrollbackBuffers` into a fresh `@xterm/headless` terminal.
  - Assert that the restored terminal's last non-empty row ends with `"echo hi"` and **no spurious newline has been appended** — i.e. `buffer.active.cursorY` equals the row containing `"echo hi"`, not the row below it. Equivalently: assert the terminal did not emit a row-break between the serialized content and the cursor.
  - Belt-and-suspenders: also assert the row at `cursorY + 1` is empty (e.g. `terminal.buffer.active.getLine(cursorY + 1)?.translateToString().trim() === ''`). Closes an edge case where a future conditional `\r\n` could otherwise slip through the primary assertion.
  - This is the concrete gate for the "removing `\r\n` is safe" claim. If it fails in any shell/terminal-size permutation we care about, we fall back to the contingent mitigation in the Risk table (conditional `\r\n` based on final-cell + alt-screen inspection).
- Existing `src/renderer/src/store/slices/terminals-hydration.test.ts` coverage for hydration remains green.
- Existing `src/renderer/src/components/terminal-pane/pty-connection.test.ts` assertions on `POST_REPLAY_MODE_RESET` and `POST_REPLAY_FOCUS_REPORTING_RESET` sequencing remain green (we're not touching pty-connection).

### Manual

1. Open Orca, start Claude Code in a persistent terminal, let it sit at the input box.
2. Quit Orca fully.
3. Reopen Orca and switch to that tab **without typing first**.
4. Observe: cursor should blink **inside** the Claude input box (to the right of the `>` or leading whitespace), not one or two rows below. The "bypass permissions on (shift+tab to cycle)" status line should be directly above the cursor, and no phantom blank row between them.
5. Repeat with vim mid-edit, lazygit with a dialog open, and htop. In all cases the cursor should match where it was at capture.
6. Cold-spawn case: open a new persistent terminal, type `echo hi` (no trailing newline, leave cursor mid-line). Quit, restart. The terminal's scrollback should show `echo hi` with the cursor after the `i`, and the new prompt should appear on the following line without a `%` indicator from zsh PROMPT_EOL_MARK.

## Out of scope

- Daemon snapshot capture cadence (`src/main/daemon/headless-emulator.ts`)
- SSH replay buffer semantics (separate path, unaffected)
- `queueResizeAll` / FitAddon interaction (separate known-good path; cursor is preserved across fit because xterm's CUP state is maintained by buffer coordinates, not screen coordinates)

## Follow-ups (separate PRs)

These came up during Phase 0.5 review. They are deliberately excluded from this change because they are scope-creep on a bug fix, not because they are low-value.

- **Alternative B: skip Path A pre-paint entirely when a daemon reattach is expected.** The cleanest long-term shape is to let the daemon snapshot be the only writer when it's known to be coming, so we never pay for a pre-paint that's about to be clobbered by a clear+write. Not included here because it's a perceived-latency change (we're trading a frame of stale-but-close UI for a frame of blank terminal) and needs measurement — ideally a before/after on time-to-first-correct-paint under cold daemon attach. Tracked separately.

- **Observability: log the "Path B made no authoritative write" case.** Currently `handleReattachResult` in `pty-connection.ts:593-606` has an `else` branch where none of `coldRestore` / `snapshot` / `replay` was provided and the code silently falls through, relying on whatever Path A left behind. That's exactly the case where the original bug was load-bearing and invisible. Add a single diagnostic log line at that branch:

  ```ts
  // pty-connection.ts, in handleReattachResult's fall-through else
  log.debug('[pty-connection] reattach produced no coldRestore/snapshot/replay; relying on pre-paint from restoreScrollbackBuffers', { ptyId })
  ```

  Cheap to add, makes the "case 3" row of the behavior matrix visible in logs next time it misbehaves. Author's call whether to land in this PR or defer — leaning defer to keep the diff surgical, but calling it out here so it doesn't get lost.

## References

- `src/renderer/src/components/terminal-pane/layout-serialization.ts:236-284` — `restoreScrollbackBuffers`
- `src/renderer/src/components/terminal-pane/pty-connection.ts:557-618` — reattach branches + SIGWINCH
- `src/renderer/src/components/terminal-pane/TerminalPane.tsx:740-808` — shutdown capture (unchanged)
- `@xterm/addon-serialize@0.15.0-beta.198` — `SerializeAddon._serializeString` for cursor-tail semantics
