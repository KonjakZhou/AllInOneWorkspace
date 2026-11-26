import { open, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { MAX_METADATA, type UpdateManifest } from './protocol'
export class UpdateHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAt = 0,
  ) {
    super(message)
  }
}
export function allowedUrl(value: string) {
  const url = new URL(value)
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    [
      'api.github.com',
      'github.com',
      'release-assets.githubusercontent.com',
      'objects.githubusercontent.com',
    ].includes(url.hostname)
  )
}
export class UpdateHttp {
  constructor(
    private request: typeof fetch = fetch,
    private now = Date.now,
  ) {}
  private async response(url: string, signal: AbortSignal) {
    for (let redirects = 0; redirects <= 5; redirects++) {
      if (!allowedUrl(url)) throw new Error('拒绝不受信任的更新下载地址')
      const response = await this.request(url, {
        signal,
        redirect: 'manual',
        headers: {
          'User-Agent': 'AllInOneWorkspace-Updater',
          Accept:
            new URL(url).hostname === 'api.github.com'
              ? 'application/vnd.github+json'
              : 'application/octet-stream',
        },
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location) throw new Error('更新下载重定向无效')
        url = new URL(location, url).href
        continue
      }
      if (!response.ok) {
        const retry = response.headers.get('retry-after')
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
        const retryAt = retry
          ? /^\d+$/.test(retry)
            ? this.now() + Number(retry) * 1000
            : Date.parse(retry)
          : 0
        await response.body?.cancel()
        throw new UpdateHttpError(
          response.status === 403 || response.status === 429
            ? '更新服务限流，请稍后重试'
            : `更新服务暂时不可用（${response.status}）`,
          response.status,
          Math.max(
            Number.isFinite(retryAt) ? retryAt : 0,
            response.status === 403 && Number.isFinite(reset) ? reset : 0,
          ),
        )
      }
      return response
    }
    throw new Error('更新下载重定向过多')
  }
  async bytes(url: string, signal: AbortSignal, limit = MAX_METADATA) {
    const response = await this.response(url, signal)
    if (!response.body) throw new Error('更新服务返回空内容')
    if (Number(response.headers.get('content-length')) > limit) {
      await response.body.cancel()
      throw new Error('更新元数据过大')
    }
    const chunks: Buffer[] = []
    let size = 0
    const reader = response.body.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if ((size += value.length) > limit) throw new Error('更新元数据过大')
        chunks.push(Buffer.from(value))
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    return Buffer.concat(chunks)
  }
  async download(
    url: string,
    path: string,
    asset: UpdateManifest['zip'],
    signal: AbortSignal,
    progress: (percent: number) => void,
  ) {
    const response = await this.response(url, signal)
    if (!response.body) throw new Error('下载内容为空')
    const size = response.headers.get('content-length')
    if (size && Number(size) !== asset.size) {
      await response.body.cancel()
      throw new Error('下载包大小与签名清单不符')
    }
    const file = await open(path, 'wx', 0o600)
    const reader = response.body.getReader(),
      hash = createHash('sha256')
    let received = 0,
      complete = false,
      lastPercent = -1
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if ((received += value.length) > asset.size) throw new Error('下载包超过预期大小')
        hash.update(value)
        await file.writeFile(value)
        const percent = Math.floor((received / asset.size) * 100)
        if (percent !== lastPercent) {
          progress(percent)
          lastPercent = percent
        }
      }
      if (received !== asset.size || hash.digest('hex') !== asset.sha256)
        throw new Error('下载包完整性校验失败')
      await file.sync()
      complete = true
    } finally {
      await file.close()
      await reader.cancel().catch(() => undefined)
      if (!complete) await rm(path, { force: true })
    }
  }
}
