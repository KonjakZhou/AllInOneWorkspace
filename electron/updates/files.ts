import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
export async function atomicWrite(path: string, bytes: string | Buffer) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
}
export async function readLimited(path: string, limit: number) {
  if ((await stat(path)).size > limit) throw new Error('更新文件超过大小限制')
  const bytes = await readFile(path)
  if (bytes.length > limit) throw new Error('更新文件超过大小限制')
  return bytes
}
export async function hashFile(path: string) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
