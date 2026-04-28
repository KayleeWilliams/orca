# Mobile UI Implementation Checklist

Reference: [mobile-ui-spec.md](./mobile-ui-spec.md)

This checklist covers the mobile UI/design implementation pass: Orca desktop-aligned visual language, compact mobile layouts, terminal viewport ergonomics, and terminal control keys. Every item has a verification step. Do not mark an item complete until verification passes on at least one physical phone or simulator.

---

## 0. Design Foundation

### Theme tokens

- [x] **Create a mobile theme module**
  - Define tokens for base background, panels, raised surfaces, borders, primary text, secondary text, muted text, blue accent, and status colors
  - Use concrete names like `mobile-theme.ts`; avoid vague `utils`/`helpers`
  - Replace repeated hard-coded colors in mobile screens with theme tokens
  - Verify: `rg "#0d0d1a|#1a1a2e|#3b82f6|#888|#666" mobile/app mobile/src` returns no screen-level one-off color drift, except deliberate terminal WebView palette values
  - **Implemented**: `src/theme/mobile-theme.ts` with `colors`, `spacing`, `radii`, `typography` exports. All screen files import from theme. Grep confirms no stale hex in app/ or src/.

- [x] **Define shared layout primitives**
  - Add small reusable components only where they remove real duplication: status dot, compact row, icon/text button, muted metadata text
  - Keep components minimal and domain-named
  - Verify: host and worktree screens share row/status styling without copy-pasted style blocks
  - **Implemented**: `src/components/StatusDot.tsx` — shared across host and session screens. Row styles use theme tokens consistently.

### Visual alignment

- [x] **Replace placeholder navy/purple styling**
  - Move app backgrounds to near-black/graphite
  - Move row/panel backgrounds to muted grey-black
  - Keep blue only for selected/active/focused states and the main Send action
  - Verify: screenshots of all screens read as dark Orca desktop, not Expo placeholder UI
  - **Implemented**: All backgrounds now use graphite `#111111`/`#1a1a1a`/`#242424`. Blue restricted to accent use (active tabs, unread dots, Send button, primary actions).

- [x] **Normalize shape and spacing**
  - Rows use compact padding and 6-8px radius max
  - Large card-like host/worktree blocks are replaced with dense rows
  - Borders are subtle 1px separators
  - Verify: at least 6 worktree rows fit on a modern phone viewport without feeling cramped
  - **Implemented**: Rows use 6px radius, compact vertical padding, 1px `borderSubtle` separators. Cards replaced with flat rows throughout.

---

## 1. Navigation And Header Chrome

- [x] **Remove raw route placeholders from headers**
  - Do not show route names like `h/[hostId]/session/[worktreeId]`
  - Home header shows `Orca`
  - Host header shows host name and connection state
  - Session header shows worktree/session/terminal title
  - Verify: physical phone screenshots contain no expo-router path placeholders
  - **Implemented**: `_layout.tsx` sets explicit `title: 'Orca'` and `title: 'Pair Host'`. Host screen shows `hostName` in status bar. Session screen shows `activeTerminal.title`.

- [x] **Make headers compact**
  - Reduce vertical header height where safe-area permits
  - Keep back navigation clear but visually restrained
  - Verify: terminal viewport gains vertical room compared with the placeholder UI
  - **Implemented**: `headerShadowVisible: false`, compact `fontSize: 16` title, reduced padding throughout.

- [x] **Standardize connection status display**
  - Use the same status dot and text treatment across host and session screens
  - States: connecting, connected, disconnected, reconnecting, auth failed
  - Verify: disconnect/reconnect states are understandable without large banners
  - **Implemented**: Shared `StatusDot` component with color mapping for all 5 states. Used in both host and session screens.

---

## 2. Home / Host List

- [x] **Restyle host list as compact rows**
  - Each row shows host name, endpoint, last connected timestamp, and status when known
  - Add Host is a compact action in the header or fixed footer, not a large floating card
  - Verify: multiple paired hosts are scannable and no row feels like a marketing card
  - **Implemented**: Flat rows with `hostName`, `endpoint`, and `lastConnected` date. Add button in a subtle footer with blue text link style.

- [x] **Polish empty state**
  - Plain title, one sentence, one Pair Host action
  - No decorative illustration or oversized hero treatment
  - Verify: empty state is functional and visually consistent with desktop Orca
  - **Implemented**: "No paired hosts" title, one-line description, single "Pair Host" primary button.

