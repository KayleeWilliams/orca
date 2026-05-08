import type { SettingsSearchEntry } from './settings-search'

export const EXPERIMENTAL_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Mobile Pairing',
    description:
      'Pair a mobile device to control Orca remotely. Experimental — requires the Orca mobile APK from GitHub Releases.',
    keywords: [
      'experimental',
      'mobile',
      'phone',
      'pair',
      'qr',
      'code',
      'scan',
      'remote',
      'android',
      'apk'
    ]
  },
  {
    title: 'Sidekick',
    description: 'Floating animated sidekick in the bottom-right corner.',
    keywords: [
      'experimental',
      'sidekick',
      'pet',
      'mascot',
      'overlay',
      'animated',
      'corner',
      'character'
    ]
  },
  {
    title: 'Agent Orchestration',
    description:
      'Coordinate multiple coding agents via messaging, task DAGs, dispatch, and decision gates.',
    keywords: [
      'experimental',
      'orchestration',
      'multi-agent',
      'agents',
      'coordination',
      'messaging',
      'dispatch',
      'task',
      'DAG',
      'worker',
      'coordinator'
    ]
  },
  {
    title: 'Branch name suggestions',
    description:
      'Suggests a better name for Orca-created local branches after a supported agent finishes with commits.',
    keywords: [
      'experimental',
      'branch',
      'branches',
      'rename',
      'renaming',
      'suggestion',
      'agent',
      'hook',
      'claude',
      'codex',
      'gemini',
      'opencode'
    ]
  },
  {
    title: 'Symlinks on worktrees',
    description:
      'Automatically symlink configured files or folders into newly created worktrees so shared state (envs, caches, installs) stays connected.',
    keywords: [
      'experimental',
      'worktree',
      'worktrees',
      'symlink',
      'symlinks',
      'link',
      'links',
      'shared',
      'env',
      'node_modules'
    ]
  }
]

// Why: title-keyed lookup avoids a fragile numeric-index invariant — the array
// shape can change without breaking consumers, and a typo/rename throws loudly
// instead of silently matching the wrong (or empty) entry.
function findEntry(title: string): SettingsSearchEntry {
  const entry = EXPERIMENTAL_PANE_SEARCH_ENTRIES.find((e) => e.title === title)
  if (!entry) {
    throw new Error(`Missing experimental-pane search entry: "${title}"`)
  }
  return entry
}

export const EXPERIMENTAL_SEARCH_ENTRY = {
  mobile: findEntry('Mobile Pairing'),
  sidekick: findEntry('Sidekick'),
  orchestration: findEntry('Agent Orchestration'),
  branchNames: findEntry('Branch name suggestions'),
  symlinks: findEntry('Symlinks on worktrees')
} as const
