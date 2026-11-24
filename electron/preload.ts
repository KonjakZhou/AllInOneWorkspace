import { contextBridge, ipcRenderer } from 'electron'
import type { ApiResult, DesktopAPI } from '../src/shared/api'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: ApiResult<T> = await ipcRenderer.invoke(channel, ...args)
  if (!result.ok) throw new Error(result.error)
  return result.value
}
const api: DesktopAPI = {
  load: () => invoke('workspace:load'),
  save: (workspace) => invoke('workspace:save', workspace),
  createAccount: (name) => invoke('account:create', name),
  renameAccount: (id, name) => invoke('account:rename', id, name),
  switchAccount: (id) => invoke('account:switch', id),
  deleteAccount: (id) => invoke('account:delete', id),
  exportAccount: (id) => invoke('account:export', id),
  importAccount: () => invoke('account:import'),
  onCloseRequested: (callback) => {
    const listener = () => {
      void callback()
    }
    ipcRenderer.on('workspace:close-requested', listener)
    return () => {
      ipcRenderer.removeListener('workspace:close-requested', listener)
    }
  },
  finishClose: () => invoke('workspace:finish-close'),
}
contextBridge.exposeInMainWorld('workspace', api)
