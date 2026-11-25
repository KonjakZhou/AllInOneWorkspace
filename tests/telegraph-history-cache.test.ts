import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TelegraphHistoryCache } from '../electron/telegraph/history-cache'
import { TelegraphService } from '../electron/telegraph/service'
import type { TelegraphHistoryPage } from '../src/shared/telegraph'

let directory: string
let now: number
let cache: TelegraphHistoryCache
const day = 24 * 60 * 60 * 1000
const history = (cursor: number, content = '快讯'): TelegraphHistoryPage => ({
  cursor,
  nextCursor: cursor - 1,
  items: [
    {
      id: cursor - 1,
      headline: '快讯',
      content,
      level: 'C',
      publishedAt: (cursor - 1) * 1000,
      modifiedAt: (cursor - 1) * 1000,
      important: false,
      subjects: [],
      url: `https://www.cls.cn/detail/${cursor - 1}`,
    },
  ],
})

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'telegraph-history-'))
  now = 1795519300000
  cache = new TelegraphHistoryCache(directory, () => now)
})
afterEach(async () => rm(directory, { force: true, recursive: true }))

it('uses memory, then disk, then the upstream for the same history read', async () => {
  const page = vi.fn(async () => history(100, '网站返回'))
  const coldCache = new TelegraphHistoryCache(directory, () => now)
  const service = new TelegraphService(
    { page },
    () => undefined,
    () => now,
    coldCache,
  )
  await cache.put(history(100))
  expect((await service.loadOlder(100)).page?.items[0].content).toBe('快讯')
  expect(page).not.toHaveBeenCalled()

  await rm(join(directory, '100.json'))
  expect((await service.loadOlder(100)).page?.items[0].content).toBe('快讯')
  expect(page).not.toHaveBeenCalled()

  now += 5 * 60 * 1000
  expect((await service.loadOlder(100)).page?.items[0].content).toBe('网站返回')
  expect(page).toHaveBeenCalledWith(100, 1, 50, expect.any(AbortSignal))
  expect((await service.loadOlder(100)).page?.items[0].content).toBe('网站返回')
  const restarted = new TelegraphHistoryCache(directory, () => now)
  expect((await restarted.get(100))?.items[0].content).toBe('网站返回')
  expect(page).toHaveBeenCalledOnce()
})

it('keeps four recently used pages in memory and falls back to disk after eviction', async () => {
  for (let cursor = 100; cursor <= 104; cursor++) await cache.put(history(cursor))
  expect(await cache.get(100)).toEqual(history(100))
  await rm(join(directory, '101.json'))
  expect(await cache.get(101)).toBeUndefined()
  await rm(join(directory, '104.json'))
  expect(await cache.get(104)).toEqual(history(104))
})

it('cleans unused disk pages on schedule and extends expiry on a cache hit', async () => {
  await cache.put(history(100))
  await cache.put(history(150))
  now += day - 1000
  expect(await cache.get(150)).toEqual(history(150))
  now += 2000
  await cache.cleanup()
  expect(await readdir(directory)).toEqual(['150.json'])
  expect(await cache.get(100)).toBeUndefined()
  expect(await cache.get(150)).toEqual(history(150))
})

it('evicts least recently used pages when the page or byte budget is full', async () => {
  for (let cursor = 2; cursor <= 130; cursor++) {
    await cache.put(history(cursor))
    now += 1000
  }
  expect(await readdir(directory)).toHaveLength(128)
  expect(await cache.get(2)).toBeUndefined()
  expect(await cache.get(3)).toEqual(history(3))
  const large = 'a'.repeat(600_000)
  for (let cursor = 200; cursor <= 229; cursor++) {
    now += 1000
    await cache.put(history(cursor, large))
  }
  const files = await readdir(directory)
  const sizes = await Promise.all(
    files.map(async (name) => (await stat(join(directory, name))).size),
  )
  expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(16 * 1024 * 1024)
  expect(await cache.get(200)).toBeUndefined()
  expect(await cache.get(229)).toEqual(history(229, large))
})
