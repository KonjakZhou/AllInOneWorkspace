# 添加一个组件

最短路径：复制 `src/widgets/counter/` 为一个新目录，修改 `widget.tsx` 中的 `type`、名称、Schema 和界面。声明文件保持为 `widget.tsx`，构建时自动注册，无需改壳子代码。新增目录后重启 `pnpm dev`，或重新打包应用。

## 最小例子

在 `src/widgets/greeting/widget.tsx` 中写入：

```tsx
import { z } from 'zod'
import { defineWidget } from '../../sdk/types'

export default defineWidget({
  type: 'personal.greeting', // 稳定且唯一，不要在组件升级时更换
  name: '问候',
  description: '一句属于这个空间的问候。',
  version: 1,
  icon: 'widget',
  accent: 'lavender',
  defaultSize: { w: 4, h: 6 },
  minSize: { w: 3, h: 4 },
  defaultConfig: { message: '你好，新的一天。' },
  defaultData: { visits: 0 },
  configSchema: z.object({ message: z.string().max(200) }),
  dataSchema: z.object({ visits: z.number().int().nonnegative() }),
  Component: ({ config, data, updateData }) => (
    <div className="text-widget">
      <h3>{config.message}</h3>
      <p>已打卡 {data.visits} 次</p>
      <button
        className="button"
        onClick={() => updateData((previous) => ({ visits: previous.visits + 1 }))}
      >
        为今天打卡
      </button>
    </div>
  ),
  Settings: ({ config, updateConfig }) => (
    <label className="form-stack">
      问候语
      <input
        value={config.message}
        maxLength={200}
        onChange={(event) => updateConfig({ message: event.target.value })}
      />
    </label>
  ),
})
```

`defineWidget` 推导配置与数据类型。默认值必须通过对应 Schema，尺寸必须合法。组件 ID 重复会在注册阶段报错，避免静默覆盖。

## 配置与数据

`WidgetContext` 包含 `accountId`、`instanceId`、`config`、`data`、`updateConfig`、`updateData`、`signal` 和 `openAccountSettings()`。两个 update 方法接受完整新对象或基于前值的函数。更新是替换对应对象，若需保留其他字段请展开原对象。需要配置账号连接的组件可调用 `openAccountSettings()` 打开当前账号的应用设置。

不要修改传入对象，不要在模块全局保存用户数据，不要自行使用 localStorage 或硬编码账号路径。所有持久化内容通过 SDK 更新；React `useState` 只保存展开/加载等临时 UI 状态。这样，同类型多实例和多账号会天然隔离。

配置与数据只支持 `null`、布尔、有限数字、字符串、数组和 JSON 对象。`Date` 需转成字符串，不支持函数、循环引用、Map 或文件对象。

## 异步、刷新与错误

异步任务使用 `context.signal`，卸载时自动中止。完成前检查 `signal.aborted`，更新数据使用函数形式，避免用过期闭包覆盖更新。当前版本的 CSP 仅允许本地资源；接入远程数据源时需在壳子中明确增加对应网络能力或受控主进程接口。

声明可选的 `refresh: async context => { ... }`，壳子就会提供刷新按钮、重复点击保护和错误重试。组件内部可使用 SDK 的 `WidgetLoading`、`WidgetEmpty` 和 `WidgetError`。

每个实例的渲染错误由 `WidgetErrorBoundary` 隔离，可点击重试。它不会捕获任意事件处理器或后台任务抛出的错误，组件应自己处理这些异常。SDK 的数据校验失败会显示公共错误提示，原数据不被替换。

## 自带标题的卡片

组件声明可选的 `chrome: 'compact'`，普通模式隐藏通用标题栏，避免与组件自身标题重复。编辑模式仍提供壳子的拖拽手柄、刷新和移除控件。省略该字段或使用 `'standard'` 时保持原外观。

紧凑组件需在自己的界面提供必要的设置/刷新入口，保证键盘操作和最小尺寸下的内部滚动。可参考 `src/widgets/feishu-calendar/`：纯日期展示函数、生命周期 hook、样式和声明分别维护。账号级远程服务通过明确的主进程接口访问，不把密钥或日程缓存写入 `config` / `data`。

## 升级组件数据

改变持久化数据结构时递增 `version`，提供从旧版本到当前版本的迁移函数，例如：

```tsx
version: 2,
migrate: stored => {
  if (stored.version !== 1) throw new Error('不支持的旧版本')
  const old = z.object({ value: z.number().int() }).parse(stored.data)
  return { config: { title: '我的计数' }, data: { count: old.value } }
},
```

迁移返回值还会经当前 Schema 和 JSON 校验。迁移必须纯净、确定且不修改输入；失败时旧数据保持不变。暂时移除一个组件目录不会删除账号里该组件的数据。

## 完成后验证

运行 `pnpm check` 与 `pnpm test`。添加两个实例并设置不同内容，切换账号并重启，确认隔离与恢复。自动发现测试不限制新增组件，也不需要维护组件列表。修改核心壳子时运行 `pnpm test:desktop`。
