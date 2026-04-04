import { BrowserWindow, ipcMain } from 'electron'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStatus, RuntimeSyncWindowGraph } from '../../shared/runtime-types'

export function registerRuntimeHandlers(runtime: OrcaRuntimeService): void {
  ipcMain.removeHandler('runtime:syncWindowGraph')
  ipcMain.removeHandler('runtime:getStatus')

  ipcMain.handle(
    'runtime:syncWindowGraph',
    (event, graph: RuntimeSyncWindowGraph): RuntimeStatus => {
      const window = BrowserWindow.fromWebContents(event.sender)
      if (!window) {
        throw new Error('Runtime graph sync must originate from a BrowserWindow')
      }
      return runtime.syncWindowGraph(window.id, graph)
    }
  )

  ipcMain.handle('runtime:getStatus', (): RuntimeStatus => {
    return runtime.getStatus()
  })
}
