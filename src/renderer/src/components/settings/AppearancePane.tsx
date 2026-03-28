import type { GlobalSettings } from '../../../../shared/types'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { UIZoomControl } from './UIZoomControl'

type AppearancePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  applyTheme: (theme: 'system' | 'dark' | 'light') => void
}

export function AppearancePane({
  settings,
  updateSettings,
  applyTheme
}: AppearancePaneProps): React.JSX.Element {
  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Theme</h2>
          <p className="text-xs text-muted-foreground">Choose how Orca looks in the app window.</p>
        </div>

        <div className="flex w-fit gap-1 rounded-md border border-border/50 p-1">
          {(['system', 'dark', 'light'] as const).map((option) => (
            <button
              key={option}
              onClick={() => {
                updateSettings({ theme: option })
                applyTheme(option)
              }}
              className={`rounded-sm px-3 py-1 text-sm capitalize transition-colors ${
                settings.theme === option
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">UI Zoom</h2>
          <p className="text-xs text-muted-foreground">
            Scale the entire application interface. Use{' '}
            <kbd className="rounded border px-1 py-0.5 text-[10px]">⌘+</kbd> /{' '}
            <kbd className="rounded border px-1 py-0.5 text-[10px]">⌘-</kbd> when not in a terminal
            pane.
          </p>
        </div>

        <UIZoomControl />
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Layout</h2>
          <p className="text-xs text-muted-foreground">
            Default layout when creating new worktrees.
          </p>
        </div>

        <div className="flex items-center justify-between gap-4 px-1 py-2">
          <div className="space-y-0.5">
            <Label>Open Right Sidebar by Default</Label>
            <p className="text-xs text-muted-foreground">
              Automatically expand the file explorer panel when creating a new worktree.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.rightSidebarOpenByDefault}
            onClick={() =>
              updateSettings({
                rightSidebarOpenByDefault: !settings.rightSidebarOpenByDefault
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.rightSidebarOpenByDefault ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.rightSidebarOpenByDefault ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </div>
      </section>
    </div>
  )
}
