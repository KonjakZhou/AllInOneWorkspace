# 验证与打包

## 自动化覆盖

- `tests/storage.test.ts`：账号 CRUD、同实例 ID 跨账号隔离、重启恢复、写入队列、导入创建新账号、未知组件保留、无效/新版本文件拒绝、v0 迁移、损坏备份恢复、写入失败重试。
- `tests/controller.test.ts`：350ms 合并保存、同类型实例独立、切换前 flush、保存失败阻止切换、旧账号回调拒绝、写入过程中再次修改、重新整理布局。
- `tests/registry.test.ts`：自动发现、ID 冲突、默认值和尺寸校验、组件版本迁移与保留。
- `tests/widget-boundary.test.tsx`：渲染错误隔离及重试、实例卸载后的异步更新拒绝。
- `tests/desktop/workspace.spec.ts`：真实 Electron 窗口内的添加、配置、多实例、拖动、缩放、账号切换、关闭前 flush、重启恢复、最小窗口及导入导出。文件对话框用 Electron 原生接口的测试替身提供路径，其余 IPC、读写和 UI 为实际实现。
- `tests/desktop/development.spec.ts`：实际启动 `pnpm dev`，验证 Vite 开发服务器、Electron 窗口和 React 热更新前导脚本的 CSP 配置。

## 本地发布检查

```sh
pnpm check
pnpm test
pnpm test:desktop
pnpm dist
```

截图输出到 `test-results/`，打包结果在 `release/`。这些生成文件不进入 Git。

打包使用当前主机架构。Apple Silicon 输出 `release/mac-arm64/All In One Workspace.app` 和对应 arm64 DMG；Intel 输出 `release/mac/All In One Workspace.app` 和对应 x64 DMG。

把 `.app` 拖到“应用程序”后启动，检查首次账号、退出后恢复、导入导出以及菜单。首版未签名和未公证，首次启动遵循 macOS 对本地未签名应用的提示处理。

测试仅使用临时目录，不修改日常账号。开发测试可通过 `WORKSPACE_DATA_DIR` 隔离数据。打包产物测试可用 `WORKSPACE_TEST_EXECUTABLE` 指向 `.app/Contents/MacOS/All In One Workspace`，并执行 `pnpm exec playwright test`。

当前开发机为 Apple Silicon。Intel 安装和打包需在 Intel macOS 实机上单独验证，不能由 arm64 通过测试推断。CI 运行桌面测试需要可启动图形界面的 macOS 环境。
