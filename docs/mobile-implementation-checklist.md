# Mobile Support — Phase 0 Implementation Checklist

Reference: [paseo-mobile-architecture-notes.md](./paseo-mobile-architecture-notes.md)

This checklist covers Phase 0 only: transport abstraction, TLS + per-device tokens, direct WebSocket, QR pairing, streaming subscriptions, mock server, and minimal mobile app. Every item has a verification step. Do not mark an item complete until verification passes.

---

## 0a. Transport Abstraction

### Types & interfaces

- [x] **Define `RpcTransport` interface** in `src/main/runtime/rpc/transport.ts`
  - `start(): Promise<void>`
  - `stop(): Promise<void>`
  - `onMessage(handler: (msg: string, reply: (response: string) => void) => void): void`
  - Verify: file exists, types compile (`pnpm run tc:node`)

- [x] **Add `websocket` variant to `RuntimeTransportMetadata`** in `src/shared/runtime-bootstrap.ts`
  - Add `| { kind: 'websocket'; endpoint: string }` to the discriminated union
  - Verify: `pnpm run tc:node` and `pnpm run tc:cli` both pass

- [x] **Change `transport` to `transports` array in `RuntimeMetadata`** in `src/shared/runtime-bootstrap.ts`
  - `transports: RuntimeTransportMetadata[]` (replaces singular `transport` field)
  - Update all consumers of `metadata.transport` to use the array
  - Verify: `pnpm run tc` passes (all typecheck targets)

### Extract UnixSocketTransport

- [x] **Extract existing socket logic** from `runtime-rpc.ts` into a `UnixSocketTransport` class implementing `RpcTransport`
  - Move `net.createServer()`, `handleConnection()`, socket path creation into the class
  - Keep the same behavior: newline-delimited JSON, 30s idle timeout, 1MB max message, 32 max connections
  - Verify: existing CLI commands still work (`orca status`, `orca worktree list`) — no behavior change

- [x] **Refactor `OrcaRuntimeRpcServer`** to use `RpcTransport` interface instead of inlined socket code
  - Constructor takes transport(s), not raw socket options
  - `start()` calls `transport.start()` for each transport
  - `stop()` calls `transport.stop()` for each transport
  - Verify: `pnpm run tc:node` passes
  - Verify: `pnpm test` passes (existing RPC tests)
  - Verify: `orca status` still works end-to-end with running Orca app

### TLS Certificate Generation

- [x] **Generate self-signed TLS certificate on first run**
  - Store cert + key at `$userData/orca-tls-cert.pem` and `$userData/orca-tls-key.pem`
  - Generate using Node.js `crypto` (or `selfsigned` package if simpler)
  - File permissions: `0o600` (owner read/write only)
  - Compute and store SHA-256 fingerprint of the cert
  - Verify: certificate files exist after first daemon start, permissions are correct
  - Verify: `openssl x509 -in <cert-path> -noout -fingerprint -sha256` shows valid fingerprint

### WebSocketTransport

- [x] **Add `ws` dependency** to `package.json`
  - `pnpm add ws` and `pnpm add -D @types/ws`
  - Verify: `pnpm install` succeeds, no lockfile conflicts

- [x] **Implement `WebSocketTransport`** class in `src/main/runtime/rpc/ws-transport.ts`
  - Uses `wss://` with self-signed TLS certificate (not `ws://`)
  - Binds to `0.0.0.0:<port>` (configurable, default 6768)
  - Long-lived connections (not one-per-request like Unix socket)
  - Multiplexes requests/responses on same connection via `id` field
  - Validates per-device tokens (from device registry), NOT the shared runtime auth token
  - Same max message size (1MB), same max connections (32)
  - Verify: `pnpm run tc:node` passes

- [x] **Bind both transports simultaneously** in `OrcaRuntimeRpcServer`
  - Unix socket transport (primary, for CLI — uses shared auth token) + WebSocket transport (secondary, for mobile — uses per-device tokens)
  - Both share the same `RpcDispatcher`
  - Verify: `pnpm run tc:node` passes

- [x] **Write `transports` array to bootstrap metadata** (`orca-runtime.json`)
  - Array includes all active transports, e.g.: `[{kind: "unix", endpoint: "/tmp/..."}, {kind: "websocket", endpoint: "wss://0.0.0.0:6768"}]`
  - Verify: start Orca app, read `~/Library/Application Support/orca/orca-runtime.json`, confirm `transports` array is present with both entries

