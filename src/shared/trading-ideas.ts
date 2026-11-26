import { z } from 'zod'
import { idSchema } from './model'

export const categories = [
  '官方披露',
  '机构研究',
  '财经媒体',
  '公开社区与开源',
  '独立作者与音视频',
  '未证实传闻',
  '论文',
] as const
export const evidenceStates = [
  '官方原文',
  '媒体报道',
  '作者观点',
  '研究摘要',
  '未证实',
  '已澄清',
] as const
export const topics = [
  '指数换样',
  'ETF 份额与申赎',
  '行业轮动',
  '因子与择时',
  '成交与流动性',
  '政策与公司事件',
  '资产配置',
] as const
export const IDEA_PAGE_SIZE = 40
export const priorityLevels = ['未标记', '高', '中', '低'] as const

export type IdeaCategory = (typeof categories)[number]
export type EvidenceState = (typeof evidenceStates)[number]
export type IdeaTopic = (typeof topics)[number]
export type Priority = (typeof priorityLevels)[number]

export const chinaDay = (time = Date.now()) =>
  new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
export const ideaDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const time = Date.parse(value)
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  }, '日期无效')
export const ideaUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((value) => {
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  }, '请输入 HTTPS 原文链接')

export type Publication = {
  value: string
  precision: 'time' | 'day' | 'month' | 'year'
}

export type IdeaContent = {
  title: string
  author: string
  url: string
  category: IdeaCategory
  evidence: EvidenceState
  summary: string
  publication: Publication | null
  eventDay: string | null
  topics: IdeaTopic[]
  market: '中国市场' | '海外市场' | '市场未注明' | null
  screening: '国内研究' | '迁移候选' | '待筛选' | null
}

export type IdeaOrigin = {
  source: string
  url: string
}

export type IdeaNote = {
  priority: Priority
  pending: boolean
  question: string
  note: string
  group: string
  evidence: EvidenceState | null
}
export const emptyIdeaNote: IdeaNote = {
  priority: '未标记',
  pending: false,
  question: '',
  note: '',
  group: '',
  evidence: null,
}

export type Idea = IdeaContent & {
  id: string
  firstSeen: number
  personal: IdeaNote
}

export type IdeaDetail = Idea & {
  origins: IdeaOrigin[]
  revisions: { capturedAt: number; content: IdeaContent }[]
  evidenceHistory: { capturedAt: number; evidence: EvidenceState | null }[]
  related: { id: string; title: string; category: IdeaCategory }[]
}

export type SourceStatus = {
  id: string
  label: string
  outcome: '未运行' | '有新增' | '无新增' | '失败'
  attemptedAt: number | null
  lastSuccess: number | null
  added: number
  details: string
}

export type IdeaCardItem = Pick<Idea, 'id' | 'title' | 'category' | 'publication' | 'firstSeen'> & {
  priority: Priority
}

export type IdeaOverview = {
  today: string
  count: number
  items: IdeaCardItem[]
  updatedAt: number | null
}
export type IdeaStatus = {
  running: boolean
  sources: SourceStatus[]
  history: SourceStatus[]
  backupIssue: string
}

export const manualIdeaSchema = z.object({
  url: ideaUrl,
  title: z.string().trim().min(1, '请填写标题').max(240),
  author: z.string().trim().max(120),
  category: z.enum(categories),
  evidence: z.enum(evidenceStates),
  summary: z.string().trim().max(600),
  publishedDay: ideaDateSchema.or(z.literal('')),
  eventDay: ideaDateSchema.or(z.literal('')),
})

export const ideaNoteSchema = z.object({
  priority: z.enum(priorityLevels),
  pending: z.boolean(),
  question: z.string().trim().max(1000),
  note: z.string().trim().max(4000),
  group: z.string().trim().max(120),
  evidence: z.enum(evidenceStates).nullable(),
})

export const ideaQuerySchema = z.object({
  mode: z.enum(['published', 'collected', 'archive', 'pending']),
  day: ideaDateSchema.optional(),
  category: z.enum(categories).optional(),
  topic: z.enum(topics).optional(),
  text: z.string().trim().max(120).optional(),
  offset: z.number().int().min(0).default(0),
})
export const ideaIdSchema = idSchema
export type IdeaQuery = z.input<typeof ideaQuerySchema>
export type ManualIdea = z.infer<typeof manualIdeaSchema>
export type IdeaView = { accountId: string; itemId: string | null }

export interface TradingIdeasAPI {
  enable(accountId: string): Promise<void>
  overview(accountId: string): Promise<IdeaOverview>
  list(accountId: string, query: IdeaQuery): Promise<{ items: Idea[]; hasMore: boolean }>
  detail(accountId: string, id: string): Promise<IdeaDetail | null>
  add(accountId: string, input: ManualIdea): Promise<string>
  saveNote(accountId: string, id: string, note: IdeaNote): Promise<void>
  openSource(accountId: string, id: string, index: number): Promise<void>
  refresh(accountId: string): Promise<void>
  status(accountId: string): Promise<IdeaStatus>
  onChanged(listener: () => void): () => void
}
