/**
 * Runtime probe for the active macOS keyboard layout.
 *
 * Runs detectOptionAsAltFromLayoutMap() at boot and on every window focus-in.
 *
 * Why focus-in and not `layoutchange`: Chromium does not implement the W3C
 * Keyboard API's `layoutchange` event — its Blink IDL exposes only
 * `lock/unlock/getLayoutMap`
 * (chromium/src/third_party/blink/renderer/modules/keyboard/keyboard.idl).
 * Subscribing to `layoutchange` is a no-op. Fortunately every real-world
 * path to switching OS keyboard layout on macOS (Input Menu, Cmd+Space,
 * global shortcut) transfers focus out of Orca and back, so focus-in is a
 * reliable proxy. The only missed case is a layout change triggered by a
 * key pressed while Orca is focused (e.g. a Karabiner rule), which is
 * exceedingly rare and self-heals on the next blur/focus cycle.
 *
 * Why two signals (fingerprint + input source ID): the fingerprint can only
 * see the base (unshifted) layer, which is identical to US QWERTY on
 * Polish Pro, US Extended, ABC Extended, and the CJK Roman IMEs — all of
 * which use Option as a dead-key / compose modifier. Without the input
 * source ID override, those users get macOptionIsMeta=true and lose every
 * Option+letter composition (issue #1205). See
 * ./input-source-id.ts for the denylist.
 */
import {
  detectOptionAsAltFromLayoutMap,
  type DetectedLayoutCategory,
  type LayoutMapLike
} from './detect-option-as-alt'
import { classifyInputSourceId } from './input-source-id'

type NavigatorWithKeyboard = Navigator & {
  keyboard?: {
    getLayoutMap: () => Promise<LayoutMapLike>
  }
}

type Listener = (category: DetectedLayoutCategory) => void

type InputSourceIdReader = () => Promise<string | null>

export type OptionAsAltProbe = {
  /** Current detected category. Starts `'unknown'` until the first probe
   *  resolves (within a few ms of app boot); listeners fire on every
   *  category change. */
  getCurrent: () => DetectedLayoutCategory
  subscribe: (listener: Listener) => () => void
  /** Force a re-probe. Safe to call from tests or debug tooling. */
  refresh: () => Promise<void>
  /** Detach all window listeners. Tests only. */
  dispose: () => void
}

type CreateProbeOptions = {
  /** Injectable reader for the macOS input source ID. Defaults to the
   *  preload `window.api.app.getKeyboardInputSourceId` when available.
   *  Tests pass a stub to exercise the compose override deterministically. */
  readInputSourceId?: InputSourceIdReader
}

function defaultInputSourceIdReader(): InputSourceIdReader {
  return async () => {
    const api = (
      globalThis as {
        window?: { api?: { app?: { getKeyboardInputSourceId?: () => Promise<string | null> } } }
      }
    ).window?.api
    const reader = api?.app?.getKeyboardInputSourceId
    if (!reader) {
      return null
    }
    try {
      return await reader()
    } catch {
      // Why: the IPC can transiently reject during main-process teardown
      // (e.g. app quitting mid-probe). Treat as no signal so the
      // fingerprint remains the sole input.
      return null
    }
  }
}

export function createOptionAsAltProbe(
  win: Window = window,
  options: CreateProbeOptions = {}
): OptionAsAltProbe {
  let current: DetectedLayoutCategory = 'unknown'
  const listeners = new Set<Listener>()
  let disposed = false
  const readInputSourceId = options.readInputSourceId ?? defaultInputSourceIdReader()

  const notify = (next: DetectedLayoutCategory): void => {
    if (next === current) {
      return
    }
    current = next
    for (const listener of listeners) {
      try {
        listener(next)
      } catch (err) {
        console.error('[option-as-alt-probe] listener threw:', err)
      }
    }
  }

  const probe = async (): Promise<void> => {
    if (disposed) {
      return
    }
    const nav = win.navigator as NavigatorWithKeyboard
    const keyboard = nav?.keyboard

    // Why: read the input-source ID first — if it's on the compose
    // denylist, we skip the layout-map fetch entirely. The ID is a macOS
    // -only string; non-Darwin resolves to null and leaves the
    // fingerprint as the only signal.
    let inputSourceId: string | null = null
    try {
      inputSourceId = await readInputSourceId()
    } catch {
      // Treat errors as no signal — the fingerprint still runs below.
      inputSourceId = null
    }

    if (disposed) {
      return
    }

    // Why: input-source override wins over the fingerprint whenever the ID
    // is on the compose denylist (Polish Pro, US Extended, CJK Roman IMEs,
    // …). These layouts keep a US-looking base layer so the fingerprint
    // would otherwise classify them as 'us' → macOptionIsMeta=true, which
    // silently swallows every Option+letter dead-key (#1205). Forcing
    // 'non-us' here makes the effective setting resolve to 'false'.
    if (classifyInputSourceId(inputSourceId) === 'compose') {
      notify('non-us')
      return
    }

    if (!keyboard?.getLayoutMap) {
      // Non-Chromium or Electron stripped of the Keyboard API. Stay at
      // 'unknown' → terminal defaults to 'false' (safe for non-US).
      notify('unknown')
      return
    }
    try {
      const map = await keyboard.getLayoutMap()
      if (disposed) {
        return
      }
      notify(detectOptionAsAltFromLayoutMap(map))
    } catch (err) {
      // getLayoutMap can reject in some Chromium corner cases (unavailable
      // permission, transient failure). Log once and keep the last known
      // good value so we don't silently regress a user mid-session.
      console.warn('[option-as-alt-probe] getLayoutMap rejected:', err)
    }
  }

  const onFocus = (): void => {
    void probe()
  }

  win.addEventListener('focus', onFocus)

  // Initial probe. Fire-and-forget; callers subscribe and pick up the
  // result as soon as Chromium's layout map resolves.
  void probe()

  return {
    getCurrent: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    refresh: probe,
    dispose: () => {
      disposed = true
      win.removeEventListener('focus', onFocus)
      listeners.clear()
    }
  }
}

/** Singleton probe for the app. Initialized lazily on first getter call so
 *  test environments without a `window` don't trigger side effects at
 *  import time. */
let _singleton: OptionAsAltProbe | null = null

export function getOptionAsAltProbe(): OptionAsAltProbe {
  if (!_singleton) {
    _singleton = createOptionAsAltProbe()
  }
  return _singleton
}

/** Test-only: reset the singleton. */
export function _resetOptionAsAltProbeForTests(): void {
  _singleton?.dispose()
  _singleton = null
}
