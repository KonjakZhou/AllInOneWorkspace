# 发布操作指南（开发 agent 与维护者）

本文件是本仓库发布流程的统一入口，操作工具为 `scripts/release.mjs`。处理版本、打包、签名、标签或 GitHub Release 任务前先阅读本文件；日常更新使用说明见 [docs/updates.md](docs/updates.md)。

## 发布目标与授权范围

- 固定公开仓库：`KonjakZhou/AllInOneWorkspace`。发布前核对 `git remote -v` 和 `gh auth status`，不要根据当前登录账号推断或切换发布目标。
- 仅支持 macOS 13+ / arm64 的稳定版本；版本号使用 `X.Y.Z`，标签使用 `vX.Y.Z`。源码、版本标签、清单中的提交、安装包必须属于同一次构建。
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

将私钥备份在受保护的离线位置。私钥不得上传 GitHub、提交 Git、放入 `.app` 或通过聊天分享。若私钥丢失，已有客户端不能自动信任新的密钥，需要手动安装采用新公钥的基线版本。若私钥泄露，应停止发布、告知使用者并更换信任基线。

## 每次发布

1. 修改 `package.json` 中的稳定版本号；完成必要测试并提交代码。工作区必须干净。已经交付给用户的构建发生功能变化时，必须提升版本号，即使尚未公开发布；不要再次交付版本号和文件名相同、功能却不同的安装包。
2. 在本机生成安装包和签名：

   ```sh
   pnpm dist:release
   ```

   此命令先验证私钥匹配，再运行单元测试和 `pnpm dist`，生成 `.app`、DMG、ZIP，以及 `update-mac-arm64.json` / `.sig`。签名清单绑定当前 Git 提交、版本、架构、最低系统要求、文件名、大小和摘要。普通 `pnpm dist` 不生成发布签名，也不上传文件。

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

   命令验证工作区、标签、远端仓库、远端标签提交、清单签名及全部资产摘要，再上传四个必需附件到草稿，并核对附件大小。重复执行仅更新同版本草稿；不会覆盖已经公开的正式版。

6. 打开脚本输出的 GitHub 草稿链接，检查发布说明及附件。若用户只要求草稿，在此交付；已授权正式发布时继续执行下一节。保持 `v<版本号>` 的标签格式，不勾选预发布，并将其设为最新正式版。客户端使用 GitHub `releases/latest`，不按提交时间或默认分支自动更新。

若打包后修改了源码或版本号，必须重新提交、打包。不得替换正式 Release 中的同名资产；修复时提升版本号发布。

## 正式发布及发后核验

用户已授权正式发布时，先核对草稿说明及四个必需附件：本版本 arm64 DMG、ZIP、`update-mac-arm64.json`、`update-mac-arm64.json.sig`。确认不是测试包，再通过 GitHub 页面发布；也可使用当前版本派生的标签：

```sh
version=$(node -p "require('./package.json').version")
gh release edit "v${version}" --repo KonjakZhou/AllInOneWorkspace --draft=false --prerelease=false --latest
```

完成后核验：

1. `gh release view "v${version}" --repo KonjakZhou/AllInOneWorkspace --json url,isDraft,isPrerelease,tagName,assets`，确认正式状态、正确标签及完整附件。
2. `gh api repos/KonjakZhou/AllInOneWorkspace/releases/latest`，确认客户端可发现此标签。未公开的草稿不能作为自动更新基线。
3. 从公开下载地址读取清单、签名及安装包，用仓库公钥验证清单并核对下载包大小和 SHA-256。不要只凭网页上的文件名确认成功。
4. 使用隔离账号验证旧版发现新版、下载、确认重启、原数据保留。1.0.0 不含更新器，必须手动安装 1.1.0 或更高基线；其安装不能充当自动升级验证。
5. 报告 Release 链接、版本与提交、必需附件、测试结果和仍未验证的条件。区分“本地已构建”“草稿已上传”“正式已发布”，不得混用。

## 验证命令与失败处理

- 源码验证：`pnpm check`、`pnpm test`。界面或账号流程有改动时运行相应桌面用例；打包后用 `WORKSPACE_TEST_APP` 与 `WORKSPACE_TEST_EXECUTABLE` 指向本工作树 App 运行对应桌面用例。
- 更新协议或安装器有改动时运行 `pnpm test:installer`，并使用 `WORKSPACE_TEST_ARCHIVE` 指向本次 ZIP 执行 `pnpm exec vitest run tests/updates.test.ts -t 'actual packaged'`。
- 私钥缺失或不匹配：停止签名和发布，说明需要恢复原私钥；可以继续无私钥的本地构建。不要生成新密钥来绕过已有客户端信任。
- 工作区不干净、标签已存在或包与提交不一致：明确定位差异，保留已有改动和已发布资产；准备正确提交或提升版本后重新构建。不要为了让脚本通过而清空改动、强推标签或修改公开版本附件。
- 构建失败或附件不完整：保持未发布状态，修复后重新制作并核验完整资产集。GitHub 故障或权限不足时报告实际失败阶段，不宣称已发布。
- 本项目没有 Apple Developer ID 或公证；独立 Ed25519 更新包签名不代表 Apple 认证。不要自动清除 quarantine 或关闭 Gatekeeper。
