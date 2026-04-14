export type AgentHookTarget = 'claude' | 'codex'

export type AgentHookInstallState = 'installed' | 'not_installed' | 'partial' | 'error'

export type AgentHookInstallStatus = {
  agent: AgentHookTarget
  state: AgentHookInstallState
  configPath: string
  managedHooksPresent: boolean
  detail: string | null
}
