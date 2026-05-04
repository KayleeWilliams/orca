/* eslint-disable max-lines -- Why: orchestration CLI handlers share flag-parsing helpers and dispatch/preamble logic; splitting by verb would fragment the RuntimeClient call shape without reducing complexity. */
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { getTerminalHandle } from '../selectors'

// Why: mirrors TaskStatus (orchestration/types.ts) so the CLI can surface a
// clear enum-aware error before the generic RPC Zod "Missing --status" message.
const TASK_STATUS_VALUES = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
] as const

type MessageSummary = {
  id: string
  from_handle: string
  to_handle?: string
  subject: string
  type?: string
  body?: string
  payload?: string | null
}

async function resolveOrchestrationTerminalHandle(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: Parameters<CommandHandler>[0]['client'],
  flagName: 'from' | 'terminal'
): Promise<string> {
  const explicit = getOptionalStringFlag(flags, flagName)
  if (explicit) {
    return explicit
  }
  const envHandle = process.env.ORCA_TERMINAL_HANDLE
  if (envHandle && envHandle.length > 0) {
    return envHandle
  }
  return await getTerminalHandle(flags, cwd, client)
}

function isDevCliInvocation(): boolean {
  return process.env.ORCA_USER_DATA_PATH?.includes('orca-dev') ?? false
}

