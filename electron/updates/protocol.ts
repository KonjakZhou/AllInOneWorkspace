import { createHash, verify } from 'node:crypto'
import { z } from 'zod'

export const REPOSITORY = 'KonjakZhou/AllInOneWorkspace'
export const BUNDLE_ID = 'local.allinone.workspace'
export const APP_NAME = 'All In One Workspace.app'
export const MAX_DOWNLOAD = 1024 ** 3
export const MAX_METADATA = 64 * 1024
export const MANIFEST_NAME = 'update-mac-arm64.json'
export const SIGNATURE_NAME = MANIFEST_NAME + '.sig'
export const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const asset = z
  .object({
    name: z
      .string()
      .regex(/^[A-Za-z0-9 ._-]+\.(zip|dmg)$/)
      .max(160),
    size: z.number().int().positive().max(MAX_DOWNLOAD),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
export const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    repository: z.literal(REPOSITORY),
    bundleId: z.literal(BUNDLE_ID),
    version: z.string().regex(STABLE),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    platform: z.literal('darwin'),
    arch: z.literal('arm64'),
    minimumSystemVersion: z.string().regex(/^\d+\.\d+(\.\d+)?$/),
    zip: asset,
    dmg: asset,
  })
  .strict()
export type UpdateManifest = z.infer<typeof manifestSchema>
export function compareVersions(a: string, b: string) {
  if (!STABLE.test(a) || !STABLE.test(b)) throw new Error('无效的正式版本号')
  const left = a.split('.').map(BigInt),
    right = b.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1
  return 0
}
export function systemSupports(actual: string, required: string) {
  const pad = (v: string) => v.split('.').concat(['0', '0']).slice(0, 3).join('.')
  return compareVersions(pad(actual), pad(required)) >= 0
}
export function verifyManifest(
  bytes: Buffer,
  signature: string,
  publicKey: string,
): UpdateManifest {
  if (bytes.length > MAX_METADATA || !/^[A-Za-z0-9+/]{86}==$/.test(signature.trim()))
    throw new Error('更新签名格式无效')
  const raw = Buffer.from(publicKey, 'base64')
  if (raw.length !== 32) throw new Error('尚未配置更新公钥')
  const key = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
  if (
    !verify(
      null,
      bytes,
      { key, type: 'spki', format: 'der' },
      Buffer.from(signature.trim(), 'base64'),
    )
  )
    throw new Error('更新签名校验失败，已拒绝安装')
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')))
  if (!manifest.zip.name.endsWith('.zip') || !manifest.dmg.name.endsWith('.dmg'))
    throw new Error('安装包类型无效')
  return manifest
}
export function assetUrl(version: string, name: string) {
  if (!STABLE.test(version) || !/^[A-Za-z0-9 ._-]+$/.test(name)) throw new Error('无效的更新地址')
  return `https://github.com/${REPOSITORY}/releases/download/v${version}/${encodeURIComponent(name)}`
}
export function releaseUrl(version?: string) {
  return `https://github.com/${REPOSITORY}/releases${version && STABLE.test(version) ? `/tag/v${version}` : ''}`
}
export function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex')
}
