import type { TuiAgent } from '../../../shared/types'

// Why: agent detection runs `which` for every agent binary on PATH — an IPC
// round-trip that takes 50–200ms. The set of installed agents doesn't change
// within a session, so cache the promise at module scope to collapse all
// callers (composer page, quick-composer modal, "Use this task" flow, etc.)
// onto a single resolve.
let detectAgentsPromise: Promise<TuiAgent[]> | null = null

export function detectAgentsCached(): Promise<TuiAgent[]> {
  if (detectAgentsPromise) {
    return detectAgentsPromise
  }
  const pending = window.api.preflight
    .detectAgents()
    .then((ids) => ids as TuiAgent[])
    .catch(() => {
      // Allow a retry on the next mount if detection blew up (e.g. IPC
      // timeout during cold start).
      detectAgentsPromise = null
      return [] as TuiAgent[]
    })
  detectAgentsPromise = pending
  return pending
}
