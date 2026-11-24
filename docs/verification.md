# 验证与打包

## 本次验证记录

2026-11-24，0.3.1，macOS Apple Silicon（arm64）：

- TypeScript 检查及未使用符号检查通过，Prettier 格式检查通过。
- 70 项核心自动化测试通过；两条授权路径均检查固定的细分权限清单，不含整组日历权限、忙闲或写入权限；增加 API 多余参会人/忙闲字段不会传入展示数据的验证。日期/API 的 10 项测试在 0.2.0 时额外以 `TZ=America/New_York` 验证自然日与夏令时边界，本次未修改日期逻辑。
- 6 项桌面流程通过，并在最终打包的 `.app` 上再次通过：一键连接/创建后取消/复用应用继续授权、布局/账号/重启恢复、保存失败保护、导入导出、原有飞书 OAuth/多实例/跨账号回调/解绑，以及日历最小尺寸/授权失效清空。打包测试跳过仅适用于开发模式的启动项。
- `pnpm dev` 实际启动测试通过。
- 0.1.0 的基础工程已从独立临时目录 Git clone，完成 `pnpm install --frozen-lockfile`、`pnpm build` 和开发窗口启动测试。本次未增加依赖，0.3.1 在现有安装环境完成构建；未模拟全新设备的网络环境。
- 已生成 arm64 `.app` 和 `.dmg`；未签名、未公证。Intel 实机验证尚未进行。
- 用户反馈旧版整组日历权限被企业策略禁止；0.3.1 的细分权限真实授权及日历读取尚未验证，详见[配置指南及联调边界](feishu-calendar.md)。飞书 API、浏览器打开与桌面测试的加密边界使用替身，设备授权替身仅允许两个细分日历权限、基础身份和离线访问；没有访问真实日程或写入日常账号。测试通过不代表企业必然允许细分权限。

## 自动化覆盖

- `tests/storage.test.ts`：账号 CRUD、同实例 ID 跨账号隔离、重启恢复、写入队列、导入创建新账号、未知组件保留、无效/新版本文件拒绝、v0 迁移、损坏备份恢复、写入失败重试。
- `tests/controller.test.ts`：350ms 合并保存、同类型实例独立、切换前 flush、保存失败阻止切换、旧账号回调拒绝、写入过程中再次修改、重新整理布局。
- `tests/registry.test.ts`：自动发现、ID 冲突、默认值和尺寸校验、组件版本迁移与保留。
- `tests/widget-boundary.test.tsx`：渲染错误隔离及重试、实例卸载后的异步更新拒绝。
- `tests/desktop/workspace.spec.ts`：真实 Electron 窗口内的添加、配置、多实例、拖动、缩放、账号切换、关闭前 flush、重启恢复、最小窗口及导入导出。文件对话框用 Electron 原生接口的测试替身提供路径，其余 IPC、读写和 UI 为实际实现。
- `tests/desktop/development.spec.ts`：实际启动 `pnpm dev`，验证 Vite 开发服务器、Electron 窗口和 React 热更新前导脚本的 CSP 配置。
- `tests/feishu-client.test.ts`：官方请求路径及 PKCE 令牌参数、API 返回有效期、限流/网络/授权错误、重复例外与取消/拒绝、全天跨天及本地时区范围、展示数据不包含参会人或忙闲字段。
- `tests/feishu-oauth.test.ts`：真实回环监听、最小细分权限清单、随机 state 和 S256 校验、错误 state、取消、超时、端口占用及打开浏览器失败。
- `tests/feishu-one-click.test.ts`：官方个人应用注册与设备授权协议、最小 scopes、pending/slow_down/拒绝/过期/超时、非飞书品牌与恶意 URL 拒绝、账号绑定、取消后保留已创建应用、创建凭证写入失败重试及删除后的迟到结果。
- `tests/feishu-service.test.ts`：账号隔离、同账号请求合并、刷新令牌轮换/落盘失败重试、旧连接保留、切换期间回调、删除/解绑后的迟到请求和读取、取消过程中写入的回滚、授权失效清空和网络失败保留缓存。
- `tests/feishu-vault.test.ts`：通过异步加密接口保存密文、0600 权限、无明文降级、损坏文件保留、导出隔离、导入新 UUID 和删除清理。使用实际 AES 加解密的测试替身，不使用系统钥匙串。
- `tests/feishu-lifecycle.test.tsx`：可见时轮询、重新聚焦、跨日立即刷新、卸载取消及旧账号/旧连接响应拒绝。
- `tests/desktop/feishu.spec.ts`：真实 Electron/preload/主进程/OAuth 回调，替换网络、系统浏览器打开和加密边界；覆盖一键连接两步确认、取消并继续、重新打开确认页、凭证密文、原有高级设置、授权期间切换账号、多实例共享、导出/导入、断开、最小尺寸及内部滚动。截图里的日程和确认码为测试数据，未创建真实飞书应用。

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
