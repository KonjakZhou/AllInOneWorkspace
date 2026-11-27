import type { Snapshot, Workspace } from './model'
import type { FeishuAPI } from './feishu'
import type { TelegraphAPI } from './telegraph'
import type { TradingIdeasAPI } from './trading-ideas'
import type { UpdatesAPI } from './updates'
import type { MailAPI } from './mail'

export interface DesktopAPI {
  mailFor(workspace: string): MailAPI
  updates: UpdatesAPI
  feishu: FeishuAPI
  telegraph: TelegraphAPI
  tradingIdeas: TradingIdeasAPI
  load(): Promise<Snapshot>
  save(workspace: Workspace): Promise<void>
  createAccount(name: string): Promise<Snapshot>
  renameAccount(id: string, name: string): Promise<Snapshot>
  switchAccount(id: string): Promise<Snapshot>
  deleteAccount(id: string): Promise<Snapshot>
  exportAccount(id: string): Promise<boolean>
  importAccount(): Promise<Snapshot | null>
  onCloseRequested(callback: () => Promise<void>): () => void
  finishClose(): Promise<void>
}
export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string }

declare global {
  interface Window {
    workspace: DesktopAPI
  }
}
