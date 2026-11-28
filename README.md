# All In One Workspace

一个属于你自己的 macOS 桌面工作区。自由摆放卡片，为不同账号保留不同布局，所有内容保存在本地。

最新正式版：[下载安装包](https://github.com/KonjakZhou/AllInOneWorkspace/releases/latest/download/all-in-one-workspace-arm64.dmg) · [查看版本与更新说明](https://github.com/KonjakZhou/AllInOneWorkspace/releases/latest)。

Electron + React + TypeScript + Vite。提供完整工作区壳子、账号管理、两个教学组件、飞书日历、财联社快讯、交易灵感和邮箱。本地账号无需登录；外部服务单独连接。

![工作区初始界面](docs/images/workspace.png)

## 在新设备上开始

适用于 **macOS 13 或更高版本、Apple Silicon（M 系列芯片）**。下载安装包即可使用，无需安装 Git、Node.js 或 pnpm。当前未提供经过验证的 Intel 安装包。

1. **下载安装包**：点击 [下载最新 macOS 安装包](https://github.com/KonjakZhou/AllInOneWorkspace/releases/latest/download/all-in-one-workspace-arm64.dmg)，下载文件名为 `all-in-one-workspace-arm64.dmg`。这个固定链接会随最新正式版更新。如需查看版本号、更新说明或其他附件，打开 [GitHub 最新版本下载页](https://github.com/KonjakZhou/AllInOneWorkspace/releases/latest)。`Source code` ZIP/TAR 是源码，请选择 DMG 安装包。
2. **安装到「应用程序」**：在访达的「下载」中双击 DMG，将窗口里的 **All In One Workspace.app** 拖到旁边的 **Applications（应用程序）** 文件夹，等待复制完成。如果已有旧版，请先退出旧版，再确认替换。
3. **从访达启动**：打开访达侧边栏的「应用程序」（也可按 `⇧⌘A`），双击 **All In One Workspace**。以后从这里启动；安装完成后可在访达中推出安装磁盘。
4. **首次打开被 macOS 阻止时**：本应用尚未进行 Apple Developer ID 签名或公证。确认安装包来自上述仓库后，可按 [Apple 官方首次打开指引](https://support.apple.com/zh-cn/102445)，到「系统设置 → 隐私与安全性」中找到该应用的拦截提示，点击「仍要打开」，再按提示确认。

首次启动会创建“默认账号”和空白工作区。点击底部“为工作区再添一点可能”即可加入文本卡片、计数器、飞书日历、财联社 7×24 快讯或交易灵感。同一种组件可以添加多次，每个实例独立保存布局和配置。

如果要迁移旧设备的工作区，请先在旧设备的「应用设置」中导出账号，再在新设备导入；外部服务的连接凭证需要在新设备重新配置或授权。账号数据不自动跨设备同步。

后续可点击右上角「应用更新」检查新版本，下载完成后选择「重启并安装」。详见 [应用更新说明](docs/updates.md)。

## 日常使用

- **工作区概况**：顶部统一显示当前工作区名称、组件数量、日期和保存状态；保存失败时点击状态重试。卡片直接从顶部工具栏下方开始排列。
- **顶部菜单**：应用菜单提供中文“关于工作区”、隐藏和退出；“编辑”保留撤销、重做、剪切、复制、粘贴和全选；“窗口”集中管理显示工作区、最小化、全屏、界面缩放和关闭。`⌘1` 可重新显示工作区，`⌘0` 恢复默认缩放；常用编辑快捷键保持可用。正式安装包不显示开发者工具。
- **添加组件**：普通模式从底部“为工作区再添一点可能”打开组件库；进入编辑布局后，右上角也会出现“添加组件”。有本地记录时先选择恢复哪一份，也可以添加全新卡片。
- **移除卡片**：编辑模式点击卡片移除按钮，选择“仅移除卡片，保留数据”或“删除卡片及其设置和数据”。保留时可命名，每张实例独立存为记录；恢复后记录移回工作区。组件库内可单独确认删除某份记录。
- **编辑布局**：开启编辑模式，用卡片左上角的手柄拖动，右下角调整大小；拖动完成后自动保存。“重新整理布局”保留内容，并按默认尺寸重新排列。
- **组件设置**：点击卡片右上角的设置按钮，修改当前实例的配置。修改合并保存，顶部显示保存状态；失败时可重试。
- **账号管理**：右上角账号按钮可创建、切换、重命名和删除账号。每个账号有独立布局、组件配置和数据，至少保留一个账号。
- **设备迁移**：在应用设置中导出当前账号，再到另一台设备导入。导入创建新账号，不覆盖现有账号；同名会追加序号。
- **飞书日历**：在应用设置中点击「一键连接飞书」，首次在飞书页面确认创建个人应用、再授权日历，无需手填凭证或安装 CLI。已有应用可从高级设置连接。每个本地账号绑定一个飞书身份，同账号日历实例共用连接；凭证和日程不随导出迁移。详见[连接指南](docs/feishu-calendar.md)。
- **财联社 7×24**：卡片可见且应用在前台时每 30 秒检查最新电报。历史可双向滚动，筛选结果会自动补满视口，悬浮按钮可直接回到最新。回看缓存有容量和闲置时间上限。详见[数据源与刷新说明](docs/cls-telegraph.md)。
- **邮箱**：支持飞书、163 和 Gmail 多账号汇总，点击邮件在 App 内打开全文并同步已读。各来源统一使用加密历史摘要缓存；自动检查间隔 1 分钟、内存闲置期限 10 分钟、磁盘闲置期限 48 小时。详见[邮箱管理与限制](docs/mail.md)。
- **关闭窗口**：等待待保存内容落盘后关闭。保存失败会保留窗口和待保存数据，修复磁盘问题后重试保存或再次关闭。
- **缺失组件**：保留占位卡、布局和原始数据。补回同类型 ID 的组件源码并重新构建即可恢复。

选择彻底删除卡片或本地记录后，无法再从组件库恢复，其他实例不受影响。移除飞书日历卡片不会断开账号连接或删除飞书中的日程。删除账号会删除其布局、组件数据及保留的记录；操作前会要求确认。

## 从源码开发（可选）

需要修改源码或开发组件时，再准备 Git、Node.js 26（也支持 Node.js 24）和 pnpm 11.25.0。首次安装依赖需要联网下载 npm 依赖及 Electron 运行时。

```sh
git clone https://github.com/KonjakZhou/AllInOneWorkspace.git
cd AllInOneWorkspace
# 已安装 nvm 时，可用 nvm install && nvm use 切换到 .nvmrc 指定版本。
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 启动开发版，不会把 App 安装到访达的「应用程序」。如需自行构建安装包，还需免费的 Xcode Command Line Tools（`xcode-select --install`）；执行 `pnpm dist` 后，打开 `release/` 中生成的 DMG，按上面的步骤拖入「应用程序」。

## 开发命令

| 命令                             | 用途                                                          |
| -------------------------------- | ------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | 安装锁定的依赖与运行时                                        |
| `pnpm dev`                       | 启动带热更新的桌面应用                                        |
| `pnpm check`                     | TypeScript 类型检查                                           |
| `pnpm test`                      | 账号隔离、存储恢复、迁移、组件注册和生命周期测试              |
| `pnpm test:desktop`              | 构建后启动真实 Electron 窗口，测试拖拽、缩放、账号和重启恢复  |
| `pnpm build`                     | 构建主进程、preload 和界面到 `out/`                           |
| `pnpm dist`                      | 为 Apple Silicon 生成 `.app`、`.dmg` 和更新 ZIP 到 `release/` |

`pnpm dist` 不发布到外部服务，也不需要发布私钥。1.1.0 增加基于 GitHub 正式 Release 的检查、下载和重启安装功能；无 Apple 签名和公证，系统仍可能要求确认来源。首次从 1.0.0 升级需手动安装。详见[自动更新与发布指南](docs/updates.md)。

开发 agent 和维护者请先阅读仓库内的 [发布操作指南](RELEASING.md)。

`main` 合入后由 GitHub Actions 串行构建并发布；环境准备、版本分配、失败重试和手动发布均见 [发布操作指南](RELEASING.md)。安装入口固定指向最新正式版，无需逐次修改 README。

若本机禁用了安装脚本，可执行 `pnpm exec install-electron` 安装 Electron 运行时。运行 `pnpm dev` 时也会按需检查下载。

## 数据位置与备份

默认目录：`~/Library/Application Support/All In One Workspace/`，具体路径可在应用设置中查看。

```text
accounts.json                 # 账号索引与当前账号
accounts.json.bak             # 上一份有效索引
accounts/<uuid>.json          # 某个账号的布局、组件配置、数据与保留记录
accounts/<uuid>.json.bak      # 该账号有效恢复备份
connections/feishu/<uuid>.json # 本机飞书连接密文（不导出，无令牌备份）
connections/mail-v1/<uuid>.json # 当前工作区的邮箱凭证密文（不导出）
cache/mail-v1/                 # 所有邮箱来源的加密历史摘要（可回收，不导出）
*.corrupt-*                   # 恢复备份前保留的异常原文件
```

写入由主进程串行执行，使用临时文件、落盘和原子替换。工作区读取异常时优先恢复有效备份并提示；无法恢复时保留文件并停止读取，不用空数据覆盖。新版本数据不会降级覆盖。飞书凭证独立加密，不恢复已轮换的旧令牌。

导出文件包含该账号全部组件的配置、数据和保留的本地记录，请按其中内容妥善保管。源码 clone 不会自动同步这些数据。文件大小上限为 20 MB，每个账号最多 200 张在用卡片、500 份保留记录，最多 100 个账号。

普通修改保留上一份有效备份；移除、恢复卡片或删除记录时，恢复备份同步为新状态，避免恢复后重复出现或复活已删数据。此操作不修改此前手动导出的文件和已保留的异常原文件。

工作区和导出格式已升级至 v2，旧 v0/v1 数据自动兼容。v2 文件需要 0.4.0 或更高版本应用读取；账号索引和飞书凭证格式不变。

开发时可用 `WORKSPACE_DATA_DIR=/绝对路径 pnpm dev` 指定独立数据目录。测试自动使用临时目录，不读取日常账号。

## 扩展开发

- [架构与数据流](docs/architecture.md)
- [添加一个组件](docs/widget-development.md)
- [前端风格约束与验证](docs/frontend-style.md)
- [验证范围与发布检查](docs/verification.md)
- [飞书日历配置与使用](docs/feishu-calendar.md)
- [财联社 7×24 数据源与刷新](docs/cls-telegraph.md)
- [邮箱管理与限制](docs/mail.md)
- [交易灵感数据源与历史资料库](docs/trading-ideas.md)

组件放在 `src/widgets/<目录名>/widget.tsx`，由构建工具自动发现，不需要改注册列表。每个组件通过 SDK 访问自己的配置、数据和取消信号。图标源文件保存在 `build/icon.svg`。

当前只实现浅色主题和源码内组件，不包含外部插件安装、远程同步、全局内容搜索或本地账号鉴权。飞书组件只读个人主日历，不创建或修改日程。
