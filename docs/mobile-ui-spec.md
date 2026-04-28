# Orca Mobile UI Design Plan

## Purpose

Orca Mobile is a companion surface for staying connected to running coding agents from a phone. The current React Native UI is functional but placeholder. This plan defines the production design direction for the mobile app: visually consistent with Orca desktop, attention-first at the host/worktree level, terminal-first inside sessions where recovery/control matters, and optimized for quick remote agent control rather than full mobile IDE work.

## Product Positioning

The mobile app should feel like a compact Orca desktop panel on a phone:

- Quiet, dark, and utilitarian.
- Dense enough for repeated operational use.
- Minimal enough that agent state, blocked work, and terminal output remain the focus.
- Native enough for phone ergonomics, without drifting into generic mobile-app styling.

The app is not a mobile IDE and should not try to replace desktop Orca. It supports monitoring, quick follow-up instructions, approvals, terminal recovery, and lightweight control of running sessions. The default journey should answer "what needs my attention?" before asking the user to inspect a full terminal.

## Design Principles

1. **Desktop Orca, Compressed**
   Use the desktop app's graphite/black language, subdued borders, muted metadata, and restrained blue accents. Avoid saturated navy/purple surfaces, large rounded cards, decorative gradients, and marketing-style empty states.

2. **Attention First, Terminal When Needed**
   Host and worktree screens prioritize blocked/active/unread work. Session views remain terminal-first because the current Orca agent control plane is still PTY-backed and the terminal is the only truthful recovery surface.

3. **Information-Dense Rows**
   Host and worktree screens should use compact rows, not large cards. Users are scanning active work, not browsing a content feed.

4. **Explicit Terminal Controls**
   Phone keyboards cannot reliably send terminal control keys. Terminal-specific keys need first-class UI controls.

5. **Faithful Desktop Terminal Mirror**
   Mobile terminal output mirrors the desktop xterm screen state and geometry. It should not reflow terminal/TUI output to phone width. Users can pan and zoom when the desktop terminal is wider than the phone.

6. **Voice Later, Text Now**
   Voice dictation is expected to become the primary input path later. The current design must not block that, but the MVP should keep text input and terminal controls polished.

7. **MVP Renderer Coupling Is Explicit**
   The faithful terminal mirror currently depends on the Electron renderer's xterm instance for serialized screen state. That is acceptable for this phase, but it must be treated as an explicit MVP constraint with clear degraded behavior, not as a long-term daemon-owned screen model.

## Visual Language

### Palette

Use a small theme module for mobile tokens. Names are illustrative; final values should match desktop Orca as closely as React Native allows.

| Token | Use |
| --- | --- |
| `bgBase` | App background, near black |
| `bgPanel` | Headers, input bars, row containers |
| `bgRaised` | Pressed/selected row surface |
| `borderSubtle` | Row separators and panel borders |
| `textPrimary` | Main labels |
| `textSecondary` | Branches, endpoint, timestamps |
| `textMuted` | Disabled and placeholder text |
| `accentBlue` | Active tab underline, primary focus/action |
| `statusGreen` | Connected/healthy status dot |
| `statusAmber` | Attention/pending state |
| `statusRed` | Disconnected/error state |

Avoid one-off colors in screen files. Avoid bright blue as a broad background. Blue should be a precise accent.

### Shape And Spacing

- Rows: 6-8px radius maximum, or flat separators where density matters.
- Buttons: compact, predictable heights, icon/text only when the command is clear.
- Tabs: underline or subtle active background, not large pill navigation.
- Borders: low contrast, 1px, used to separate function rather than decorate.
- Empty states: plain text and one action, no large illustrations.

### Typography

- Use compact, tool-like sizing.
- Primary row labels should be scannable but not oversized.
- Metadata should be smaller and muted.
- Terminal output remains monospace inside the WebView.
- Do not show raw route names such as `h/[hostId]/session/[worktreeId]`.

## Navigation Structure

```
Home / Hosts
  └─ Host / Worktrees
       └─ Session / Terminals
            ├─ Terminal tabs
            ├─ Terminal viewport
            └─ Accessory keys + input bar
```

The app should keep the hierarchy shallow. The back button should always move one level up. Re-pairing and host management can live from the host list screen until a fuller settings surface exists.

## Screen Specifications

### Home / Hosts

Purpose: choose a paired desktop host or pair a new one.

Layout:

- Compact header: `Orca` plus a small add/pair action.
- Host list as dense rows:
  - Host/device name.
  - Endpoint.
  - Last connected timestamp.
  - Connection status when known.
- Empty state: "No paired hosts" and one pair action.

States:

| State | Behavior |
| --- | --- |
| Empty | Shows pair CTA and short explanatory text |
| Hosts available | Shows compact rows |
| Stale host | Row remains visible with muted last-seen metadata |
| Pair failed | Inline/toast error with retry path |

