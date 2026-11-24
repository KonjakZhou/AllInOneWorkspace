import { z } from 'zod'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
)
export const idSchema = z.uuid()
export const nameSchema = z
  .string()
  .trim()
  .min(1, '请输入账号名称')
  .max(40, '账号名称最多 40 个字符')
export const layoutSchema = z
  .object({
    x: z.number().int().min(0).max(11),
    y: z.number().int().min(0).max(100000),
    w: z.number().int().min(1).max(12),
    h: z.number().int().min(2).max(1000),
  })
  .refine((item) => item.x + item.w <= 12, '组件不能超出网格')
export const widgetSchema = z.object({
  id: idSchema,
  type: z.string().min(1).max(120),
  version: z.number().int().min(1),
  config: jsonSchema,
  data: jsonSchema,
  layout: layoutSchema,
})
export const workspaceSchema = z
  .object({
    schemaVersion: z.literal(1),
    accountId: idSchema,
    widgets: z.array(widgetSchema).max(200),
  })
  .superRefine((doc, context) => {
    if (new Set(doc.widgets.map((widget) => widget.id)).size !== doc.widgets.length) {
      context.addIssue({ code: 'custom', message: '组件实例 ID 重复' })
    }
    for (let i = 0; i < doc.widgets.length; i++) {
      const a = doc.widgets[i].layout
      for (let j = i + 1; j < doc.widgets.length; j++) {
        const b = doc.widgets[j].layout
        if (a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y) {
          context.addIssue({ code: 'custom', message: '组件布局不能重叠' })
          return
        }
      }
    }
  })
export const accountSchema = z.object({
  id: idSchema,
  name: nameSchema,
  createdAt: z.string().datetime(),
})
export const indexSchema = z
  .object({
    schemaVersion: z.literal(1),
    activeAccountId: idSchema,
    accounts: z.array(accountSchema).min(1).max(100),
  })
  .refine(
    (index) =>
      new Set(index.accounts.map((account) => account.id)).size === index.accounts.length &&
      index.accounts.some((account) => account.id === index.activeAccountId),
    '账号索引无效',
  )
export const exportSchema = z.object({
  format: z.literal('all-in-one-workspace'),
  schemaVersion: z.literal(1),
  exportedAt: z.string().datetime(),
  account: z.object({ name: nameSchema }),
  workspace: workspaceSchema,
})
export type WidgetInstance = z.infer<typeof widgetSchema>
export type Workspace = z.infer<typeof workspaceSchema>
export type Account = z.infer<typeof accountSchema>
export type AccountIndex = z.infer<typeof indexSchema>
export type WorkspaceExport = z.infer<typeof exportSchema>
export type Snapshot = {
  index: AccountIndex
  workspace: Workspace
  notices: string[]
  dataDirectory: string
}

export class UnsupportedVersionError extends Error {
  constructor() {
    super('数据来自更新版本的应用，请先升级应用；原文件未修改。')
  }
}
export function checkVersion(value: unknown): void {
  if (
    value &&
    typeof value === 'object' &&
    'schemaVersion' in value &&
    typeof value.schemaVersion === 'number' &&
    value.schemaVersion > 1
  )
    throw new UnsupportedVersionError()
}
export function parseWorkspace(value: unknown): Workspace {
  checkVersion(value)
  // v0 used the same grid/config/data shape, but widget versions were optional.
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 0) {
    const legacy = z
      .object({
        accountId: idSchema,
        widgets: z.array(widgetSchema.extend({ version: z.number().int().min(1).optional() })),
      })
      .parse(value)
    return workspaceSchema.parse({
      ...legacy,
      schemaVersion: 1,
      widgets: legacy.widgets.map((widget) => ({ ...widget, version: widget.version ?? 1 })),
    })
  }
  return workspaceSchema.parse(value)
}
export function parseIndex(value: unknown): AccountIndex {
  checkVersion(value)
  return indexSchema.parse(value)
}
export function parseExport(value: unknown): WorkspaceExport {
  checkVersion(value)
  const envelope = z
    .object({
      format: z.literal('all-in-one-workspace'),
      schemaVersion: z.union([z.literal(0), z.literal(1)]),
      exportedAt: z.string().datetime(),
      account: z.object({ name: nameSchema }),
      workspace: z.unknown(),
    })
    .parse(value)
  return exportSchema.parse({
    ...envelope,
    schemaVersion: 1,
    workspace: parseWorkspace(envelope.workspace),
  })
}
export function emptyWorkspace(accountId: string): Workspace {
  return { schemaVersion: 1, accountId, widgets: [] }
}
export function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError)
    return (
      '数据格式无效：' +
      error.issues
        .map((issue) => issue.message)
        .slice(0, 3)
        .join('；')
    )
  return error instanceof Error ? error.message : '操作失败，请重试'
}
