# Design Review Context

## Document Info
- Path: docs/mobile-ui-spec.md
- Type: Technical/Product Design Plan
- Review started: 2026-04-28

## Design Direction
- Direction confirmed: confirmed
- Chosen approach: Attention-first mobile companion using Orca desktop visual language, with faithful terminal mirror inside session views for PTY-backed agent control/recovery.
- Alternatives considered: Pure terminal-first mirror (too high cognitive load as default); new agent-centric control plane (better long-term but 2-3x scope); phone-sized terminal/reflow mode (risks disrupting desktop TUI state).
- Key UX decisions: Worktree list should prioritize unread/active/recent work; session view remains terminal-first; terminal mirror is renderer-coupled MVP behavior with degraded fallback; terminal accessory keys are first-class controls.

## Iteration State
Current iteration: 2
Last completed phase: Iteration 2 adversarial review clean for P0/P1

## Addressed Issues (Do Not Re-report)
<!-- Issues that were fixed in the design doc. Reviewers should not re-report these. -->
<!-- Format: [iteration] | [severity] | [category] | [issue summary] | [how addressed] -->

Iteration 0.5 | P1 | Product direction | Terminal-first alone underweights the attention journey | Reframed plan as attention-first at host/worktree level and terminal-first inside sessions
Iteration 0.5 | P1 | Architecture | Faithful mirror depends on renderer snapshot/focus | Documented renderer-coupled MVP constraint, degraded behavior, and long-term daemon-owned screen model option
Iteration 0.5 | P1 | UX side effect | Mobile terminal.focus can activate desktop terminal unexpectedly | Documented as MVP behavior and added checklist item to make side effect explicit
Iteration 0.5 | P2 | UX states | Missing input/degraded/disconnected state coverage | Added not-writable, send failed, degraded mirror, disconnected draft preservation, and reconnect behaviors
Iteration 0.5 | P2 | Runtime | CDN-loaded xterm assets are brittle for local/offline companion use | Added production checklist item to bundle terminal assets locally
Iteration 0.5 | P1 | Runtime cleanup | Subscription ownership may collide/leak across clients | Added subscription ownership section and validation checklist
Iteration 1 | P1 | State model | Auth failure was mixed with transient disconnect/reconnect | Split auth failed into separate state/flow; checklist requires unauthorized mapping, read-only stale content, and re-pair/remove-host actions
Iteration 1 | P1 | Data contract | Attention-first ordering was not anchored to actual `worktree.ps` behavior | Defined MVP client-side sort order using available fields and added verification for unread-before-recent ordering
Iteration 1 | P2 | Terminal fit | Initial fit lacked concrete measurement algorithm | Added measured xterm surface fit algorithm and checklist coverage for 80/150/200+ column terminals
Iteration 1 | P2 | Empty state | No-terminal session path was ambiguous despite `terminal.create` support | Made create-terminal action required for empty sessions and added checklist verification

## Skipped Issues (Accepted Risks)
<!-- Issues reviewed but deemed acceptable for this context. Do not re-report. -->
<!-- Format: [iteration] | [severity] | [category] | [reason skipped] | [issue summary] -->
<!-- NOTE: Only P2/P3 issues may be skipped. P0/P1 must always be addressed. -->

[Initially empty - populated during triage phase]

## Invalidated Findings (Do Not Re-report)
<!-- Findings that were challenged and determined to be false positives or noise. -->
<!-- Reviewers in future iterations must NOT resurface these. -->
<!-- Format: [iteration] | [original severity] | [finding summary] | [reason invalidated] -->

[Initially empty - populated after each validation phase]

## Findings History
<!-- Running log of findings across iterations for convergence tracking -->

Iteration 0.5 challenge:
- P1: Terminal-first alone is wrong primary mobile product direction; keep terminal fidelity but make default journey attention-first.
- P1: Faithful desktop terminal mirror is renderer-coupled MVP behavior, not stable long-term runtime capability.
- P1: terminal.focus before subscribe can change desktop state and must be documented or replaced later.
- P2: Terminal mirror readability needs fit/zoom/degraded state coverage.
- P2: Input states need pending/failed/not-writable/disconnected coverage.
- P2: Bundle xterm assets before release.

Iteration 1 adversarial review:
- P1: Auth failed state conflicted with reconnect/disconnect handling.
- P1: Attention-first ordering depended on data ordering that `worktree.ps` does not currently provide.
- P2: Initial terminal fit did not define measurement or scale behavior precisely enough.
- P2: No-terminal session behavior was incomplete even though `terminal.create` exists.

Iteration 2 adversarial review:
- No P0/P1 findings after updates to auth failure, attention ordering, measured terminal fit, and empty-terminal creation flow.