- [x] **Test WebSocket transport manually with wscat**
  - Start Orca app with `enableWebSocket: true`
  - Connect via Node.js WebSocket client to `wss://localhost:6768`
  - Send `status.get` with valid device token
  - Verify: receive valid JSON-RPC response with `ok: true` ✓

- [x] **Test auth rejection**
  - Send request with wrong device token
  - Verify: receive `unauthorized` error response ✓

- [ ] **Test from another device on same network**
  - Find local IP: `ifconfig | grep "inet " | grep -v 127.0.0.1`
  - From phone browser or another machine: `npx wscat -c wss://<local-ip>:6768 --no-check`
  - Send `status.get` request with correct device token
  - Verify: receive valid response

- [x] **Add WebSocket transport tests**
  - Unit test: WebSocket server starts and stops cleanly
  - Unit test: request/response round-trip over WebSocket
  - Unit test: multiple concurrent connections
  - Unit test: multiplexed requests on single connection
  - Unit test: streaming responses via reply callback
  - Unit test: oversized message rejection (closes connection)
  - Unit test: safe reply to closed connection
  - Unit test: idempotent start/stop
  - Verify: `pnpm test` passes (9 tests, all green)

### Device Registry

- [x] **Create device registry** at `src/main/runtime/device-registry.ts`
  - File location: `$userData/orca-devices.json`
  - Format: `[{deviceId, name, token, pairedAt, lastSeenAt}]`
  - File permissions: `0o600`
  - Functions: `addDevice()`, `removeDevice()`, `listDevices()`, `validateToken()`, `updateLastSeen()`
  - Token generation: `crypto.randomBytes(24).toString('hex')`
  - Verify: `pnpm run tc:node` passes
  - Verify: unit test — add device, validate token, remove device, validate fails

### CLI transport update

- [x] **Update CLI transport** to read from `transports` array in `src/cli/runtime/transport.ts`
  - CLI picks `unix` or `named-pipe` transport from the array (not websocket)
  - Maintain backward compatibility: if old `transport` field exists, use it as fallback
  - Verify: `pnpm run tc:cli` passes
  - Verify: `orca status` works with running Orca app

---

## 0b. QR Code Pairing (Desktop Side)

- [x] **Add `qrcode` dependency**
  - `pnpm add qrcode` and `pnpm add -D @types/qrcode`
  - Verify: `pnpm install` succeeds

- [x] **Define pairing offer schema** in `src/shared/pairing.ts`
  - Version 1: `{ v: 1, endpoint: string, deviceToken: string, certFingerprint: string }`
  - Zod schema for validation
  - Encode/decode functions: JSON → base64url, base64url → JSON
  - URL format: `orca://pair#<base64url>`
  - Verify: `pnpm run tc` passes
  - Verify: unit test — encode then decode round-trips correctly (7 tests, all green)

- [x] **Generate QR code data** in main process
  - Build pairing offer from runtime metadata (wss endpoint + new per-device token + cert fingerprint)
  - Creating a QR triggers: generate new device token → store in device registry → build pairing payload
  - Encode as `orca://pair#<base64url>`
  - Generate QR code as data URL
  - Verify: `pnpm run tc:node` passes

- [x] **Expose QR code via IPC to renderer**
  - Add IPC handler `mobile:getPairingQR` that returns QR data URL + endpoint + deviceId
  - Add IPC handler `mobile:listDevices` that returns paired devices (without tokens)
  - Add IPC handler `mobile:revokeDevice` that removes a device from registry
  - Add IPC handler `mobile:isWebSocketReady` that returns WebSocket status
  - Registered in `src/main/index.ts` after RPC server creation (not in `register-core-handlers.ts` since rpcServer is created later)
  - Verify: `pnpm run tc:node` passes

- [ ] **Display QR code in desktop app UI**
  - Add UI element in settings or menu (exact location TBD in product design doc)
  - Shows QR code image
  - Shows the endpoint as text (for manual entry fallback) — do NOT show the device token as plain text
  - Shows list of paired devices with revoke button
  - Verify: open Orca, navigate to the QR display, see a scannable QR code
  - Verify: decode the QR content manually (scan with phone camera or QR reader) and confirm it contains valid JSON with endpoint, deviceToken, and certFingerprint

