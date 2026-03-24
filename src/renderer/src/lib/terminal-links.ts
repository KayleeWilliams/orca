export type ParsedTerminalFileLink = {
  pathText: string
  line: number | null
  column: number | null
  startIndex: number
  endIndex: number
  displayText: string
}

export type ResolvedTerminalFileLink = {
  absolutePath: string
  line: number | null
  column: number | null
}

const FILE_LINK_CANDIDATE_REGEX =
  /(?:\/|\.{1,2}\/|[A-Za-z0-9._-]+\/)[A-Za-z0-9._~\-/]*(?::\d+)?(?::\d+)?/g

const LEADING_TRIM_CHARS = new Set(['(', '[', '{', '"', "'"])
const TRAILING_TRIM_CHARS = new Set([')', ']', '}', '"', "'", ',', ';', '.'])

function trimBoundaryPunctuation(
  value: string,
  startIndex: number
): { text: string; startIndex: number; endIndex: number } | null {
  let start = 0
  let end = value.length

  while (start < end && LEADING_TRIM_CHARS.has(value[start])) {
    start += 1
  }
  while (end > start && TRAILING_TRIM_CHARS.has(value[end - 1])) {
    end -= 1
  }

  if (start >= end) {
    return null
  }

  return {
    text: value.slice(start, end),
    startIndex: startIndex + start,
    endIndex: startIndex + end
  }
}

function parsePathWithOptionalLineColumn(value: string): {
  pathText: string
  line: number | null
  column: number | null
} | null {
  const match = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(value)
  if (!match) {
    return null
  }
  const pathText = match[1]
  if (!pathText || pathText.endsWith('/')) {
    return null
  }

  const line = match[2] ? Number.parseInt(match[2], 10) : null
  const column = match[3] ? Number.parseInt(match[3], 10) : null
  if ((line !== null && line < 1) || (column !== null && column < 1)) {
    return null
  }

  return { pathText, line, column }
}

function normalizeAbsolutePosixPath(pathValue: string): string {
  const segments = pathValue.split('/')
  const stack: string[] = []
  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (stack.length > 0) {
        stack.pop()
      }
      continue
    }
    stack.push(segment)
  }
  return `/${stack.join('/')}`
}

export function extractTerminalFileLinks(lineText: string): ParsedTerminalFileLink[] {
  const results: ParsedTerminalFileLink[] = []
  const matches = lineText.matchAll(FILE_LINK_CANDIDATE_REGEX)
  for (const match of matches) {
    const rawText = match[0]
    const rawStart = match.index ?? 0

    const trimmed = trimBoundaryPunctuation(rawText, rawStart)
    if (!trimmed) {
      continue
    }

    const candidateText = trimmed.text
    if (candidateText.includes('://')) {
      continue
    }
    const prefix = lineText.slice(0, trimmed.startIndex)
    if (/[A-Za-z][A-Za-z0-9+.-]*:\/\/$/.test(prefix)) {
      continue
    }
    if (!candidateText.includes('/')) {
      continue
    }

    const parsed = parsePathWithOptionalLineColumn(candidateText)
    if (!parsed) {
      continue
    }

    results.push({
      pathText: parsed.pathText,
      line: parsed.line,
      column: parsed.column,
      startIndex: trimmed.startIndex,
      endIndex: trimmed.endIndex,
      displayText: candidateText
    })
  }

  return results
}

export function resolveTerminalFileLink(
  parsed: ParsedTerminalFileLink,
  cwd: string
): ResolvedTerminalFileLink | null {
  if (!cwd.startsWith('/')) {
    return null
  }

  const absolutePath = parsed.pathText.startsWith('/')
    ? normalizeAbsolutePosixPath(parsed.pathText)
    : normalizeAbsolutePosixPath(`${cwd.replace(/\/+$/, '')}/${parsed.pathText}`)

  return {
    absolutePath,
    line: parsed.line,
    column: parsed.column
  }
}

export function isPathInsideWorktree(filePath: string, worktreePath: string): boolean {
  const normalizedFile = normalizeAbsolutePosixPath(filePath)
  const normalizedWorktree = normalizeAbsolutePosixPath(worktreePath)
  if (normalizedFile === normalizedWorktree) {
    return true
  }
  return normalizedFile.startsWith(`${normalizedWorktree}/`)
}

export function toWorktreeRelativePath(filePath: string, worktreePath: string): string | null {
  const normalizedFile = normalizeAbsolutePosixPath(filePath)
  const normalizedWorktree = normalizeAbsolutePosixPath(worktreePath)
  if (normalizedFile === normalizedWorktree) {
    return ''
  }
  if (!normalizedFile.startsWith(`${normalizedWorktree}/`)) {
    return null
  }
  return normalizedFile.slice(normalizedWorktree.length + 1)
}
