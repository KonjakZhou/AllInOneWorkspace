import { jsonSchema, type WidgetInstance } from '../shared/model'
import type { AnyWidgetDefinition } from './types'

export function buildRegistry(
  definitions: AnyWidgetDefinition[],
): Map<string, AnyWidgetDefinition> {
  const registry = new Map<string, AnyWidgetDefinition>()
  for (const definition of definitions) {
    if (!/^[a-z][a-z0-9.-]+$/.test(definition.type))
      throw new Error(`组件类型 ID 无效：${definition.type}`)
    if (registry.has(definition.type)) throw new Error(`组件类型 ID 重复：${definition.type}`)
    if (!Number.isInteger(definition.version) || definition.version < 1)
      throw new Error('组件版本必须为正整数')
    for (const size of [definition.minSize, definition.defaultSize]) {
      if (
        !Number.isInteger(size.w) ||
        size.w < 1 ||
        size.w > 12 ||
        !Number.isInteger(size.h) ||
        size.h < 2 ||
        size.h > 1000
      )
        throw new Error(`组件尺寸无效：${definition.type}`)
    }
    if (
      definition.defaultSize.w < definition.minSize.w ||
      definition.defaultSize.h < definition.minSize.h
    )
      throw new Error(`默认尺寸不能小于最小尺寸：${definition.type}`)
    jsonSchema.parse(definition.configSchema.parse(definition.defaultConfig))
    jsonSchema.parse(definition.dataSchema.parse(definition.defaultData))
    registry.set(definition.type, definition)
  }
  return registry
}
export function prepareWidget(
  widget: WidgetInstance,
  definition?: AnyWidgetDefinition,
): WidgetInstance {
  if (!definition) return widget
  if (widget.version > definition.version)
    throw new Error('此组件数据来自更新版本，请升级组件后再使用。')
  let config = widget.config,
    data = widget.data
  if (widget.version < definition.version) {
    if (!definition.migrate) throw new Error('此组件尚未提供旧版本数据迁移。原始数据已保留。')
    const migrated = definition.migrate({ version: widget.version, config, data })
    config = migrated.config
    data = migrated.data
  }
  return {
    ...widget,
    version: definition.version,
    config: jsonSchema.parse(definition.configSchema.parse(config)),
    data: jsonSchema.parse(definition.dataSchema.parse(data)),
  }
}
