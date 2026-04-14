import { ipcMain } from 'electron'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { claudeHookService } from '../claude/hook-service'
import { codexHookService } from '../codex/hook-service'

export function registerAgentHookHandlers(): void {
  ipcMain.handle(
    'agentHooks:claudeStatus',
    (): AgentHookInstallStatus => claudeHookService.getStatus()
  )
  ipcMain.handle(
    'agentHooks:claudeInstall',
    (): AgentHookInstallStatus => claudeHookService.install()
  )
  ipcMain.handle(
    'agentHooks:claudeRemove',
    (): AgentHookInstallStatus => claudeHookService.remove()
  )

  ipcMain.handle(
    'agentHooks:codexStatus',
    (): AgentHookInstallStatus => codexHookService.getStatus()
  )
  ipcMain.handle(
    'agentHooks:codexInstall',
    (): AgentHookInstallStatus => codexHookService.install()
  )
  ipcMain.handle('agentHooks:codexRemove', (): AgentHookInstallStatus => codexHookService.remove())
}
