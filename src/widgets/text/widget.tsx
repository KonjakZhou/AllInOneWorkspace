import { z } from 'zod'
import { defineWidget } from '../../sdk/types'
import { WidgetEmpty } from '../../sdk/components'

const configSchema = z.object({ title: z.string().max(80), content: z.string().max(10000) })
const dataSchema = z.null()

export default defineWidget({
  type: 'starter.text',
  name: '文本卡片',
  description: '留下一段文字，让重要的事始终在眼前。',
  version: 1,
  icon: 'text',
  accent: 'sand',
  defaultSize: { w: 4, h: 7 },
  minSize: { w: 3, h: 5 },
  defaultConfig: {
    title: '留一点空间，给重要的事',
    content:
      '这里是你的工作区。\n\n把想法、提醒，或今天最重要的一件事放在这里。点击卡片右上角的设置，开始写下第一句话。',
  },
  defaultData: null,
  configSchema,
  dataSchema,
  Component: ({ config }) => (
    <div className="text-widget">
      <span className="eyebrow">A LITTLE NOTE</span>
      <h3>{config.title || '随手记'}</h3>
      {config.content ? (
        <p>{config.content}</p>
      ) : (
        <WidgetEmpty message="点击设置，写下你的第一段文字" />
      )}
      <span className="text-widget-footer">留在此刻 · 保存在本地</span>
    </div>
  ),
  Settings: ({ config, updateConfig }) => (
    <div className="form-stack">
      <label>
        卡片标题
        <input
          aria-label="卡片标题"
          value={config.title}
          maxLength={80}
          onChange={(event) => updateConfig({ ...config, title: event.target.value })}
        />
      </label>
      <label>
        正文
        <textarea
          aria-label="正文"
          value={config.content}
          maxLength={10000}
          rows={8}
          onChange={(event) => updateConfig({ ...config, content: event.target.value })}
          placeholder="写下一点想法…"
        />
      </label>
      <p className="field-hint">修改会自动保存，仅对当前卡片生效。</p>
    </div>
  ),
})
