import { contextBridge, ipcRenderer } from 'electron'
import type { ApiResult, DesktopAPI } from '../src/shared/api'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: ApiResult<T> = await ipcRenderer.invoke(channel, ...args)
  if (!result.ok) throw new Error(result.error)
  return result.value
}
const api: DesktopAPI = {
  feishu: {
    getConnection: (id) => invoke('feishu:connection', id),
    saveConfig: (id, config) => invoke('feishu:config', id, config),
    authorize: (id) => invoke('feishu:authorize', id),
    cancelAuthorization: (id) => invoke('feishu:cancel', id),
    disconnect: (id) => invoke('feishu:disconnect', id),
    getAgenda: (id, force) => invoke('feishu:agenda', id, force === true),
    onChanged: (id, callback) => {
      const listener = (_event: unknown, accountId: string) => {
        if (accountId === id) callback()
      }
      ipcRenderer.on('feishu:changed', listener)
      return () => {
        ipcRenderer.removeListener('feishu:changed', listener)
      }
    },
  },
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
