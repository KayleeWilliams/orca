# Design: Pet Overlay (v1)

**Branch:** `add-a-pet-for-orca`
**Status:** Draft — scoped for fast ship

## Problem

Orca has no idle-time personality surface. A small animated pet in the bottom-right corner gives the app a recognizable mascot and is the kind of detail users screenshot and share. It needs to be opt-in (some users find mascots distracting) and cheap when disabled.

## Goals (v1)

- Floating pet overlay pinned to bottom-right, above terminal panes and below modals.
- Toggled by an experimental flag in Settings → Experimental.
- "Hide pet" menu from a status-bar segment for quick dismissal without disabling the feature.
- Visually 3D / animated, not a flat SVG.
- Zero cost when disabled — no renderer weight, no dangling listeners.

## Non-goals (v1)

- Tint, accessories, full Pet Studio — follow-up.
- Drag-to-reposition — follow-up. Position is fixed bottom-right.
- Reactions to app state beyond a single idle loop — follow-up.
- Pet-to-pet multiplayer, voice/audio, reacting to code or AI output.

**In v1:** a model picker across three bundled GLBs (gremlin, blue demon, green blob) **plus user-uploaded custom GLBs**. Selection lives in `petModelId` on `PersistedUIState`, flipped from a Model submenu in the status-bar pet dropdown. Custom models live in `userData/pets/custom/<uuid>.glb` on disk and are listed alongside bundled models in the submenu, each with an inline Remove button. Upload goes through a `pet:import` IPC that opens a native file picker, validates size/extension, and copies the file into userData; the renderer fetches bytes via `pet:read` and renders them via a `blob:` URL so `webSecurity=true` and `sandbox=true` can stay enabled. Kept tiny on purpose — no separate pane, no per-model settings; this is the customization surface that fits on the existing dropdown without introducing a Pet Studio.

## Format decision: glTF (GLB) via three.js

Considered options:

| Format | 3D? | Size | Notes |
|---|---|---|---|
| SVG / Lottie | No | Tiny | Can't do realistic shading |
| Transparent WebM (VP9 alpha) | Pre-rendered | Medium | Baked pixels, no runtime variation |
| Sprite sheet (PNG frames) | No | Large | Rigid, no angle changes |
| **GLB + three.js** | Yes | ~500KB model + ~150KB gz (~600KB raw) for three + fiber subset | Real 3D, room to grow into customization |

**Decision: GLB + three.js.** Even without v1 customization, GLB is the only option that leaves the door open for the follow-up features without a format migration.

Stack: `three` + `@react-three/fiber`. All imports live behind a dynamic `import()` gated on the experimental flag so disabled users pay zero bytes.

## UI integration

### Experimental flag

Add to `GlobalSettings` in `src/shared/types.ts`:

```ts
/** Experimental: floating animated pet overlay in the bottom-right corner.
 *  Opt-in because it loads three.js (~150KB gz) and a GLB model; users who
 *  don't want it should pay zero cost. When false, the overlay component
 *  is never mounted and three.js is never imported. */
experimentalPet: boolean
```

Default `false`. Same pattern as `experimentalAgentDashboard` at `src/shared/types.ts:1047`, with one deliberate difference: `experimentalAgentDashboard` requires a relaunch because it gates hook installation in the main process; `experimentalPet` is purely renderer-side, so toggling it mounts/unmounts `PetOverlay` immediately and triggers the dynamic `import()` on first enable within a session.

### Status bar segment

`src/renderer/src/components/status-bar/StatusBar.tsx` gets a new `PetStatusSegment` (only rendered when `experimentalPet` is on). It does **not** participate in the user-configurable `statusBarItems` array (`src/shared/types.ts:1090`) in v1 — that list is for always-available provider/system segments, and gating pet visibility via two independent toggles (experimental flag + status-bar checkbox + in-menu "Hide pet") would be confusing. Revisit if/when pet promotes out of experimental.

Clicking the segment opens a menu with:

- **Hide pet** — flips a `petVisible` boolean stored on the ui slice. Kept separate from `experimentalPet` so a user can re-show without re-enabling the feature.
- **Pet settings…** — opens Settings → Experimental (just scrolls to the flag in v1; Pet Studio is follow-up).

### Persistence

`petVisible` must survive reload. Follow the existing pattern used by every other persisted UI field:

1. Add `petVisible: boolean` to `PersistedUIState` in `src/shared/types.ts:1098`.
2. Hydrate it in `hydratePersistedUI` in `src/renderer/src/store/slices/ui.ts` (default `true` when absent, so existing users see the pet the first time they enable the flag).
3. Include it in whatever the ui slice emits to the main-process persistence writer. No new persistence channel is needed — this is the same path `statusBarVisible`, `sidebarWidth`, etc. take.

`experimentalPet` itself lives on `GlobalSettings` and is persisted through the settings pipeline, not `PersistedUIState`.

### Overlay component

`src/renderer/src/components/pet/PetOverlay.tsx`:

- Mounted once at the app root, conditional on `experimentalPet && petVisible`.
- Fixed bottom-right canvas, `pointer-events: none` on the whole canvas. All interaction goes through the status-bar segment: a pet that eats clicks in the bottom-right would silently block terminal-pane interaction near the corner, and hit-testing a transparent GLB against actual mesh bounds (not the canvas rect) is non-trivial. Revisit once drag-to-reposition lands.
- Transparent background; `z-index` just under the modal layer.
- Single idle animation clip on loop.
- Pause the animation loop when `document.visibilityState !== 'visible'` to avoid burning battery in the background.
- Respect `prefers-reduced-motion` via `window.matchMedia('(prefers-reduced-motion: reduce)')`: when reduced, render a static first frame and skip the animation loop.
- If WebGL context creation fails (some Linux/VM setups), unmount silently — do not crash the app root. Log once.

### Architectural boundary

No pet-specific IPC and no main-process pet logic. Rendering, animation loop, visibility-state handling, and the `petVisible` toggle all live in the renderer. The only thing that crosses IPC is the generic `PersistedUIState` write-back that `petVisible` rides on, alongside every other persisted ui-slice field — this is existing infrastructure, not new plumbing. This matches the boundary documented in `CLAUDE.md`: cosmetic per-window state stays in the renderer.

## Rollout

1. Land experimental flag + overlay + status-bar segment behind `experimentalPet=false`, with one bundled gremlin GLB in `resources/pets/`.
2. Dogfood internally; watch for WebGL init failures across macOS/Windows/Linux.
3. Follow-up PRs: drag-to-reposition (expands position to all four corners), tint + accessories, additional models, custom GLB loading, state-reactive animation clips.
4. Promote out of experimental once no WebGL-init crash reports surface from dogfood and external bug channels across macOS/Windows/Linux. There is no in-app telemetry pipeline (grep confirms), so the bar is "no reported failures" rather than a measured success rate — log WebGL-init failures to the renderer console with a stable prefix (`[pet-overlay]`) so users who hit it can surface the string when reporting, and so dogfooders can grep their own logs.
