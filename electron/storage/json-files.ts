import { open, mkdir, readFile, rename, rm, copyFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { UnsupportedVersionError } from '../../src/shared/model'

export const MAX_FILE_BYTES = 20 * 1024 * 1024
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

export class JsonFiles {
  readonly notices: string[] = []

  async read<T>(
    path: string,
    parse: (value: unknown) => T,
    allowMissing = false,
  ): Promise<T | undefined> {
    const readOne = async (file: string): Promise<T> => {
      const bytes = await readFile(file)
      if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('数据文件超过 20 MB 限制')
      return parse(JSON.parse(bytes.toString('utf8')))
    }
    try {
      return await readOne(path)
    } catch (primaryError) {
      if (primaryError instanceof UnsupportedVersionError) throw primaryError
      let recovered: T
      try {
        recovered = await readOne(path + '.bak')
      } catch (backupError) {
        if (allowMissing && missing(primaryError) && missing(backupError)) return undefined
        throw new Error(
          `无法读取数据文件，原文件已保留：${path}\n${primaryError instanceof Error ? primaryError.message : ''}`,
        )
      }
      // Keep the damaged primary for manual recovery before restoring a validated backup.
      if (!missing(primaryError))
        await copyFile(path, `${path}.corrupt-${Date.now()}-${randomUUID()}`)
      await this.write(path, recovered)
      this.notices.push('检测到异常数据文件，已从上一份有效备份恢复。异常原文件已保留。')
      return recovered
    }
  }

  async write(path: string, value: unknown, previous?: unknown): Promise<void> {
    const content = JSON.stringify(value, null, 2) + '\n'
    if (Buffer.byteLength(content) > MAX_FILE_BYTES)
      throw new Error('数据超过 20 MB 限制，保存未完成')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    if (previous !== undefined)
      await this.atomic(path + '.bak', JSON.stringify(previous, null, 2) + '\n')
    await this.atomic(path, content)
  }

  private async atomic(path: string, content: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(content, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }
}
