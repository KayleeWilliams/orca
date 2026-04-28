# Paseo Mobile Architecture Notes

## Scope

This document covers the **communication architecture and infrastructure** needed for an Orca mobile app: how the phone talks to the computer, transport protocols, encryption, relay infrastructure, pairing, build tooling, and development workflow.

**What this document covers:**
- Paseo's mobile architecture (investigation and verification)
- Transport layer design (WebSocket, direct connection, relay)
- Encryption and pairing model
- Framework and tech stack decisions
- Build, test, and CI setup
- Infrastructure requirements and cost
- Phased implementation plan for the communication layer

**What this document does NOT cover:**
- Mobile app UI/UX design (screens, navigation flow, visual design)
- Feature spec (what the app does, user stories, interaction patterns)
- Desktop-side UI changes (QR code display, pairing settings)
- Agent protocol details (how agent messages are structured beyond transport)

A separate design doc should cover the app's actual product design — what screens exist, what users can do, how information is presented on a phone form factor.

---

## Anti-Goals (What Mobile Is NOT)

The mobile app is for **continuing work with coding agents on the go** — monitoring progress, approving actions, giving follow-up instructions, and reviewing results.

**Primary input mode: voice dictation** (not typing). Voice work is on a separate branch to be combined later. Text input exists as a secondary option for short messages, approvals, and quick corrections.

**The mobile app is NOT:**
- A mobile IDE — no editing code files
- A file browser — no navigating or browsing file trees
- A terminal emulator — no interactive terminal sessions
- A keyboard-heavy workflow tool — the phone keyboard is a fallback, not the primary input method

If a task requires sustained typing, file navigation, or terminal interaction, the user should be at their computer. The mobile app optimizes for the complementary use case: staying connected to running agents when away from the desk.

---

## Short Answers

- The mobile app is open sourced in the `paseo` monorepo.
- The app is built as a shared Expo / React Native app in `packages/app`.
- Paseo is not pure peer-to-peer in the default remote-access flow.
- The core architecture is daemon-centric: desktop, mobile, web, and CLI are clients of a daemon.
- Mobile-to-host communication can be direct, but the default remote path uses a relay plus end-to-end encryption.
- Dictation and voice models, when local, run on the daemon machine, not on the phone.

---

## Evidence That The Mobile App Is Open Sourced

The `paseo` monorepo includes:

| Package | Purpose |
|---------|---------|
| `packages/app` | Mobile + web app (React Native + Expo) |
| `packages/server` | Backend daemon/server |
| `packages/desktop` | Electron desktop wrapper |
| `packages/relay` | WebSocket relay service (Cloudflare Durable Objects) |
| `packages/cli` | Command-line interface |
| `packages/expose-two-way-audio` | Native module for audio streaming |
| `packages/highlight` | Syntax highlighting utility |
| `packages/website` | Marketing website |

The root workspace definition includes `packages/app`, and that package contains Expo config, app routes, mobile permissions, and mobile-specific hooks.

Notable detail:

- The app source is present, but committed `ios/` and `android/` projects do not appear to be checked in. This strongly suggests Expo prebuild-generated native projects rather than committed native app folders.

---

## Mobile App Tech Stack (Verified)

| Component | Technology | Version |
|-----------|-----------|---------|
| Framework | React Native + Expo | RN 0.81.5 / Expo SDK 54.0.18 |
| React | React 19.1.0 | 19.1.0 |
| Language | TypeScript | 5.9.2 |
| State Management | Zustand | 5.0.9 |
| Server State | Tanstack React Query | 5.90.11 |
| Navigation | Expo Router (file-based) | 6.0.13 |
| Styling | React Native Unistyles | 3.0.15 |
| Bottom Sheets | @gorhom/bottom-sheet | 5.2.6 |
| Gestures | React Native Gesture Handler | 2.28.0 |
| Animations | React Native Reanimated | 4.1.1 |
| Icons | Lucide React Native | 0.546.0 |
| Storage | @react-native-async-storage | 2.2.0 |
| WebSocket | ws | 8.20.0 |
| Encryption | tweetnacl | 1.0.3 |
| Audio (native) | @getpaseo/expo-two-way-audio | custom |
| Audio (web) | expo-audio | 1.0.13 |
| Notifications | expo-notifications | 0.32.16 |
| Validation | Zod | 3.23.8 |
| QR Codes | qrcode | 1.5.4 |
| Build/Deploy | EAS Build (Expo Application Services) | — |
| E2E Testing | Playwright | 1.56.1 |

### Framework Decision: Why Expo/React Native For Orca

**Decision: React Native + Expo.** This was evaluated against other options:

| Framework | Code Sharing w/ Electron | Native Feel | Ecosystem | Verdict |
|-----------|--------------------------|-------------|-----------|---------|
| **React Native + Expo** | Types + business logic only (different UI primitives) | True native components | Massive (largest mobile JS ecosystem) | **Chosen** |
| Capacitor/Ionic | High (same React DOM components) | WebView — not native | Smaller, fewer libraries | Rejected |
| PWA | Highest (just make web responsive) | Web — no native APIs | N/A | Rejected |
| Flutter / Native | Zero (different language) | Best | Separate ecosystem | Rejected |

**Why not Capacitor?** Its main advantage is sharing React DOM components between Electron and mobile. But the mobile UI needs to be redesigned for phone form factor anyway — terminal output, worktree lists, and interaction patterns are fundamentally different on a small screen. Trying to share components would compromise both experiences. Once code sharing is off the table, Capacitor's WebView-based approach is strictly worse than React Native's true native components.

