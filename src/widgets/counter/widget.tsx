import { z } from 'zod'
import { Minus, Plus, RotateCcw } from 'lucide-react'
import { defineWidget } from '../../sdk/types'

const configSchema = z.object({
  title: z.string().max(80),
  step: z.number().int().min(1).max(1000),
})
const dataSchema = z.object({ count: z.number().int().min(-999999999).max(999999999) })
export default defineWidget({
  type: 'starter.counter',
  name: '计数器',
  description: '记录一点进展，每个小小的积累都算数。',
  version: 1,
  icon: 'counter',
  accent: 'sage',
  defaultSize: { w: 4, h: 7 },
  minSize: { w: 3, h: 6 },
  defaultConfig: { title: '今天，也在向前', step: 1 },
  defaultData: { count: 0 },
  configSchema,
  dataSchema,
  Component: ({ config, data, updateData }) => (
    <div className="counter-widget">
      <span className="eyebrow">SMALL STEPS, EVERY DAY</span>
      <h3>{config.title}</h3>
      <output aria-label="当前计数">{data.count.toLocaleString()}</output>
      <div className="counter-controls">
        <button
          className="counter-button"
          aria-label="减少计数"
          disabled={data.count - config.step < -999999999}
          onClick={() => updateData((previous) => ({ count: previous.count - config.step }))}
        >
          <Minus size={18} />
        </button>
        <span>每次 {config.step}</span>
        <button
          className="counter-button filled"
          aria-label="增加计数"
          disabled={data.count + config.step > 999999999}
          onClick={() => updateData((previous) => ({ count: previous.count + config.step }))}
        >
          <Plus size={18} />
        </button>
      </div>
      <button className="quiet-button reset-counter" onClick={() => updateData({ count: 0 })}>
        <RotateCcw size={12} />
        归零
      </button>
    </div>
  ),
  Settings: ({ config, updateConfig }) => (
    <div className="form-stack">
      <label>
        计数器标题
        <input
          aria-label="计数器标题"
          value={config.title}
          maxLength={80}
          onChange={(event) => updateConfig({ ...config, title: event.target.value })}
        />
      </label>
      <label>
        每次增减
        <input
          aria-label="每次增减"
          type="number"
          min={1}
          max={1000}
          value={config.step}
          onChange={(event) => {
            const step = Number(event.target.value)
            if (Number.isInteger(step) && step >= 1 && step <= 1000)
              updateConfig({ ...config, step })
          }}
        />
      </label>
      <p className="field-hint">每张卡片独立计数，切换账号也不会混在一起。</p>
    </div>
  ),
})
