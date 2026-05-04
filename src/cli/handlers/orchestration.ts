import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalPositiveIntegerFlag,
  getOptionalStringFlag,
  getRequiredStringFlag
} from '../flags'
import { getTerminalHandle } from '../selectors'

// Why: 15 s is well under Claude Code's empirical ~2 min Bash-tool silence
// budget and generates only ~40 lines per 10 min wait — enough to assure the
// parent process the subprocess is alive without flooding logs. See design
// doc §3.4.
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000

// Why: test-only escape hatch so subprocess tests can verify the feature in
// under 10 s rather than needing a full 15 s silence window. Production users
// should never set this — there is no surface documentation. A bogus value
// falls back to the default rather than disabling the heartbeat.
function resolveHeartbeatIntervalMs(): number {
  const raw = process.env.ORCA_HEARTBEAT_INTERVAL_MS
  if (!raw) {
    return DEFAULT_HEARTBEAT_INTERVAL_MS
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HEARTBEAT_INTERVAL_MS
  }
  return parsed
}

function startCheckHeartbeat(deadlineMs: number | undefined): () => void {
  const startedAt = Date.now()
  const interval = setInterval(() => {
    const payload = {
      _heartbeat: true,
      elapsedMs: Date.now() - startedAt,
      deadlineMs: deadlineMs ?? null
    }
    // Why: `process.stderr.write` is line-flushed per-call in Node, whereas a
    // fully-buffered writer would hold all heartbeat lines until exit and
    // silently defeat the whole point of the ping. Subprocess test asserts
    // this by reading stderr incrementally. See §3.4.
    process.stderr.write(`${JSON.stringify(payload)}\n`)
  }, resolveHeartbeatIntervalMs())
  if (typeof interval.unref === 'function') {
    interval.unref()
  }
  return () => clearInterval(interval)
}

type MessageSummary = {
  id: string
  from_handle: string
  to_handle?: string
  subject: string
  type?: string
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
    const wait = flags.has('wait')
    const timeoutMs = flags.has('timeout-ms') ? Number(flags.get('timeout-ms')) : undefined

    // Why: Claude Code's Bash tool auto-backgrounds subprocesses that produce
    // no output for ~2 min (shorter on the non-interactive path). Emit a
    // heartbeat line to stderr every HEARTBEAT_INTERVAL_MS while the wait is
    // active so the parent process can see the subprocess is still alive.
    // Stderr rather than stdout so stdout stays a single final JSON payload,
    // and JSON-shaped rather than `# …` so `2>&1 | jq` pipelines still work
    // (jq refuses `#`-prefixed lines). See design doc §3.4.
    const stopHeartbeat = wait ? startCheckHeartbeat(timeoutMs) : null
    type CheckResult = {
      messages: MessageSummary[]
      count: number
      formatted?: string
    }
    let result: Awaited<ReturnType<typeof client.call<CheckResult>>>
    try {
      result = await client.call<CheckResult>('orchestration.check', {
        terminal,
        unread: flags.has('unread') ? true : undefined,
        all: flags.has('all') ? true : undefined,
        types: getOptionalStringFlag(flags, 'types'),
        inject: flags.has('inject') ? true : undefined,
        wait: wait ? true : undefined,
        timeoutMs
      })
    } finally {
      stopHeartbeat?.()
    }
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
    const result = await client.call<{
      messages: MessageSummary[]
      count: number
    }>('orchestration.inbox', {
      limit: getOptionalPositiveIntegerFlag(flags, 'limit'),
      terminal: getOptionalStringFlag(flags, 'terminal')
    })
    printResult(result, json, (r) => {
      if (r.count === 0) {
        return 'No messages.'
      }
      return r.messages
        .map((m) => `${m.id} ${m.from_handle} -> ${m.to_handle ?? '?'}: "${m.subject}"`)
        .join('\n')
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
      tasks: { id: string; spec: string; status: string }[]
      count: number
    }>('orchestration.taskList', {
      status: getOptionalStringFlag(flags, 'status'),
      ready: flags.has('ready') ? true : undefined
    })
    printResult(result, json, (r) => {
      if (r.count === 0) {
        return 'No tasks.'
      }
      return r.tasks.map((t) => `${t.id} [${t.status}] ${t.spec.slice(0, 60)}`).join('\n')
    })
  },

  'orchestration task-update': async ({ flags, client, json }) => {
    const result = await client.call<{ task: { id: string; status: string } }>(
      'orchestration.taskUpdate',
      {
        id: getRequiredStringFlag(flags, 'id'),
        status: getRequiredStringFlag(flags, 'status'),
        result: getOptionalStringFlag(flags, 'result')
      }
    )
    printResult(result, json, (r) => `Updated ${r.task.id} -> ${r.task.status}`)
  },

  'orchestration dispatch': async ({ flags, client, cwd, json }) => {
    const from = await resolveOrchestrationTerminalHandle(flags, cwd, client, 'from')
    const result = await client.call<{
      dispatch: { id: string; task_id: string; status: string }
    }>('orchestration.dispatch', {
      task: getRequiredStringFlag(flags, 'task'),
      to: getRequiredStringFlag(flags, 'to'),
      from,
      inject: flags.has('inject') ? true : undefined,
      devMode: isDevCliInvocation()
    })
    printResult(
      result,
      json,
      (r) => `Dispatched ${r.dispatch.task_id} -> ${r.dispatch.id} [${r.dispatch.status}]`
    )
  },

  'orchestration dispatch-show': async ({ flags, client, json }) => {
    const result = await client.call<{
      dispatch: { id: string; task_id: string; status: string } | null
    }>('orchestration.dispatchShow', {
      task: getRequiredStringFlag(flags, 'task')
    })
    printResult(result, json, (r) => {
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
