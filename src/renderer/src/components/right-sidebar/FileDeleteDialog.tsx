import React from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { PendingDelete } from './file-explorer-types'

type FileDeleteDialogProps = {
  pendingDelete: PendingDelete | null
  isDeleting: boolean
  deleteDescription: string
  deleteActionLabel: string
  onClose: () => void
  onConfirm: () => void
}

export function FileDeleteDialog({
  pendingDelete,
  isDeleting,
  deleteDescription,
  deleteActionLabel,
  onClose,
  onConfirm
}: FileDeleteDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={pendingDelete !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{deleteActionLabel}</DialogTitle>
          <DialogDescription>{deleteDescription}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isDeleting}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={isDeleting}>
            {isDeleting ? 'Deleting…' : deleteActionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
