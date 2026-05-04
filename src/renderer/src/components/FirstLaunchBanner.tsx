// Existing-user first-launch notice. Shown to users whose cohort marker is
// `existedBeforeTelemetryRelease === true` and whose `optedIn` is still
// `null`, i.e. users who installed Orca before the telemetry release and
// have not yet resolved the notice.
//
// Why existing users see a notice at all (and new users do not): pre-
// telemetry users installed Orca under a "no telemetry" social contract,
// so default-on for them would be a silent policy flip. New users are
// covered by the install-time disclosure and receive no first-launch UI —
// see telemetry-plan.md §First-launch experience.
//
// Three actions, three semantics:
//   - ✕ (top-right) → silent acknowledge. Persists `optedIn: true`, fires
//     nothing. Routes through `window.api.telemetryAcknowledgeBanner()` to
//     a dedicated main-side channel so no `via` derivation can tag this
//     path. The ✕ IS the opt-in action for this cohort: the user sees the
//     notice, chooses not to intervene, and is opted in silently — the
//     same shape every direct-shape competitor ships.
//   - "Turn off" → explicit opt-out. Routes through
//     `window.api.telemetrySetOptIn(false)`; main derives
//     `via = 'first_launch_banner'` from the pre-mutation state
//     (existedBeforeTelemetryRelease=true, optedIn=null, incoming=false)
//     and fires `telemetry_opted_out { via: 'first_launch_banner' }`
//     BEFORE disabling the SDK — the one signal that tells us the
//     opt-out flow is working must not be silenced by the opt-out it
//     announces.
//   - "Privacy policy" → opens the privacy doc URL, no state change, no
//     dismiss.
//
// No auto-dismiss, no delayed re-ask: once resolved (✕ or Turn off), the
// notice never returns, because the cohort condition (`optedIn === null`)
// clears in both paths.

import { useState } from 'react'
import { X } from 'lucide-react'

import { Button } from './ui/button'
import { acknowledgeBanner, PRIVACY_URL, setOptIn as telemetrySetOptIn } from '../lib/telemetry'

type FirstLaunchBannerProps = {
  onResolve: () => void
  fetchSettings: () => Promise<void>
}

export function FirstLaunchBanner({
  onResolve,
  fetchSettings
}: FirstLaunchBannerProps): React.JSX.Element {
  // Double-click guard. Without this, a fast second click on "Turn off"
  // would re-enter telemetrySetOptIn(false); on the second call, main's
  // deriveOptInVia sees currentOptedIn=false (just persisted by click 1)
  // and falls through to the 'settings' branch, producing one opt-out
  // intent tagged as two different `via` values. The ✕ path is guarded
  // symmetrically — a second click there would be a wasted IPC round-trip,
  // but the guard also blocks a Turn-off click that arrives mid-flight
  // after a ✕ click (or vice versa).
  const [inFlight, setInFlight] = useState(false)

  const handleAcknowledge = async (): Promise<void> => {
    if (inFlight) {
      return
    }
    setInFlight(true)
    // Main's `telemetry:acknowledgeBanner` handler persists `optedIn: true`
    // silently (no event) and intentionally does NOT broadcast
    // `settings:changed` (see src/main/ipc/telemetry.ts). Without an
    // explicit `fetchSettings()` refresh, the renderer store would retain
    // `optedIn: null` and PrivacyPane would keep rendering its pending-
    // banner helper text until the next full relaunch. Mirror
    // PrivacyPane's handleToggle pattern which refetches for the same
    // reason before surfacing UI changes.
    await acknowledgeBanner()
    await fetchSettings()
    onResolve()
  }

  const handleTurnOff = async (): Promise<void> => {
    if (inFlight) {
      return
    }
    setInFlight(true)
    // Opt-out fires `telemetry_opted_out { via: 'first_launch_banner' }`
    // BEFORE the SDK disable — main enforces that ordering inside
    // `setOptIn` (client.ts). The renderer just needs to route through
    // `telemetrySetOptIn(false)` so the IPC handler derives the correct
    // `via` and fires the event.
    await telemetrySetOptIn(false)
    await fetchSettings()
    onResolve()
  }

  return (
    // Fixed-top strip so the notice overlays whatever is beneath without
    // shifting the rest of the layout (the titlebar is ~42px; the notice
    // sits just below it). `top-11` ≈ 44px clears the titlebar on mac +
    // the full-width titlebar on other views; the notice is non-modal and
    // intentionally does not occlude the main content — clicks pass
    // through to below-notice regions outside this box.
    //
    // `relative` is load-bearing: the absolutely-positioned ✕ anchors to
    // this container. `pr-8` reserves space on the right edge so the ✕
    // does not visually overlap the "Turn off" button.
    <div
      className="fixed left-1/2 top-11 z-40 flex max-w-3xl -translate-x-1/2 items-start gap-4 rounded-xl border border-border bg-card/95 px-4 py-3 pr-8 text-sm shadow-lg backdrop-blur"
      role="region"
      aria-label="Telemetry notice"
      aria-live="polite"
    >
      <div className="flex-1 space-y-1">
        <p className="font-medium">Orca sends anonymous usage data</p>
        <p className="text-muted-foreground">
          We never send your file contents, prompts, terminal output, or anything that could
          identify you. Anonymous counts help us decide what to build next. You can change this
          anytime in Settings &rarr; Privacy.{' '}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => void window.api.shell.openUrl(PRIVACY_URL)}
          >
            Privacy policy
          </button>
          .
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button variant="outline" size="sm" onClick={handleTurnOff} disabled={inFlight}>
          Turn off
        </Button>
      </div>
      {/* ✕ in the top-right corner. aria-label names the semantic
          explicitly — "Dismiss" rather than "Close" — because the action
          persists silent opt-in, not just hides the UI. A second button
          labeled "Got it" alongside "Turn off" would visually compete
          and muddy the decision; the universal close control reads as
          "acknowledge and move on" without competing for attention. */}
      <button
        type="button"
        aria-label="Dismiss notice"
        onClick={handleAcknowledge}
        disabled={inFlight}
        className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
