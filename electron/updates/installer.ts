import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, chmod, copyFile, lstat, mkdir, realpath, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { atomicWrite, readLimited } from './files'
import { APP_NAME } from './protocol'
import type { UpdateService } from './service'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
export async function installationReason(target: string): Promise<string | undefined> {
  try {
    if (
      ![join(homedir(), 'Applications', APP_NAME), join('/Applications', APP_NAME)].includes(
        target,
      ) ||
      (await realpath(target)) !== target ||
      (await lstat(target)).isSymbolicLink()
    )
      return '请将 App 安装到用户应用程序或 /Applications 后使用重启安装'
    await access(dirname(target), constants.W_OK)
    await access(target, constants.W_OK)
  } catch {
    return '应用目录不可写，请从发布页下载并手动安装'
  }
}
export async function startInstaller(
  service: UpdateService,
  target: string,
  helper: string,
  dataDirectory: string,
) {
  const reason = await installationReason(target)
  if (reason) throw new Error(reason)
  const update = await service.prepareInstall()
  const nonce = randomUUID(),
    job = join(service.cache, 'install-' + nonce)
  await mkdir(job, { mode: 0o700 })
  const request = {
    target,
    archive: update.archive,
    manifestPath: join(job, 'manifest.json'),
    signaturePath: join(job, 'manifest.sig'),
    parentPid: process.pid,
    nonce,
    stage: join(dirname(target), '.aio-update-' + nonce),
    dataDirectory,
  }
  let child: ReturnType<typeof spawn> | undefined
  try {
    await atomicWrite(request.manifestPath, update.bytes)
    await atomicWrite(request.signaturePath, update.signature)
    await atomicWrite(join(job, 'request.json'), JSON.stringify(request))
    await copyFile(helper, join(job, 'installer'))
    await chmod(join(job, 'installer'), 0o700)
    child = spawn(join(job, 'installer'), [job], {
      detached: true,
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir() },
    })
    let failure: Error | undefined
    child.on('error', (error) => {
      failure = error
    })
    child.unref()
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      if (failure) throw failure
      let status: { phase?: string; message?: string } | undefined
      try {
        status = JSON.parse((await readLimited(join(job, 'status.json'), 4096)).toString())
      } catch {
        /* helper is preparing */
      }
      if (status?.phase === 'failed') throw new Error(status.message ?? '更新安装准备失败')
      if (status?.phase === 'prepared') {
        await atomicWrite(join(job, 'go'), nonce)
        return
      }
      if (child.exitCode !== null) throw new Error('安装辅助程序已退出')
      await delay(100)
    }
    throw new Error('安装准备超时，原应用保持不变')
  } catch (error) {
    await atomicWrite(join(job, 'cancel'), nonce).catch(() => undefined)
    service.installFailed(error)
    throw error
  }
}
// Called before registering workspace IPC or opening a window. No migration or data read
// is allowed until the installer commits. An ordinary launch never accepts arbitrary jobs.
export async function completeUpdateHandshake(args: string[], target: string, cache: string) {
  const index = args.indexOf('--aio-update-job')
  if (index < 0) return
  const job = args[index + 1],
    nonce = args[args.indexOf('--aio-update-nonce') + 1]
  if (
    !job ||
    !/^[0-9a-f-]{36}$/.test(nonce ?? '') ||
    resolve(job) !== join(cache, 'install-' + nonce) ||
    (await realpath(job)) !== job ||
    (await stat(job)).uid !== process.getuid?.()
  )
    throw new Error('更新启动会话无效')
  const request = JSON.parse((await readLimited(join(job, 'request.json'), 8192)).toString())
  if (request.target !== target || request.nonce !== nonce || (await installationReason(target)))
    throw new Error('更新启动位置不匹配')
  await atomicWrite(join(job, 'health'), nonce)
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    try {
      if ((await readLimited(join(job, 'continue'), 100)).toString() === nonce) return
    } catch {
      /* wait for commit */
    }
    await delay(100)
  }
  throw new Error('更新尚未提交，已停止打开工作区')
}
