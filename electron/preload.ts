import { contextBridge, ipcRenderer } from 'electron'
import { mailBridge } from './mail/bridge'
import type { ApiResult, DesktopAPI } from '../src/shared/api'
import type { TradingIdeasAPI } from '../src/shared/trading-ideas'

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result: ApiResult<T> = await ipcRenderer.invoke(channel, ...args)
  if (!result.ok) throw new Error(result.error)
  return result.value
}
const tradingIdeas: TradingIdeasAPI = {
  enable: (account) => invoke('ideas:enable', account),
  overview: (account) => invoke('ideas:overview', account),
  list: (account, query) => invoke('ideas:list', account, query),
  detail: (account, id) => invoke('ideas:detail', account, id),
  add: (account, input) => invoke('ideas:add', account, input),
  saveNote: (account, id, note) => invoke('ideas:note', account, id, note),
  openSource: (account, id, index) => invoke('ideas:source', account, id, index),
  refresh: (account) => invoke('ideas:refresh', account),
  status: (account) => invoke('ideas:status', account),
  onChanged: (callback) => {
    const listener = () => callback()
    ipcRenderer.on('ideas:changed', listener)
    return () => ipcRenderer.removeListener('ideas:changed', listener)
  },
}
const api: DesktopAPI = {
  mailFor: mailBridge,
  updates: {
    getState: () => invoke('updates:state'),
    check: () => invoke('updates:check'),
    download: () => invoke('updates:download'),
    setAutomatic: (enabled) => invoke('updates:automatic', enabled),
    install: () => invoke('updates:install'),
    openRelease: () => invoke('updates:open-release'),
    onChanged: (callback) => {
      const listener = (_event: unknown, state: import('../src/shared/updates').UpdateState) =>
        callback(state)
      ipcRenderer.on('updates:changed', listener)
      return () => {
        ipcRenderer.removeListener('updates:changed', listener)
      }
    },
  },
  tradingIdeas,
  telegraph: {
    getFeed: (force) => invoke('telegraph:feed', force === true),
    loadOlder: (cursor) => invoke('telegraph:older', cursor),
    openItem: (id) => invoke('telegraph:open', id),
    onChanged: (callback) => {
      const listener = () => callback()
      ipcRenderer.on('telegraph:changed', listener)
      return () => {
        ipcRenderer.removeListener('telegraph:changed', listener)
      }
    },
  },
  feishu: {
    connect: (id) => invoke('feishu:connect', id),
    reopenAuthorization: (id) => invoke('feishu:reopen', id),
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