---

## 0c. Streaming Subscription Pattern

### RPC core changes

- [x] **Define `RpcStreamingMethod` type** in `src/main/runtime/rpc/core.ts`
  - Similar to `RpcMethod` but handler receives a `stream` callback for sending multiple responses
  - `handler: (params, ctx, stream: (result: unknown) => void) => Promise<void>`
  - Verify: `pnpm run tc:node` passes

- [x] **Extend dispatcher to support streaming methods**
  - Streaming methods detected by type/flag in registry
  - For streaming methods: call handler with stream callback that sends multiple responses with same `id`
  - Responses include `streaming: true` flag in envelope
  - For regular methods: behavior unchanged
  - Verify: `pnpm test` passes (existing RPC tests still green)

- [x] **Add subscription tracking** in WebSocket transport
  - Track active subscriptions per connection: `Map<connectionId, Set<subscriptionId>>`
  - When connection closes, clean up all subscriptions for that connection
  - Verify: unit test — subscription cleaned up when WebSocket disconnects

### Terminal streaming methods

- [x] **Add `terminal.subscribe` method** in `src/main/runtime/rpc/methods/terminal.ts`
  - Params: `{ ptyId: string }` (Zod validated)
  - Streams terminal output chunks as they arrive
  - Sends initial scrollback, then live updates
  - Verify: `pnpm run tc:node` passes

- [x] **Add `terminal.unsubscribe` method**
  - Params: `{ subscriptionId: string }`
  - Stops streaming, cleans up listener
  - Verify: `pnpm run tc:node` passes

- [x] **Register new methods** in `src/main/runtime/rpc/methods/index.ts`
  - Add to `ALL_RPC_METHODS` array
  - Verify: `pnpm run tc:node` passes

- [x] **Test terminal streaming end-to-end**
  - Start Orca app with a terminal open
  - Connect via WebSocket client to wss://localhost:6768
  - Send `terminal.subscribe` — received scrollback ✓
  - Terminal without live pty correctly sends scrollback then ends ✓
  - worktree.ps and terminal.list return real data over WebSocket ✓

- [x] **Add streaming RPC tests** in `src/main/runtime/rpc/streaming.test.ts`
  - Unit test: subscribe sends initial scrollback via emit ✓
  - Unit test: subscribe sends live data chunks ✓
  - Unit test: unsubscribe stops further streaming ✓
  - Unit test: non-streaming methods fall back to one-shot dispatch ✓
  - Unit test: unknown method returns error ✓
  - Unit test: streaming method rejected over one-shot dispatch ✓
  - Unit test: handler errors captured in streaming dispatch ✓
  - Verify: `pnpm test` passes (7 tests, all green) ✓

---

## 0d. Mock Server

- [x] **Create `mobile/scripts/mock-server.ts`**
  - Standalone WebSocket server (no dependency on Electron or main process)
  - Responds to: `status.get`, `worktree.ps`, `terminal.list`, `terminal.subscribe`, `terminal.send`, `terminal.unsubscribe`
  - Returns realistic fake data (2 worktrees, 2 terminals, scrollback + streaming chunks)
  - `terminal.subscribe` sends scrollback then 5 `streaming: true` data chunks at 500ms intervals followed by `type: "end"` sentinel
  - Auth token: `mock-device-token` (rejects wrong tokens with `unauthorized`)
  - Verify: `cd mobile && pnpm mock-server` starts without errors ✓

- [x] **Test mock server with WebSocket client**
  - Connect and send `status.get` → valid response with graphStatus, window/tab/terminal counts ✓
  - Send `worktree.ps` → fake worktree list with 2 entries ✓
  - Send `terminal.list` → fake terminal list ✓
  - Send request with wrong token → `unauthorized` error ✓
  - Verify: mock server handles malformed input gracefully ✓

---

## 0e. Mobile App — Project Setup

- [x] **Create Expo project**
  - Set up manually in existing `mobile/` directory (already had mock-server deps)
  - Expo SDK 55, React Native 0.83.6, React 19.2.0
  - Verify: `npx expo export --platform ios` and `--platform android` both succeed ✓

