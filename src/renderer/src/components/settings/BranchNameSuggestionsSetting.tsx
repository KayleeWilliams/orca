import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { EXPERIMENTAL_SEARCH_ENTRY } from './experimental-search'

const BRANCH_NAME_SUGGESTION_AGENTS: readonly TuiAgent[] = ['claude', 'codex', 'gemini', 'opencode']

const BRANCH_NAME_SUGGESTION_AGENT_ENTRIES = BRANCH_NAME_SUGGESTION_AGENTS.map((id) => {
  const entry = AGENT_CATALOG.find((agent) => agent.id === id)
  return { id, label: entry?.label ?? id }
})

type BranchNameSuggestionsSettingProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function BranchNameSuggestionsSetting({
  settings,
  updateSettings
}: BranchNameSuggestionsSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title="Branch name suggestions"
      description="Suggests a better name for Orca-created local branches after an agent finishes."
      keywords={EXPERIMENTAL_SEARCH_ENTRY.branchNames.keywords}
      className="space-y-3 px-1 py-2"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 shrink space-y-1.5">
          <Label>Branch name suggestions</Label>
          <p className="text-xs text-muted-foreground">
            After a supported agent finishes with commits on a newly created local Orca branch, ask
            that agent for a cleaner branch name and show it before applying. Skips pushed branches,
            and does not apply retroactively to existing worktrees.
          </p>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>Supported agents:</span>
            {BRANCH_NAME_SUGGESTION_AGENT_ENTRIES.map(({ id, label }) => (
              <span
                key={id}
                className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/30 px-2 py-0.5"
              >
                <AgentIcon agent={id} size={12} />
                {label}
              </span>
            ))}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.experimentalBranchNameSuggestions}
          onClick={() => {
            updateSettings({
              experimentalBranchNameSuggestions: !settings.experimentalBranchNameSuggestions
            })
          }}
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            settings.experimentalBranchNameSuggestions ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow-sm transition-transform ${
              settings.experimentalBranchNameSuggestions ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>
    </SearchableSetting>
  )
}