**Why Expo specifically:**
- Managed workflow — no maintaining `ios/` and `android/` directories
- EAS Build — cloud-built binaries without needing Xcode or Android Studio locally
- Expo Router — file-based routing modeled after Next.js
- Rich native module ecosystem (camera, notifications, haptics, biometrics)
- Battle-tested: Paseo built the same kind of companion app with Expo and it works well
- React Native New Architecture (JSI, Fabric, TurboModules) is production-ready — performance gap with native is negligible for a companion app

### iOS/Android Support

**Managed Expo workflow** — no `ios/` or `android/` directories in source control. Native projects generated via `expo prebuild` before building.

**iOS:**
- Permissions: Microphone (NSMicrophoneUsageDescription)
- Bundle ID: `sh.paseo` (production), `sh.paseo.debug` (development)
- ITSAppUsesNonExemptEncryption: false

**Android:**
- Min SDK: 29
- Kotlin: 2.1.20
- Permissions: RECORD_AUDIO, MODIFY_AUDIO_SETTINGS, CAMERA
- Cleartext traffic enabled for local network (dev + release)
- Package names per variant (production/debug)

### Build Profiles (EAS)

1. **development** — Dev client, internal distribution, debug Gradle
2. **production** — App Store/Play Store, auto-incrementing versionCode
3. **production-apk** — APK for internal/testing, skips lint for speed

### Web Deployment

The same codebase also ships as a web app via Cloudflare Pages using Wrangler CLI.

---

## High-Level Product Architecture

Paseo is structured around a local daemon:

- The daemon runs on the user's machine.
- Clients connect to the daemon.
- The clients include:
  - desktop app
  - mobile app
  - web app
  - CLI

This means the desktop app is not the backend. The daemon is the backend.

Conceptually:

1. Daemon owns agent lifecycle, terminals, workspaces, and speech services.
2. Clients render UI and send control/input messages.
3. Relay exists only to bridge connectivity when client and daemon are not directly reachable.

---

## Mobile-To-Host Connection Model

There are two connection paths.

### 1. Direct connection (P2P)

The client connects straight to the daemon over WebSocket at a reachable `host:port`.

**How it works in practice:**
- The daemon listens on `127.0.0.1:6767` by default (localhost only — not reachable from other devices)
- To enable direct connections from a phone, the user must either:
  - Use a VPN like Tailscale (recommended by Paseo) — daemon listens on Tailscale IP (e.g., `100.x.y.z:6767`)
  - Bind daemon to LAN IP and enter it manually in the mobile app (e.g., `192.168.1.100:6767`)
  - Bind to `0.0.0.0` (Paseo warns against this for security reasons)
- **No auto-discovery** — there is no mDNS/Bonjour/Zeroconf. The user manually enters `hostname:port` in an "Add Host" modal.
- Unix socket mode (`directSocket`) is also supported for CLI-only use on the same machine.

This is suitable for LAN, Tailscale, or other VPN setups where the user is willing to configure networking.

### 2. Relay connection (recommended default)

The daemon opens outbound sockets to a relay service.
The mobile app also opens an outbound socket to the relay.
The relay routes traffic between them.

This is the default and recommended path for remote access. No open ports, no VPN, no port forwarding required.

Important nuance:

- This is not pure peer-to-peer.
- But it is also not "Paseo cloud runs your agents."
- The daemon still runs locally on the user's machine.
- The relay is zero-knowledge — it routes encrypted bytes and cannot read content.

### Connection Selection (Automatic)

When a host has multiple connection types configured, the app probes all of them simultaneously and picks the fastest:

- `directTcp` — local network / VPN (6-second probe timeout)
- `directSocket` — Unix socket (desktop only)
- `directPipe` — Windows named pipe
- `relay` — cloud relay via `relay.paseo.sh` (10-second probe timeout)

Probe states: `pending` → `available` (with latencyMs) or `unavailable`. The lowest-latency available connection wins. If you're on the same LAN, direct will typically win; if not, relay kicks in automatically.

---

## Pairing Model

Pairing is based on a QR code or pairing link.

The daemon generates a relay-oriented pairing offer containing:

- `v` (version, currently 2)
- `serverId`
- `daemonPublicKeyB64`
- `relay.endpoint` (default: `relay.paseo.sh:443`)

That payload is base64url-encoded into a URL fragment like:

- `https://app.paseo.sh/#offer=<base64url-encoded-JSON>`

The mobile app:

1. Requests camera permission (expo-camera)
2. Scans QR code and extracts URL with `#offer=` fragment
3. Decodes and validates offer against `ConnectionOfferV2Schema` (Zod)
4. Calls `connectToDaemon()` with relay endpoint and daemon public key
5. Establishes encrypted channel via relay
6. Stores host profile in AsyncStorage
7. Navigates to paired host screen

### Daemon Keypair Persistence

- Stored at: `<PASEO_HOME>/daemon-keypair.json`
- Format: `{v: 2, publicKeyB64: "...", secretKeyB64: "..."}`
- File permissions: `0o600` (owner read/write only)
- Loaded or created on startup via `loadOrCreateDaemonKeyPair()`

---

## Relay Architecture

Paseo's relay is best understood as a packet router.

### Hosting and Cost

The relay (`relay.paseo.sh`) is **hosted by the Paseo team** on their Cloudflare account (account ID visible in `packages/relay/wrangler.toml`). Their security page refers to it as "our relay server."

**Who pays:** The Paseo team absorbs the cost. There is no explicit documentation about whether this will remain free, no SLA, and no commitment. Their FAQ says "Paseo is free and open source" and "Paseo adds zero cost on top" — but this refers to the overall product, not a specific guarantee about relay infrastructure.

