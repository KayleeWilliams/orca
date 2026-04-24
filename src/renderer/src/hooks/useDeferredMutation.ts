import { useCallback, useRef, useEffect } from 'react'
import { toast } from 'sonner'

type DeferredMutationOptions<T> = {
  /** Unique key to scope this mutation (e.g. 'state', 'labels'). A new
   *  trigger with the same key cancels the previous one; different keys
   *  are independent. */
  key: string
  /** Human-readable label for the undo toast, e.g. "Issue closed" */
  description: string
  /** The actual API call — only fires after the undo window expires or on unmount */
  mutate: () => Promise<T>
  /** Called immediately before the API call is deferred (optimistic UI) */
  onOptimistic?: () => void
  /** Reverts the optimistic update on undo or API failure */
  onRevert?: () => void
  /** Called after a successful API response */
  onSuccess?: (result: T) => void
  /** Called after a failed API response */
  onError?: (error: string) => void
  /** Delay in ms before firing the mutation. Default: 5000 */
  delay?: number
}

type PendingEntry<T> = {
  timerId: ReturnType<typeof setTimeout>
  toastId: string | number
  opts: DeferredMutationOptions<T>
}

/**
 * Returns a trigger function that shows a 5-second undo toast, then fires
 * the mutation. Multiple mutations with different keys can be pending
 * simultaneously; a new trigger with the same key cancels the previous one.
 * If the component unmounts while mutations are pending, they fire
 * immediately (fire-and-forget with global error toast).
 */
export function useDeferredMutation<T = unknown>() {
  const pendingRef = useRef<Map<string, PendingEntry<T>>>(new Map())

  const fireMutation = useCallback((opts: DeferredMutationOptions<T>, isUnmounting: boolean) => {
    opts
      .mutate()
      .then((result) => {
        // Why: GitHub/Linear IPC handlers resolve with {ok:false, error} on
        // server-side validation failures instead of rejecting. Without this
        // check the optimistic UI would stick even though the API rejected.
        const asResult = result as { ok?: boolean; error?: string }
        if (asResult && asResult.ok === false) {
          opts.onRevert?.()
          const message = asResult.error ?? 'Update failed'
          if (isUnmounting) {
            toast.error(message)
          } else {
            opts.onError?.(message)
          }
        } else {
          opts.onSuccess?.(result)
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        opts.onRevert?.()
        if (isUnmounting) {
          toast.error(message)
        } else {
          opts.onError?.(message)
        }
      })
  }, [])

  const trigger = useCallback(
    (opts: DeferredMutationOptions<T>) => {
      const pending = pendingRef.current

      // Cancel any existing pending mutation with the same key
      const existing = pending.get(opts.key)
      if (existing) {
        clearTimeout(existing.timerId)
        toast.dismiss(existing.toastId)
        existing.opts.onRevert?.()
        pending.delete(opts.key)
      }

      opts.onOptimistic?.()

      const toastId = toast(opts.description, {
        duration: opts.delay ?? 5000,
        action: {
          label: 'Undo',
          onClick: () => {
            const entry = pending.get(opts.key)
            if (entry) {
              clearTimeout(entry.timerId)
              entry.opts.onRevert?.()
              pending.delete(opts.key)
            }
          }
        }
      })

      const timerId = setTimeout(() => {
        toast.dismiss(toastId)
        pending.delete(opts.key)
        fireMutation(opts, false)
      }, opts.delay ?? 5000)

      pending.set(opts.key, { timerId, toastId, opts })
    },
    [fireMutation]
  )

  // Why: if the drawer unmounts while deferred mutations are pending,
  // fire them immediately so the user's intent is not silently dropped.
  useEffect(() => {
    return () => {
      for (const entry of pendingRef.current.values()) {
        clearTimeout(entry.timerId)
        toast.dismiss(entry.toastId)
        fireMutation(entry.opts, true)
      }
      pendingRef.current.clear()
    }
  }, [fireMutation])

  return trigger
}