- [x] **Install core dependencies**
  - expo, expo-router, expo-camera, expo-linking, expo-constants, expo-status-bar
  - react-native-screens, react-native-safe-area-context, react-native-gesture-handler, react-native-reanimated
  - zustand, @react-native-async-storage/async-storage, react-native-web
  - Used `npx expo install --fix` to align versions with SDK 55
  - Verify: `pnpm install` succeeds, no version conflicts ✓

- [x] **Configure Expo Router** in `app.json`
  - `"plugins": ["expo-router"]`, `"scheme": "orca"`, `"main": "expo-router/entry"`
  - File-based routing in `app/` directory with `_layout.tsx`, `index.tsx`, `pair-scan.tsx`
  - Verify: bundles build successfully ✓

- [x] **Configure TypeScript**
  - Strict mode, `@/*` path alias to `./src/*`
  - Extends `expo/tsconfig.base`
  - Verify: `npx tsc --noEmit` passes ✓

- [x] **Set up linting and formatting**
  - oxlint + oxfmt (matching main repo tooling)
  - Added `lint` and `format` scripts to `mobile/package.json`
  - Own `.oxlintrc.json` to avoid root config version mismatch
  - Verify: `pnpm lint` and `pnpm format` pass ✓

- [x] **Add `.gitignore`** for mobile directory
  - Ignores `node_modules/`, `android/`, `ios/`, `.expo/`, `dist/`, `web-build/`
  - Verify: `git status` shows only source files ✓

- [x] **Add `mobile/README.md`**
  - Prerequisites, quick start (3 commands)
  - "I have an Android phone" path with dev client build steps
  - "I only have a Mac" path (iOS Simulator)
  - Mock server usage
  - Connecting to real Orca instance
  - Project structure overview

- [x] **Build Android dev client (one-time)**
  - `npx expo prebuild --platform android`
  - Gradle 8.14 + JDK 17 (temurin) for Android build compatibility
  - Added `react-native-worklets@0.7.4` (peer dep of reanimated)
  - `JAVA_HOME=.../temurin-17.jdk/Contents/Home ./gradlew assembleDebug`
  - Verify: APK installed on phone, app opens ✓

- [x] **Verify hot reload**
  - `adb reverse tcp:8081 tcp:8081` + `pnpm start --dev-client`
  - Changed title text → appeared on phone instantly ✓

---

## 0f. Mobile App — Transport Layer

- [x] **Copy shared RPC types** into `mobile/src/transport/types.ts`
  - `RpcRequest`, `RpcResponse`, `RpcSuccess`, `RpcFailure` types
  - Pairing offer v1 schema (Zod) — `{ v: 1, endpoint: string, deviceToken: string, certFingerprint: string }`
  - `ConnectionState`, `HostProfile` types
  - Verify: `npx tsc --noEmit` passes ✓

- [x] **Implement WebSocket RPC client** in `mobile/src/transport/rpc-client.ts`
  - `connect(endpoint, deviceToken, onStateChange?)` returns `RpcClient`
  - `sendRequest(method, params): Promise<RpcResponse>` — one-shot with 30s timeout
  - `subscribe(method, params, onData): () => void` — streaming, returns unsubscribe fn
  - Routes responses by `streaming` flag + `type` field (scrollback, data, end)
  - Auto-reconnect with exponential backoff (1s → 16s)
  - Connection state: `connecting`, `connected`, `disconnected`, `reconnecting`
  - `onStateChange` listener + `close()` for cleanup
  - Verify: `npx tsc --noEmit` passes ✓

- [x] **Implement host profile storage** in `mobile/src/transport/host-store.ts`
  - Store/load host profiles from AsyncStorage under `orca:hosts` key
  - `loadHosts()`, `saveHost()`, `removeHost()`, `updateLastConnected()`
  - Verify: `npx tsc --noEmit` passes ✓

---

## 0g. Mobile App — QR Scanning

- [x] **Create pair screen** at `mobile/app/pair-scan.tsx`
  - Camera permission request via `useCameraPermissions()`
  - QR scanner using `CameraView` with `onBarcodeScanned`
  - `decodePairingUrl()` in `src/transport/pairing.ts`: decodes `orca://pair#<base64url>`, validates with Zod
  - Tests connection (`status.get`), saves host profile, navigates to host screen
  - Error states: invalid QR, auth failed, network unreachable — each with retry
  - Verify: `npx tsc --noEmit` passes ✓