### Host / Worktrees

Purpose: scan active work, identify what needs attention, and enter a session.

Layout:

- Header shows host name and connection state.
- Worktrees as compact rows:
  - Repo/worktree display name.
  - Branch.
  - Agent/terminal preview.
  - Terminal count.
  - Unread/activity indicator.
- Rows should be sorted to favor work needing attention:
  - Unread/blocked/active terminals first where the data is available.
  - Recent output next.
  - Inactive work last.
- Refresh/reconnect should be available but not visually dominant.

MVP ordering is client-side because `worktree.ps` currently sorts by recent output, terminal count, and path. Mobile should sort returned rows as:

1. Unread/attention rows first.
2. Active/live terminals next when exposed by the existing response.
3. Newest `lastOutputAt`.
4. Higher terminal count.
5. Stable repo/worktree name.

If blocked/agent state is unavailable, do not invent it in UI. Use unread/recent-output ordering and keep the missing signal visible as an implementation limitation.

States:

| State | Behavior |
| --- | --- |
| Connecting | Header status and lightweight row skeletons |
| Connected empty | Plain empty message |
| Disconnected | Preserve last-known rows if available, show reconnect state |
| Auth failed | Preserve stale rows as read-only, stop reconnect churn, and show re-pair/remove-host actions |

MVP data remains existing RPC output (`worktree.ps`, `terminal.list`, previews, unread state). Do not add a new agent protocol for this UI pass. If agent/blocked state is not available, fall back to unread/recent-output ordering and make the limitation visible in the implementation checklist.

### Session / Terminals

Purpose: monitor and control a running terminal/agent session.

Layout:

- Compact header: worktree/session title and connection dot.
- Terminal tabs: horizontal compact strip, active underline.
- Terminal viewport: fills remaining space above input/accessory controls.
- Input area:
  - Terminal accessory key row.
  - Text field.
  - Send button.

The terminal viewport must be clipped above the input area. No terminal content should be hidden behind the input bar.

States:

| State | Behavior |
| --- | --- |
| No terminals | Offer create terminal action that calls `terminal.create`, then subscribe to the created handle |
| Subscribing | Keep chrome stable; show terminal background |
| Streaming | Render serialized xterm snapshot + live chunks |
| Disconnected | Preserve visible terminal content and show reconnect status |
| Auth failed | Preserve visible terminal content as read-only and show re-pair/remove-host actions; do not keep retrying |
| Reconnected | Resubscribe and restore current terminal |
| Degraded mirror | Show compact debug/status affordance when serialized screen or dimensions are missing |
| Not writable | Keep output visible, disable Send/accessory keys, explain terminal is not writable |
| Send failed | Preserve drafted text and show retry/error state |

## Terminal Viewport Design

The terminal view mirrors desktop xterm in MVP through the desktop renderer:

1. Desktop renderer serializes xterm screen state and dimensions.
2. Mobile xterm initializes at the same `cols`/`rows`.
3. Mobile writes serialized buffer first.
4. Live chunks append after initialization.
5. CSS/WebView scale fits desktop width into the phone viewport initially.

This is intentionally renderer-coupled for Phase 0/1 because desktop xterm is the only component that already has faithful screen state. Long term, a daemon-owned terminal screen model could remove the need to focus the desktop renderer before subscribing. That is out of scope for the UI polish pass.

Interaction requirements:

- Vertical scroll.
- Horizontal pan when zoomed or when content exceeds viewport.
- Pinch zoom for readability.
- Initial scale fits full desktop width using measured xterm dimensions rather than a fixed viewport scale.
- Switching tabs clears stale content before the new terminal initializes.
- Mobile focuses the desktop terminal before subscribing so hidden/new panes can fit and register their serializer.

Initial fit algorithm:

1. Set WebView viewport `initial-scale=1`.
2. Initialize xterm at the desktop `cols`/`rows` before writing scrollback.
3. After xterm opens, measure the rendered terminal surface in CSS pixels.
4. Compute `fitScale = min(1, viewportWidth / terminalSurfaceWidth)`.
5. Apply `transform: scale(fitScale)` to the terminal surface wrapper with `transform-origin: top left`.
6. Size the scroll container to the scaled terminal width/height so vertical scroll and horizontal pan remain accurate.
7. Recompute after terminal init, tab switch, and orientation/viewport changes.

Do not use a hard-coded `initial-scale` such as `0.5`; it will fit some terminal widths and corrupt others.

Failure behavior:

- If serialized buffer is unavailable, still initialize mobile xterm using tracked PTY dimensions.
- If dimensions are unavailable, fall back to `80x24` but mark this as degraded in debug logs/test tooling.
- If desktop focus is needed to produce a good snapshot, mobile may activate the desktop terminal as an MVP behavior. This should be documented in release notes and revisited if it proves disruptive.
- Do not attempt to reflow TUI output to phone width.

