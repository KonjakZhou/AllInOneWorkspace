import { clipboard, dialog, shell, type BrowserWindow } from 'electron'
import { open } from 'node:fs/promises'
import {
  connectSchema,
  cursorSchema,
  filterSchema,
  mailIdSchema,
  mailSetupGuides,
  refSchema,
  type MailSetupGuide,
} from '../../src/shared/mail'
import { googleFileSchema, MailError } from './provider'
import type { MailService } from './service'

async function importGoogle(parent: BrowserWindow) {
  const choice = await dialog.showOpenDialog(parent, {
    title: '导入 Google 桌面 OAuth 配置',
    properties: ['openFile'],
    filters: [{ name: 'OAuth 配置', extensions: ['json'] }],
  })
  if (choice.canceled || !choice.filePaths[0]) return null
  const handle = await open(choice.filePaths[0], 'r')
  try {
    const bytes = Buffer.alloc(65537)
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
    if (bytesRead > 65536) throw new MailError('Google OAuth 配置文件过大。')
    const result = googleFileSchema.safeParse(
      JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')),
    )
    if (!result.success)
      throw new MailError('请选择从 Google Cloud 下载的桌面应用 OAuth JSON 文件。')
    return {
      clientId: result.data.installed.client_id,
      secret: result.data.installed.client_secret,
    }
  } catch (error) {
    if (error instanceof SyntaxError) throw new MailError('Google OAuth 配置不是有效的 JSON。')
    throw error
  } finally {
    await handle.close()
  }
}

export function registerMailHandlers(
  handle: (channel: string, action: (...args: unknown[]) => unknown) => void,
  service: MailService,
  isActiveAccount: (id: string) => Promise<boolean>,
  getWindow: () => BrowserWindow | null,
) {
  const register = (
    name: string,
    action: (workspace: string, args: unknown[], parent: BrowserWindow) => unknown,
  ) => {
    handle('mail:' + name, async (account, ...args) => {
      try {
        const workspace = mailIdSchema.parse(account)
        const parent = getWindow()
        if (!parent || !(await isActiveAccount(workspace)))
          throw new MailError('当前工作区已切换。')
        const value = await action(workspace, args, parent)
        if (parent.isDestroyed() || !(await isActiveAccount(workspace)))
          throw new MailError('当前工作区已切换。')
        return value
      } catch (error) {
        throw error instanceof MailError
          ? error
          : new MailError('邮箱操作未完成，请检查输入后重试。')
      }
    })
  }
  register('state', (id) => service.state(id))
  register('import-google', async (id, _args, parent) => {
    const config = await importGoogle(parent)
    if (!config) return false
    if (parent.isDestroyed() || !(await isActiveAccount(id)))
      throw new MailError('当前工作区已切换。')
    await service.importGoogle(id, config)
    return true
  })
  register('connect', (id, [input]) => service.connect(id, connectSchema.parse(input)))
  register('setup-guide', async (_id, [guide]) => {
    if (typeof guide !== 'string' || !Object.hasOwn(mailSetupGuides, guide))
      throw new MailError('邮箱教程链接无效。')
    await shell.openExternal(mailSetupGuides[guide as MailSetupGuide])
  })
  register('cancel', (id) => service.cancel(id))
  register('disconnect', (id, [account]) => service.disconnect(id, mailIdSchema.parse(account)))
  register('cached', (id, [filter, disk]) =>
    service.cached(id, filterSchema.parse(filter), disk === true),
  )
  register('list', (id, [filter, cursor, revalidate]) =>
    service.list(
      id,
      filterSchema.parse(filter),
      cursorSchema.optional().parse(cursor),
      revalidate === true,
    ),
  )
  register('detail', (id, [ref]) => service.detail(id, refSchema.parse(ref)))
  register('read', (id, [ref]) => service.markRead(id, refSchema.parse(ref)))
  register('external', (id, [account]) => service.openMailbox(id, mailIdSchema.parse(account)))
  register('reply', async (id, [ref], parent) => {
    const result = await service.openReply(id, refSchema.parse(ref))
    if (parent.isDestroyed() || !(await isActiveAccount(id)))
      throw new MailError('当前工作区已切换。')
    if (result.kind !== 'mailbox' || !result.keyword) return result.kind
    await clipboard.writeText(result.keyword)
    return 'mailbox-with-keyword'
  })
  register('reopen', async (id) => {
    const setup = (await service.state(id)).setup
    if (!setup?.url) throw new MailError('当前没有可重开的授权页面。')
    const url = new URL(setup.url)
    if (
      url.protocol !== 'https:' ||
      !['open.feishu.cn', 'accounts.feishu.cn'].includes(url.host) ||
      url.username ||
      url.password
    )
      throw new MailError('授权地址无效。')
    await shell.openExternal(url.href)
  })
}
