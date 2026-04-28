/**
 * Classifier for macOS's `AppleCurrentKeyboardLayoutInputSourceID`.
 *
 * Why this exists alongside detect-option-as-alt: the layout-fingerprint
 * probe (`detectOptionAsAltFromLayoutMap`) inspects `navigator.keyboard
 * .getLayoutMap()`, which only surfaces the base (unshifted) layer. Some
 * Apple-shipped layouts — most notably "Polish Pro" and the Japanese/Chinese
 * Roman modes — keep the base layer identical to US QWERTY but repurpose
 * the Option layer for character composition (Option+A = ą, Option+C = ć,
 * …). The fingerprint classifies these as `'us'`, the effective setting
 * resolves to `'true'`, xterm's `macOptionIsMeta` turns on, and every
 * Option+letter keystroke is silently translated to an Esc+letter
 * readline chord — so typing Polish diacritics, etc., fails with no
 * visible feedback (issue #1205).
 *
 * macOS exposes the active input source via the defaults value
 * `AppleCurrentKeyboardLayoutInputSourceID` (e.g. `com.apple.keylayout.US`,
 * `com.apple.keylayout.PolishPro`, `com.apple.inputmethod.Kotoeri.…`). This
 * module keeps an explicit denylist of IDs whose Option layer composes
 * characters even though the base layer looks US-like; anything on that
 * denylist overrides the fingerprint's `'us'` verdict.
 *
 * Reference:
 *   ~/projects/ghostty/macos/Sources/Helpers/KeyboardLayout.swift
 *   (Ghostty reads TISCopyCurrentKeyboardInputSource; same underlying
 *   identifier string as AppleCurrentKeyboardLayoutInputSourceID.)
 */

/**
 * Input source IDs whose Option layer composes layout characters even
 * though the unshifted layer matches US QWERTY on `getLayoutMap()`. On
 * these layouts the effective `macOptionAsAlt` must stay `'false'` so
 * Option+letter reaches xterm as a composed dead-key character instead of
 * being translated to an Esc+letter readline chord.
 *
 * Matching is case-insensitive on the full ID so future Apple-shipped
 * variants under the same product family (e.g. `PolishProUnicode`,
 * `Polish.…`) are still caught. Prefix matching is intentional —
 * Apple occasionally ships `.US` vs `.USExtended` pairs where the
 * extended variant also composes via Option.
 */
const COMPOSING_INPUT_SOURCE_PREFIXES: readonly string[] = [
  // Polish Pro: base layer is US QWERTY, Option+A/C/E/L/N/O/S/X/Z compose
  // the nine Polish diacritics (ą, ć, ę, ł, ń, ó, ś, ź, ż). Reported in #1205.
  'com.apple.keylayout.polishpro',
  // US Extended (formerly "US Extended" / "USExtended"): ships with macOS
  // and uses Option as a dead-key modifier for accents on A/E/I/O/U — same
  // shape as the Polish Pro trap. Matches Ghostty's classification.
  'com.apple.keylayout.usextended',
  // ABC Extended: Apple's newer replacement for US Extended. Base layer
  // matches US; Option composes accents and typographic punctuation.
  'com.apple.keylayout.abcextended',
  // Japanese/Chinese/Korean Roman modes route Option through the IME for
  // kana/pinyin input. The fingerprint sees a US-looking base layer
  // because the Roman mode reports ASCII, so we treat these as composing.
  'com.apple.inputmethod.kotoeri',
  'com.apple.inputmethod.tcim',
  'com.apple.inputmethod.scim',
  'com.apple.inputmethod.korean'
]

export type InputSourceOverride =
  /** Input source is known to compose layout characters via Option. The
   *  effective setting must be `'false'` regardless of what the layout
   *  fingerprint said. */
  | 'compose'
  /** Input source is recognized but does not compose via Option (e.g.
   *  plain `com.apple.keylayout.US`, `com.apple.keylayout.Dvorak`). Let
   *  the fingerprint decide. */
  | 'none'

export function classifyInputSourceId(id: string | null | undefined): InputSourceOverride {
  if (!id) {
    return 'none'
  }
  const normalized = id.toLowerCase()
  for (const prefix of COMPOSING_INPUT_SOURCE_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}.`)) {
      return 'compose'
    }
  }
  return 'none'
}

/** Test-only: exported so tests can assert the denylist membership
 *  directly without reimporting the private constant. */
export const __composingInputSourcePrefixesForTests: readonly string[] =
  COMPOSING_INPUT_SOURCE_PREFIXES