export const ORCHESTRATION_HANDLERS: Record<string, CommandHandler> = {
  'orchestration send': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await client.call<
      { message: { id: string } } | { messages: { id: string }[]; recipients: number }
    >('orchestration.send', {
      from,
      to: getRequiredStringFlag(flags, 'to'),
      subject: getRequiredStringFlag(flags, 'subject'),
      body: getOptionalStringFlag(flags, 'body'),
      type: getOptionalStringFlag(flags, 'type'),
      priority: getOptionalStringFlag(flags, 'priority'),
      threadId: getOptionalStringFlag(flags, 'thread-id'),
      payload: getOptionalStringFlag(flags, 'payload'),
      devMode: isDevCliInvocation()
    })
    printResult(result, json, (r) => {
      if ('message' in r) {
        return `Sent ${r.message.id}`
      }
      return `Sent ${r.messages.length} messages to ${r.recipients} recipients`
    })
  },

  'orchestration check': async ({ flags, client, cwd, json }) => {
    const terminal = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'terminal')
    const result = await client.call<{
      messages: MessageSummary[]
      count: number
      formatted?: string
    }>('orchestration.check', {
      terminal,
      unread: flags.has('unread') ? true : undefined,
      types: getOptionalStringFlag(flags, 'types'),
      inject: flags.has('inject') ? true : undefined,
      wait: flags.has('wait') ? true : undefined,
      timeoutMs: flags.has('timeout-ms') ? Number(flags.get('timeout-ms')) : undefined
    })
    printResult(result, json, (r) => {
      if (r.formatted) {
        return r.formatted
      }
      if (r.count === 0) {
        return 'No messages.'
      }
      return r.messages
        .map((m) => `${m.id} [${m.type ?? 'status'}] from=${m.from_handle} "${m.subject}"`)
        .join('\n')
    })
  },

  'orchestration reply': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await client.call<{ message: { id: string } }>('orchestration.reply', {
      id: getRequiredStringFlag(flags, 'id'),
      body: getRequiredStringFlag(flags, 'body'),
      from
    })
    printResult(result, json, (r) => `Replied ${r.message.id}`)
  },

  'orchestration inbox': async ({ flags, client, json }) => {
    const full = flags.has('full')
    const result = await client.call<{
      messages: MessageSummary[]
      count: number
    }>('orchestration.inbox', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit')
    })
    printResult(result, json, (r) => {
      if (r.count === 0) {
        return 'No messages.'
      }
      // Why: default output omits body/payload for at-a-glance sweeps; --full
      // prints them verbatim so callers can audit without parsing --json.
      return r.messages
        .map((m) => {
          const head = `${m.id} ${m.from_handle} -> ${m.to_handle ?? '?'}: "${m.subject}"`
          if (!full) {
            return head
          }
          const parts = [head]
          if (m.body && m.body.length > 0) {
            parts.push(m.body)
          }
          if (m.payload) {
            parts.push(`[payload] ${m.payload}`)
          }
          return parts.join('\n')
        })
        .join(full ? '\n\n' : '\n')
    })
  },

  'orchestration task-create': async ({ flags, client, json }) => {
    const result = await client.call<{ task: { id: string; status: string } }>(
      'orchestration.taskCreate',
      {
        spec: getRequiredStringFlag(flags, 'spec'),
        deps: getOptionalStringFlag(flags, 'deps'),
        parent: getOptionalStringFlag(flags, 'parent')
      }
    )
    printResult(result, json, (r) => `Created ${r.task.id} [${r.task.status}]`)
  },

  'orchestration task-list': async ({ flags, client, json }) => {
    const result = await client.call<{
      tasks: {
        id: string
        spec: string
        status: string
        assignee_handle?: string | null
        dispatch_id?: string | null
      }[]
      count: number
    }>('orchestration.taskList', {
      status: getOptionalStringFlag(flags, 'status'),
      ready: flags.has('ready') ? true : undefined
    })
    printResult(result, json, (r) => {
      if (r.count === 0) {
        return 'No tasks.'
      }
      return r.tasks
        .map((t) => {
          const head = `${t.id} [${t.status}] ${t.spec.slice(0, 60)}`
          if (t.status === 'dispatched' && t.assignee_handle) {
            return `${head} -> ${t.assignee_handle} (${t.dispatch_id ?? '?'})`
          }
          return head
        })
        .join('\n')
    })
  },

  'orchestration task-update': async ({ flags, client, json }) => {
    const status = getRequiredStringFlag(flags, 'status')
    if (!TASK_STATUS_VALUES.includes(status as (typeof TASK_STATUS_VALUES)[number])) {
      throw new RuntimeClientError(
        'invalid_argument',
        `invalid status '${status}', expected one of: ${TASK_STATUS_VALUES.join(', ')}`
      )
    }
    const result = await client.call<{ task: { id: string; status: string } }>(
      'orchestration.taskUpdate',
      {
        id: getRequiredStringFlag(flags, 'id'),
        status,
        result: getOptionalStringFlag(flags, 'result')
      }
    )
    printResult(result, json, (r) => `Updated ${r.task.id} -> ${r.task.status}`)
  },

  'orchestration dispatch': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const dryRun = flags.has('dry-run') ? true : undefined
    const returnPreamble = flags.has('return-preamble') ? true : undefined
    // Why: --to is only required for non-dry-run; the RPC handler re-enforces.
    const to = dryRun ? getOptionalStringFlag(flags, 'to') : getRequiredStringFlag(flags, 'to')
    const result = await client.call<{
      dispatch: { id: string; task_id: string; status: string } | null
      injected?: boolean
      dryRun?: boolean
      preamble?: string
    }>('orchestration.dispatch', {
      task: getRequiredStringFlag(flags, 'task'),
      to,
      from,
      inject: flags.has('inject') ? true : undefined,
      dryRun,
      returnPreamble,
      devMode: isDevCliInvocation()
    })
    printResult(result, json, (r) => {
      if (r.dryRun) {
        return r.preamble ?? ''
      }
      const base = `Dispatched ${r.dispatch?.task_id} -> ${r.dispatch?.id} [${r.dispatch?.status}]`
      return r.preamble ? `${base}\n\n--- Preamble ---\n${r.preamble}` : base
    })
  },

  'orchestration dispatch-show': async ({ flags, client, cwd, json }) => {
    const showPreamble = flags.has('preamble') ? true : undefined
    // Why: resolve --from when previewing so the preamble embeds a real
    // coordinator handle, matching what an actual dispatch would produce.
    const from = showPreamble
      ? await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
      : undefined
    const result = await client.call<{
      dispatch: { id: string; task_id: string; status: string } | null
      preamble?: string
    }>('orchestration.dispatchShow', {
      task: getRequiredStringFlag(flags, 'task'),
      preamble: showPreamble,
      from,
      devMode: isDevCliInvocation()
    })
    printResult(result, json, (r) => {
      if (r.preamble && showPreamble) {
        return r.preamble
      }
      if (!r.dispatch) {
        return 'No dispatch context found.'
      }
      return `${r.dispatch.id} task=${r.dispatch.task_id} [${r.dispatch.status}]`
    })
  },

  'orchestration run': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await client.call<{
      runId: string
      status: string
    }>('orchestration.run', {
      spec: getRequiredStringFlag(flags, 'spec'),
      from,
      pollIntervalMs: getOptionalPositiveIntegerFlag(flags, 'poll-interval-ms'),
      maxConcurrent: getOptionalPositiveIntegerFlag(flags, 'max-concurrent'),
      worktree: getOptionalStringFlag(flags, 'worktree')
    })
    printResult(result, json, (r) => `Run ${r.runId} started (${r.status})`)
  },

  'orchestration run-stop': async ({ client, json }) => {
    const result = await client.call<{
      runId: string
      stopped: boolean
    }>('orchestration.runStop', {})
    printResult(result, json, (r) => `Run ${r.runId} stopped`)
  },

  'orchestration gate-create': async ({ flags, client, json }) => {
    const result = await client.call<{
      gate: { id: string; task_id: string; status: string }
    }>('orchestration.gateCreate', {
      task: getRequiredStringFlag(flags, 'task'),
      question: getRequiredStringFlag(flags, 'question'),
      options: getOptionalStringFlag(flags, 'options')
    })
    printResult(
      result,
      json,
      (r) => `Gate ${r.gate.id} created for task ${r.gate.task_id} [${r.gate.status}]`
    )
  },

  'orchestration gate-resolve': async ({ flags, client, json }) => {
    const result = await client.call<{
      gate: { id: string; task_id: string; status: string; resolution: string }
    }>('orchestration.gateResolve', {
      id: getRequiredStringFlag(flags, 'id'),
      resolution: getRequiredStringFlag(flags, 'resolution')
    })
    printResult(result, json, (r) => `Gate ${r.gate.id} resolved: ${r.gate.resolution}`)
  },

  'orchestration gate-list': async ({ flags, client, json }) => {
    const result = await client.call<{
      gates: { id: string; task_id: string; question: string; status: string }[]
      count: number
    }>('orchestration.gateList', {
      task: getOptionalStringFlag(flags, 'task'),
      status: getOptionalStringFlag(flags, 'status')
    })
    printResult(result, json, (r) => {
      if (r.gates.length === 0) {
        return 'No gates found.'
      }
      return r.gates
        .map((g) => `${g.id} task=${g.task_id} [${g.status}] "${g.question}"`)
        .join('\n')
    })
  },

  'orchestration reset': async ({ flags, client, json }) => {
    const result = await client.call<{ reset: string }>('orchestration.reset', {
      all: flags.has('all') ? true : undefined,
      tasks: flags.has('tasks') ? true : undefined,
      messages: flags.has('messages') ? true : undefined
    })
    printResult(result, json, (r) => `Reset: ${r.reset}`)
  }
}