**Self-hosting:** The relay endpoint is configurable. Users can point to their own relay instance via:
- Environment variable: `PASEO_RELAY_ENDPOINT`
- Config file: `daemon.relay.endpoint` in `~/.paseo/config.json`
- There is no Docker setup or self-hosting guide — you'd need to deploy the Cloudflare Worker from `packages/relay` yourself.

**Cost profile:** Cloudflare Workers + Durable Objects with WebSocket hibernation is cheap at low scale (Workers: ~$0.30/M requests, DO: ~$0.50/M operations, idle WebSocket connections cost nearly nothing due to hibernation). At large scale the cost would grow, but remains modest compared to traditional server infrastructure.

### Deployment

The relay is deployed as **Cloudflare Durable Objects** — not a traditional server. This means:

- Cloudflare manages scaling, availability, and geographic distribution
- Durable Objects provide per-server state isolation
- WebSocket hibernation keeps idle connection costs near zero
- SQLite persistence within Durable Objects for session state

### Protocol (v2)

Three socket shapes:

1. `role=server` (no connectionId) — daemon control socket
2. `role=server&connectionId=X` — daemon per-connection data socket
3. `role=client&connectionId=X` — app socket

Control messages:

- `sync` — sync active connection list
- `connected` — new client connected
- `disconnected` — client disconnected
- `ping` / `pong` — keepalive

The relay therefore does not own product semantics. It just routes sockets.

---

## Trust And Encryption Model

The relay is designed to be untrusted.

Paseo separates:

- reachability (relay provides this)
- trust (pairing QR/link provides this)

### Key Exchange — ECDH (Curve25519)

Library: **tweetnacl** (NaCl crypto)

1. `nacl.box.keyPair()` → generates (publicKey: 32 bytes, secretKey: 32 bytes)
2. `nacl.box.before(peerPublicKey, ourSecretKey)` → 32-byte shared key

### Encryption — XSalsa20-Poly1305

- `nacl.box.after(plaintext, nonce, sharedKey)` — authenticated encryption
- 24-byte random nonce per message
- Bundle format: `[nonce (24 bytes)][ciphertext...]`
- Transport: base64 text over WebSocket

**Note:** Paseo's security documentation page claims AES-256-GCM, but the actual implementation in `packages/relay/src/crypto.ts` uses XSalsa20-Poly1305 via tweetnacl. Both are strong authenticated encryption ciphers. The docs are inaccurate on this point.

### Encrypted Channel Handshake

**Client side:**
1. Receives daemon's public key via QR code
2. Generates own keypair
3. Sends: `{type: "e2ee_hello", key: "<base64-clientPublicKey>"}`
4. Derives shared key
5. Waits for daemon's `{type: "e2ee_ready"}`
6. Channel transitions to "open"

**Daemon side:**
1. Has pre-generated keypair (public key in QR)
2. Receives client's `e2ee_hello`
3. Extracts client public key, derives shared key
4. Sends: `{type: "e2ee_ready"}`
5. Channel opens

Retry: client retries every 1000ms if daemon hasn't acked within handshake timeout.

So the effective stack is:

1. raw WebSocket
2. relay routing
3. encrypted channel on top
4. Paseo application protocol on top

---

## Application Protocol Above Transport

After transport is established, Paseo runs a higher-level daemon session protocol.

That session protocol carries things like:

- server info and capabilities
- agent lifecycle events (ready, thinking, executing)
- chat messages (user/assistant)
- tool call invocations and results
- artifact updates
- workspace/diff events
- streamed agent output
- terminal messages
- permission requests
- audio output streaming
- dictation input streaming

This is a long-lived session model, not just stateless RPC.

The client and daemon maintain session continuity across reconnects using client identity and server identity.

### Audio Output Message Format

```
{
  type: "audio_output",
  payload: {
    chunkId: string,
    mimeType: "audio/pcm;rate=16000;bits=16",
    data: string,      // base64-encoded PCM
    isFinal: boolean,
  }
}
```

---

## What The Mobile App Stores

The app stores host profiles that can contain different connection types:

- `directTcp`
- `directSocket`
- `directPipe`
- `relay`

For relay, the important fields are:

- relay endpoint
- daemon public key

This means pairing does not rely on a user account session as the trust anchor. The trust anchor is the pairing offer itself.

---

## Mobile App State Management

### Zustand Stores

Location: `/packages/app/src/stores/`

Major stores:
- `session-store.ts` (37KB) — session state, agents, messages, artifacts, DaemonClient integration
- `workspace-layout-store.ts` (24KB) — panel/layout state
- `panel-store.ts` (18KB) — individual panel state
- `draft-store.ts` (19KB) — draft message composition
- `workspace-tabs-store.ts` (22KB) — tab management
- `keyboard-shortcuts-store.ts` — keyboard bindings
- `sidebar-collapsed-sections-store.ts` — UI state

### Context Providers

Location: `/packages/app/src/contexts/`

- `SessionContext` (59KB) — core session lifecycle, stream reducers
- `VoiceContext` — voice mode state
- `ToastContext` — toast notifications
- `SidebarAnimationContext`, `SidebarCalloutContext`, `HorizontalScrollContext`

### Navigation

Expo Router with file-based routing:

```
/src/app/
├── _layout.tsx           # Root layout (providers, listeners)
├── index.tsx             # Root screen
├── pair-scan.tsx         # QR scanner screen
├── welcome.tsx           # Welcome/onboarding
└── h/
    └── [serverId]/       # Per-host routes
        └── ...
```

Dynamic route segment `[serverId]` scopes all host-specific screens.

---

## Voice And Dictation Architecture

### What runs on the phone

The phone app does:

