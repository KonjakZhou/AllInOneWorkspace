import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { telegraphHistoryPageSchema, type TelegraphHistoryPage } from '../../src/shared/telegraph'

const MAX_BYTES = 16 * 1024 * 1024
const MAX_PAGES = 128
const IDLE_FOR = 24 * 60 * 60 * 1000
const MAX_PAGE_BYTES = 1024 * 1024
const HOT_PAGES = 4
const HOT_IDLE_FOR = 5 * 60 * 1000

export class TelegraphHistoryCache {
  private tail: Promise<unknown> = Promise.resolve()
  private hot = new Map<number, { page: TelegraphHistoryPage; usedAt: number }>()

  constructor(
    private directory: string,
    private now = Date.now,
  ) {}

  private queue<T>(operation: () => Promise<T>): Promise<T | undefined> {
    const result = this.tail.then(operation).catch(() => undefined)
    this.tail = result
    return result
  }

  expireMemory() {
    const now = this.now()
    for (const [cursor, entry] of this.hot) {
      if (now - entry.usedAt >= HOT_IDLE_FOR) this.hot.delete(cursor)
    }
  }

  private remember(page: TelegraphHistoryPage) {
    this.expireMemory()
    this.hot.delete(page.cursor)
    this.hot.set(page.cursor, { page, usedAt: this.now() })
    if (this.hot.size > HOT_PAGES) {
      const oldest = this.hot.keys().next()
      if (!oldest.done) this.hot.delete(oldest.value)
    }
  }

  private fromMemory(cursor: number) {
    this.expireMemory()
    const hit = this.hot.get(cursor)
    if (!hit) return
    this.remember(hit.page)
    return hit.page
  }

  async get(cursor: number) {
    const hit = this.fromMemory(cursor)
    if (hit) return hit
    return this.queue(async () => {
      const warmed = this.fromMemory(cursor)
      if (warmed) return warmed
      const path = join(this.directory, `${cursor}.json`)
      const info = await stat(path)
      const now = this.now()
      if (now - info.mtimeMs >= IDLE_FOR || info.size > MAX_PAGE_BYTES) {
        await rm(path, { force: true })
        return
      }
      const page = telegraphHistoryPageSchema.parse(JSON.parse(await readFile(path, 'utf8')))
      if (page.cursor !== cursor || (page.nextCursor !== null && page.nextCursor >= cursor)) return
      this.remember(page)
      await utimes(path, now / 1000, now / 1000).catch(() => undefined)
      return page
    })
  }

  put(page: TelegraphHistoryPage) {
    return this.queue(async () => {
      const content = JSON.stringify(page)
      const size = Buffer.byteLength(content)
      if (size > MAX_PAGE_BYTES) return
      this.remember(page)
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      const path = join(this.directory, `${page.cursor}.json`)
      const temporary = `${path}.tmp`
      await this.prune(page.cursor, size)
      try {
        await writeFile(temporary, content, { mode: 0o600, flag: 'wx' })
        const now = this.now() / 1000
        await utimes(temporary, now, now)
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
    })
  }

  cleanup() {
    return this.queue(() => this.prune())
  }

  private async prune(replacing?: number, reservedBytes = 0) {
    const entries = await readdir(this.directory, { withFileTypes: true })
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^\d+\.json(?:\.tmp)?$/u.test(entry.name))
        .map(async ({ name }) => {
          const path = join(this.directory, name)
          if (name.endsWith('.tmp')) {
            await rm(path, { force: true })
            return
          }
          if (name === `${replacing}.json`) return
          const { size, mtimeMs } = await stat(path)
          return { path, size, mtimeMs }
        }),
    )
    let bytes = reservedBytes
    let pages = replacing === undefined ? 0 : 1
    const now = this.now()
    for (const file of files
      .filter((file) => file !== undefined)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)) {
      if (now - file.mtimeMs >= IDLE_FOR || pages >= MAX_PAGES || bytes + file.size > MAX_BYTES) {
        await rm(file.path, { force: true })
      } else {
        bytes += file.size
        pages++
      }
    }
  }
}
