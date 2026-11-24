import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EncryptedVault, type Encryption } from '../electron/feishu/vault'
import { WorkspaceStore } from '../electron/storage/workspace-store'
import { credentials } from './feishu-fixtures'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'feishu-vault-'))
  directories.push(directory)
  const key = randomBytes(32)
  const encryption: Encryption = {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptStringAsync: vi.fn(async (value) => {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), data])
    }),
    decryptStringAsync: vi.fn(async (value) => {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12))
      cipher.setAuthTag(value.subarray(12, 28))
      return {
        result: Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString('utf8'),
        shouldReEncrypt: false,
      }
    }),
  }
  return { directory, encryption, vault: new EncryptedVault(directory, encryption) }
}
describe('encrypted local credential vault', () => {
  it('stores only ciphertext, uses private permissions, rotates atomically without credential backups', async () => {
    const { directory, encryption, vault } = await setup(),
      id = randomUUID()
    const path = join(directory, 'connections/feishu', id + '.json')
    await vault.write(id, credentials())
    expect(await vault.read(id)).toEqual(credentials())
    expect(encryption.encryptStringAsync).toHaveBeenCalledOnce()
    const file = await readFile(path, 'utf8')
    expect(file).not.toMatch(/test-secret|refresh-|access-|calendar-/)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    await vault.write(id, { ...credentials('新'), authMode: 'device' })
    expect((await vault.read(id))?.authMode).toBe('device')
    expect(await readdir(join(directory, 'connections/feishu'))).toEqual([id + '.json'])
    await vault.remove(id)
    expect(await vault.read(id)).toBeUndefined()
  })
  it('does not fall back to plaintext and preserves corrupted credentials', async () => {
    const { directory, encryption, vault } = await setup(),
      id = randomUUID()
    vi.mocked(encryption.isAsyncEncryptionAvailable).mockResolvedValueOnce(false)
    await expect(vault.write(id, credentials())).rejects.toThrow('钥匙串')
    expect(await vault.read(id)).toBeUndefined()
    await vault.write(id, credentials())
    const path = join(directory, 'connections/feishu', id + '.json')
    await writeFile(path, 'broken')
    await expect(vault.read(id)).rejects.toThrow('解密')
    expect(await readFile(path, 'utf8')).toBe('broken')
  })
  it('never exports credentials or calendar cache; imported calendars require a new binding', async () => {
    const { directory, vault } = await setup(),
      store = new WorkspaceStore(directory)
    const first = await store.load(),
      id = first.index.activeAccountId
    await vault.write(id, credentials())
    await store.save({
      ...first.workspace,
      widgets: [
        {
          id: randomUUID(),
          type: 'feishu.calendar',
          version: 1,
          config: {},
          data: null,
          layout: { x: 0, y: 0, w: 3, h: 14 },
        },
      ],
    })
    const exported = await store.exportAccount(id)
    expect(JSON.stringify(exported)).not.toMatch(
      /test-secret|refresh-|access-|calendar-甲|authorization|ciphertext/,
    )
    const imported = await store.importAccount(exported)
    expect(imported.workspace.widgets[0]).toMatchObject({ type: 'feishu.calendar', data: null })
    expect(imported.index.activeAccountId).not.toBe(id)
    expect(await vault.read(imported.index.activeAccountId)).toBeUndefined()
    await store.deleteAccount(id, (accountId) => vault.remove(accountId))
    expect(await vault.read(id)).toBeUndefined()
  })
})