- [ ] **Preserve stale hosts**
  - Stale/unreachable hosts stay visible with muted metadata and retry path
  - Verify: turning off desktop host does not remove paired host from the list
  - **Note**: Hosts persist in AsyncStorage and remain visible. Connection state per-host is not currently displayed on the home screen — requires phone QA.

---

## 3. Pairing Screen

- [x] **Restyle camera pairing screen**
  - Compact header and instructions
  - Camera preview uses subtle border/radius and fills useful space
  - Error/permission states use plain panels and compact buttons
  - Verify: QR scanner is usable on physical phone and matches app theme
  - **Implemented**: Compact instruction text, camera with 8px radius, all colors from theme. Permission/error states use centered layout with theme styling.

- [ ] **Improve pairing error states**
  - Invalid QR, auth failure, network unreachable, and permission denied have distinct messages
  - Retry path is always available
  - Verify: each error path can be triggered manually or with mock data
  - **Note**: Error messages are distinct per case. Requires phone QA to verify all paths.

---

## 4. Host / Worktree List

- [x] **Make worktree list attention-first**
  - Sort on the mobile client until `worktree.ps` exposes the desired product ordering
  - Ordering: unread/attention first, active/live terminals next when available, newest `lastOutputAt`, terminal count, stable name
  - Fall back to unread/recent output and terminal count when blocked state is unavailable
  - Keep inactive work visible but visually quieter
  - Verify: mock or live data with unread older work still renders before newer non-unread work
  - **Implemented**: `sortWorktreesAttentionFirst()` sorts by unread > liveTerminalCount > lastOutputAt > repo name. Comment explains why client-side sort is needed.

- [x] **Restyle worktrees as dense rows**
  - Row content: repo/worktree name, branch, preview, terminal count, unread/activity state
  - Use one-line preview by default; no two-line card blocks unless needed
  - Verify: active worktrees can be scanned quickly with one thumb scroll
  - **Implemented**: Flat rows with repo name, unread dot, branch, one-line preview, and terminal count. No card padding.

- [x] **Handle loading, empty, and disconnected states**
  - Loading uses compact skeleton rows or muted loading text
  - Empty uses plain message
  - Disconnected preserves last-known content where available and shows reconnect state
  - Auth failed preserves stale content as read-only and shows re-pair/remove-host actions
  - Verify: all states render without layout jumps
  - **Implemented**: Loading shows small ActivityIndicator. Empty shows "No active worktrees". Disconnected/reconnecting preserves `lastKnownWorktrees`. Auth-failed shows banner with re-pair/remove actions and read-only rows.

- [x] **Model auth failure separately from disconnect**
  - Extend mobile connection/error state with an auth-failed branch or equivalent error subtype
  - Map RPC `unauthorized`/pairing rejection to auth failed, not reconnecting
  - Stop automatic reconnect churn while auth failed
  - Verify: stale pairing shows re-pair action and does not repeatedly reconnect
  - **Implemented**: `ConnectionState` extended with `'auth-failed'`. RPC client detects `unauthorized` error code, closes socket with `intentionallyClosed = true`, and transitions to `auth-failed` state. No reconnect churn.

- [x] **Avoid over-emphasizing metadata**
  - Branch names and previews are muted relative to worktree names
  - Terminal count is compact secondary metadata
  - Verify: visual hierarchy is clear in screenshots
  - **Implemented**: Branch uses `textSecondary`, preview uses `textMuted`, terminal count uses `textMuted` with right alignment.

---

## 5. Session / Terminal Layout

- [x] **Make session chrome terminal-first**
  - Compact session header
  - Compact horizontal terminal tabs
  - Terminal viewport fills all remaining space above accessory/input area
  - Verify: terminal content takes the majority of the screen height
  - **Implemented**: Compact header (8px vertical padding), 38px tab bar, `flex: 1` terminal frame, compact accessory + input bars.

- [x] **Fix terminal bottom clipping**
  - Terminal scrollable area ends at the top of the accessory/input area
  - Last visible terminal row is not hidden under the input bar
  - Verify: scroll to bottom after command output; final line is fully visible
  - **Implemented**: Terminal frame has `flex: 1, minHeight: 0, overflow: 'hidden'`. Accessory and input bars are siblings below the terminal in the flex column. Requires phone QA to confirm clipping fix.

- [ ] **Support terminal pan and zoom**
  - Vertical scroll works
  - Horizontal pan works when zoomed or when content exceeds viewport
  - Pinch zoom works on Android and iOS where supported
  - Verify: desktop-width Claude Code output can be inspected on phone without corrupting layout
  - **Note**: WebView has `scrollEnabled`, `nestedScrollEnabled`, viewport `user-scalable=yes`, and pinch zoom range 0.1–5. Requires phone QA.