Asset behavior:

- The current WebView prototype may load xterm from a CDN during development.
- Production mobile builds should bundle xterm assets locally so local-network/offline companion use does not depend on jsdelivr.

## Terminal Input Design

The text input remains line-oriented:

- User types a command/message.
- Send submits text plus Enter via `terminal.send`.
- Return key behaves like Send.
- If disconnected or terminal is not writable, preserve drafted text and disable Send rather than dropping input.

Add an accessory key row for terminal control keys that phone keyboards cannot express reliably.

MVP keys:

| Control | Bytes | User-facing label |
| --- | --- | --- |
| Escape | `\x1b` | `Esc` |
| Tab | `\t` | `Tab` |
| Up | `\x1b[A` | `↑` |
| Down | `\x1b[B` | `↓` |
| Left | `\x1b[D` | `←` |
| Right | `\x1b[C` | `→` |
| Ctrl+C | `\x03` | `Interrupt` or `Ctrl+C` |
| Ctrl+D | `\x04` | `EOF` or `Ctrl+D` |

Rules:

- Accessory keys send immediately.
- Accessory keys do not mutate the text field.
- Accessory keys do not append Enter.
- Accessory keys should be disabled when disconnected/not writable, with drafted text preserved.
- Styling should be compact grey controls, not prominent primary buttons.
- The Send button remains the only primary action in the input area.

## Data And Control Flow

### Happy Path: Session Subscribe

```
Phone session screen
  -> terminal.focus(handle)
  -> terminal.subscribe(handle)
  -> desktop runtime resolves PTY
  -> renderer xterm serializer returns screen + cols/rows
  -> phone xterm init(cols, rows)
  -> phone writes serialized screen
  -> live PTY chunks stream into phone xterm
```

### No Serializer

```
terminal.subscribe(handle)
  -> renderer serializer missing/null
  -> runtime returns tracked PTY cols/rows
  -> phone xterm init(cols, rows)
  -> phone writes tail lines as degraded fallback
  -> live chunks stream
```

### Empty Terminal

```
terminal.list returns no terminals
  -> session shows empty terminal state
  -> user taps Create Terminal
  -> terminal.create(worktree)
  -> session focuses/subscribes created handle
```

If `terminal.create` fails, keep the user in the session and show a compact error/retry state. Empty terminal state must not be a dead end.

### Upstream Error

```
WebSocket request fails / host disconnects
  -> preserve current screen where possible
  -> show compact disconnected state
  -> reconnect and resubscribe active handle
```

### Auth Failed / Pairing Revoked

```
RPC returns unauthorized / pairing token is rejected
  -> transition connection state to auth failed
  -> stop automatic reconnect loop
  -> preserve stale content as read-only where available
  -> show re-pair and remove-host actions
```

Auth failure is distinct from transient disconnect. Treating it as reconnectable causes stale pairings to churn forever and hides the action the user needs to take.

### Subscription Ownership

Mobile may reconnect or multiple clients may subscribe at once. The runtime/WebSocket layer should treat each active stream as connection-scoped ownership, with cleanup on explicit unsubscribe and socket close. The current MVP uses terminal handles in parts of cleanup; implementation work should converge on request/subscription scoped cleanup so clients do not collide.

## Implementation Boundaries

- Mobile UI code lives under `mobile/`.
- Runtime streaming and PTY geometry support may touch `src/main/runtime`, `src/main/ipc`, `src/preload`, and terminal-pane serializer code.
- Design polish should not introduce new backend concepts unless required for terminal fidelity or pairing status.
- Styling should be centralized before broad screen restyling to avoid hard-coded color drift.

## Non-Goals For This Pass

- Full mobile IDE behavior.
- File editing or file browser.
- Full terminal keyboard emulation.
- Replacing desktop interaction for long terminal sessions.
- Relay transport UX beyond preserving room for it in host connection metadata.
- Final voice dictation UI.

## Verification Plan

Design verification:

- Screenshots of host list, worktree list, session with terminal, disconnected state, and empty state.
- Compare visually against desktop Orca for palette, density, border treatment, and accent usage.
- Confirm no raw route placeholders are visible.

Functional verification:

- Pair host.
- Open worktree.
- Switch terminal tabs.
- Stream Claude Code and Codex output.
- Pinch zoom, horizontal pan, and vertical scroll.
- Send text command.
- Send accessory keys: `Interrupt`, `Esc`, arrows, `Tab`, `Ctrl+D`.

Regression verification:

- No-phone `terminal.subscribe` repro still reports streamed marker, read marker, cols/rows, and serialized buffer length.
- Mobile TypeScript and lint pass.
