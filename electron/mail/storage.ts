import { createHash } from 'node:crypto'
import { readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { MAIL_POLICY } from '../../src/shared/mail-policy'
import { mailIdSchema, summarySchema, type MailRef, type MailSummary } from '../../src/shared/mail'
import type { Encryption } from '../feishu/vault'
import { JsonFiles } from '../storage/json-files'
import { MailError, registrySchema, type MailRegistry, type RangeResult } from './provider'

const PAGE_BYTES = MAIL_POLICY.diskEntryBytes
const pageSchema = z.object({
  items: z.array(summarySchema),
  exhausted: z.boolean().optional(),
  revision: z.string().optional(),
  // Content age must not change when an idle read touches the file's mtime.
  fetchedAt: z.number().optional(),
})
const wrapperSchema = z.object({ version: z.literal(1), ciphertext: z.string() })
const cacheName = /^[\da-f-]{36}_[\da-f-]{36}_[\da-f]{64}\.json$/u

export class MailStorage {
  private tail: Promise<unknown> = Promise.resolve()
  private files = new JsonFiles()
  private history: string

  constructor(
    private directory: string,
    private encryption: Encryption,
  ) {
    this.history = join(directory, 'cache', 'mail-v1')
  }

  private vault(workspace: string) {
    return join(this.directory, 'connections', 'mail-v1', mailIdSchema.parse(workspace) + '.json')
  }

  private async decrypt(path: string, maxBytes: number) {
    const info = await stat(path)
    if (info.size > maxBytes) throw new Error('文件过大')
    const envelope = wrapperSchema.parse(JSON.parse(await readFile(path, 'utf8')))
    const { result } = await this.encryption.decryptStringAsync(
      Buffer.from(envelope.ciphertext, 'base64'),
    )
    return JSON.parse(result) as unknown
  }

  private async encrypt(path: string, value: unknown, maxBytes: number) {
    if (!(await this.encryption.isAsyncEncryptionAvailable())) throw new Error('系统钥匙串不可用')
    const content = JSON.stringify(value)
    if ((Buffer.byteLength(content) * 4) / 3 + 512 > maxBytes) throw new Error('文件过大')
    const ciphertext = await this.encryption.encryptStringAsync(content)
    await this.files.write(path, { version: 1, ciphertext: ciphertext.toString('base64') })
  }

  async load(workspace: string): Promise<MailRegistry> {
    try {
      return registrySchema.parse(await this.decrypt(this.vault(workspace), 4 * PAGE_BYTES))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { accounts: [] }
      throw new MailError('无法解密邮箱凭证，请解锁系统钥匙串后重试。')
    }
  }

  async save(workspace: string, registry: MailRegistry) {
    try {
      const path = this.vault(workspace)
      if (!registry.accounts.length && !registry.google) await rm(path, { force: true })
      else await this.encrypt(path, registrySchema.parse(registry), 4 * PAGE_BYTES)
    } catch {
      throw new MailError('无法保存邮箱凭证，请检查系统钥匙串和磁盘权限。')
    }
  }

  async removeWorkspace(workspace: string) {
    await rm(this.vault(workspace), { force: true })
    await this.forget(workspace)
  }

  private queued<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const result = this.tail.then(fn).catch(() => undefined)
    this.tail = result
    return result
  }

  private name(workspace: string, account: string, key: string) {
    return (
      mailIdSchema.parse(workspace) +
      '_' +
      mailIdSchema.parse(account) +
      '_' +
      createHash('sha256').update(key).digest('hex') +
      '.json'
    )
  }

  get(workspace: string, account: string, key: string) {
    return this.queued(async () => {
      const path = join(this.history, this.name(workspace, account, key))
      const now = Date.now()
      const { mtimeMs } = await stat(path)
      if (now - mtimeMs >= MAIL_POLICY.diskIdleMs) {
        await rm(path, { force: true })
        return
      }
      const value = pageSchema.parse(await this.decrypt(path, PAGE_BYTES))
      if (value.items.some((item) => item.account !== account)) return
      await utimes(path, now / 1000, now / 1000).catch(() => undefined)
      return value
    })
  }

  put(workspace: string, account: string, key: string, result: RangeResult) {
    return this.queued(async () => {
      await this.encrypt(
        join(this.history, this.name(workspace, account, key)),
        pageSchema.parse({ ...result, fetchedAt: Date.now() }),
        PAGE_BYTES,
      )
      await this.prune()
    })
  }

  private async accountPages(workspace: string, account: string) {
    const prefix = mailIdSchema.parse(workspace) + '_' + mailIdSchema.parse(account) + '_'
    return (await this.names())
      .filter((entry) => entry.startsWith(prefix))
      .map((name) => join(this.history, name))
  }

  recent(workspace: string, account: string) {
    return this.queued(async () => {
      const now = Date.now()
      const pages = await Promise.all(
        (await this.accountPages(workspace, account)).map(async (path) => {
          try {
            const { mtimeMs } = await stat(path)
            if (now - mtimeMs >= MAIL_POLICY.diskIdleMs) return
            const page = pageSchema.parse(await this.decrypt(path, PAGE_BYTES))
            if (page.items.some((item) => item.account !== account)) return
            await utimes(path, now / 1000, now / 1000).catch(() => undefined)
            return { page, fetchedAt: page.fetchedAt ?? mtimeMs }
          } catch {
            return
          }
        }),
      )
      const items = new Map<string, MailSummary>()
      for (const { page } of pages
        .filter((page) => !!page)
        .sort((a, b) => a.fetchedAt - b.fetchedAt))
        for (const item of page.items) items.set(item.id, item)
      return [...items.values()]
    })
  }

  markRead(workspace: string, ref: MailRef) {
    return this.queued(async () => {
      for (const path of await this.accountPages(workspace, ref.account)) {
        try {
          const info = await stat(path)
          const page = pageSchema.parse(await this.decrypt(path, PAGE_BYTES))
          if (
            !page.items.some(
              (item) => item.account === ref.account && item.id === ref.id && item.unread,
            )
          )
            continue
          page.items = page.items.map((item) =>
            item.account === ref.account && item.id === ref.id ? { ...item, unread: false } : item,
          )
          await this.encrypt(path, page, PAGE_BYTES)
          await utimes(path, info.atime, info.mtime)
        } catch {
          continue
        }
      }
    })
  }

  forget(workspace: string, account?: string) {
    const prefix =
      mailIdSchema.parse(workspace) + '_' + (account ? mailIdSchema.parse(account) + '_' : '')
    return this.queued(async () => {
      for (const entry of await this.names())
        if (entry.startsWith(prefix)) await rm(join(this.history, entry), { force: true })
    })
  }

  cleanup() {
    return this.queued(() => this.prune())
  }

  private async names() {
    try {
      return (await readdir(this.history, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && cacheName.test(entry.name))
        .map(({ name }) => name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async prune() {
    const now = Date.now()
    const files = await Promise.all(
      (await this.names()).map(async (name) => {
        const path = join(this.history, name)
        return { path, ...(await stat(path)) }
      }),
    )
    let bytes = 0
    let pages = 0
    for (const { path, size, mtimeMs } of files.sort((a, b) => b.mtimeMs - a.mtimeMs)) {
      if (
        pages >= MAIL_POLICY.diskEntries ||
        bytes + size > MAIL_POLICY.diskBytes ||
        now - mtimeMs >= MAIL_POLICY.diskIdleMs
      )
        await rm(path, { force: true })
      else {
        pages++
        bytes += size
      }
    }
  }
}