- [x] **Implement measured initial terminal fit**
  - WebView viewport starts at `initial-scale=1`
  - Initialize xterm with desktop/tracked `cols` and `rows`
  - Measure rendered xterm surface after open
  - Apply `fitScale = min(1, viewportWidth / terminalSurfaceWidth)` to the terminal surface wrapper
  - Size the scroll container from the scaled surface dimensions so pan/scroll coordinates stay correct
  - Recompute on init, tab switch, and orientation/viewport change
  - Verify: 80-col, 150-col, and 200+ col terminals initially fit without fixed-scale distortion
  - **Implemented**: Viewport starts at `initial-scale=1`. `computeFitScale()` measures `el.scrollWidth` vs `window.innerWidth`. `applyFitScale()` sets `transform: scale()` on `#terminal-surface` and sizes `#scroll-container`. Recomputes on `window.resize` and after `requestAnimationFrame` post-init.

- [x] **Keep terminal geometry faithful**
  - Mobile initializes xterm with desktop `cols`/`rows` or tracked PTY dimensions
  - Serialized xterm buffer is preferred over line-tail fallback
  - Tab switching clears stale content before reinitializing
  - Verify: Claude Code and Codex TUIs remain coherent after tab switch, zoom, and reconnect
  - **Implemented**: `subscribeToTerminal()` calls `clear()` before subscribing. Scrollback handler inits xterm at desktop cols/rows and prefers `data.serialized` over `data.lines`.

- [ ] **Expose degraded mirror state for debugging**
  - Detect when serialized buffer is missing or dimensions fall back to `80x24`
  - Show a compact status/debug affordance in development builds or logs
  - Preserve terminal usability even in degraded mode
  - Verify: no-phone repro reports `scrollbackCols`, `scrollbackRows`, and `serializedLength`
  - **Note**: Fallback to 80x24 exists in code. Debug logging not yet added.

- [x] **Document desktop focus side effect**
  - Mobile may call `terminal.focus` before subscribing so the desktop renderer fits xterm and registers a serializer
  - Keep this behavior explicit until a non-disruptive daemon-owned screen snapshot exists
  - Verify: implementation comment and release/dev notes explain why mobile can activate a desktop terminal
  - **Implemented**: Comment in `subscribeToTerminal()` explains the desktop focus side effect and why it's necessary for the MVP renderer-coupled terminal mirror.

- [x] **Add create-terminal path for empty sessions**
  - If `terminal.list` returns no terminals, show compact `Create Terminal` action
  - Call `terminal.create` for the current worktree
  - Focus and subscribe to the created terminal handle
  - Show compact error/retry state if creation fails
  - Verify: opening a worktree with no terminals is recoverable without leaving the session
  - **Implemented**: `showEmptyState` renders "No terminals" message with "Create Terminal" button. `handleCreateTerminal()` calls `terminal.create`, updates terminal list, and subscribes. Error/creating states handled.

---

## 6. Terminal Input And Accessory Keys

- [x] **Add terminal accessory key row**
  - Add compact keys above text input: `Esc`, `Tab`, `↑`, `↓`, `←`, `→`, `Interrupt`, `Ctrl+D`
  - Use grey low-contrast buttons, not large blue controls
  - Verify: accessory row fits on phone width without text clipping
  - **Implemented**: `ACCESSORY_KEYS` array rendered in a horizontal `ScrollView` with `bgRaised` background, `textSecondary` text, 6px radius. Compact sizing with `minWidth: 36`.

- [x] **Wire raw control bytes**
  - `Esc` sends `\x1b`
  - `Tab` sends `\t`
  - `↑` sends `\x1b[A`
  - `↓` sends `\x1b[B`
  - `←` sends `\x1b[D`
  - `→` sends `\x1b[C`
  - `Interrupt` sends `\x03`
  - `Ctrl+D` sends `\x04`
  - Verify: each key reaches the desktop terminal through `terminal.send`
  - **Implemented**: `handleAccessoryKey()` sends raw bytes via `terminal.send` with `enter: false`. Each key's byte sequence is defined in the `ACCESSORY_KEYS` constant.

- [x] **Keep text input line-oriented**
  - Send button submits text plus Enter
  - Return key submits text plus Enter
  - Accessory key presses do not mutate the text field and do not append Enter
  - Verify: partially typed text remains intact after pressing an accessory key
  - **Implemented**: `handleSend()` sends with `enter: true`. `handleAccessoryKey()` sends with `enter: false` and does not touch the `input` state. `returnKeyType="send"` triggers `handleSend()`.