- microphone capture via `@getpaseo/expo-two-way-audio` (custom Expo native module with iOS Swift + Android Kotlin)
- local PCM chunking (16-bit signed, 16000 Hz sample rate)
- local audio playback
- voice/dictation UI
- keep-awake during voice sessions (tag: `"paseo:voice"`)

### Voice Runtime State Machine

```
disabled → starting → listening → submitting → waiting → playing → stopping
```

### What runs on the daemon

The daemon does:

- dictation speech-to-text (Sherpa-ONNX)
- realtime voice speech-to-text
- turn detection
- text-to-speech
- voice-mode orchestration

Local speech models downloaded to `$PASEO_HOME/models/local-speech`.

### Speech providers

- **Local**: ONNX models on daemon machine
- **OpenAI**: cloud-based STT/TTS

In both cases the phone is a capture/playback client. The speech provider lives daemon-side.

### Web Audio Fallback

For the web version: Web Audio API for microphone capture + AudioContext for playback, with PCM16 resampling.

---

## Push Notifications

- Library: `expo-notifications` v0.32.16
- Configured in `app.config.js` plugins
- Icon: `./assets/images/notification-icon.png`, color: `#20744A`
- Permission requested on-demand at startup
- Notification routing: `buildNotificationRoute()` resolves target screen/workspace from notification payload

---

## Is Paseo Pure P2P?

No.

The accurate answer is:

- It supports direct client-to-daemon connectivity when reachable.
- Its remote-friendly path uses external relay infrastructure (Cloudflare Durable Objects).
- The relay is transport infrastructure, not trusted compute infrastructure.
- Agents and local models still run on the daemon machine.

---

## What This Suggests For Orca

### Current Orca Architecture (Verified)

Orca already has an architectural foothold that matters here:

**Runtime RPC Layer:**
- `OrcaRuntimeService` is the authoritative control plane managing workspace/session state, terminals, worktrees, browser automation
- `orca-cli` communicates via newline-delimited JSON over TCP sockets (Unix socket on macOS/Linux, named pipe on Windows)
- The CLI discovers the runtime by reading `$userData/orca-runtime.json`
- Auth is a random 24-byte hex token, validated on every RPC request
- Metadata file has `0o600` permissions

**RPC API surface already defined:**
- `status.get`, `status.cliStatus` — runtime state
- `repo.list`, `repo.add`, `repo.remove`, `repo.update`, `repo.searchRefs` — repo management
- `worktree.list`, `worktree.ps`, `worktree.create`, `worktree.remove`, `worktree.merge`, `worktree.show` — worktree operations
- `terminal.list`, `terminal.read`, `terminal.send`, `terminal.create`, `terminal.split`, `terminal.close`, `terminal.wait` — terminal I/O
- `browser.screenshot`, `browser.click`, `browser.goto`, etc. — browser automation

**Daemon already exists:**
- Forked Node.js process (`child_process.fork()`, detached, survives app restarts)
- Same JSON-RPC envelope as runtime RPC
- Terminal session persistence across restarts with disk-based history
- Cold restore: scrollback + working directory on reconnect

**Remote/SSH relay already exists:**
- `/src/relay/protocol.ts` — binary frame protocol for remote host operations
- JSON-RPC over binary frames
- Keep-alive every 5 seconds, 20-second timeout
- Currently scoped to filesystem, git, and PTY operations over SSH

### Gaps Between Orca Today and Mobile Support

| Gap | Description | Severity |
|-----|-------------|----------|
| No WebSocket transport | Runtime RPC is Unix socket / named pipe only | High |
| No relay service | No way for mobile to reach daemon when not on same network | High |
| No E2E encryption | Local transport doesn't need it; remote does | High |
| No pairing flow | No QR code / link-based device pairing | High |
| No session protocol | Terminal read (`terminal.read`) is request/response, not streaming | Medium |
| No pub/sub for state | Graph epoch is renderer-specific, not remote-client-aware | Medium |
| No per-client auth | Single auth token, not per-device tokens | Medium (addressed in Phase 0b) |
| No push notifications | No way to alert mobile user of attention-needed states | Low |
| Renderer dependence | Some state still depends on renderer graph publication | Medium |

---

## Plan For Orca Mobile Support

### Approach: Start Minimal, Extend Later

The plan is structured so that Phase 0a (transport infrastructure) and Phase 0b (mobile companion app) ship value with zero hosted infrastructure, and each subsequent phase layers on top without rewriting what came before. Phase 0a is intentionally validated independently before mobile depends on it.

The key architectural decision: **introduce a transport abstraction that treats relay as just another transport implementation.** Direct WebSocket, relay-routed WebSocket, and the existing Unix socket all implement the same interface. Nothing above the transport layer needs to know which one is active.

---

### Phase 0a: Transport Infrastructure (1-2 weeks)

**Goal:** Extract a transport abstraction and add WebSocket support to the Orca runtime. This benefits the CLI and all future clients — mobile is not the only consumer.

**Validation gate:** Before any mobile code is written, validate the WebSocket transport with `wscat` or any generic WebSocket client. If the transport layer isn't solid, nothing built on top of it will be either.

#### Transport abstraction

Extract a transport interface from the current inlined socket logic. The RPC server should be able to bind multiple transports simultaneously (Unix socket for CLI + WebSocket for mobile).

```typescript
interface RpcTransport {
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: (msg: string, reply: (response: string) => void) => void): void
}
```

**Files to modify:**

| File | Change |
|------|--------|
| `src/shared/runtime-bootstrap.ts` | Add `websocket` variant to `RuntimeTransportMetadata` discriminated union, change to `transports` array |
| `src/main/runtime/runtime-rpc.ts` | Extract `UnixSocketTransport` from existing code, add `WebSocketTransport` (with `wss://` via self-signed TLS), support binding both simultaneously |
| `src/cli/runtime/transport.ts` | Select transport from `transports` array by kind (CLI picks unix/pipe, mobile picks websocket) |

