import type { ITheme } from '@xterm/xterm'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { GlobalSettings } from '../../../../shared/types'
import { resolveTerminalFontWeights } from '../../../../shared/terminal-fonts'
import {
  getBuiltinTheme,
  resolvePaneStyleOptions,
  resolveEffectiveTerminalAppearance
} from '@/lib/terminal-theme'
import { buildFontFamily } from './layout-serialization'
import { captureScrollState, restoreScrollState } from '@/lib/pane-manager/pane-tree-ops'
import type { PtyTransport } from './pty-transport'
import type { EffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/detect-option-as-alt'

// Contour/Kitty "color-scheme update" protocol (DEC mode 2031 + CSI 997):
// the terminal pushes `CSI ?997;1n` for dark and `CSI ?997;2n` for light to
// subscribed TUIs. This helper is the single source of truth so the push
// site in applyTerminalAppearance and the subscribe-time seed in the
// lifecycle hook cannot drift.
export function mode2031SequenceFor(mode: 'dark' | 'light'): string {
  return mode === 'dark' ? '\x1b[?997;1n' : '\x1b[?997;2n'
}

// Gate on actual mode flip so font/size/opacity tweaks — which also re-run
// applyTerminalAppearance — don't spam subscribed TUIs with CSI 997. The
// subscribe/last-mode maps are mutated in place so callers share state with
// the lifecycle hook's seed path.
export function maybePushMode2031Flip(
  paneId: number,
  mode: 'dark' | 'light',
  transport: Pick<PtyTransport, 'isConnected' | 'sendInput'>,
  paneMode2031: Map<number, boolean>,
  paneLastThemeMode: Map<number, 'dark' | 'light'>
): boolean {
  if (!transport.isConnected()) {
    return false
  }
  if (!paneMode2031.get(paneId)) {
    return false
  }
  if (paneLastThemeMode.get(paneId) === mode) {
    return false
  }
  if (!transport.sendInput(mode2031SequenceFor(mode))) {
    return false
  }
  paneLastThemeMode.set(paneId, mode)
  return true
}

export function applyTerminalAppearance(
  manager: PaneManager,
  settings: GlobalSettings,
  systemPrefersDark: boolean,
  paneFontSizes: Map<number, number>,
  paneTransports: Map<number, PtyTransport>,
  effectiveMacOptionAsAlt: EffectiveMacOptionAsAlt,
  paneMode2031: Map<number, boolean>,
  paneLastThemeMode: Map<number, 'dark' | 'light'>
): void {
  const appearance = resolveEffectiveTerminalAppearance(settings, systemPrefersDark)
  const paneStyles = resolvePaneStyleOptions(settings)
  const theme: ITheme | null = appearance.theme ?? getBuiltinTheme(appearance.themeName)
  const paneBackground = theme?.background ?? '#000000'
  const terminalFontWeights = resolveTerminalFontWeights(settings.terminalFontWeight)

  for (const pane of manager.getPanes()) {
    if (theme) {
      pane.terminal.options.theme = theme
    }
    pane.terminal.options.cursorStyle = settings.terminalCursorStyle
    pane.terminal.options.cursorBlink = settings.terminalCursorBlink
    const paneSize = paneFontSizes.get(pane.id)
    pane.terminal.options.fontSize = paneSize ?? settings.terminalFontSize
    pane.terminal.options.fontFamily = buildFontFamily(settings.terminalFontFamily)
    pane.terminal.options.fontWeight = terminalFontWeights.fontWeight
    pane.terminal.options.fontWeightBold = terminalFontWeights.fontWeightBold
    // Why: xterm's macOptionIsMeta only flips on the 'true' mode. 'left' and
    // 'right' are handled in the keydown policy (terminal-shortcut-policy),
    // which needs Option to stay composable at the xterm level for the
    // non-Meta side. Treating only 'true' as Meta here matches the pre-
    // detection behavior; the detection layer simply decides *what* value
    // `effectiveMacOptionAsAlt` carries.
    pane.terminal.options.macOptionIsMeta = effectiveMacOptionAsAlt === 'true'
    pane.terminal.options.lineHeight = settings.terminalLineHeight
    try {
      const state = captureScrollState(pane.terminal)
      pane.fitAddon.fit()
      restoreScrollState(pane.terminal, state)
    } catch {
      /* ignore */
    }
    const transport = paneTransports.get(pane.id)
    if (transport?.isConnected()) {
      transport.resize(pane.terminal.cols, pane.terminal.rows)
      maybePushMode2031Flip(pane.id, appearance.mode, transport, paneMode2031, paneLastThemeMode)
    }
  }

  manager.setPaneStyleOptions({
    splitBackground: paneBackground,
    paneBackground,
    inactivePaneOpacity: paneStyles.inactivePaneOpacity,
    activePaneOpacity: paneStyles.activePaneOpacity,
    opacityTransitionMs: paneStyles.opacityTransitionMs,
    dividerThicknessPx: paneStyles.dividerThicknessPx,
    focusFollowsMouse: paneStyles.focusFollowsMouse
  })
}
