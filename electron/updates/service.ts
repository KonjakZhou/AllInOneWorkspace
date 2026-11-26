import { mkdir, rename, rm, stat, readdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { UpdateState } from '../../src/shared/updates'
import { errorMessage } from '../../src/shared/model'
import { atomicWrite, hashFile, readLimited } from './files'
import {
  assetUrl,
  compareVersions,
  MANIFEST_NAME,
  MAX_METADATA,
  REPOSITORY,
  releaseUrl,
  SIGNATURE_NAME,
  STABLE,
  systemSupports,
  verifyManifest,
  type UpdateManifest,
} from './protocol'
import { UpdateHttp, UpdateHttpError } from './http'
import { inspectArchive } from './archive'

const SIX_HOURS = 6 * 60 * 60 * 1000,
  SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000
export interface UpdateOptions {
  directory: string
  version: string
  systemVersion: string
  enabled: boolean
  publicKey: string
  changed(state: UpdateState): void
  installationReason?: string
  http?: UpdateHttp
  now?: () => number
  inspect?: (path: string) => Promise<void>
}
export class UpdateService {
  private state: UpdateState
  private manifest?: UpdateManifest
  private bytes?: Buffer
  private signature?: string
  private checkedAt = 0
  private nextCheck = 0
  private cooldown = 0
  private failures = 0
  private lastManual = -Infinity
  private pending?: Promise<void>
  private timer?: ReturnType<typeof setInterval>
  private initial?: ReturnType<typeof setTimeout>
  private abort = new AbortController()
  private disposed = false
  private persistence = Promise.resolve()
  private settingsWrite = Promise.resolve()
  private http: UpdateHttp
  private now: () => number
  readonly cache: string
  readonly archive: string
  constructor(private options: UpdateOptions) {
    this.now = options.now ?? Date.now
    this.http = options.http ?? new UpdateHttp()
    this.cache = join(
      options.directory,
      'cache',
      'app-updates-v1',
      'KonjakZhou-AllInOneWorkspace-stable-darwin-arm64',
    )
    this.archive = join(this.cache, 'update.zip')
    this.state = {
      phase: 'idle',
      currentVersion: options.version,
      automatic: true,
      canInstall: !options.installationReason,
      message: options.installationReason,
    }
  }
  getState = (): UpdateState => ({ ...this.state })
  private emit(patch: Partial<UpdateState>) {
    this.state = { ...this.state, ...patch }
    if (!this.disposed) this.options.changed(this.getState())
  }
  async init() {
    await mkdir(this.cache, { recursive: true, mode: 0o700 })
    try {
      const value = JSON.parse(
        (await readLimited(join(this.options.directory, 'update-settings.json'), 4096)).toString(),
      )
      if (typeof value.automatic === 'boolean') this.state.automatic = value.automatic
    } catch {
      /* Missing or damaged settings fall back to automatic checks. */
    }
    if (!this.options.enabled || !this.options.publicKey) {
      this.emit({
        phase: 'unavailable',
        message: !this.options.publicKey
          ? '尚未配置发布公钥，暂不能自动更新'
          : '自动更新仅在 macOS Apple Silicon 正式安装版中可用',
      })
      return
    }
    await rm(this.archive + '.part', { force: true })
    try {
      const cached = JSON.parse(
        (await readLimited(join(this.cache, 'check.json'), MAX_METADATA)).toString(),
      )
      if (
        cached.currentVersion !== this.options.version ||
        !Number.isFinite(cached.checkedAt) ||
        !Number.isFinite(cached.recordedAt) ||
        cached.recordedAt > this.now() ||
        this.now() - cached.recordedAt >= SEVEN_DAYS
      )
        throw new Error('cache expired')
      this.checkedAt = cached.checkedAt
      this.nextCheck = Math.min(Number(cached.nextCheck) || 0, this.now() + SIX_HOURS)
      this.cooldown = Number.isFinite(cached.cooldown) ? cached.cooldown : 0
      this.failures = Number.isInteger(cached.failures) ? Math.min(3, cached.failures) : 0
      if (cached.manifest) {
        const bytes = Buffer.from(cached.manifest, 'base64')
        const manifest = verifyManifest(bytes, cached.signature, this.options.publicKey)
        if (compareVersions(manifest.version, this.options.version) > 0) {
          this.validateCompatibility(manifest)
          this.manifest = manifest
          this.bytes = bytes
          this.signature = cached.signature
          this.state = {
            ...this.state,
            phase: 'available',
            version: manifest.version,
            releaseUrl: releaseUrl(manifest.version),
            checkedAt: this.checkedAt,
          }
          if (
            (await stat(this.archive)).size === manifest.zip.size &&
            (await hashFile(this.archive)) === manifest.zip.sha256
          ) {
            await (this.options.inspect ?? inspectArchive)(this.archive)
            this.state.phase = 'ready'
          }
        } else {
          this.state.phase = 'current'
          await rm(this.archive, { force: true })
        }
      } else {
        this.state.phase = this.checkedAt ? 'current' : 'idle'
        await rm(this.archive, { force: true })
      }
      if (typeof cached.error === 'string' && cached.error.length < 1000) {
        this.state.message = cached.error
        if (this.state.phase !== 'ready') this.state.phase = 'error'
      }
    } catch {
      // A partial/invalid cache never establishes update trust. Keep a validated manifest
      // when only the archive is missing, so the next download can resume by retrying.
      await rm(this.archive, { force: true })
    }
    if (!this.manifest) {
      this.bytes = undefined
      this.signature = undefined
      if (!['current', 'error'].includes(this.state.phase) && !this.cooldown) {
        this.checkedAt = 0
        this.nextCheck = 0
      }
    }
    // Completed installation journals are separate from workspace data. Never remove a
    // stage containing a possible rollback App here; the native transaction owns it.
    let latestFailure = 0
    for (const entry of await readdir(this.cache, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^install-[0-9a-f-]{36}$/.test(entry.name)) continue
      const job = join(this.cache, entry.name)
      try {
        const info = await lstat(join(job, 'status.json'))
        const status = JSON.parse((await readLimited(join(job, 'status.json'), 4096)).toString())
        if (
          ['committed', 'failed'].includes(status.phase) &&
          this.now() - info.mtimeMs > SEVEN_DAYS
        ) {
          await rm(job, { recursive: true, force: true })
        } else if (status.phase === 'failed' && info.mtimeMs > latestFailure) {
          latestFailure = info.mtimeMs
          this.state.message = '上次安装未完成：' + String(status.message).slice(0, 600)
        }
      } catch {
        /* Keep incomplete journals for manual recovery. */
      }
    }
    this.emit({ checkedAt: this.checkedAt || undefined })
  }
  start() {
    if (this.state.phase === 'unavailable') return
    this.initial = setTimeout(() => this.resume(), 10000)
    this.timer = setInterval(() => this.resume(), 60000)
  }
  resume = () => {
    if (!this.state.automatic || this.disposed) return
    if (this.state.phase === 'available' && this.now() < this.nextCheck) void this.download()
    else if (this.now() >= this.nextCheck) void this.check(false)
  }
  private persist() {
    const record = {
      recordedAt: this.now(),
      error: this.state.phase === 'error' ? this.state.message : undefined,
      currentVersion: this.options.version,
      checkedAt: this.checkedAt,
      nextCheck: this.nextCheck,
      cooldown: this.cooldown,
      failures: this.failures,
      manifest: this.bytes?.toString('base64'),
      signature: this.signature,
    }
    this.persistence = this.persistence
      .catch(() => undefined)
      .then(() => atomicWrite(join(this.cache, 'check.json'), JSON.stringify(record)))
    return this.persistence
  }
  async setAutomatic(enabled: boolean) {
    if (typeof enabled !== 'boolean') throw new Error('无效的更新设置')
    this.settingsWrite = this.settingsWrite
      .catch(() => undefined)
      .then(async () => {
        await atomicWrite(
          join(this.options.directory, 'update-settings.json'),
          JSON.stringify({ automatic: enabled }),
        )
        this.emit({ automatic: enabled })
      })
    await this.settingsWrite
    if (enabled) this.resume()
  }
  private validateCompatibility(manifest: UpdateManifest) {
    if (!systemSupports(this.options.systemVersion, manifest.minimumSystemVersion))
      throw new Error(`新版需要 macOS ${manifest.minimumSystemVersion} 或更高版本`)
  }
  check(manual = true): Promise<void> {
    if (this.pending) return this.pending
    if (this.disposed || ['unavailable', 'installing'].includes(this.state.phase))
      return Promise.resolve()
    const now = this.now()
    if (
      now < this.cooldown ||
      (manual && now - this.lastManual < 60000) ||
      (!manual && now < this.nextCheck)
    )
      return Promise.resolve()
    if (manual) this.lastManual = now
    this.pending = this.performCheck()
      .catch((error) => this.failed(error))
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }
  private async performCheck() {
    this.emit({
      phase: this.state.phase === 'ready' ? 'ready' : 'checking',
      message: this.options.installationReason,
    })
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30000)])
    let release: { tag_name?: string; draft?: boolean; prerelease?: boolean }
    try {
      release = JSON.parse(
        (
          await this.http.bytes(
            `https://api.github.com/repos/${REPOSITORY}/releases/latest`,
            signal,
          )
        ).toString(),
      )
    } catch (error) {
      if (!(error instanceof UpdateHttpError) || error.status !== 404) throw error
      release = {}
    }
    const version = release.tag_name?.replace(/^v/, '')
    if (
      version &&
      (release.draft ||
        release.prerelease ||
        release.tag_name !== `v${version}` ||
        !STABLE.test(version))
    )
      throw new Error('线上正式版本格式无效')
    if (version && compareVersions(version, this.options.version) > 0) {
      const bytes = await this.http.bytes(assetUrl(version, MANIFEST_NAME), signal)
      const signature = (await this.http.bytes(assetUrl(version, SIGNATURE_NAME), signal, 256))
        .toString()
        .trim()
      const manifest = verifyManifest(bytes, signature, this.options.publicKey)
      if (manifest.version !== version) throw new Error('发布版本与签名清单不一致')
      this.validateCompatibility(manifest)
      const same =
        this.manifest?.zip.sha256 === manifest.zip.sha256 &&
        this.manifest.version === manifest.version
      if (!same) await rm(this.archive, { force: true })
      this.manifest = manifest
      this.bytes = bytes
      this.signature = signature
      this.emit({
        phase: same && this.state.phase === 'ready' ? 'ready' : 'available',
        version,
        releaseUrl: releaseUrl(version),
      })
    } else {
      this.manifest = undefined
      this.bytes = undefined
      this.signature = undefined
      await rm(this.archive, { force: true })
      this.emit({
        phase: 'current',
        version: undefined,
        releaseUrl: releaseUrl(),
        message: version ? '当前已是最新版本' : 'GitHub 暂无正式发布版本',
      })
    }
    this.checkedAt = this.now()
    this.nextCheck = this.now() + SIX_HOURS
    this.failures = 0
    this.cooldown = 0
    this.emit({ checkedAt: this.checkedAt })
    await this.persist()
    if (this.state.automatic && this.manifest && this.state.phase !== 'ready')
      await this.performDownload()
  }
  download(): Promise<void> {
    if (this.pending) return this.pending
    if (
      !this.manifest ||
      ['ready', 'installing'].includes(this.state.phase) ||
      this.now() < this.cooldown
    )
      return Promise.resolve()
    this.pending = this.performDownload()
      .catch((error) => this.failed(error))
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }
  private async performDownload() {
    const manifest = this.manifest!
    this.emit({ phase: 'downloading', progress: 0, message: this.options.installationReason })
    const partial = this.archive + '.part'
    await rm(partial, { force: true })
    try {
      await this.http.download(
        assetUrl(manifest.version, manifest.zip.name),
        partial,
        manifest.zip,
        AbortSignal.any([this.abort.signal, AbortSignal.timeout(30 * 60 * 1000)]),
        (progress) => this.emit({ progress }),
      )
      await (this.options.inspect ?? inspectArchive)(partial)
      await rename(partial, this.archive)
      this.emit({ phase: 'ready', progress: 100, message: this.options.installationReason })
      await this.persist()
    } finally {
      await rm(partial, { force: true })
    }
  }
  private async failed(error: unknown) {
    if (this.disposed) return
    this.nextCheck = this.now() + [15 * 60000, 3600000, SIX_HOURS][Math.min(this.failures++, 2)]
    if (error instanceof UpdateHttpError) this.cooldown = Math.max(this.cooldown, error.retryAt)
    this.nextCheck = Math.max(this.nextCheck, this.cooldown)
    this.emit({
      phase: this.state.phase === 'ready' ? 'ready' : 'error',
      message: errorMessage(error),
    })
    await this.persist().catch(() => undefined)
  }
  async prepareInstall() {
    if (
      this.pending ||
      this.state.phase !== 'ready' ||
      !this.state.canInstall ||
      !this.manifest ||
      !this.bytes ||
      !this.signature
    )
      throw new Error(this.options.installationReason ?? '更新尚未准备完成')
    this.emit({ phase: 'installing', message: '正在验证安装包并准备重启…' })
    try {
      verifyManifest(this.bytes, this.signature, this.options.publicKey)
      if (
        (await stat(this.archive)).size !== this.manifest.zip.size ||
        (await hashFile(this.archive)) !== this.manifest.zip.sha256
      )
        throw new Error('待安装更新包校验失败，请重新下载')
      await (this.options.inspect ?? inspectArchive)(this.archive)
      return {
        archive: this.archive,
        manifest: this.manifest,
        bytes: this.bytes,
        signature: this.signature,
      }
    } catch (error) {
      this.emit({ phase: 'error', message: errorMessage(error) })
      throw error
    }
  }
  initializationFailed(error: unknown) {
    this.emit({ phase: 'unavailable', message: errorMessage(error) })
  }
  installFailed(error: unknown) {
    this.emit({
      phase: this.state.phase === 'installing' ? 'ready' : this.state.phase,
      message: errorMessage(error),
    })
  }
  dispose() {
    this.disposed = true
    clearInterval(this.timer)
    clearTimeout(this.initial)
    this.abort.abort()
  }
}
