import type { ComponentType } from 'react'
import type { z } from 'zod'
import type { Json } from '../shared/model'

export type Update<T> = T | ((previous: T) => T)
export interface WidgetContext<C extends Json = Json, D extends Json = Json> {
  accountId: string
  instanceId: string
  config: C
  data: D
  updateConfig: (value: Update<C>) => void
  updateData: (value: Update<D>) => void
  signal: AbortSignal
  openAccountSettings: () => void
}
export interface WidgetDefinition<C extends Json = Json, D extends Json = Json> {
  type: string
  name: string
  description: string
  version: number
  icon: 'text' | 'counter' | 'widget' | 'calendar' | 'news' | 'mail'
  chrome?: 'standard' | 'compact'
  accent: 'sage' | 'peach' | 'lavender' | 'sand'
  defaultSize: { w: number; h: number }
  minSize: { w: number; h: number }
  defaultConfig: C
  defaultData: D
  configSchema: z.ZodType<C>
  dataSchema: z.ZodType<D>
  Component: ComponentType<WidgetContext<C, D>>
  Settings?: ComponentType<WidgetContext<C, D>>
  refresh?: (context: WidgetContext<C, D>) => Promise<void>
  migrate?: (stored: { version: number; config: Json; data: Json }) => { config: C; data: D }
}
// Type erasure is confined to the registry; each definition retains its own typed context.
export type AnyWidgetDefinition = WidgetDefinition<any, any>
export function defineWidget<C extends Json, D extends Json>(
  definition: WidgetDefinition<C, D>,
): WidgetDefinition<C, D> {
  return definition
}
