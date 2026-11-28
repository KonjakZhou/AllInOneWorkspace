import { mkdir, open, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { REPOSITORY } from '../electron/updates/protocol.ts'

export function assertSigningCI(env = process.env) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
  )
    throw new Error('仅在本仓库 main 的 push 或手动 CI 签名步骤中使用')
}

export async function withTemporarySigningKey(secret, keyPath, operation) {
  // Remove the inherited secret before any operation can spawn a subprocess.
  // Do not restore it after signing, including on failure.
  delete process.env.UPDATE_SIGNING_PRIVATE_KEY
  if (typeof secret !== 'string' || !secret.trim())
    throw new Error('release 环境缺少 UPDATE_SIGNING_PRIVATE_KEY')
  await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 })
  let created = false
  try {
    const key = await open(keyPath, 'wx', 0o600)
    created = true
    try {
      await key.writeFile(secret)
    } finally {
      await key.close()
    }
    return await operation(keyPath)
  } finally {
    if (created) await rm(keyPath, { force: true })
  }
}

export async function main() {
  const secret = process.env.UPDATE_SIGNING_PRIVATE_KEY
  delete process.env.UPDATE_SIGNING_PRIVATE_KEY
  assertSigningCI()
  const keyPath = join(homedir(), '.config/all-in-one-workspace/release-signing/private.pem')
  return withTemporarySigningKey(secret, keyPath, () => {
    const result = spawnSync(process.execPath, ['scripts/release.mjs', 'sign'], {
      stdio: 'inherit',
      timeout: 120000,
    })
    if (result.error || result.status !== 0)
      throw new Error('签名失败；检查原私钥是否与仓库公钥匹配')
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main()
