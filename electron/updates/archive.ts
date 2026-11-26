import yauzl from 'yauzl'
import { posix } from 'node:path'
import { APP_NAME } from './protocol'

// Inspect before invoking the system extractor. In particular, no entry may be beneath
// a symlink entry, so extraction order cannot redirect a subsequent write outside staging.
export function inspectArchive(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      path,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) return reject(error ?? new Error('无法读取更新包'))
        let total = 0,
          count = 0
        const entries = new Set<string>(),
          links = new Set<string>()
        const fail = (error: unknown) => {
          zip.close()
          reject(error)
        }
        zip.on('error', fail)
        zip.on('entry', (entry: yauzl.Entry) => {
          try {
            const name = entry.fileName.replace(/\/$/, '')
            if (++count > 100000 || (total += entry.uncompressedSize) > 3 * 1024 ** 3)
              throw new Error('解压内容超过限制')
            if (name !== APP_NAME && !name.startsWith(APP_NAME + '/'))
              throw new Error('更新包包含意外文件')
            if (
              /[\\\u0000-\u001f]/.test(name) ||
              name.split('/').some((p) => !p || p === '.' || p === '..')
            )
              throw new Error('更新包包含不安全路径')
            const key = name.normalize('NFC').toLowerCase()
            if (entries.has(key)) throw new Error('更新包包含重复路径')
            entries.add(key)
            const type = (entry.externalFileAttributes >>> 16) & 0o170000
            if (![0, 0o100000, 0o040000, 0o120000].includes(type))
              throw new Error('更新包包含不支持的文件类型')
            if (entry.generalPurposeBitFlag & 1) throw new Error('不支持加密更新包')
            if (type !== 0o120000) {
              zip.readEntry()
              return
            }
            if (entry.uncompressedSize > 4096) throw new Error('符号链接过长')
            links.add(key)
            zip.openReadStream(entry, (error, stream) => {
              if (error || !stream) return fail(error ?? new Error('无法读取符号链接'))
              const chunks: Buffer[] = []
              stream.on('data', (chunk) => chunks.push(chunk))
              stream.on('error', fail)
              stream.on('end', () => {
                const target = Buffer.concat(chunks).toString('utf8')
                const destination = posix.normalize(posix.join(posix.dirname(name), target))
                if (
                  !target ||
                  /[\\\u0000-\u001f]/.test(target) ||
                  posix.isAbsolute(target) ||
                  !destination.startsWith(APP_NAME + '/')
                )
                  return fail(new Error('更新包包含逃逸的符号链接'))
                zip.readEntry()
              })
            })
          } catch (error) {
            fail(error)
          }
        })
        zip.on('end', () => {
          for (const entry of entries) {
            let parent = posix.dirname(entry)
            while (parent !== '.') {
              if (links.has(parent)) return fail(new Error('更新包通过符号链接写入文件'))
              parent = posix.dirname(parent)
            }
          }
          if (!entries.has(`${APP_NAME}/Contents/Info.plist`.toLowerCase()))
            return fail(new Error('更新包缺少 App'))
          resolve()
        })
        zip.readEntry()
      },
    )
  })
}
