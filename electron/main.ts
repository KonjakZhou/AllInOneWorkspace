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
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WorkspaceStore } from './storage/workspace-store'
import { MAX_FILE_BYTES } from './storage/json-files'
import { errorMessage } from '../src/shared/model'
import type { ApiResult } from '../src/shared/api'
import { EncryptedVault } from './feishu/vault'
import { FeishuClient } from './feishu/client'
import { LoopbackOAuth } from './feishu/oauth'
import { FeishuService } from './feishu/service'
import { OneClickAuth } from './feishu/one-click'

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
let window: BrowserWindow | null = null
let closeRequested = false
let quitRequested = false
let allowedToQuit = false
const rendererFile = join(dirname, '../renderer/index.html')
const devURL = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined

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
    event.preventDefault()
    requestClose()
  })
  window.on('closed', () => {
    window = null
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
    if (window) {
      if (window.isMinimized()) window.restore()
      window.focus()
    } else createWindow()
  })
  void app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
      callback(false),
    )
    session.defaultSession.setPermissionCheckHandler(() => false)
    handle('workspace:load', () => store.load())
    handle('workspace:save', (input) => store.save(input))
    handle('account:create', (name) => store.createAccount(name))
    handle('account:rename', (id, name) => store.renameAccount(id, name))
    handle('account:switch', (id) => store.switchAccount(id))
    handle('account:delete', (id) =>
      store.deleteAccount(id, (accountId) => feishu.removeAccount(accountId)),
    )
    handle('feishu:connection', (id) => feishu.getConnection(id))
    handle('feishu:connect', (id) => feishu.connect(id))
    handle('feishu:reopen', (id) => feishu.reopenAuthorization(id))
    handle('feishu:config', (id, config) => feishu.saveConfig(id, config))
    handle('feishu:authorize', (id) => feishu.authorize(id))
    handle('feishu:cancel', (id) => feishu.cancelAuthorization(id))
    handle('feishu:disconnect', (id) => feishu.disconnect(id))
    handle('feishu:agenda', (id, force) => feishu.getAgenda(id, force === true))
    powerMonitor.on('resume', () => feishu.resume())
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
      return store.importAccount(JSON.parse(bytes.toString('utf8')))
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
            { role: 'about' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        { role: 'editMenu' },
        {
          label: '视图',
          submenu: [
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { role: 'togglefullscreen' },
            ...(!app.isPackaged ? [{ role: 'toggleDevTools' as const }] : []),
          ],
        },
        { role: 'windowMenu' },
      ]),
    )
    createWindow()
    app.on('activate', () => {
      if (!window) createWindow()
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
  app.on('will-quit', () => feishu.dispose())
}
