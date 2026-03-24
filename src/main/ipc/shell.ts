import { ipcMain, shell } from 'electron'
import { stat } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch {
    return false
  }
}

export function registerShellHandlers(): void {
  ipcMain.handle('shell:openPath', (_event, path: string) => {
    shell.showItemInFolder(path)
  })

  ipcMain.handle('shell:openUrl', (_event, rawUrl: string) => {
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return
    }

    return shell.openExternal(parsed.toString())
  })

  ipcMain.handle('shell:openFilePath', async (_event, filePath: string) => {
    if (!isAbsolute(filePath)) {
      return
    }
    const normalizedPath = normalize(filePath)
    if (!(await pathExists(normalizedPath))) {
      return
    }
    await shell.openPath(normalizedPath)
  })

  ipcMain.handle('shell:openFileUri', async (_event, rawUri: string) => {
    let parsed: URL
    try {
      parsed = new URL(rawUri)
    } catch {
      return
    }

    if (parsed.protocol !== 'file:') {
      return
    }

    // Only local files are supported. Remote hosts are intentionally rejected.
    if (parsed.hostname && parsed.hostname !== 'localhost') {
      return
    }

    let filePath: string
    try {
      filePath = fileURLToPath(parsed)
    } catch {
      return
    }

    const normalizedPath = normalize(filePath)
    if (!isAbsolute(normalizedPath)) {
      return
    }
    if (!(await pathExists(normalizedPath))) {
      return
    }

    await shell.openPath(normalizedPath)
  })

  ipcMain.handle('shell:pathExists', async (_event, filePath: string): Promise<boolean> => {
    return pathExists(filePath)
  })
}
