import { useCallback, useEffect, useRef, useState } from 'react'
import type { LinearWorkflowState, LinearLabel, LinearMember } from '../../../shared/types'

type MetadataState<T> = {
  data: T
  loading: boolean
  error: string | null
}

const METADATA_TTL = 300_000 // 5 min

type CachedMetadata<T> = { data: T; fetchedAt: number }

// ─── GitHub ────────────────────────────────────────────────

const ghLabelCache = new Map<string, CachedMetadata<string[]>>()
const ghAssigneeCache = new Map<string, CachedMetadata<string[]>>()

export function useRepoLabels(repoPath: string | null): MetadataState<string[]> {
  const [state, setState] = useState<MetadataState<string[]>>({
    data: [],
    loading: false,
    error: null
  })
  const fetchedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!repoPath) {
      return
    }
    if (fetchedForRef.current === repoPath) {
      return
    }
    fetchedForRef.current = repoPath

    const cached = ghLabelCache.get(repoPath)
    if (cached && Date.now() - cached.fetchedAt < METADATA_TTL) {
      setState({ data: cached.data, loading: false, error: null })
      return
    }

    setState((s) => ({ ...s, loading: true, error: null }))
    window.api.gh
      .listLabels({ repoPath })
      .then((labels) => {
        const data = labels as string[]
        ghLabelCache.set(repoPath, { data, fetchedAt: Date.now() })
        setState({ data, loading: false, error: null })
      })
      .catch((err) => {
        // Why: allow retry on next render by resetting the guard. Without this,
        // the hook would permanently skip re-fetching after a transient failure.
        fetchedForRef.current = null
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load labels'
        }))
      })
  }, [repoPath])

  return state
}

export function useRepoAssignees(repoPath: string | null): MetadataState<string[]> {
  const [state, setState] = useState<MetadataState<string[]>>({
    data: [],
    loading: false,
    error: null
  })
  const fetchedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!repoPath) {
      return
    }
    if (fetchedForRef.current === repoPath) {
      return
    }
    fetchedForRef.current = repoPath

    const cached = ghAssigneeCache.get(repoPath)
    if (cached && Date.now() - cached.fetchedAt < METADATA_TTL) {
      setState({ data: cached.data, loading: false, error: null })
      return
    }

    setState((s) => ({ ...s, loading: true, error: null }))
    window.api.gh
      .listAssignableUsers({ repoPath })
      .then((users) => {
        const data = users as string[]
        ghAssigneeCache.set(repoPath, { data, fetchedAt: Date.now() })
        setState({ data, loading: false, error: null })
      })
      .catch((err) => {
        fetchedForRef.current = null
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load assignees'
        }))
      })
  }, [repoPath])

  return state
}

// ─── Linear ────────────────────────────────────────────────

const linearStateCache = new Map<string, CachedMetadata<LinearWorkflowState[]>>()
const linearLabelCache = new Map<string, CachedMetadata<LinearLabel[]>>()
const linearMemberCache = new Map<string, CachedMetadata<LinearMember[]>>()

export function useTeamStates(teamId: string | null): MetadataState<LinearWorkflowState[]> {
  const [state, setState] = useState<MetadataState<LinearWorkflowState[]>>({
    data: [],
    loading: false,
    error: null
  })
  const fetchedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!teamId) {
      return
    }
    if (fetchedForRef.current === teamId) {
      return
    }
    fetchedForRef.current = teamId

    const cached = linearStateCache.get(teamId)
    if (cached && Date.now() - cached.fetchedAt < METADATA_TTL) {
      setState({ data: cached.data, loading: false, error: null })
      return
    }

    setState((s) => ({ ...s, loading: true, error: null }))
    window.api.linear
      .teamStates({ teamId })
      .then((states) => {
        const data = states as LinearWorkflowState[]
        linearStateCache.set(teamId, { data, fetchedAt: Date.now() })
        setState({ data, loading: false, error: null })
      })
      .catch((err) => {
        fetchedForRef.current = null
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load states'
        }))
      })
  }, [teamId])

  return state
}

export function useTeamLabels(teamId: string | null): MetadataState<LinearLabel[]> {
  const [state, setState] = useState<MetadataState<LinearLabel[]>>({
    data: [],
    loading: false,
    error: null
  })
  const fetchedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!teamId) {
      return
    }
    if (fetchedForRef.current === teamId) {
      return
    }
    fetchedForRef.current = teamId

    const cached = linearLabelCache.get(teamId)
    if (cached && Date.now() - cached.fetchedAt < METADATA_TTL) {
      setState({ data: cached.data, loading: false, error: null })
      return
    }

    setState((s) => ({ ...s, loading: true, error: null }))
    window.api.linear
      .teamLabels({ teamId })
      .then((labels) => {
        const data = labels as LinearLabel[]
        linearLabelCache.set(teamId, { data, fetchedAt: Date.now() })
        setState({ data, loading: false, error: null })
      })
      .catch((err) => {
        fetchedForRef.current = null
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load labels'
        }))
      })
  }, [teamId])

  return state
}

export function useTeamMembers(teamId: string | null): MetadataState<LinearMember[]> {
  const [state, setState] = useState<MetadataState<LinearMember[]>>({
    data: [],
    loading: false,
    error: null
  })
  const fetchedForRef = useRef<string | null>(null)

  useEffect(() => {
    if (!teamId) {
      return
    }
    if (fetchedForRef.current === teamId) {
      return
    }
    fetchedForRef.current = teamId

    const cached = linearMemberCache.get(teamId)
    if (cached && Date.now() - cached.fetchedAt < METADATA_TTL) {
      setState({ data: cached.data, loading: false, error: null })
      return
    }

    setState((s) => ({ ...s, loading: true, error: null }))
    window.api.linear
      .teamMembers({ teamId })
      .then((members) => {
        const data = members as LinearMember[]
        linearMemberCache.set(teamId, { data, fetchedAt: Date.now() })
        setState({ data, loading: false, error: null })
      })
      .catch((err) => {
        fetchedForRef.current = null
        setState((s) => ({
          ...s,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load members'
        }))
      })
  }, [teamId])

  return state
}

// ─── Helpers ───────────────────────────────────────────────

/**
 * Simple multi-select toggle helper. Returns a new array with the item
 * toggled in or out.
 */
export function toggleInArray<T>(arr: T[], item: T): T[] {
  return arr.includes(item) ? arr.filter((i) => i !== item) : [...arr, item]
}

/**
 * Wraps an immediate mutation (no undo delay) with loading/error state
 * and optimistic patching.
 */
export function useImmediateMutation() {
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())

  const isPending = useCallback((key: string) => pendingKeys.has(key), [pendingKeys])

  const run = useCallback(
    async <T>(
      key: string,
      opts: {
        mutate: () => Promise<T>
        onOptimistic?: () => void
        onSuccess?: (result: T) => void
        onRevert?: () => void
        onError?: (error: string) => void
      }
    ) => {
      setPendingKeys((prev) => new Set(prev).add(key))
      opts.onOptimistic?.()
      try {
        const result = await opts.mutate()
        const asResult = result as { ok?: boolean; error?: string }
        if (asResult && asResult.ok === false) {
          opts.onRevert?.()
          opts.onError?.(asResult.error ?? 'Update failed')
        } else {
          opts.onSuccess?.(result)
        }
      } catch (err) {
        opts.onRevert?.()
        opts.onError?.(err instanceof Error ? err.message : 'Update failed')
      } finally {
        setPendingKeys((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    []
  )

  return { isPending, run }
}
