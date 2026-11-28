# 发布操作指南（开发 agent 与维护者）

本文件是本仓库发布流程的统一入口，操作工具为 `scripts/release.mjs`。处理版本、打包、签名、标签或 GitHub Release 任务前先阅读本文件；日常更新使用说明见 [docs/updates.md](docs/updates.md)。

## 发布目标与授权范围

- 固定公开仓库：`KonjakZhou/AllInOneWorkspace`。发布前核对 `git remote -v` 和 `gh auth status`，不要根据当前登录账号推断或切换发布目标。
- 仅支持 macOS 13+ / arm64 的稳定版本；版本号使用 `X.Y.Z`，标签使用 `vX.Y.Z`。源码、版本标签、清单中的提交、安装包必须属于同一次构建。
- DMG 和 ZIP 使用 `package.json` 的 `name` 生成文件名：`all-in-one-workspace-<版本号>-arm64.dmg` / `.zip`。名称仅允许小写字母、数字和连字符，不使用含空格的 `productName`，避免 GitHub 上传时改写名称。打包器、签名清单及上传校验必须使用同一名称；访达中的 `All In One Workspace.app` 名称保持不变。
- 每个 Release 还必须提供固定名 `all-in-one-workspace-arm64.dmg`。它是本版本 DMG 的逐字节副本，大小和 SHA-256 必须与签名清单中的 DMG 一致。固定名仅用于 README 的最新下载入口，更新器继续使用清单中的版本附件。
- 普通开发或本地打包任务仅执行本地验证和 `pnpm dist`；这不等于上传或正式发布。本文件本身不授予发布权限。
- 用户要求准备发布或创建草稿时，执行到草稿上传并报告可审核结果。用户已明确要求正式发布时，在完成验证后继续发布，不重复要求同一授权；没有正式发布授权时，保留草稿。`pnpm release` 始终只创建或更新草稿。
- 按当前工作目录内的 `AGENTS.md` 管理构建产物；不要复用其他工作树的安装包。不要输出、提交或上传私钥、本地账号、凭据、缓存及导出文件。

## 首次准备发布身份

安装 Node.js 24/26、pnpm 11.25.0、GitHub CLI 和 Apple 免费的 Xcode Command Line Tools（`xcode-select --install`）。构建原生安装助手不需要 Apple Developer Program。

本仓库的 `build/update-public-key.json` 是所有客户端信任的发布公钥。首次初始化仓库时执行一次：

```sh
pnpm release:keygen
```

私钥保存在 `~/.config/all-in-one-workspace/release-signing/private.pem`，目录权限 0700、文件权限 0600。命令不会覆盖现有密钥或公钥。**公钥已存在时不要重新生成。** 普通 clone、开发和 `pnpm dist` 都无需私钥；换发布设备时，将备份私钥安全恢复到上述位置并保持权限。

将私钥备份在受保护的离线位置。私钥不得提交 Git、上传为 Release/Actions 附件、放入 `.app` 或通过聊天分享；CI 只允许将原私钥保存在下述受保护发布环境的 Secret 中。若私钥丢失，已有客户端不能自动信任新的密钥，需要手动安装采用新公钥的基线版本。若私钥泄露，应停止发布、告知使用者并更换信任基线。

## 手动发布（自动发布故障时的维护入口）

常规 main 合入使用下文自动工作流；不要与正在运行的自动发布并行手动发版。需要手动维护时先暂停工作流并等正在运行的发布完成，避免争用版本标签或 latest。

1. 修改 `package.json` 中的稳定版本号；完成必要测试并提交代码。工作区必须干净。已经交付给用户的构建发生功能变化时，必须提升版本号，即使尚未公开发布；不要再次交付版本号和文件名相同、功能却不同的安装包。
2. 在本机生成安装包和签名：

   ```sh
   pnpm dist:release
   ```

   此命令先验证私钥匹配，再运行单元测试和 `pnpm dist`，生成 `.app`、版本 DMG、ZIP、固定名 DMG，以及 `update-mac-arm64.json` / `.sig`。签名清单绑定当前 Git 提交、版本、架构、最低系统要求、文件名、大小和摘要。固定名 DMG 在源文件及副本均通过摘要校验后原子替换。普通 `pnpm dist` 不生成发布签名和固定下载副本，也不上传文件。

