export type PreambleParams = {
  taskId: string
  taskSpec: string
  coordinatorHandle: string
  devMode?: boolean
  // Why: populated by the coordinator's dispatch pre-flight (§3.1) only
  // when the target worktree is behind its tracking remote. When absent
  // or when `behind === 0`, the preamble emits no drift section. Callers
  // must NOT pre-populate this with empty data; the drift section is a
  // loud-but-rare signal tied to the `allow-stale-base: true` override
  // path, and polluting it for fresh worktrees would train workers to
  // ignore it.
  baseDrift?: {
    base: string
    behind: number
    recentSubjects: string[]
  }
}

// Why: the dispatch preamble teaches agents about Orca's CLI commands for
// structured communication. Agents don't need prior knowledge of Orca — they
// treat these as shell tools the same way they use git or npm.
export function buildDispatchPreamble(params: PreambleParams): string {
  // Why: in dev mode, agents must use orca-dev to connect to the dev runtime's
  // socket. Without this, agents inside the dev Electron app would call the
  // production CLI and talk to the wrong Orca instance (Section 6.4).
  const cli = params.devMode ? 'orca-dev' : 'orca'

  const header = `You are working inside Orca, a multi-agent IDE. You have access to these
CLI commands for communicating with the coordinator:

  # Report task completion (REQUIRED when done):
  ${cli} orchestration send --to ${params.coordinatorHandle} \\
    --type worker_done --subject "Done" \\
    --payload '{"taskId":"${params.taskId}","filesModified":[...]}'

  # Report a blocker or failure:
  ${cli} orchestration send --to ${params.coordinatorHandle} \\
    --type escalation --subject "Blocked: <reason>" \\
    --body "<details>"

  # Check for messages from the coordinator or other agents:
  ${cli} orchestration check

Your assigned task ID is: ${params.taskId}

When you finish your task, run the worker_done command above with the
list of files you modified. If you are blocked or need help, send an
escalation. Do not exit the session.`

  // Why: the drift section fires only when the coordinator allowed dispatch
  // against a stale worktree (via `allow-stale-base: true` in the task spec,
  // see §3.4) OR when behind>0 but under the refusal threshold. Either way
  // it is defense-in-depth: the worker sees the drift from line 1 instead
  // of discovering it via stale line numbers in artifacts later.
  const drift =
    params.baseDrift && params.baseDrift.behind > 0 ? buildDriftSection(params.baseDrift) : ''

  return `${header}${drift}

--- TASK ---
${params.taskSpec}`
}

function buildDriftSection(drift: NonNullable<PreambleParams['baseDrift']>): string {
  const subjects = drift.recentSubjects.map((s) => `  - ${s}`).join('\n')
  return `

--- BASE DRIFT ---
Your worktree HEAD is ${drift.behind} commits behind ${drift.base}. The 5 most recent
subjects on ${drift.base} NOT in your worktree:
${subjects}

If any look relevant to your task, either pull them in (\`git pull --rebase
${drift.base}\` or equivalent) or escalate to the coordinator before starting.
---`
}
