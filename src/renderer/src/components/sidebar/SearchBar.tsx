import React, { useCallback } from 'react'
import { Search, X, Activity } from 'lucide-react'
import { useAppStore } from '@/store'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import RepoDotLabel from '@/components/repo/RepoDotLabel'

const SearchBar = React.memo(function SearchBar() {
  const searchQuery = useAppStore((s) => s.searchQuery)
  const setSearchQuery = useAppStore((s) => s.setSearchQuery)
  const showActiveOnly = useAppStore((s) => s.showActiveOnly)
  const setShowActiveOnly = useAppStore((s) => s.setShowActiveOnly)
  const filterRepoId = useAppStore((s) => s.filterRepoId)
  const setFilterRepoId = useAppStore((s) => s.setFilterRepoId)
  const repos = useAppStore((s) => s.repos)
  const selectedRepo = repos.find((r) => r.id === filterRepoId)

  const handleClear = useCallback(() => setSearchQuery(''), [setSearchQuery])
  const handleToggleActive = useCallback(
    () => setShowActiveOnly(!showActiveOnly),
    [showActiveOnly, setShowActiveOnly]
  )

  return (
    <div className="px-2 pb-1">
      <div className="relative flex items-center">
        <Search className="absolute left-2 size-3.5 text-muted-foreground pointer-events-none" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search..."
          className="h-7 pl-7 pr-20 text-xs border-none bg-muted/50 shadow-none focus-visible:ring-1 focus-visible:ring-ring/30"
        />
        <div className="absolute right-1 flex items-center gap-0.5">
          {searchQuery && (
            <Button variant="ghost" size="icon-xs" onClick={handleClear} className="size-5">
              <X className="size-3" />
            </Button>
          )}
          <Tooltip>
            <Button
              render={<TooltipTrigger />}
              variant="ghost"
              size="icon-xs"
              onClick={handleToggleActive}
              className={cn('size-5', showActiveOnly && 'bg-accent text-accent-foreground')}
            >
              <Activity className="size-3" />
            </Button>
            <TooltipContent side="bottom" sideOffset={4}>
              {showActiveOnly ? 'Show all' : 'Active only'}
            </TooltipContent>
          </Tooltip>
          {repos.length > 1 && (
            <Select
              value={filterRepoId ?? '__all__'}
              onValueChange={(v) => setFilterRepoId(v === '__all__' ? null : v)}
            >
              <SelectTrigger
                size="sm"
                className="h-5 w-auto gap-1 border-none bg-transparent px-1 text-[10px] shadow-none focus-visible:ring-0"
              >
                <SelectValue>
                  {selectedRepo ? (
                    <RepoDotLabel
                      name={selectedRepo.displayName}
                      color={selectedRepo.badgeColor}
                      dotClassName="size-1"
                    />
                  ) : (
                    'All repos'
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="end" alignItemWithTrigger={false}>
                <SelectItem value="__all__">All repos</SelectItem>
                {repos.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    <RepoDotLabel name={r.displayName} color={r.badgeColor} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    </div>
  )
})

export default SearchBar