3. 核验本工作树、同一轮构建生成的 App 和 DMG：只读挂载 DMG，对比内部 App 与独立 App 的 Bundle 版本及 `Contents/Resources/app.asar` 的 SHA-256，完成后卸载。交付链接必须指向这一轮产物，并同时提供当前版本的 DMG 与 App。实际启动本次 App，验证工作区和更新设置。需要验证安装器时运行 `pnpm test:installer`；它只使用临时目录中的测试应用和独立测试密钥。
4. 确认当前 HEAD 就是用户要求发布的提交，并遵循仓库 Git 工作流将其推送到正确分支，再推送对应标签。不要在任务分支中盲目推送本地 `main`。例如，发布当前分支的已验证提交：

   ```sh
   git tag v1.1.1
   git push origin HEAD
   git push origin v1.1.1
   ```

5. 使用已登录且有仓库写权限的 `gh` 创建草稿：

   ```sh
   pnpm release
   ```

   命令验证工作区、标签、远端仓库、远端标签提交、清单签名及全部资产摘要，重新生成并校验固定名 DMG，再上传五个必需附件到草稿，并核对附件大小。重复执行仅更新同版本草稿；不会覆盖已经公开的正式版。

6. 打开脚本输出的 GitHub 草稿链接，检查发布说明及附件。若用户只要求草稿，在此交付；已授权正式发布时继续执行下一节。保持 `v<版本号>` 的标签格式，不勾选预发布，并将其设为最新正式版。客户端使用 GitHub `releases/latest`，不按提交时间或默认分支自动更新。

若打包后修改了源码或版本号，必须重新提交、打包。不得替换正式 Release 中的同名资产；修复时提升版本号发布。

## 正式发布及发后核验

用户已授权正式发布时，先核对草稿说明及五个必需附件：本版本 arm64 DMG、ZIP、`update-mac-arm64.json`、`update-mac-arm64.json.sig`、`all-in-one-workspace-arm64.dmg`。确认不是测试包，再通过 GitHub 页面发布；也可使用当前版本派生的标签：

```sh
version=$(node -p "require('./package.json').version")
gh release edit "v${version}" --repo KonjakZhou/AllInOneWorkspace --draft=false --prerelease=false --latest
```

完成后核验：

1. `gh release view "v${version}" --repo KonjakZhou/AllInOneWorkspace --json url,isDraft,isPrerelease,tagName,assets`，确认正式状态、正确标签及完整附件。
2. `gh api repos/KonjakZhou/AllInOneWorkspace/releases/latest`，确认客户端可发现此标签。未公开的草稿不能作为自动更新基线。
3. 从公开下载地址读取清单、签名及安装包，用仓库公钥验证清单并核对下载包大小和 SHA-256。另通过 README 的固定最新下载链接下载 DMG，确认重定向到本次版本，且大小、SHA-256 与签名清单的版本 DMG 一致。不要只凭网页上的文件名确认成功。
4. 使用隔离账号验证旧版发现新版、下载、确认重启、原数据保留。1.0.0 不含更新器，必须手动安装 1.1.0 或更高基线；其安装不能充当自动升级验证。
5. 报告 Release 链接、版本与提交、必需附件、测试结果和仍未验证的条件。区分“本地已构建”“草稿已上传”“正式已发布”，不得混用。

## 验证命令与失败处理

- 源码验证：`pnpm check`、`pnpm test`。界面或账号流程有改动时运行相应桌面用例；打包后用 `WORKSPACE_TEST_APP` 与 `WORKSPACE_TEST_EXECUTABLE` 指向本工作树 App 运行对应桌面用例。
- 更新协议或安装器有改动时运行 `pnpm test:installer`，并使用 `WORKSPACE_TEST_ARCHIVE` 指向本次 ZIP 执行 `pnpm exec vitest run tests/updates.test.ts -t 'actual packaged'`。
- 私钥缺失或不匹配：停止签名和发布，说明需要恢复原私钥；可以继续无私钥的本地构建。不要生成新密钥来绕过已有客户端信任。
- 工作区不干净、标签已存在或包与提交不一致：明确定位差异，保留已有改动和已发布资产；准备正确提交或提升版本后重新构建。不要为了让脚本通过而清空改动、强推标签或修改公开版本附件。
- 构建失败或附件不完整：保持未发布状态，修复后重新制作并核验完整资产集。GitHub 故障或权限不足时报告实际失败阶段，不宣称已发布。
- 本项目没有 Apple Developer ID 或公证；独立 Ed25519 更新包签名不代表 Apple 认证。不要自动清除 quarantine 或关闭 Gatekeeper。

