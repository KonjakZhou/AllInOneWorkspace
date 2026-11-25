import { describe, expect, it, vi } from 'vitest'
import type { TelegraphItem } from '../src/shared/telegraph'
import type { TelegraphClientAPI } from '../electron/telegraph/client'
import { TelegraphError } from '../electron/telegraph/client'
import { TelegraphService } from '../electron/telegraph/service'
import { deferred } from './feishu-fixtures'

const item = (id: number, publishedAt = id * 1000, modifiedAt = publishedAt): TelegraphItem => ({
  id,
  headline: `消息 ${id}`,
  content: `内容 ${id}`,
  level: 'C',
  publishedAt,
  modifiedAt,
  important: false,
  subjects: [],
  url: `https://www.cls.cn/detail/${id}`,
})

const response = (items: TelegraphItem[], nextCursor: number | null = null) => ({
  items,
  nextCursor,
})

function setup() {
  let time = 1795519300000
  const changed = vi.fn()
  const client = {
    page: vi.fn<TelegraphClientAPI['page']>(async () =>
      response([item(2, time - 1000), item(1, time - 2000)], (time - 2000) / 1000),
    ),
  }
  const service = new TelegraphService(client, changed, () => time)
  return {
    client,
    service,
    changed,
    advance: (ms: number) => {
      time += ms
    },
    now: () => time,
  }
}

describe('shared CLS telegraph service', () => {
  it('coalesces callers, caches for 30 seconds and uses incremental refresh afterwards', async () => {
    const { client, service, advance, now } = setup()
    const pending = deferred<ReturnType<typeof response>>()
    client.page.mockImplementationOnce(() => pending.promise)
    const first = service.getFeed()
    const second = service.getFeed()
    expect(client.page).toHaveBeenCalledOnce()
    expect(client.page.mock.calls[0].slice(0, 3)).toEqual([Math.floor(now() / 1000), 1, 50])
    pending.resolve(response([item(1, now() - 1000)]))
    expect(await first).toEqual(await second)
    await service.getFeed()
    expect(client.page).toHaveBeenCalledOnce()
    advance(30000)
    client.page.mockResolvedValueOnce(response([item(2, now()), item(1, now() - 1000)]))
    const refreshed = await service.getFeed()
    expect(client.page.mock.calls[1].slice(0, 3)).toEqual([(now() - 31000) / 1000, 0, 50])
    expect(refreshed.items.map((value) => value.id)).toEqual([2, 1])
  })

  it('deduplicates revisions and only retains the most recent page for the live feed', async () => {
    const { client, service, advance, now } = setup()
    client.page.mockResolvedValueOnce(
      response(
        Array.from({ length: 50 }, (_, index) => item(index + 1)),
        1,
      ),
    )
    await service.getFeed()
    advance(30000)
    client.page.mockResolvedValueOnce(
      response([
        item(50, 50000, now()),
        ...Array.from({ length: 49 }, (_, index) => item(index + 51)),
      ]),
    )
    const result = await service.getFeed()
    expect(result.items).toHaveLength(50)
    expect(result.items[0].id).toBe(99)
    expect(result.historyCursor).toBe(50)
    expect(result.items.filter((value) => value.id === 50)).toHaveLength(1)
    expect(result.items.find((value) => value.id === 50)?.modifiedAt).toBe(now())
  })

  it('reads past 500 historical items using each requested cursor without growing the head', async () => {
    const { client, service } = setup()
    client.page
      .mockResolvedValueOnce(
        response(
          Array.from({ length: 50 }, (_, index) => item(700 - index)),
          651,
        ),
      )
      .mockImplementation(async (cursor) =>
        cursor > 50
          ? response(
              Array.from({ length: 50 }, (_, index) => item(cursor - 1 - index)),
              cursor - 50,
            )
          : response([]),
      )
    const head = await service.getFeed()
    let cursor = head.historyCursor
    let total = 0
    const calls: number[] = []
    while (cursor !== null) {
      calls.push(cursor)
      const { page } = await service.loadOlder(cursor)
      expect(page).toBeDefined()
      total += page!.items.length
      cursor = page!.nextCursor
    }
    expect(total).toBe(650)
    expect(client.page.mock.calls.slice(1).map(([time, direction]) => [time, direction])).toEqual(
      calls.map((time) => [time, 1]),
    )
    expect(await service.getFeed()).toEqual(head)
  })

  it('coalesces history for one cursor without blocking a live refresh', async () => {
    const { client, service, advance } = setup()
    client.page.mockResolvedValueOnce(response([item(100)], 100))
    await service.getFeed()
    advance(30000)

    const history = deferred<ReturnType<typeof response>>()
    client.page.mockImplementationOnce(() => history.promise)
    const older = service.loadOlder(100)
    const duplicate = service.loadOlder(100)
    const latestA = service.getFeed(true)
    const latestB = service.getFeed(true)
    expect(client.page).toHaveBeenCalledTimes(3)
    expect(client.page.mock.calls[2].slice(0, 3)).toEqual([100, 0, 50])
    expect(await latestA).toEqual(await latestB)
    history.resolve(response([item(99)], 99))
    expect(await older).toEqual(await duplicate)
  })

  it('backs off on a history rate limit and retries the same cursor without erasing the live head', async () => {
    const { client, service, advance } = setup()
    const head = await service.getFeed()
    const cursor = head.historyCursor!
    client.page.mockRejectedValueOnce(new TelegraphError('rate_limit', '稍后重试', 8000))
    expect((await service.loadOlder(cursor)).error?.kind).toBe('rate_limit')
    expect((await service.loadOlder(cursor)).error?.kind).toBe('rate_limit')
    expect(await service.getFeed()).toEqual(head)
    expect(client.page).toHaveBeenCalledTimes(2)
    advance(8000)
    client.page.mockResolvedValueOnce(response([item(99)], 99))
    expect((await service.loadOlder(cursor)).page?.nextCursor).toBe(99)
    expect(client.page.mock.calls[2].slice(0, 2)).toEqual([cursor, 1])
  })

  it('retains stale data, honors backoff and invalidates freshness after system resume', async () => {
    const { client, service, changed, advance } = setup()
    const original = await service.getFeed()
    advance(30000)
    client.page.mockRejectedValueOnce(new TelegraphError('network', '离线', 30000))
    const offline = await service.getFeed()
    expect(offline).toMatchObject({
      items: original.items,
      stale: true,
      error: { kind: 'network', message: '离线' },
    })
    await service.getFeed(true)
    expect(client.page).toHaveBeenCalledTimes(2)
    advance(30000)
    client.page.mockResolvedValueOnce(response([item(3)]))
    expect((await service.getFeed()).stale).toBe(false)
    service.resume()
    expect(changed).toHaveBeenCalled()
    await service.getFeed()
    expect(client.page).toHaveBeenCalledTimes(4)
  })

  it('throttles repeated forced refreshes to a five-second minimum', async () => {
    const { client, service, advance } = setup()
    await service.getFeed()
    await service.getFeed(true)
    expect(client.page).toHaveBeenCalledOnce()
    advance(5000)
    await service.getFeed(true)
    expect(client.page).toHaveBeenCalledTimes(2)
  })

  it('returns to an initial request after 15 minutes without a feed reader', async () => {
    const { client, service, advance, now } = setup()
    await service.getFeed()
    advance(15 * 60 * 1000)
    await service.getFeed()
    expect(client.page.mock.calls[1].slice(0, 3)).toEqual([now() / 1000, 1, 50])
  })
})