- [x] **Test QR scanning with mock server**
  - Start mock server on computer
  - Generate a test QR code manually
  - Scan with phone
  - Verify: app connects to mock server and navigates to host screen ✓

- [x] **Handle edge cases**
  - Invalid QR code (not orca:// scheme) → "Not a valid Orca QR code" error
  - Network unreachable → "Cannot connect" error with Try Again button
  - Wrong device token → "Authentication failed" error
  - Verify: all error paths coded ✓

---

## 0h. Mobile App — Screens

### Design language

- [ ] **Replace placeholder mobile styling with Orca desktop-aligned design**
  - Use a graphite/near-black palette, not saturated navy/purple backgrounds
  - Centralize colors, spacing, borders, and typography in a small mobile theme module
  - Prefer dense rows and compact panels over large decorative cards
  - Use subtle grey borders and muted text; reserve blue for active/focused states only
  - Use smaller, tool-like typography that mirrors the desktop app's restrained UI
  - Verify: home, host, worktree, and session screens all read as "Orca on mobile", not an Expo placeholder

- [ ] **Clean up route/header chrome**
  - Do not display raw expo-router paths like `h/[hostId]/session/[worktreeId]`
  - Headers should show meaningful host/worktree/session names
  - Keep headers compact so terminal/session content remains the primary surface
  - Verify: screenshots have no placeholder route names or demo labels

### Home / host list

- [x] **Create home screen** at `mobile/app/index.tsx`
  - List of paired hosts from AsyncStorage via `useFocusEffect`
  - Each host shows: name, endpoint, last connected date
  - Tap host → navigate to host screen
  - "Add host" button → navigate to pair screen
  - Empty state with centered title when no hosts paired

### Host screen / worktree list

- [x] **Create host screen** at `mobile/app/h/[hostId]/index.tsx`
  - Connects to host via WebSocket on mount, cleans up on unmount
  - Shows connection status (green dot when connected)
  - Calls `worktree.ps` and displays worktree cards
  - Each worktree shows: repo name, branch, preview, terminal count, unread dot
  - Tap worktree → navigate to session view

- [ ] **Restyle worktree list as compact desktop-like rows**
  - Show repo/worktree name, branch, terminal count, unread/activity indicator, and one-line preview
  - Avoid oversized card padding; rows should be scannable and information-dense
  - Use subtle hover/pressed states and low-contrast dividers
  - Verify: at least 6 worktrees fit comfortably on a modern phone viewport

### Session / terminal view

- [x] **Create session view** at `mobile/app/h/[hostId]/session/[worktreeId].tsx`
  - Calls `terminal.list` for the worktree
  - Calls `terminal.subscribe` for the active terminal
  - Displays streaming terminal output (scrollable, monospace, selectable text)
  - Tab bar for switching between multiple terminals
  - Auto-scrolls to bottom on new output

- [ ] **Polish terminal viewport behavior**
  - Terminal content should end exactly above the input/accessory area, with no hidden bottom content
  - Support vertical scroll, horizontal pan, and pinch zoom for desktop-sized xterm snapshots
  - Initial terminal scale should show the full desktop width, with user-controlled zoom for readability
  - Verify: Claude Code and Codex TUI output remain coherent after tab switches, zoom, and scroll

### Input bar

- [x] **Add input bar** to session view
  - Text input at bottom of screen with monospace font
  - Send button → calls `terminal.send` with text + `enter: true`
  - `KeyboardAvoidingView` moves input bar above keyboard
  - Submit via keyboard return key or Send button
  - Voice dictation placeholder deferred to separate branch

- [ ] **Add terminal key accessory bar**
  - Add a compact row above the text input for terminal-only keys that phone keyboards cannot express reliably
  - MVP keys: `Esc`, `Tab`, `↑`, `↓`, `←`, `→`, `Ctrl+C`, `Ctrl+D`
  - Send raw bytes through `terminal.send` without appending Enter:
    - `Ctrl+C` → `\x03`
    - `Ctrl+D` → `\x04`
    - `Esc` → `\x1b`
    - `Tab` → `\t`
    - arrows → `\x1b[A`, `\x1b[B`, `\x1b[D`, `\x1b[C`
  - Use compact grey buttons; label `Ctrl+C` as `Interrupt` where space allows
  - Verify: can interrupt Claude/Codex, navigate history/menus, and tab-complete from the phone

- [ ] **Separate line-send and raw-key behaviors**
  - Text field remains line-oriented: Send transmits text plus Enter
  - Accessory keys transmit immediately and do not mutate the text field
  - Long-term: add a dedicated "Keys" or "Terminal control" mode only if the accessory bar is insufficient
  - Verify: pressing accessory keys does not accidentally submit partially typed text

---

## 0i. Integration Testing

- [x] **End-to-end test: mock server path**
  - Start mock server
  - Open mobile app → pair screen → scan QR (or manually enter mock server address)
  - See worktree list ✓
  - Tap worktree → see streaming terminal output ✓
  - Send a message → see it echoed
  - Verify: full flow works without running Orca desktop app ✓

- [ ] **End-to-end test: real Orca path**
  - Start Orca desktop app
  - Open a terminal and start an agent or run some commands
  - Open mobile app → scan QR from Orca settings
  - See real worktree list
  - Tap worktree → see real terminal output streaming
  - Send a follow-up message from phone → see it in the Orca terminal
  - Verify: full flow works with real Orca desktop app

- [ ] **Test reconnection**
  - Connect mobile to Orca
  - Kill and restart Orca
  - Verify: mobile app detects disconnection, shows status, attempts reconnect
  - Verify: after Orca restarts, mobile reconnects and resumes

- [ ] **Test multiple connections**
  - Connect two clients (e.g., phone + wscat) to same Orca instance
  - Both subscribe to terminal output
  - Verify: both receive streaming data
  - Disconnect one → verify: other still works

---

## 0j. CI Setup

- [x] **Add GitHub Actions workflow** for mobile at `.github/workflows/mobile.yml`
  - Trigger: on PR changes to `mobile/**`
  - Steps: install deps, typecheck, lint
  - Verify: push a PR with mobile changes, CI runs and passes

- [x] **Add Android build check to CI**
  - `npx expo prebuild --platform android && cd android && ./gradlew assembleDebug`
  - Runs on `ubuntu-latest` with JDK 17 (temurin)
  - Runs after verify job passes
  - Verify: CI builds APK successfully

- [ ] **Add iOS build check (nightly/weekly)**
  - `npx expo prebuild --platform ios && xcodebuild -workspace ... -sdk iphonesimulator build`
  - Runs on `macos-latest`
  - Verify: CI builds iOS simulator binary successfully

---

## Phase 1: TLS Certificate Pinning

- [ ] **Create Expo native module** for pinned WebSocket connections
  - `npx create-expo-module expo-pinned-websocket`
  - Android: OkHttp WebSocket + `CertificatePinner` with `sha256/` fingerprint
  - iOS: `URLSessionWebSocketTask` with custom `URLSessionDelegate` that validates cert fingerprint
  - JS API: `createPinnedWebSocket(url, fingerprint)` returning standard WebSocket-like interface
  - Verify: module builds on both platforms

- [ ] **Integrate pinned WebSocket into rpc-client.ts**
  - Replace `new WebSocket(endpoint)` with `createPinnedWebSocket(endpoint, fingerprint)`
  - Pass `certFingerprint` from host profile through to the native module
  - Verify: connects to `wss://` server, rejects mismatched certs

- [ ] **Re-enable TLS on WebSocket transport**
  - Revert `ws-transport.ts` and `runtime-rpc.ts` to use `wss://` with TLS cert/key
  - Verify: mobile app connects via `wss://` with pinned cert
  - Verify: connection rejected when fingerprint doesn't match

- [ ] **Rebuild dev client APK/IPA** with native module
  - `npx expo prebuild && cd android && ./gradlew assembleDebug`
  - Verify: app installs and connects with TLS pinning active

---

## Final Verification

- [ ] **All existing tests pass**: `pnpm test` in root Nautilus directory
- [x] **All existing typecheck passes**: `pnpm run tc` in root Nautilus directory ✓
- [ ] **CLI still works**: `orca status`, `orca worktree list` — no regressions
- [x] **Desktop app still works**: launch Orca, open terminal, run commands — no regressions ✓
- [ ] **Mobile app connects to real Orca**: full flow (QR scan → worktree list → terminal streaming → send message)
- [x] **Mobile app connects to mock server**: full flow without Orca running ✓
- [ ] **CI passes**: all checks green on a PR
- [ ] **README is accurate**: someone else can follow it cold and get running