**Transport metadata extension:**
```typescript
export type RuntimeTransportMetadata =
  | { kind: 'unix'; endpoint: string }
  | { kind: 'named-pipe'; endpoint: string }
  | { kind: 'websocket'; endpoint: string }  // e.g., "wss://0.0.0.0:6768"
```

**Bootstrap metadata extension:**
```typescript
export type RuntimeMetadata = {
  runtimeId: string
  pid: number
  transports: RuntimeTransportMetadata[]  // all active transports
  authToken: string | null
  startedAt: number
}
```

The `transports` array contains all active transports. The CLI picks the unix/pipe entry, mobile picks the websocket entry. This scales naturally — when relay is added in Phase 1, it's just another entry in the array. No more awkward optional fields or special-casing.

**Design decision — WebSocket connections are long-lived**, unlike Unix socket (one connection per request). This is important because:
- Mobile connections are expensive to re-establish (especially over relay later)
- We need streaming for terminal output (streaming subscriptions below)
- Multiple requests can be multiplexed on the same connection via the existing `id` field
- The dispatcher already correlates requests/responses by `id`, so this works without changes to the RPC core

**Note on `handleConnection` rearchitecture:** The current `handleConnection` in `runtime-rpc.ts` assumes one-shot request/response with a 30-second idle timeout. WebSocket transport requires a fundamentally different connection lifecycle model: long-lived, bidirectional, no idle timeout. This is not a patch — it's a rearchitecture of the connection handler, which is why extracting the transport interface is the right first step. The transport abstraction isolates this difference so the Unix socket handler can keep its existing behavior while the WebSocket handler implements the long-lived model.

#### Streaming subscription pattern

Current RPC is request/response only (`terminal.read` polls with a cursor). Add a subscription pattern that allows multiple responses per request ID:

```
Client sends:
→ {id: "sub-1", authToken: "...", method: "terminal.subscribe", params: {ptyId: "x"}}

Server streams back (same id, multiple responses):
← {id: "sub-1", ok: true, streaming: true, result: {type: "data", chunk: "ls -la\n"}, _meta: {...}}
← {id: "sub-1", ok: true, streaming: true, result: {type: "data", chunk: "total 48\n..."}, _meta: {...}}
← {id: "sub-1", ok: true, streaming: true, result: {type: "end"}, _meta: {...}}

Client can unsubscribe:
→ {id: "unsub-1", authToken: "...", method: "terminal.unsubscribe", params: {subscriptionId: "sub-1"}}
```

This reuses the existing RPC envelope — just allows multiple responses per request. Only works over WebSocket (Unix socket transport stays one-shot, unaffected).

**Client-side correlation model for subscriptions:** Subscription responses use a fundamentally different correlation model than one-shot request/response. The client must NOT use a Promise-per-request-ID pattern for subscriptions — a subscription emits multiple responses over time, so a single Promise would resolve on the first response and miss everything after it. Instead, the client registers an event callback/listener keyed by the subscription ID. The `streaming: true` flag on the response envelope lets the client distinguish subscription responses from one-shot responses and route them accordingly. Sentinel values signal lifecycle: `type: "end"` means the subscription completed normally (client should clean up the listener), and `type: "error"` means the subscription failed (client should clean up and surface the error).

```typescript
// Client-side subscription pattern (conceptual)
function subscribe(method: string, params: object, onData: (chunk: any) => void): () => void {
  const id = nextId();
  send({ id, authToken, method, params });

  // Register a listener — NOT a Promise — for this subscription ID
  subscriptionListeners.set(id, (response) => {
    if (response.result.type === "data") onData(response.result);
    if (response.result.type === "end" || response.result.type === "error") {
      subscriptionListeners.delete(id);  // clean up
    }
  });

  // Return an unsubscribe function
  return () => send({ id: nextId(), authToken, method: "terminal.unsubscribe", params: { subscriptionId: id } });
}

// In the WebSocket message handler, route by `streaming` flag:
ws.onmessage = (msg) => {
  const response = JSON.parse(msg.data);
  if (response.streaming && subscriptionListeners.has(response.id)) {
    subscriptionListeners.get(response.id)(response);  // streaming → listener
  } else {
    pendingPromises.get(response.id)?.resolve(response);  // one-shot → Promise
  }
};
```

**Files to modify:**

| File | Change |
|------|--------|
| `src/main/runtime/rpc/core.ts` | Add `RpcStreamingMethod` type alongside `RpcMethod`, extend dispatcher to support streaming responses, add per-connection subscription tracking |
| `src/main/runtime/rpc/methods/terminal.ts` | Add `terminal.subscribe` and `terminal.unsubscribe` |
| `src/main/runtime/rpc/methods/index.ts` | Register new methods |

**Subscription cleanup on disconnect:** The server tracks active subscriptions per WebSocket connection using a `Map<connectionId, Set<subscriptionId>>`. When a connection closes (graceful or unexpected), all its subscriptions are automatically cleaned up. This prevents resource leaks from mobile clients that lose connectivity without explicitly unsubscribing — which is the common case on mobile (app backgrounded, network switch, phone locked).

**Estimated effort for Phase 0a:** 1-2 weeks

---

### Phase 0b: Mobile Companion App (2-3 weeks)

**Goal:** Ship a minimal mobile app with secure pairing. Depends on Phase 0a being stable — validate the WebSocket transport with `wscat` before building a mobile client on top of it.

#### TLS + per-device tokens

