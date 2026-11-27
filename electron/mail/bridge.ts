import { ipcRenderer } from 'electron'
import type { MailAPI, MailChange } from '../../src/shared/mail'
import type { ApiResult } from '../../src/shared/api'

export function mailBridge(owner: string): MailAPI {
  async function invoke<T>(method: string, ...args: unknown[]): Promise<T> {
    const result: ApiResult<T> = await ipcRenderer.invoke('mail:' + method, owner, ...args)
    if (!result.ok) throw new Error(result.error)
    return result.value
  }
  return {
    state: () => invoke('state'),
    importGoogle: () => invoke('import-google'),
    openSetupGuide: (guide) => invoke('setup-guide', guide),
    connect: (input) => invoke('connect', input),
    cancel: () => invoke('cancel'),
    reopen: () => invoke('reopen'),
    disconnect: (id) => invoke('disconnect', id),
    cached: (filter, disk) => invoke('cached', filter, disk),
    list: (filter, cursor, refresh) => invoke('list', filter, cursor, refresh),
    detail: (ref) => invoke('detail', ref),
    markRead: (ref) => invoke('read', ref),
    openMailbox: (account) => invoke('external', account),
    openReply: (ref) => invoke('reply', ref),
    onChanged: (callback) => {
      const listener = (_event: unknown, workspace: string, change: MailChange) => {
        if (workspace === owner) callback(change)
      }
      ipcRenderer.on('mail:changed', listener)
      return () => {
        ipcRenderer.removeListener('mail:changed', listener)
      }
    },
  }
}