## GitHub Actions 串行自动发布

工作流位于 `.github/workflows/release.yml`，合入 main 后生效。`push` 到 main 自动触发，`workflow_dispatch` 提供手动重试入口。任务仅在 `KonjakZhou/AllInOneWorkspace` 的 main 上运行；其他分支及 fork 不发布。所有阶段共用 `release-main` 并发组，`cancel-in-progress: false`、`queue: max`：最多一个运行，最多 100 个等待，超出队列的任务由 GitHub 取消。任务排队不阻止 PR 合入。

### 一次性 GitHub 配置

1. 在 [Actions 设置](https://github.com/KonjakZhou/AllInOneWorkspace/settings/actions)启用 Actions。默认 token 保持只读，工作流仅为版本预留和签名发布 job 授予 `contents: write`；使用内置 `GITHUB_TOKEN`，无需个人 PAT，也不需要允许机器人创建/批准 PR。
2. 在 [Environments](https://github.com/KonjakZhou/AllInOneWorkspace/settings/environments)创建名为 `release` 的环境，Deployment branches and tags 选 Selected branches and tags，添加 Branch `main`。完全自动发布不设置 Required reviewers 或 Wait timer。
3. 在该环境的 Environment secrets 中添加 `UPDATE_SIGNING_PRIVATE_KEY`，值是原发布私钥 PEM。不要重建密钥。签名发布与构建在不同 runner 上运行；构建 runner 只拥有只读权限且不接收私钥。工作流只在签名步骤暴露 Secret，以 0600 临时写入，签名结束后删除；最终清理步骤始终执行。密钥不进入缓存、日志或附件。
4. 合入工作流后在 [Actions](https://github.com/KonjakZhou/AllInOneWorkspace/actions)查看 `Release macOS`；成功后检查 [最新 Release](https://github.com/KonjakZhou/AllInOneWorkspace/releases/latest)。Secret 保存成功只证明已配置；第一次签名成功才证明它与现有公钥匹配。

官方说明：[发布环境](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)、[串行队列](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)。

### 版本与源码如何绑定

`scripts/ci-release.mjs prepare` 固定触发任务的 main SHA，读取全部稳定版本标签（包括失败任务的预留版本），选择下一个补丁号。若源码 `package.json` 显式设置了高于全部标签的稳定版本，则使用该版本，可用于次版本或主版本发布。

自动化在该源码提交上生成一个只修改 `package.json` 版本和 `.release/source.json` 的发布提交，用 GitHub bot 的公开 noreply 身份提交，不向 main 回写。发布记录包含源码 SHA、仓库和版本号；发布提交的父提交必须就是源码 SHA，验证时也检查不能夹带额外代码。App、清单和版本标签都对应这个发布提交。因此 main 中的 package 版本不代表最新安装版本，最新安装版本以 Release 为准。

构建前通过一次原子 push 同时保存 `v<版本号>` 和 `release-source-<源码SHA>` 两个不可移动的标签。这是持久化的版本预留，尚不是正式 Release；即使 runner 中断，也能在重试中找到同一提交和版本。标签可能先于安装包出现；下载请以正式 Release 为准。不要删除预留标签来回收版本，也不要强推标签。

队列顺序按进入等待状态的时间决定，不能保证与 main 提交顺序一致。因此还检查所有已发布版本的源码祖先关系：

- 同一源码已正式发布：仅重新验证公开附件，不重新构建或覆盖。
- 更新的正式版本已经包含本次源码：跳过旧任务，避免把 latest 降回旧代码。
- 两份源码不在同一 main 提交链：停止，要求维护者处理，不自动发布分叉代码。
- 旧任务预留的版本号已低于已发布版本，但其源码还未被包含：停止；通过 main 上的新提交重新发布，不复用版本号或移动标签。

### 工作流执行顺序

1. 各 job 安装 `.nvmrc` 指定的 Node.js、固定的 pnpm 11.25.0。版本预留与签名发布在独立 Ubuntu runner 上执行 `pnpm install --frozen-lockfile --ignore-scripts`，不执行依赖生命周期脚本；构建在 macOS arm64 runner（`macos-15`，显式检查架构）上正常安装依赖。Actions 使用完整提交 SHA 固定。
2. 分配或恢复版本；忽略已被新版包含的任务。源码提交固定后不在构建中切换到新 main。
3. `node scripts/release.mjs build-unsigned` 执行单元测试及 `pnpm dist`（包括类型检查），保存绑定当前提交及安装包摘要的本地构建记录。此阶段不提供签名 Secret。
4. 原生安装器测试、实际 ZIP 结构测试，以及隔离账号的打包 App 启动和更新入口验证。`verify-release.mjs local-unsigned` 核验 App/只读挂载 DMG 的版本和 `app.asar` 一致性。测试不读取真实账号，不访问飞书等个人服务。仅将验证后的 ZIP、DMG 和构建记录作为当前运行的 artifact 传递到全新的签名发布 runner，artifact 保留 7 天。
5. `scripts/sign-ci-release.mjs` 临时恢复原私钥，调用 `release.mjs sign` 校验构建记录、提交、版本及摘要后签名，生成固定名 DMG，最后删除私钥。
6. `scripts/verify-release.mjs assets` 在发布 runner 核验签名及五个附件。手动本地发布仍可用 `local` 同时核验签名和 App/DMG。
7. `pnpm release` 创建/更新草稿，上传五个附件；`verify-release.mjs remote-draft` 重新下载并验证签名与摘要；草稿附件集合必须恰好为五个允许的文件，额外附件也会阻止发布。
8. 再次检查已发布版本和源码关系，通过后正式发布并设为 latest。最后 `verify-release.mjs remote-public` 验证公开下载与 README 固定入口。整个过程在同一工作流内，不依赖 token 创建的标签触发另一个工作流。

### 失败与重试

在 Actions 打开失败的 `Release macOS` 运行，选择 **Re-run all jobs**，重试原源码及预留版本。工作流首页的 **Run workflow → main** 则处理当前 main。没有额外的手工版本输入；正常合入自动递增，需显式提升主/次版本时通过 PR 修改 package 版本。

发布前失败：latest 保持不变，可能留下预留标签或草稿；重试只允许更新草稿。后续 main 的发布任务可以继续执行，失败预留号不会分配给其他源码。正式发布后的验证失败：该版本可能已可下载，重试只能验证，不能覆盖公开附件；需要改包时发布新版本。

例如线上为 `1.2.10`：A 合入，预留 `1.2.11` 开始构建；B 合入，等待 A；A 成功后 latest 指向 `1.2.11`，B 再发布 `1.2.12`。若 A 失败而 B 成功且已包含 A，之后重试 A 会跳过。README 的固定入口随 latest 切换，不产生额外机器人提交。

### 五个发布附件的用途

| 文件 | 用途 |
| --- | --- |
| `all-in-one-workspace-<版本号>-arm64.dmg` | 指定版本的手动安装包；清单记录其大小和摘要。 |
| `all-in-one-workspace-<版本号>-arm64.zip` | 应用内更新器下载并解压的 App 包；不是 GitHub 自动生成的源码 ZIP。 |
| `update-mac-arm64.json` | 更新清单：版本、源码提交、平台、最低系统版本、安装包文件名、大小和 SHA-256。 |
| `update-mac-arm64.json.sig` | 清单的 Ed25519 签名；客户端用内置公钥验证来源及内容，进而核验安装包。 |
| `all-in-one-workspace-arm64.dmg` | 本版本 DMG 的逐字节副本，为 README 提供固定的最新下载地址。 |

这五个附件是本项目安装和更新协议的约定，不是 GitHub 强制要求。GitHub 页面另附的 Source code ZIP/TAR 是源码，不属于这五个附件。自动化不需要 Apple Developer ID；本项目更新签名不等于 Apple 签名/公证。

## README 的固定安装入口

- README 使用「最新正式版」和 [最新 Release](https://github.com/KonjakZhou/AllInOneWorkspace/releases/latest)，不再写死当前安装版本号。
- [直接下载最新版](https://github.com/KonjakZhou/AllInOneWorkspace/releases/latest/download/all-in-one-workspace-arm64.dmg) 指向 latest 对应 Release 的固定名附件。不同 Release 中可以各自有这个同名附件；发布新版后无需覆盖旧 Release 的文件或修改 README。参见 [GitHub 最新附件链接规则](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)。
- 发布脚本自动生成并上传固定名副本。安装步骤无需发布机器人回写 main；main 合入后由前述工作流启动完整发布任务。
- 已发布旧版首次补齐固定名附件时，必须核对原发布清单的签名及原 DMG 摘要，复制原 DMG 后只添加这个缺失附件。不能使用重新构建但版本号相同的 DMG，也不能覆盖已有附件、签名清单或版本标签；已有固定名附件时先核验，不使用 `--clobber`。
