import React, { useState, useCallback } from 'react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@/components/ui/select'
import RepoDotLabel from '@/components/repo/RepoDotLabel'

const AddWorktreeDialog = React.memo(function AddWorktreeDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const closeModal = useAppStore((s) => s.closeModal)
  const repos = useAppStore((s) => s.repos)
  const createWorktree = useAppStore((s) => s.createWorktree)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)

  const [repoId, setRepoId] = useState<string>('')
  const [name, setName] = useState('')
  const [linkedIssue, setLinkedIssue] = useState('')
  const [comment, setComment] = useState('')
  const [creating, setCreating] = useState(false)

  const isOpen = activeModal === 'create-worktree'
  const selectedRepo = repos.find((r) => r.id === repoId)

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
        setRepoId('')
        setName('')
        setLinkedIssue('')
        setComment('')
      }
    },
    [closeModal]
  )

  const handleCreate = useCallback(async () => {
    if (!repoId || !name.trim()) return
    setCreating(true)
    try {
      const wt = await createWorktree(repoId, name.trim())
      if (wt) {
        const metaUpdates: Record<string, unknown> = {}
        if (linkedIssue.trim()) {
          const num = parseInt(linkedIssue.trim(), 10)
          if (!isNaN(num)) (metaUpdates as { linkedIssue: number }).linkedIssue = num
        }
        if (comment.trim()) {
          ;(metaUpdates as { comment: string }).comment = comment.trim()
        }
        if (Object.keys(metaUpdates).length > 0) {
          await updateWorktreeMeta(wt.id, metaUpdates as { linkedIssue?: number; comment?: string })
        }
      }
      handleOpenChange(false)
    } finally {
      setCreating(false)
    }
  }, [repoId, name, linkedIssue, comment, createWorktree, updateWorktreeMeta, handleOpenChange])

  // Auto-select first repo when opening
  React.useEffect(() => {
    if (isOpen && repos.length > 0 && !repoId) {
      setRepoId(repos[0].id)
    }
  }, [isOpen, repos, repoId])

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">New Worktree</DialogTitle>
          <DialogDescription className="text-xs">
            Create a new git worktree. The branch name will inherit from the name you provide.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* Repo selector */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Repository</label>
            <Select value={repoId} onValueChange={(value) => setRepoId(value ?? '')}>
              <SelectTrigger className="h-8 text-xs w-full">
                <SelectValue placeholder="Select repo...">
                  {selectedRepo ? (
                    <RepoDotLabel
                      name={selectedRepo.displayName}
                      color={selectedRepo.badgeColor}
                      dotClassName="size-1.5"
                    />
                  ) : null}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {repos.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    <RepoDotLabel name={r.displayName} color={r.badgeColor} />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Name */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="feature/my-feature"
              className="h-8 text-xs"
              autoFocus
            />
          </div>

          {/* Link GH Issue */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              Link GH Issue <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <Input
              value={linkedIssue}
              onChange={(e) => setLinkedIssue(e.target.value)}
              placeholder="Issue number, e.g. 42"
              className="h-8 text-xs"
            />
          </div>

          {/* Comment */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              Comment <span className="text-muted-foreground/50">(optional)</span>
            </label>
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Notes about this worktree..."
              rows={2}
              className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 resize-none"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleOpenChange(false)}
            className="text-xs"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleCreate}
            disabled={!repoId || !name.trim() || creating}
            className="text-xs"
          >
            {creating ? 'Creating...' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default AddWorktreeDialog