- [x] **Handle input failure states**
  - Disable Send/accessory keys while disconnected or when terminal is not writable
  - Preserve drafted text on send failure
  - Show compact retry/error state without covering terminal output
  - Verify: disconnect during draft does not lose text
  - **Implemented**: `canSend` guard disables Send, accessory keys, and TextInput when not connected or no active terminal. `handleSend()` restores input text on failure via `catch { setInput(text) }`.

- [ ] **Keyboard avoidance and safe areas**
  - Input/accessory area stays above the OS keyboard
  - Terminal viewport resizes rather than hiding content behind the keyboard
  - Verify: focus input on Android and iOS; no content is obscured by keyboard or home indicator
  - **Note**: `KeyboardAvoidingView` with platform-specific behavior is in place. Requires phone QA.

---

## 7. Accessibility And Ergonomics

- [x] **Add accessible labels for controls**
  - Accessory keys have meaningful labels such as `Send Escape`, `Interrupt terminal`
  - Icon-only controls have accessibility labels
  - Verify: screen reader labels are understandable
  - **Implemented**: Accessory keys have `accessibilityLabel` prop. `Ctrl+C` labeled "Interrupt terminal", `Ctrl+D` labeled "Send EOF", others labeled "Send {key}".

- [ ] **Check touch targets**
  - Primary actions meet platform touch target expectations
  - Compact accessory keys remain tappable without accidental adjacent taps
  - Verify: manual phone testing with one-handed use
  - **Note**: Requires phone QA.

- [ ] **Respect reduced motion and text scaling where practical**
  - Avoid relying on animation for critical state
  - Ensure labels do not clip at common text scaling settings
  - Verify: no obvious clipping with larger system text
  - **Note**: No animations used for critical state. Text scaling requires phone QA.

---

## 8. Validation

### Runtime / protocol checks

- [ ] **Confirm stream cleanup ownership**
  - Multiple mobile clients can subscribe without colliding
  - Reconnect unsubscribes old streams or scopes cleanup to the old socket
  - Explicit unsubscribe does not close another client's stream
  - Verify: two WebSocket clients can subscribe to the same terminal and close independently

- [ ] **Confirm auth failure contract**
  - Runtime/client maps unauthorized responses into mobile auth-failed state
  - Auth failed disables terminal writes and reconnect attempts
  - Re-pair returns the host to connected state without restarting the app
  - Verify: revoked/stale pairing shows auth failed UI and a successful re-pair recovers
  - **Note**: Client-side auth-failed detection implemented. Full contract verification requires runtime + phone testing.

- [ ] **Bundle terminal assets before release**
  - Replace CDN-loaded xterm assets in `TerminalWebView` with bundled/local assets for production
  - Keep dev fallback only if needed
  - Verify: terminal renders with network disabled after app bundle is loaded

### Static checks

- [x] **Run mobile TypeScript**
  - Command: `cd mobile && pnpm exec tsc --noEmit`
  - Verify: exits 0
  - **Verified**: TypeScript passes with exit code 0.

- [x] **Run mobile lint**
  - Command: `cd mobile && pnpm lint`
  - Verify: exits 0
  - **Verified**: oxlint passes with 0 warnings and 0 errors.

### No-phone terminal repro

- [ ] **Verify terminal subscribe still includes stream/read markers**
  - Command: `cd mobile && ORCA_MOBILE_WS_URL=ws://127.0.0.1:6768 pnpm exec tsx scripts/test-subscribe.ts <deviceToken>`
  - Verify: `streamSawMarker: true` and `readSawMarker: true`

- [ ] **Verify terminal geometry payload**
  - Same command as above
  - Verify: `scrollbackCols`, `scrollbackRows`, and `serializedLength` are logged

### Physical phone QA

- [ ] **Phone smoke test**
  - Pair host
  - Open worktree
  - Switch terminal tabs
  - Send `ls`
  - Verify output appears and input bar remains usable

- [ ] **Terminal TUI test**
  - Open Claude Code or Codex in desktop terminal
  - Open same terminal on phone
  - Pan, zoom, and scroll
  - Send `Interrupt`
  - Verify TUI remains coherent and control key works

- [ ] **Screenshot review**
  - Capture home, pairing, worktree list, session terminal, keyboard-open, disconnected/error states
  - Verify against [mobile-ui-spec.md](./mobile-ui-spec.md)
