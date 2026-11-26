import { shell } from 'electron'
import { z } from 'zod'
import { idSchema } from '../../src/shared/model'
import {
  ideaIdSchema,
  ideaNoteSchema,
  ideaQuerySchema,
  ideaUrl,
  manualIdeaSchema,
} from '../../src/shared/trading-ideas'
import type { IdeaService } from './service'

export function registerIdeaHandlers(
  handle: (channel: string, run: (...input: unknown[]) => unknown) => void,
  service: IdeaService,
  isActiveAccount: (id: string) => Promise<boolean>,
) {
  const scope = async (value: unknown) => {
    const id = idSchema.parse(value)
    if (!(await isActiveAccount(id))) throw new Error('当前工作区账号已变更')
    return id
  }
  handle('ideas:enable', async (account) => {
    await scope(account)
    service.enable()
  })
  handle('ideas:overview', async (account) => service.overview(await scope(account)))
  handle('ideas:list', async (account, query) =>
    service.archive.list(await scope(account), ideaQuerySchema.parse(query)),
  )
  handle('ideas:detail', async (account, id) =>
    service.detail(await scope(account), ideaIdSchema.parse(id)),
  )
  handle('ideas:add', async (account, input) =>
    service.add(await scope(account), manualIdeaSchema.parse(input)),
  )
  handle('ideas:note', async (account, id, note) =>
    service.saveNote(await scope(account), ideaIdSchema.parse(id), ideaNoteSchema.parse(note)),
  )
  handle('ideas:source', async (account, id, index) => {
    const idea = service.archive.detail(await scope(account), ideaIdSchema.parse(id))
    const origin = idea?.origins[z.number().int().min(0).parse(index)]
    if (!origin) throw new Error('找不到原文链接')
    await shell.openExternal(ideaUrl.parse(origin.url))
  })
  handle('ideas:refresh', async (account) => {
    await scope(account)
    return service.refresh()
  })
  handle('ideas:status', async (account) => {
    await scope(account)
    return service.status()
  })
}
