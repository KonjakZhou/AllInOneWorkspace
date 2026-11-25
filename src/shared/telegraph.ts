import { z } from 'zod'

export const telegraphItemIdSchema = z.number().int().positive()
export const telegraphCursorSchema = z.number().int().min(1).max(253402300799)
export const TELEGRAPH_PAGE_SIZE = 50

export type TelegraphIssue = {
  kind: 'network' | 'rate_limit' | 'api'
  message: string
}

const telegraphItemSchema = z.object({
  id: telegraphItemIdSchema,
  headline: z.string(),
  content: z.string(),
  level: z.string(),
  publishedAt: z.number().int().positive(),
  modifiedAt: z.number().int().positive(),
  important: z.boolean(),
  subjects: z.array(z.string()),
  url: z.string(),
})
export type TelegraphItem = z.infer<typeof telegraphItemSchema>

export const telegraphHistoryPageSchema = z.object({
  cursor: telegraphCursorSchema,
  nextCursor: telegraphCursorSchema.nullable(),
  items: z.array(telegraphItemSchema).max(TELEGRAPH_PAGE_SIZE),
})
export type TelegraphHistoryPage = z.infer<typeof telegraphHistoryPageSchema>
export type TelegraphHistoryResult =
  { page: TelegraphHistoryPage; error?: never } | { page?: never; error: TelegraphIssue }

export type TelegraphFeed = {
  revision: number
  items: TelegraphItem[]
  updatedAt: number | null
  stale: boolean
  error: TelegraphIssue | null
  historyCursor: number | null
}

export interface TelegraphAPI {
  getFeed(force?: boolean): Promise<TelegraphFeed>
  loadOlder(cursor: number): Promise<TelegraphHistoryResult>
  openItem(id: number): Promise<void>
  onChanged(listener: () => void): () => void
}
