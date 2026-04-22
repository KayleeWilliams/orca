// Shell-integration escape sequences that xterm.js does not handle natively.
// Host wires these per-pane in use-terminal-pane-lifecycle.ts (register in
// onPaneCreated, dispose in onPaneClosed) following the DEC 2031 / OSC 52
// pattern. See docs/shell-integration-design.md.
//
//   OSC 7:   shell cwd notification — emitted on every `cd` by a shell whose
//            rc includes a `precmd` hook. Payload is a file:// URI.
//   OSC 133: FinalTerm/iTerm semantic prompt marks. Payload starts with one
//            of A/B/C/D and may carry `;key=value` suffixes we ignore.

export type SemanticMarkKind = 'prompt-start' | 'prompt-end' | 'command-end' | 'done'

export type SemanticMark =
  | { kind: 'prompt-start' }
  | { kind: 'prompt-end' }
  | { kind: 'command-end' }
  | { kind: 'done'; exitCode: number | null }

// Why: URL parsing is the most robust way to strip the file://[host] prefix
// and percent-decode. Matches the main-side parser in
// src/main/daemon/history-manager.ts; the duplication is intentional —
// renderer code does not import from main. A later cleanup can hoist both
// into src/shared/.
export function parseOsc7Path(data: string): string | null {
  if (!data) {
    return null
  }
  try {
    const url = new URL(data)
    if (url.protocol !== 'file:') {
      return null
    }
    const decodedPath = decodeURIComponent(url.pathname)

    const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
    if (!isWindows) {
      return decodedPath
    }

    // Why: OSC 7 on Windows can carry UNC paths (\\host\share) or
    // drive-letter paths (/C:/Users/x). Preserve both so "Reveal in
    // Explorer" opens the right directory.
    if (url.hostname) {
      return `\\\\${url.hostname}${decodedPath.replace(/\//g, '\\')}`
    }
    if (/^\/[A-Za-z]:/.test(decodedPath)) {
      return decodedPath.slice(1).replace(/\//g, '\\')
    }
    return decodedPath.replace(/\//g, '\\')
  } catch {
    return null
  }
}

export function parseOsc133Payload(data: string): SemanticMark | null {
  if (!data) {
    return null
  }
  // Why: some emitters append `;key=value` hints (e.g. `A;cl=m`, `D;0`).
  // We only care about the leading letter and, for `D`, the first numeric
  // token — everything after the first `;` beyond the exit code is hint
  // data we do not consume today.
  const letter = data[0]
  switch (letter) {
    case 'A':
      return { kind: 'prompt-start' }
    case 'B':
      return { kind: 'prompt-end' }
    case 'C':
      return { kind: 'command-end' }
    case 'D': {
      const rest = data.slice(1)
      if (rest === '' || rest[0] !== ';') {
        return { kind: 'done', exitCode: null }
      }
      const codeToken = rest.slice(1).split(';', 1)[0]
      const code = Number.parseInt(codeToken, 10)
      return { kind: 'done', exitCode: Number.isFinite(code) ? code : null }
    }
    default:
      return null
  }
}

export type RecordedSemanticMark = SemanticMark & { row: number }

export const SEMANTIC_MARK_RING_CAPACITY = 10_000

// Why: long-running sessions with millions of commands would grow the array
// without bound. 10 000 marks at ~40 bytes each caps per-pane footprint at
// ~400 KB and matches what block-navigation consumers will reasonably scroll.
export function pushSemanticMark(
  marks: RecordedSemanticMark[],
  mark: RecordedSemanticMark,
  capacity: number = SEMANTIC_MARK_RING_CAPACITY
): RecordedSemanticMark[] {
  marks.push(mark)
  if (marks.length > capacity) {
    marks.splice(0, marks.length - capacity)
  }
  return marks
}
