import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpdateService } from '../electron/updates/service'
import { UpdateHttp, allowedUrl } from '../electron/updates/http'
import {
  verifyManifest,
  compareVersions,
  APP_NAME,
  systemSupports,
} from '../electron/updates/protocol'
import { inspectArchive } from '../electron/updates/archive'
import { updateFixture, zip } from './update-fixtures'
const directories: string[] = []
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { force: true, recursive: true })
})
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'updates-unit-'))
  directories.push(directory)
  const fixture = updateFixture()
  let now = 1800000000000
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith('/latest'))
      return Response.json({
        tag_name: 'v' + fixture.manifest.version,
        draft: false,
        prerelease: false,
      })
    if (url.endsWith('.json.sig')) return new Response(fixture.encode().signature)
    if (url.endsWith('.json')) return new Response(new Uint8Array(fixture.encode().bytes))
    return new Response(new Uint8Array(fixture.archive))
  })
  const options = {
    directory,
    version: '1.1.0',
    systemVersion: '15.0',
    enabled: true,
    publicKey: fixture.publicKey,
    changed: vi.fn(),
    http: new UpdateHttp(fetcher as typeof fetch, () => now),
    now: () => now,
  }
  const service = new UpdateService(options)
  await service.init()
  return {
    service,
    options,
    directory,
    fixture,
    fetcher,
    advance: (ms: number) => {
      now += ms
    },
  }
}
describe('signed update protocol and archive validation', () => {
  it('validates the signed bytes, key, platform and semantic version', () => {
    const fixture = updateFixture(),
      { bytes, signature } = fixture.encode()
    expect(verifyManifest(bytes, signature, fixture.publicKey).version).toBe('1.2.0')
    expect(() =>
      verifyManifest(Buffer.concat([bytes, Buffer.from(' ')]), signature, fixture.publicKey),
    ).toThrow('签名')
    expect(() => verifyManifest(bytes, signature, updateFixture().publicKey)).toThrow('签名')
    fixture.manifest.arch = 'x64' as 'arm64'
    expect(() =>
      verifyManifest(fixture.encode().bytes, fixture.encode().signature, fixture.publicKey),
    ).toThrow()
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.1.0', '1.1.0')).toBe(0)
    expect(() => compareVersions('1.2.0-beta.1', '1.1.0')).toThrow()
    expect(systemSupports('13.0.1', '13.0')).toBe(true)
    expect(systemSupports('12.9', '13.0')).toBe(false)
  })
  it('rejects traversal, absolute paths, case collisions and symlink ancestors, accepts framework links', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'updates-zip-'))
    directories.push(directory)
    const file = join(directory, 'test.zip'),
      base = { name: `${APP_NAME}/Contents/Info.plist`, content: 'info' }
    const malicious = [
      [{ name: '../escape', content: 'bad' }],
      [{ name: '/escape', content: 'bad' }],
      [base, { ...base, name: base.name.toUpperCase() }],
      [base, { name: `${APP_NAME}/link`, mode: 0o120777, content: '../../outside' }],
      [
        base,
        { name: `${APP_NAME}/link`, mode: 0o120777, content: 'Contents' },
        { name: `${APP_NAME}/link/file`, content: 'bad' },
      ],
    ]
    for (const entries of malicious) {
      await writeFile(file, zip(entries))
      await expect(inspectArchive(file)).rejects.toThrow()
    }
    await writeFile(
      file,
      zip([
        base,
        { name: `${APP_NAME}/Contents/Framework/Versions/Current`, mode: 0o120777, content: 'A' },
        { name: `${APP_NAME}/Contents/Framework/Versions/A/file`, content: 'ok' },
      ]),
    )
    await expect(inspectArchive(file)).resolves.toBeUndefined()
  })
  it('allows only HTTPS GitHub download hosts', () => {
    expect(allowedUrl('https://release-assets.githubusercontent.com/file')).toBe(true)
    for (const url of [
      'http://github.com/file',
      'https://github.com.evil.test/file',
      'https://user:password@github.com/file',
      'https://github.com:444/file',
    ])
      expect(allowedUrl(url)).toBe(false)
  })
})
describe('update service', () => {
  it('coalesces checks and downloads, then restores verified disk data without network', async () => {
    const s = await setup()
    await Promise.all([s.service.check(), s.service.check()])
    expect(s.fetcher).toHaveBeenCalledTimes(4)
    expect(s.service.getState()).toMatchObject({ phase: 'ready', version: '1.2.0', progress: 100 })
    const restored = new UpdateService(s.options)
    await restored.init()
    expect(restored.getState().phase).toBe('ready')
    restored.resume()
    expect(s.fetcher).toHaveBeenCalledTimes(4)
    expect(await readFile(restored.archive)).toEqual(s.fixture.archive)
    s.service.dispose()
    restored.dispose()
  })
  it('honors the automatic switch and permits an explicit download', async () => {
    const s = await setup()
    await s.service.setAutomatic(false)
    await s.service.check()
    expect(s.fetcher).toHaveBeenCalledTimes(3)
    expect(s.service.getState().phase).toBe('available')
    await s.service.download()
    expect(s.service.getState().phase).toBe('ready')
    const restored = new UpdateService(s.options)
    await restored.init()
    expect(restored.getState().automatic).toBe(false)
    s.service.dispose()
    restored.dispose()
  })
  it('does not install same/older versions or prereleases', async () => {
    for (const version of ['1.1.0', '1.0.8']) {
      const s = await setup()
      s.fixture.manifest.version = version
      await s.service.check()
      expect(s.service.getState().phase).toBe('current')
      expect(s.fetcher).toHaveBeenCalledTimes(1)
    }
    const s = await setup()
    s.fetcher.mockResolvedValueOnce(Response.json({ tag_name: 'v1.3.0-beta', prerelease: true }))
    await s.service.check()
    expect(s.service.getState().phase).toBe('error')
  })
  it('handles an empty release repository and rejects a newer system requirement', async () => {
    const s = await setup()
    s.fetcher.mockResolvedValueOnce(new Response('', { status: 404 }))
    await s.service.check()
    expect(s.service.getState()).toMatchObject({
      phase: 'current',
      message: 'GitHub 暂无正式发布版本',
    })
    s.advance(60001)
    s.fixture.manifest.minimumSystemVersion = '99.0'
    await s.service.check()
    expect(s.service.getState().message).toContain('99.0')
  })
  it('respects provider cooldown and coalesced retries after network failures', async () => {
    const s = await setup()
    s.fetcher.mockResolvedValueOnce(
      new Response('', { status: 429, headers: { 'retry-after': '7200' } }),
    )
    await s.service.check()
    s.advance(61 * 60000)
    await s.service.check()
    s.service.resume()
    expect(s.fetcher).toHaveBeenCalledTimes(1)
    s.advance(60 * 60000)
    await s.service.check()
    expect(s.service.getState().phase).toBe('ready')
  })
  it('retains a ready verified package when a later check goes offline', async () => {
    const s = await setup()
    await s.service.check()
    s.advance(6 * 3600000)
    s.fetcher.mockRejectedValueOnce(new Error('offline'))
    await s.service.check()
    expect(s.service.getState()).toMatchObject({ phase: 'ready', message: 'offline' })
    await expect(s.service.prepareInstall()).resolves.toHaveProperty('manifest.version', '1.2.0')
  })
  it('deletes corrupt downloads and refuses tampered cached archives at install time', async () => {
    const s = await setup()
    await s.service.setAutomatic(false)
    await s.service.check()
    s.fetcher.mockResolvedValueOnce(new Response('corrupted'))
    await s.service.download()
    expect(s.service.getState().phase).toBe('error')
    await expect(access(s.service.archive)).rejects.toThrow()
    await s.service.download()
    await writeFile(s.service.archive, 'changed')
    await expect(s.service.prepareInstall()).rejects.toThrow('校验失败')
  })
  it('cleans installed/expired packages and never puts updater data into the workspace', async () => {
    const s = await setup()
    await s.service.check()
    const upgraded = new UpdateService({ ...s.options, version: '1.2.0' })
    await upgraded.init()
    await expect(access(upgraded.archive)).rejects.toThrow()
    await expect(access(join(s.directory, 'accounts.json'))).rejects.toThrow()
    expect(s.service.cache).toContain('/cache/app-updates-v1/')
  })
  it('disables network in development or when trust is unconfigured', async () => {
    const s = await setup(),
      dev = new UpdateService({ ...s.options, enabled: false })
    await dev.init()
    await dev.check()
    expect(dev.getState().phase).toBe('unavailable')
    expect(s.fetcher).not.toHaveBeenCalled()
  })
})

it('remembers provider cooldown across restarts before the first successful check', async () => {
  const s = await setup()
  s.fetcher.mockResolvedValueOnce(
    new Response('', { status: 429, headers: { 'retry-after': '7200' } }),
  )
  await s.service.check()
  const restored = new UpdateService(s.options)
  await restored.init()
  s.advance(61 * 60000)
  await restored.check()
  expect(s.fetcher).toHaveBeenCalledTimes(1)
  expect(restored.getState().phase).toBe('error')
  restored.dispose()
  s.service.dispose()
})

it('forgets a package when a successful latest-release check withdraws it', async () => {
  const s = await setup()
  await s.service.check()
  s.advance(61000)
  s.fetcher.mockResolvedValueOnce(new Response('', { status: 404 }))
  await s.service.check()
  expect(s.service.getState().phase).toBe('current')
  await expect(access(s.service.archive)).rejects.toThrow()
})

it.skipIf(!process.env.WORKSPACE_TEST_ARCHIVE)(
  'validates the actual packaged Electron ZIP structure',
  async () => {
    await expect(inspectArchive(process.env.WORKSPACE_TEST_ARCHIVE!)).resolves.toBeUndefined()
  },
)
