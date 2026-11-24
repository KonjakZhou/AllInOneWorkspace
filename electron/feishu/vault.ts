import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { idSchema } from '../../src/shared/model'
import { feishuConfigSchema } from '../../src/shared/feishu'
import { JsonFiles } from '../storage/json-files'
import { FeishuError } from './errors'

export const tokenSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  refreshExpiresAt: z.number(),
})
const authorizationSchema = z.object({
  application: feishuConfigSchema,
  token: tokenSchema,
  identity: z.object({ openId: z.string(), name: z.string(), tenantKey: z.string().optional() }),
  calendarId: z.string(),
})
export const credentialSchema = z.object({
  schemaVersion: z.literal(1),
  configuration: feishuConfigSchema,
  authMode: z.literal('device').optional(),
  authorization: authorizationSchema.optional(),
})
export type CredentialRecord = z.infer<typeof credentialSchema>
export type Authorization = z.infer<typeof authorizationSchema>
export interface Encryption {
  isAsyncEncryptionAvailable(): Promise<boolean>
  encryptStringAsync(value: string): Promise<Buffer>
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>
}
export interface CredentialVault {
  read(accountId: string): Promise<CredentialRecord | undefined>
  write(accountId: string, record: CredentialRecord): Promise<void>
  remove(accountId: string): Promise<void>
}

export class EncryptedVault implements CredentialVault {
  constructor(
    private directory: string,
    private encryption: Encryption,
    private files = new JsonFiles(),
  ) {}
  private path(id: string) {
    return join(this.directory, 'connections', 'feishu', idSchema.parse(id) + '.json')
  }
  private async available() {
    if (!(await this.encryption.isAsyncEncryptionAvailable()))
      throw new FeishuError('storage', '系统钥匙串不可用，无法保存飞书凭证。请解锁钥匙串后重试。')
  }
  async read(accountId: string): Promise<CredentialRecord | undefined> {
    let text: string
    try {
      text = await readFile(this.path(accountId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new FeishuError('storage', '无法读取飞书凭证文件，请检查本地数据目录。')
    }
    try {
      await this.available()
      const wrapper = z
        .object({ schemaVersion: z.literal(1), ciphertext: z.string().max(100000) })
        .parse(JSON.parse(text))
      const decrypted = await this.encryption.decryptStringAsync(
        Buffer.from(wrapper.ciphertext, 'base64'),
      )
      const value = credentialSchema.parse(JSON.parse(decrypted.result))
      if (decrypted.shouldReEncrypt) await this.write(accountId, value)
      return value
    } catch {
      throw new FeishuError(
        'storage',
        '无法解密本机飞书凭证。请检查钥匙串；也可断开连接后重新配置授权。原文件未覆盖。',
      )
    }
  }
  async write(accountId: string, input: CredentialRecord): Promise<void> {
    try {
      await this.available()
      const record = credentialSchema.parse(input)
      const encrypted = await this.encryption.encryptStringAsync(JSON.stringify(record))
      // No rolling credential backup: old refresh tokens are single-use and must not be restored.
      await this.files.write(this.path(accountId), {
        schemaVersion: 1,
        ciphertext: encrypted.toString('base64'),
      })
    } catch (error) {
      if (error instanceof FeishuError) throw error
      throw new FeishuError('storage', '飞书凭证保存失败，请检查磁盘空间和目录权限后重试。')
    }
  }
  async remove(accountId: string): Promise<void> {
    try {
      await rm(this.path(accountId), { force: true })
    } catch {
      throw new FeishuError('storage', '飞书凭证清理失败，请检查目录权限并再次断开连接。')
    }
  }
}
