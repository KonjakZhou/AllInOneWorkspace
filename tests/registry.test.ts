import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { buildRegistry, prepareWidget } from '../src/sdk/registry'
import { widgetRegistry } from '../src/widgets'
import type { WidgetInstance } from '../src/shared/model'

describe('component contract', () => {
  it('discovers definitions by filename without a hand-maintained list', () => {
    expect([...widgetRegistry.keys()]).toEqual(
      expect.arrayContaining(['starter.counter', 'starter.text', 'feishu.calendar']),
    )
  })
  it('rejects duplicate IDs, invalid sizes and invalid defaults early', () => {
    const definition = widgetRegistry.get('starter.counter')!
    expect(() => buildRegistry([definition, definition])).toThrow('重复')
    expect(() => buildRegistry([{ ...definition, minSize: { w: 13, h: 3 } }])).toThrow('尺寸')
    expect(() => buildRegistry([{ ...definition, defaultData: { count: 'oops' } }])).toThrow()
  })
  it('migrates known older data and retains unknown types unchanged', () => {
    const original: WidgetInstance = {
      id: randomUUID(),
      type: 'starter.counter',
      version: 1,
      config: {},
      data: { value: 2 },
      layout: { x: 0, y: 0, w: 4, h: 7 },
    }
    const definition = {
      ...widgetRegistry.get('starter.counter')!,
      version: 2,
      configSchema: z.object({}),
      migrate: () => ({ config: {}, data: { count: 2 } }),
    }
    expect(prepareWidget(original, definition)).toMatchObject({ version: 2, data: { count: 2 } })
    expect(prepareWidget(original)).toBe(original)
    expect(original.version).toBe(1)
    expect(() => prepareWidget({ ...original, version: 3 }, definition)).toThrow('更新版本')
    expect(() => prepareWidget(original, { ...definition, migrate: undefined })).toThrow('迁移')
  })
})
