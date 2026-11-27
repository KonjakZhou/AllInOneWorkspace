import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  safeStorage,
  shell,
  powerMonitor,
  type IpcMainInvokeEvent,
} from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WorkspaceStore } from './storage/workspace-store'
import { MAX_FILE_BYTES } from './storage/json-files'
import { errorMessage, type Snapshot } from '../src/shared/model'
import type { ApiResult } from '../src/shared/api'
import { IdeaService } from './trading-ideas/service'
import { collectors } from './trading-ideas/sources'
import { registerIdeaHandlers } from './trading-ideas/ipc'
import { EncryptedVault } from './feishu/vault'
import { FeishuClient } from './feishu/client'
import { LoopbackOAuth } from './feishu/oauth'
import { FeishuService } from './feishu/service'
import { OneClickAuth } from './feishu/one-click'
import { TelegraphClient } from './telegraph/client'
import { TelegraphHistoryCache } from './telegraph/history-cache'
import { TelegraphService } from './telegraph/service'
import { telegraphCursorSchema, telegraphItemIdSchema } from '../src/shared/telegraph'

import updateKey from '../build/update-public-key.json'
import { UpdateService } from './updates/service'
import { installationReason, startInstaller, completeUpdateHandshake } from './updates/installer'
import { releaseUrl } from './updates/protocol'
import { MailService } from './mail/service'
import { MailStorage } from './mail/storage'
import { registerMailHandlers } from './mail/ipc'

const dirname = fileURLToPath(new URL('.', import.meta.url))
app.setName('All In One Workspace')
if (process.env.WORKSPACE_DATA_DIR) app.setPath('userData', process.env.WORKSPACE_DATA_DIR)
const store = new WorkspaceStore(app.getPath('userData'))
const feishu = new FeishuService(
  new EncryptedVault(app.getPath('userData'), safeStorage),
  new FeishuClient((...args) => fetch(...args)),
  new LoopbackOAuth((url) => shell.openExternal(url)),
  (id) => store.hasAccount(id),
  (id) => {
    if (window && !window.isDestroyed()) window.webContents.send('feishu:changed', id)
  },
  Date.now,
  new OneClickAuth(
    (url) => shell.openExternal(url),
    (...args) => fetch(...args),
  ),
)
const telegraph = new TelegraphService(
  new TelegraphClient((...args) => fetch(...args)),
  () => {
    if (window && !window.isDestroyed()) window.webContents.send('telegraph:changed')
  },
  Date.now,
  new TelegraphHistoryCache(join(store.directory, 'cache', 'cls-telegraph-v1')),
)
let window: BrowserWindow | null = null
let updates: UpdateService | undefined
let updateInstalling = false
let mainReady = false
let closeRequested = false
let quitRequested = false
let allowedToQuit = false
const rendererFile = join(dirname, '../renderer/index.html')
const devURL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const ideas = new IdeaService(join(store.directory, 'trading-ideas'), collectors(), () => {
  if (window && !window.isDestroyed()) window.webContents.send('ideas:changed')
})
const mail = new MailService(
  new MailStorage(store.directory, safeStorage),
  (url) => shell.openExternal(url),
  (workspace, change) => {
    if (window && !window.isDestroyed()) window.webContents.send('mail:changed', workspace, change)
  },
)

function useWorkspace(snapshot: Snapshot) {
  mail.activate(snapshot.workspace.accountId)
  return snapshot
}

