import React from 'react'
import { useAppStore } from '@/store'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'

const GroupControls = React.memo(function GroupControls() {
  const groupBy = useAppStore((s) => s.groupBy)
  const setGroupBy = useAppStore((s) => s.setGroupBy)
  const sortBy = useAppStore((s) => s.sortBy)
  const setSortBy = useAppStore((s) => s.setSortBy)

  return (
    <div className="flex items-center justify-between px-2 pb-1.5">
      <ToggleGroup
        multiple={false}
        value={[groupBy]}
        onValueChange={(values) => {
          const next = values[0]
          if (next) setGroupBy(next as typeof groupBy)
        }}
        variant="outline"
        size="sm"
        className="h-6"
      >
        <ToggleGroupItem value="none" className="h-6 px-2 text-[10px]">
          All
        </ToggleGroupItem>
        <ToggleGroupItem value="pr-status" className="h-6 px-2 text-[10px]">
          PR Status
        </ToggleGroupItem>
        <ToggleGroupItem value="repo" className="h-6 px-2 text-[10px]">
          Repo
        </ToggleGroupItem>
      </ToggleGroup>
      <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
        <SelectTrigger
          size="sm"
          className="h-6 w-auto gap-1 border-none bg-transparent px-1.5 text-[10px] shadow-none focus-visible:ring-0"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end" alignItemWithTrigger={false}>
          <SelectItem value="name">Name</SelectItem>
          <SelectItem value="recent">Recent</SelectItem>
          <SelectItem value="repo">Repo</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
})

export default GroupControls
