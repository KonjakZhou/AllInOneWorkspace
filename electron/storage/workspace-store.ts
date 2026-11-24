import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { JsonFiles } from './json-files'
import {
  emptyWorkspace,
  idSchema,
  nameSchema,
  parseExport,
  parseIndex,
  parseWorkspace,
  type AccountIndex,
  type Snapshot,
  type Workspace,
  type WorkspaceExport,
} from '../../src/shared/model'

export class WorkspaceStore {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(
    readonly directory: string,
    readonly files = new JsonFiles(),
  ) {}
  private get indexPath() {
    return join(this.directory, 'accounts.json')
  }
  private accountPath(id: string) {
    return join(this.directory, 'accounts', idSchema.parse(id) + '.json')
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation)
    this.tail = next.catch(() => undefined)
    return next
  }
  private async index(): Promise<AccountIndex> {
    const value = await this.files.read(this.indexPath, parseIndex)
    if (!value) throw new Error('账号索引不存在')
    return value
  }
  private async workspace(id: string): Promise<Workspace> {
    const value = await this.files.read(this.accountPath(id), (input) => {
      const doc = parseWorkspace(input)
      if (doc.accountId !== id) throw new Error('账号数据与文件不匹配')
      return doc
    })
    if (!value) throw new Error('账号数据不存在')
    return value
  }
  private async snapshot(index: AccountIndex): Promise<Snapshot> {
    const workspace = await this.workspace(index.activeAccountId)
    return {
      index,
      workspace,
      notices: this.files.notices.splice(0),
      dataDirectory: this.directory,
    }
  }
  private requireAccount(index: AccountIndex, id: string) {
    idSchema.parse(id)
    const account = index.accounts.find((item) => item.id === id)
    if (!account) throw new Error('账号不存在，操作未执行')
    return account
  }
  private uniqueName(index: AccountIndex, name: string): string {
    let candidate = name,
      suffix = 2
    while (index.accounts.some((account) => account.name === candidate))
      candidate = name.slice(0, 32) + ` (${suffix++})`
    return candidate
  }

  load(): Promise<Snapshot> {
    return this.queue(async () => {
      await mkdir(join(this.directory, 'accounts'), { recursive: true, mode: 0o700 })
      let index = await this.files.read(this.indexPath, parseIndex, true)
      if (!index) {
        if (
          (await readdir(join(this.directory, 'accounts'))).some((file) => file.endsWith('.json'))
        ) {
          throw new Error(
            '账号索引缺失，但发现已有账号文件。为保护数据，未创建新索引。请从备份恢复 accounts.json。',
          )
        }
        const id = randomUUID()
        index = {
          schemaVersion: 1,
          activeAccountId: id,
          accounts: [{ id, name: '默认账号', createdAt: new Date().toISOString() }],
        }
        await this.files.write(this.accountPath(id), emptyWorkspace(id))
        try {
          await this.files.write(this.indexPath, index)
        } catch (error) {
          await rm(this.accountPath(id), { force: true }).catch(() => undefined)
          throw error
        }
      }
      return this.snapshot(index)
    })
  }
  save(input: Workspace): Promise<void> {
    return this.queue(async () => {
      const workspace = parseWorkspace(input)
      this.requireAccount(await this.index(), workspace.accountId)
      const previous = await this.workspace(workspace.accountId)
      await this.files.write(this.accountPath(workspace.accountId), workspace, previous)
    })
  }
  createAccount(name: string): Promise<Snapshot> {
    return this.queue(async () => this.create(await this.index(), nameSchema.parse(name)))
  }
  private async create(index: AccountIndex, name: string, imported?: Workspace): Promise<Snapshot> {
    if (index.accounts.length >= 100) throw new Error('最多支持 100 个账号')
    const id = randomUUID()
    const workspace = imported ? { ...imported, accountId: id } : emptyWorkspace(id)
    const next: AccountIndex = {
      ...index,
      activeAccountId: id,
      accounts: [
        ...index.accounts,
        { id, name: this.uniqueName(index, name), createdAt: new Date().toISOString() },
      ],
    }
    await this.files.write(this.accountPath(id), workspace)
    try {
      await this.files.write(this.indexPath, next, index)
    } catch (error) {
      await rm(this.accountPath(id), { force: true }).catch(() => undefined)
      throw error
    }
    return this.snapshot(next)
  }
  renameAccount(id: string, name: string): Promise<Snapshot> {
    return this.queue(async () => {
      const index = await this.index()
      this.requireAccount(index, id)
      const parsed = nameSchema.parse(name)
      if (index.accounts.some((account) => account.id !== id && account.name === parsed))
        throw new Error('已有同名账号')
      const next = {
        ...index,
        accounts: index.accounts.map((account) =>
          account.id === id ? { ...account, name: parsed } : account,
        ),
      }
      await this.files.write(this.indexPath, next, index)
      return this.snapshot(next)
    })
  }
  switchAccount(id: string): Promise<Snapshot> {
    return this.queue(async () => {
      const index = await this.index()
      this.requireAccount(index, id)
      const workspace = await this.workspace(id)
      const next = { ...index, activeAccountId: id }
      await this.files.write(this.indexPath, next, index)
      return {
        index: next,
        workspace,
        notices: this.files.notices.splice(0),
        dataDirectory: this.directory,
      }
    })
  }
  deleteAccount(id: string): Promise<Snapshot> {
    return this.queue(async () => {
      const index = await this.index()
      this.requireAccount(index, id)
      if (index.accounts.length === 1) throw new Error('至少需要保留一个账号')
      const accounts = index.accounts.filter((account) => account.id !== id)
      const next = {
        ...index,
        accounts,
        activeAccountId: index.activeAccountId === id ? accounts[0].id : index.activeAccountId,
      }
      await this.workspace(next.activeAccountId)
      await this.files.write(this.indexPath, next, index)
      // Deletion commits at the index. Keep its backup consistent before removing account files.
      try {
        await this.files.write(this.indexPath + '.bak', next)
      } catch {
        this.files.notices.push(
          '账号已从列表删除，但备份索引清理失败。为保持恢复能力，旧账号文件暂时保留。',
        )
        return this.snapshot(next)
      }
      for (const suffix of ['', '.bak'])
        await rm(this.accountPath(id) + suffix, { force: true }).catch(() => {
          this.files.notices.push('账号已删除，但部分文件清理失败，可在数据目录手动清理。')
        })
      return this.snapshot(next)
    })
  }
  exportAccount(id: string): Promise<WorkspaceExport> {
    return this.queue(async () => {
      const account = this.requireAccount(await this.index(), id)
      return {
        format: 'all-in-one-workspace',
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        account: { name: account.name },
        workspace: await this.workspace(id),
      }
    })
  }
  importAccount(input: unknown): Promise<Snapshot> {
    return this.queue(async () => {
      const imported = parseExport(input)
      return this.create(await this.index(), imported.account.name, imported.workspace)
    })
  }
}