function trusted(event: IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    return false
  const url = event.senderFrame?.url
  return devURL
    ? !!url && new URL(url).origin === new URL(devURL).origin
    : url === pathToFileURL(rendererFile).href
}
function handle(channel: string, action: (...args: any[]) => unknown) {
  ipcMain.handle(channel, async (event, ...args): Promise<ApiResult<unknown>> => {
    try {
      if (!trusted(event)) throw new Error('拒绝未知页面请求')
      if (updateInstalling && (channel === 'workspace:save' || channel.startsWith('account:')))
        throw new Error('正在安装更新，请稍候')
      return { ok: true, value: await action(...args) }
    } catch (error) {
      return { ok: false, error: errorMessage(error) }
    }
  })
}
function requestClose() {
  if (!window || window.isDestroyed()) return
  closeRequested = true
  window.webContents.send('workspace:close-requested')
}
function showWorkspace() {
  if (!window) createWindow()
  else {
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }
}
function createWindow() {
  closeRequested = false
  window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: 'All In One Workspace',
    backgroundColor: '#f4f3ef',
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 22, y: 20 },
    webPreferences: {
      preload: join(dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.on('ready-to-show', () => window?.show())
  window.on('close', (event) => {
    if (allowedToQuit) return
    event.preventDefault()
    requestClose()
  })
  window.on('closed', () => {
    window = null
    mail.deactivate()
  })
  window.webContents.on('render-process-gone', async () => {
    if (!window) return
    const result = await dialog.showMessageBox(window, {
      type: 'error',
      title: '工作区页面已停止',
      message: '页面发生异常。重新加载会恢复最近一次保存的工作区。',
      buttons: ['重新加载', '关闭窗口'],
    })
    if (result.response === 0) window?.reload()
    else window?.destroy()
  })
  if (devURL) void window.loadURL(devURL)
  else void window.loadFile(rendererFile)
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (!mainReady) return
    showWorkspace()
  })
  void app.whenReady().then(async () => {
    const target = resolve(process.resourcesPath, '../..')
    updates = new UpdateService({
      directory: store.directory,
      version: app.getVersion(),
      systemVersion: process.getSystemVersion(),
      enabled: app.isPackaged && process.platform === 'darwin' && process.arch === 'arm64',
      publicKey: updateKey.publicKey,
      installationReason: await installationReason(target),
      changed: (state) => {
        if (window && !window.isDestroyed()) window.webContents.send('updates:changed', state)
      },
    })
    try {
      await completeUpdateHandshake(process.argv, target, updates.cache)
    } catch {
      allowedToQuit = true
      app.exit(1)
      return
    }
    try {
      await updates.init()
      updates.start()
    } catch (error) {
      updates.initializationFailed(error)
    }
    handle('updates:state', () => updates!.getState())
    handle('updates:check', () => updates!.check())
    handle('updates:download', () => updates!.download())
    handle('updates:automatic', (enabled) => updates!.setAutomatic(enabled))
    handle('updates:open-release', () =>
      shell.openExternal(releaseUrl(updates!.getState().version)),
    )
    handle('updates:install', async () => {
      if (updateInstalling) throw new Error('更新正在安装')
      updateInstalling = true
      try {
        await startInstaller(
          updates!,
          target,
          join(process.resourcesPath, 'aio-update-installer'),
          store.directory,
        )
        setTimeout(() => {
          allowedToQuit = true
          app.quit()
        }, 100)
      } catch (error) {
        updateInstalling = false
        updates!.installFailed(error)
        throw error
      }
    })
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    )
    session.defaultSession.setPermissionCheckHandler(() => false)
    handle('workspace:load', async () => useWorkspace(await store.load()))
    registerMailHandlers(
      handle,
      mail,
      (id) => store.isActiveAccount(id),
      () => window,
    )
    mail.startMaintenance()
    handle('workspace:save', (input) => store.save(input))
    handle('account:create', async (name) => useWorkspace(await store.createAccount(name)))
    handle('account:rename', (id, name) => store.renameAccount(id, name))
    handle('account:switch', async (id) => useWorkspace(await store.switchAccount(id)))
    handle('account:delete', async (id) => {
      let snapshot: Snapshot
      try {
        snapshot = useWorkspace(
          await store.deleteAccount(id, async (accountId) => {
            await feishu.removeAccount(accountId)
            await mail.removeWorkspace(accountId)
          }),
        )
      } catch (error) {
        useWorkspace(await store.load())
        throw error
      }
      try {
        ideas.removeAccount(id)
      } catch {
        snapshot.notices.push('账号已删除，交易灵感个人资料清理失败。')
      }
      return snapshot
    })
    registerIdeaHandlers(handle, ideas, (id) => store.isActiveAccount(id))
    ideas.start()
    handle('feishu:connection', (id) => feishu.getConnection(id))
    handle('feishu:connect', (id) => feishu.connect(id))
    handle('feishu:reopen', (id) => feishu.reopenAuthorization(id))
    handle('feishu:config', (id, config) => feishu.saveConfig(id, config))
    handle('feishu:authorize', (id) => feishu.authorize(id))
    handle('feishu:cancel', (id) => feishu.cancelAuthorization(id))
    handle('feishu:disconnect', (id) => feishu.disconnect(id))
    handle('feishu:agenda', (id, force) => feishu.getAgenda(id, force === true))
    handle('telegraph:feed', (force) => telegraph.getFeed(force === true))
    telegraph.startMaintenance()
    handle('telegraph:older', (cursor) => telegraph.loadOlder(telegraphCursorSchema.parse(cursor)))
    handle('telegraph:open', async (input) => {
      const id = telegraphItemIdSchema.parse(input)
      await shell.openExternal(`https://www.cls.cn/detail/${id}`)
    })
    powerMonitor.on('resume', () => {
      feishu.resume()
      telegraph.resume()
      ideas.resume()
      mail.resume()
      updates?.resume()
    })
    handle('account:export', async (id) => {
      const data = await store.exportAccount(id)
      const choice = await dialog.showSaveDialog(window!, {
        title: '导出账号',
        defaultPath: `workspace-${data.account.name.replace(/[\\/:*?"<>|]/g, '_')}.json`,
        filters: [{ name: '工作区数据', extensions: ['json'] }],
      })
      if (choice.canceled || !choice.filePath) return false
      await writeFile(choice.filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
      return true
    })
    handle('account:import', async () => {
      const choice = await dialog.showOpenDialog(window!, {
        title: '导入账号',
        properties: ['openFile'],
        filters: [{ name: '工作区数据', extensions: ['json'] }],
      })
      if (choice.canceled || !choice.filePaths[0]) return null
      const bytes = await readFile(choice.filePaths[0])
      if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('导入文件超过 20 MB 限制')
      return useWorkspace(await store.importAccount(JSON.parse(bytes.toString('utf8'))))
    })
    handle('workspace:finish-close', () => {
      if (!closeRequested) return
      // Reply to IPC before destroying its sender.
      setTimeout(() => {
        window?.destroy()
        if (quitRequested) {
          allowedToQuit = true
          app.quit()
        }
      }, 0)
    })
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: app.name,
          submenu: [
            {
              id: 'about-workspace',
              label: '关于工作区',
              click: () => {
                const options = {
                  type: 'info' as const,
                  title: '关于工作区',
                  message: 'All In One Workspace',
                  detail: `版本 ${app.getVersion()}\n你的本地个人工作区。\n账号、布局和组件数据保存在本机。`,
                  buttons: ['好'],
                  noLink: true,
                }
                if (window) void dialog.showMessageBox(window, options)
                else void dialog.showMessageBox(options)
              },
            },
            { type: 'separator' },
            { label: '隐藏工作区', role: 'hide' },
            { type: 'separator' },
            { label: '退出工作区', role: 'quit' },
          ],
        },
        {
          label: '编辑',
          submenu: [
            { label: '撤销', role: 'undo' },
            { label: '重做', role: 'redo' },
            { type: 'separator' },
            { label: '剪切', role: 'cut' },
            { label: '复制', role: 'copy' },
            { label: '粘贴', role: 'paste' },
            { label: '全选', role: 'selectAll' },
          ],
        },
        {
          label: '窗口',
          submenu: [
            {
              id: 'show-workspace',
              label: '显示工作区',
              accelerator: 'CmdOrCtrl+1',
              click: showWorkspace,
            },
            { label: '最小化窗口', role: 'minimize' },
            { label: '切换全屏', role: 'togglefullscreen' },
            { type: 'separator' },
            { label: '放大界面', role: 'zoomIn' },
            { label: '缩小界面', role: 'zoomOut' },
            { label: '恢复默认缩放', role: 'resetZoom' },
            { type: 'separator' },
            { label: '关闭窗口', role: 'close' },
            ...(!app.isPackaged
              ? [
                  { type: 'separator' as const },
                  { label: '切换开发者工具', role: 'toggleDevTools' as const },
                ]
              : []),
          ],
        },
      ]),
    )
    mainReady = true
    createWindow()
    app.on('activate', () => {
      showWorkspace()
    })
  })
  app.on('before-quit', (event) => {
    if (!allowedToQuit && window) {
      event.preventDefault()
      quitRequested = true
      requestClose()
    }
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('will-quit', () => {
    updates?.dispose()
    feishu.dispose()
    telegraph.dispose()
    ideas.dispose()
    mail.dispose()
  })
}