The existing runtime auth token lives in a `0o600`-permissioned file — safe when it stays on disk. But QR code pairing makes it visible (displayed on screen, scanned by camera). Shipping the shared runtime auth token in QR payloads is a security downgrade we should avoid from the start.

**TLS setup:**
- Daemon generates a self-signed TLS certificate on first run (stored alongside the keypair in `$userData/`)
- WebSocket transport uses `wss://` not `ws://` — even on LAN, this prevents passive sniffing of auth tokens on shared WiFi
- The self-signed cert is acceptable for direct connections; the mobile app pins the certificate fingerprint received during pairing

**Per-device pairing tokens:**
- QR code contains a per-device pairing token, not the shared runtime auth token
- Per-device tokens are generated at pairing time using `crypto.randomBytes(24).toString('hex')`
- Tokens are stored in a device registry file at `$userData/orca-devices.json`
- Device registry format: `[{deviceId, name, token, pairedAt, lastSeenAt}]`
- Devices can be listed and revoked from the desktop app (settings panel)
- Revoking a device invalidates its token immediately — the device must re-pair

#### Pairing via QR code (direct connection)

For direct connection, the QR code contains:
```json
{
  "v": 1,
  "endpoint": "wss://192.168.1.100:6768",
  "deviceToken": "per-device-token-generated-at-pairing-time...",
  "certFingerprint": "sha256:..."
}
```

**Desktop side:**
- Show QR code in Orca settings or menu bar (use `qrcode` npm package)
- QR encodes `orca://pair#<base64url-encoded-JSON>`
- Generating the QR triggers creation of a new per-device token and stores it in the device registry
- Desktop UI shows a list of paired devices with option to revoke

**Mobile side:**
- Scan QR with expo-camera
- Decode endpoint + device token + certificate fingerprint
- Pin the TLS certificate fingerprint for this host
- Store in AsyncStorage as a host profile
- Connect via `wss://` WebSocket

**VPN / Tailscale works automatically:** If the daemon is bound to a Tailscale IP (e.g., `100.x.y.z:6768`), the QR contains that address and the phone connects over Tailscale. No special handling needed — the endpoint is just a different IP. This is actually better UX than Paseo's direct mode, which requires the user to manually type an IP into a text field.

**The QR payload is designed to evolve** as we add capabilities:

```
Phase 0b (direct only):
{v: 1, endpoint: "wss://192.168.1.100:6768", deviceToken: "...", certFingerprint: "sha256:..."}

Phase 1 (relay):
{v: 2, serverId: "...", daemonPublicKeyB64: "...", relay: {endpoint: "relay.orca.dev:443"}}

Self-hosted relay:
{v: 2, serverId: "...", daemonPublicKeyB64: "...", relay: {endpoint: "relay.corp-internal.com:443"}}
```

The mobile app reads the version field and handles each format. Self-hosted relay is just a different `relay.endpoint` value — no code change on the mobile side. On the daemon side, the relay endpoint is configurable via env var (e.g., `ORCA_RELAY_ENDPOINT`), same pattern as Paseo's `PASEO_RELAY_ENDPOINT`.

#### Minimal mobile app

**Tech stack:**

| Component | Choice |
|-----------|--------|
| Framework | React Native + Expo (managed workflow) |
| Build | EAS Build — internal distribution (no app store) |
| State | Zustand |
| Navigation | Expo Router |
| Storage | @react-native-async-storage |
| Primary Input | Voice dictation (separate branch, to be integrated) |
| Secondary Input | Text field for short messages and approvals |

**Voice-first design note:** The primary input mode is voice dictation (being built on a separate branch to be combined later). Text input exists as a secondary option for short messages, approvals, and quick corrections. This affects screen design — prioritize output readability (large text, clear status indicators, generous spacing) and voice input affordances (prominent mic button, waveform feedback, hands-free flow). The input bar should be optimized for voice-to-text, not keyboard typing.

**MVP screens:**
1. **Pair screen** — scan QR code to connect
2. **Worktree list** — show active worktrees from `worktree.list`
3. **Session view** — live agent output (optimized for readability on small screens), agent status. **Data source:** the session view is built on terminal subscriptions (`terminal.subscribe`), not a separate agent API. In Orca, agent sessions flow through terminal PTYs — the terminal output IS the agent output. Agent status detection already exists in the codebase via terminal title parsing (`extractLastOscTitle` / `detectAgentStatusFromTitle`), which reads OSC escape sequences that agents emit to signal their current state (thinking, executing, idle, etc.). The session view therefore displays two things: (1) the live terminal output stream from `terminal.subscribe`, and (2) the detected agent status derived from terminal title changes. No new agent-specific RPC methods are needed for MVP — `terminal.subscribe` covers the streaming output, and agent status comes from parsing the terminal title in the existing output stream.
4. **Input bar** — voice dictation button (primary) + text field (secondary) for follow-up messages
5. **Devices screen** — list paired devices, revoke access (desktop-side, but mobile should show its own pairing status)

**Estimated effort for Phase 0b:** 2-3 weeks (depends on Phase 0a being stable)

---

### Phase 1: Relay Transport (Hosted Infra)

**Goal:** Allow mobile clients to reach the daemon when not on the same network.

