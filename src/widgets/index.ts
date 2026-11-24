import { buildRegistry } from '../sdk/registry'
import type { AnyWidgetDefinition } from '../sdk/types'

const modules = import.meta.glob<{ default: AnyWidgetDefinition }>('./*/widget.tsx', {
  eager: true,
})
export const widgetRegistry = buildRegistry(Object.values(modules).map((module) => module.default))
