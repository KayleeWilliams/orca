import { useCallback, useEffect, useRef, useState } from 'react'
import type { LinearWorkflowState, LinearLabel, LinearMember } from '../../../shared/types'

type MetadataState<T> = {
  data: T
  loading: boolean
  error: string | null
}

const METADATA_TTL = 300_000 // 5 min

type CachedMetadata<T> = { data: T; fetchedAt: number }

function isCacheFresh<T>(cache: Map<string, CachedMetadata<T>>, key: string): boolean {
  const entry = cache.get(key)
  return !!entry && Date.now() - entry.fetchedAt < METADATA_TTL
}

// ─── GitHub ────────────────────────────────────────────────

const ghLabelCache = new Map<string, CachedMetadata<string[]>>()
const ghAssigneeCache = new Map<string, CachedMetadata<string[]>>()

export function useRepoLabels(repoPath: string | null): MetadataState<string[]> {
  const [state, setState] = useState<MetadataState<string[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!repoPath) {
      return
    }

    const cached = ghLabelCache.get(repoPath)
    if (cached && isCacheFresh(ghLabelCache, repoPath)) {
      if (activeKeyRef.current !== repoPath) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = repoPath
      }
      return
    }

    activeKeyRef.current = repoPath
    const requestKey = repoPath
    setState((s) => ({ ...s, loading: true, error: null }))
    window.api.gh
      .listLabels({ repoPath })
      .then((labels) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        const data = labels as string[]
        ghLabelCache.set(repoPath, { data, fetchedAt: Date.now() })
        setState({ data, loading: false, error: null })
      })
      .catch((err) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        activeKeyRef.current = null
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
  const activeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!repoPath) {
      return
    }

    const cached = ghAssigneeCache.get(repoPath)
    if (cached && isCacheFresh(ghAssigneeCache, repoPath)) {
      if (activeKeyRef.current !== repoPath) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = repoPath
      }
      return
    }

    activeKeyRef.current = repoPath
    const requestKey = repoPath
    setState((s) => ({ ...s, loading: true, error: null }))
    window.api.gh
      .listAssignableUsers({ repoPath })
      .then((users) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        const data = users as string[]
        ghAssigneeCache.set(repoPath, { data, fetchedAt: Date.now() })
        setState({ data, loading: false, error: null })
      })
      .catch((err) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        activeKeyRef.current = null
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

export function clearLinearMetadataCache(): void {
  linearStateCache.clear()
  linearLabelCache.clear()
  linearMemberCache.clear()
}

export function clearGitHubMetadataCache(): void {
  ghLabelCache.clear()
  ghAssigneeCache.clear()
}

export function useTeamStates(teamId: string | null): MetadataState<LinearWorkflowState[]> {
  const [state, setState] = useState<MetadataState<LinearWorkflowState[]>>({
    data: [],
    loading: false,
    error: null
  })
  const activeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!teamId) {
      return
    }

    const cached = linearStateCache.get(teamId)
    if (cached && isCacheFresh(linearStateCache, teamId)) {
      if (activeKeyRef.current !== teamId) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = teamId
      }
      return
    }

    activeKeyRef.current = teamId
    const requestKey = teamId
    setState((s) => ({ ...s, loading: true, error: null }))
    window.api.linear
      .teamStates({ teamId })
      .then((states) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        const data = states as LinearWorkflowState[]
        linearStateCache.set(teamId, { data, fetchedAt: Date.now() })
        setState({ data, loading: false, error: null })
      })
      .catch((err) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        activeKeyRef.current = null
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
  const activeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!teamId) {
      return
    }

    const cached = linearLabelCache.get(teamId)
    if (cached && isCacheFresh(linearLabelCache, teamId)) {
      if (activeKeyRef.current !== teamId) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = teamId
      }
      return
    }

    activeKeyRef.current = teamId
    const requestKey = teamId
    setState((s) => ({ ...s, loading: true, error: null }))
    window.api.linear
      .teamLabels({ teamId })
      .then((labels) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        const data = labels as LinearLabel[]
        linearLabelCache.set(teamId, { data, fetchedAt: Date.now() })
        setState({ data, loading: false, error: null })
      })
      .catch((err) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        activeKeyRef.current = null
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
  const activeKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!teamId) {
      return
    }

    const cached = linearMemberCache.get(teamId)
    if (cached && isCacheFresh(linearMemberCache, teamId)) {
      if (activeKeyRef.current !== teamId) {
        setState({ data: cached.data, loading: false, error: null })
        activeKeyRef.current = teamId
      }
      return
    }

    activeKeyRef.current = teamId
    const requestKey = teamId
    setState((s) => ({ ...s, loading: true, error: null }))
    window.api.linear
      .teamMembers({ teamId })
      .then((members) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        const data = members as LinearMember[]
        linearMemberCache.set(teamId, { data, fetchedAt: Date.now() })
        setState({ data, loading: false, error: null })
      })
      .catch((err) => {
        if (activeKeyRef.current !== requestKey) {
          return
        }
        activeKeyRef.current = null
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
 * Wraps an immediate mutation (no undo delay) with loading/error state
 * and optimistic patching. Skips if the same key is already in-flight.
 */
export function useImmediateMutation() {
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())
  const pendingRef = useRef(pendingKeys)
  pendingRef.current = pendingKeys

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
      if (pendingRef.current.has(key)) {
        return
      }
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