Because of the transport abstraction from Phase 0a, relay is implemented as a new `RelayTransport` that wraps WebSocket with:
- Outbound connection from daemon to relay service (no open ports on user's machine)
- ConnectionId-based routing (relay matches daemon and mobile client)
- E2E encryption layer (ECDH key exchange + XSalsa20-Poly1305 via tweetnacl)

**Nothing above the transport layer changes.** The RPC dispatcher, subscription pattern, mobile app screens — all unchanged. The mobile app just gets a new connection type in its host profile.

**QR payload extends to:**
```json
{
  "v": 2,
  "serverId": "...",
  "daemonPublicKeyB64": "...",
  "relay": { "endpoint": "relay.orca.dev:443" }
}
```

**Relay deployment:** Cloudflare Workers + Durable Objects (following Paseo's proven pattern).

**Relay endpoint should be configurable** via env var (e.g., `ORCA_RELAY_ENDPOINT`) so enterprise users can self-host.

**Estimated effort:** 2-3 weeks

---

### Phase 2: Polish + Distribution

**Goal:** Make the mobile app ready for wider distribution.

- Push notifications (expo-notifications) for attention-needed states
- App store submission (iOS App Store, Google Play)
- Permission request approval/denial UI
- Reconnection handling (background/foreground transitions, network changes)
- Device management UI polish (rename devices, usage stats, last-seen timestamps)

**Estimated effort:** 2-3 weeks

---

### Phase 3: Voice (Post-MVP)

**Goal:** Add voice input/output to mobile.

1. Build or adopt a custom Expo native module for PCM capture/playback (16-bit, 16kHz)
2. Stream PCM chunks to daemon over encrypted channel
3. Daemon runs STT (local ONNX or cloud provider) and returns text
4. For TTS: daemon streams audio chunks back, mobile plays them

**Estimated effort:** 3-4 weeks

---

## Development, Build, and Testing Guide

### Prerequisites

- Node.js 18+ and pnpm (already in use for Nautilus)
- Expo CLI: `npx expo` (no global install needed)
- Android Studio (for Android SDK + emulator, or building APKs for physical device)
- Xcode (for iOS Simulator — comes free with macOS, no Apple Developer account needed)

No paid services required for development. No Expo account needed. All builds run locally.

### First-Time Setup

```bash
cd Nautilus/mobile

# Install dependencies
pnpm install

# Generate native Android project (one-time, or after adding native modules)
npx expo prebuild --platform android

# Build debug APK for your Android phone
cd android && ./gradlew assembleDebug
# APK at: android/app/build/outputs/apk/debug/app-debug.apk
# Install on phone via USB: adb install app-debug.apk

# Start dev server with hot reload
npx expo start --dev-client
# Open the dev client app on your phone — it connects to the dev server
```

After this one-time setup, daily development is just `npx expo start --dev-client` — hot reload works instantly. **You only need to rebuild the APK when adding new native modules** (e.g., expo-camera, expo-notifications) or changing native config in `app.config.ts`.

### Development Workflows

**Android phone (primary — your setup):**
1. One-time: build APK locally, install on phone via USB
2. Daily: `npx expo start --dev-client` → open dev client on phone → hot reload

**iOS Simulator (for cross-platform confidence):**
1. `npx expo prebuild --platform ios` (one-time)
2. `npx expo start --dev-client` → press `i` → opens in iOS Simulator
3. No Apple Developer account needed for simulator
4. Catches iOS-specific layout/behavior differences

**Android Emulator (alternative to physical phone):**
1. Open Android Studio → Virtual Device Manager → create device (e.g., Pixel 8, API 34)
2. `npx expo start --dev-client` → press `a` → opens in emulator

**Mock server (for UI development without running Orca):**
```bash
# In a separate terminal:
pnpm mock-server
# Starts a fake WebSocket server on localhost:6768 that responds to RPC methods
# with realistic test data — no need to run the full Electron app
```

### Cross-Platform Confidence Without an iPhone

Since you only have an Android phone, use these to ensure iOS works:

1. **iOS Simulator** — runs on your Mac via Xcode, free. Covers ~95% of iOS-specific issues (safe areas, keyboard, gestures).
2. **CI builds** — GitHub Actions `macos-latest` runners can build iOS. Add to PR checks:
   ```bash
   npx expo prebuild --platform ios
   cd ios && xcodebuild -workspace OrcaMobile.xcworkspace -scheme OrcaMobile \
     -configuration Debug -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 16' \
     build
   ```
3. **React Native's cross-platform abstractions** handle most differences. The main risk areas: keyboard avoidance, safe area insets (notch/dynamic island), background suspension behavior, permission prompt timing.

### Testing the WebSocket Connection

For testing the transport layer without a mobile app:

```bash
# Start Orca with WebSocket transport enabled
# Then test with wscat or any WebSocket client:
npx wscat -c wss://localhost:6768 --no-check

# Send a JSON-RPC request:
{"id":"test-1","authToken":"<token-from-orca-runtime.json>","method":"status.get","params":{}}
```

### Testing Direct Connection (Phone → Computer)

1. Computer and phone must be on the same WiFi network
2. Find your computer's local IP: `ifconfig | grep "inet " | grep -v 127.0.0.1`
3. Ensure the WebSocket transport binds to `0.0.0.0` (not `127.0.0.1`) so it's reachable from the phone
4. Test from phone browser or app: `wss://<your-ip>:6768` (self-signed cert — app pins fingerprint from pairing)

### Project Structure

The mobile app lives as a standalone directory in the Nautilus repo (not a pnpm workspace member — avoids any risk of breaking the Electron build):

```
Nautilus/
├── src/              # Existing Electron app (untouched)
├── mobile/           # New: standalone Expo app
│   ├── app/          # Expo Router file-based routes
│   ├── src/
│   │   ├── components/
│   │   ├── stores/        # Zustand stores
│   │   └── transport/     # WebSocket client + RPC types
│   ├── scripts/
│   │   └── mock-server.ts # Standalone mock for UI development
│   ├── app.config.ts
│   ├── package.json       # Own dependencies, own node_modules
│   └── tsconfig.json
├── package.json      # Existing Electron package.json (untouched)
└── ...
```

For shared types (`RpcRequest`, `RpcResponse`, `RuntimeMetadata`): copy the few needed types into `mobile/src/transport/` for now. Extract a shared package later once the interface stabilizes.

### Contributor DevEx

To make it easy for others to contribute from day one:

**1. Mock server** — the most important thing. Without it, every contributor needs the full Electron app running. `pnpm mock-server` starts a standalone WebSocket server that responds to `status.get`, `worktree.list`, `terminal.subscribe` with realistic fake data. ~1 day to build, eliminates the biggest setup friction.

**2. Scripts in `mobile/package.json`:**
```json
{
  "scripts": {
    "dev": "expo start --dev-client",
    "dev:android": "expo start --dev-client --android",
    "dev:ios": "expo start --dev-client --ios",
    "mock-server": "tsx scripts/mock-server.ts",
    "build:android": "expo prebuild --platform android && cd android && ./gradlew assembleDebug",
    "build:ios": "expo prebuild --platform ios",
    "lint": "oxlint",
    "format": "oxfmt --write .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

**3. Match main repo tooling:** same linter (oxlint), formatter (oxfmt), test runner (vitest), TypeScript strict mode.

**4. README.md in `mobile/`** covering:
- Prerequisites (Node, Android Studio or Xcode)
- First-time setup (4-5 commands)
- "I have an Android phone" vs "I only have a Mac" paths
- How to use the mock server
- How to connect to a real running Orca instance

**5. CI (GitHub Actions):**
```yaml
# On every PR — runs on ubuntu-latest (free):
- pnpm typecheck
- pnpm lint
- pnpm test
- npx expo prebuild --platform android && cd android && ./gradlew assembleDebug

# Nightly or weekly — runs on macos-latest:
- npx expo prebuild --platform ios && xcodebuild ... -sdk iphonesimulator build
```

Android CI runs on free Ubuntu runners. iOS CI requires macOS runners (free for public repos, paid minutes for private — but only needs to run nightly, not per-PR).

---

## Infrastructure Requirements Summary

### Phase 0a + 0b (Minimal — No Hosted Infra, No Paid Services)

| Requirement | Cost |
|-------------|------|
| Android Studio (for SDK + builds) | Free |
| Xcode (for iOS Simulator) | Free (macOS only) |
| Android phone or emulator | Free |
| Same WiFi network | Free |

No Expo account, no EAS Build, no cloud services.

### Phase 1+ (Relay)

| Service | Platform | Cost Model |
|---------|----------|------------|
| **Relay service** | Cloudflare Workers + Durable Objects | Pay-per-use (~$0.15/M requests + $0.50/M DO operations) |
| **Push notification backend** | Firebase Cloud Messaging (Android) + APNs (iOS) via Expo Push | Free (Expo handles routing) |

### App Store (Phase 2+)

| Store | Cost |
|-------|------|
| Apple Developer Program | $99/year (required for TestFlight / App Store) |
| Google Play Developer Account | $25 one-time |

### Optional: EAS Build (Convenience, Not Required)

EAS Build is Expo's cloud build service. It's useful if you want to build iOS without a Mac or avoid maintaining local Android SDK, but it's not required — everything can be built locally or on your own CI.

- Free tier: 30 builds/month per platform
- Paid: $99/month for 500 builds

---

## Maintenance Burden

A mobile app adds ongoing work in:

- iOS and Android OS compatibility (major OS releases annually)
- App store submissions, screenshots, metadata, privacy disclosures (Phase 2+)
- Permission handling across OS versions
- Reconnect / backgrounding behavior
- Version compatibility between mobile app and host runtime
- Notification infrastructure (Phase 2+)
- Expo SDK upgrades (roughly quarterly)

This is manageable if the mobile app is a remote companion, not a full mobile IDE.

---

## Main Takeaways

1. **Paseo's architecture is well-documented and proven.** The original notes were accurate. Key additions: relay runs on Cloudflare Durable Objects, tech stack is modern (RN 0.81, Expo SDK 54, React 19), and the encryption/pairing implementation is solid.

2. **Orca is closer than expected.** The daemon, RPC layer, auth model, and API surface already exist. The main gap is transport (WebSocket) and relay infrastructure.

3. **Start with direct WebSocket, design for relay.** Phase 0a + 0b require zero hosted infrastructure and zero paid services — just a WebSocket server on the daemon and a mobile app on the same network. The transport abstraction ensures relay slots in later without rewriting anything above the transport layer. Splitting transport infrastructure (0a) from the mobile app (0b) ensures the foundation is solid before building on it.

4. **Relay is needed for the "just works" experience, but direct connections are also an option.** The relay is what makes QR-scan-and-go work without VPN/port-forwarding. But Paseo also supports direct TCP connections for users on the same LAN or using Tailscale. We should support both: relay as the recommended default, direct as an advanced option. Note that Paseo's team hosts `relay.paseo.sh` on their own Cloudflare account — there is no explicit guarantee it stays free, and no self-hosting guide exists.

5. **All builds run locally or on your own CI.** No paid cloud build services required. Android builds on any machine with Android SDK. iOS builds on any Mac with Xcode. EAS Build is an optional convenience, not a dependency.

6. **Mock server is the key to good contributor DevEx.** It lets anyone work on the mobile app without running the full Electron app. Set this up early.

7. **Total estimated timeline:** Phase 0a is ~1-2 weeks (transport infrastructure). Phase 0b is ~2-3 weeks (TLS + per-device tokens + mobile app). Phase 1 adds ~2-3 weeks for relay. Phase 2 adds ~2-3 weeks for polish and app store.
