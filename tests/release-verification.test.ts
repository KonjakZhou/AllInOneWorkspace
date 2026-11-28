import { execFile } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APP_NAME,
  BUNDLE_ID,
  MANIFEST_NAME,
  MAX_METADATA,
  REPOSITORY,
  SIGNATURE_NAME,
  assetUrl,
  sha256,
} from '../electron/updates/protocol'
import { updateFixture } from './update-fixtures'

// Also exercise the .mjs entry point under native Node below, as CI invokes it.
const moduleUrl = new URL('../scripts/verify-release.mjs', import.meta.url).href
const verifier = await import(moduleUrl)
const execute = promisify(execFile)
const alias = 'all-in-one-workspace-arm64.dmg'
const directories: string[] = []
const expected = {
  packageName: 'all-in-one-workspace',
  version: '1.2.0',
  commit: 'a'.repeat(40),
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function directory() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'release-verification-test-')))
  directories.push(path)
  return path
}

function fixture() {
  const signed = updateFixture(expected.version)
  const dmg = Buffer.from('isolated DMG fixture')
  signed.manifest.zip.name = `${expected.packageName}-${expected.version}-arm64.zip`
  signed.manifest.dmg = {
    name: `${expected.packageName}-${expected.version}-arm64.dmg`,
    size: dmg.length,
    sha256: sha256(dmg),
  }
  const encoded = signed.encode()
  const files: Record<string, Buffer> = {
    [signed.manifest.zip.name]: signed.archive,
    [signed.manifest.dmg.name]: dmg,
    [MANIFEST_NAME]: encoded.bytes,
    [SIGNATURE_NAME]: Buffer.from(encoded.signature + '\n'),
    [alias]: dmg,
  }
  return {
    ...signed,
    ...encoded,
    files,
    metadata: {
      tagName: `v${expected.version}`,
      isDraft: true,
      isPrerelease: false,
      assets: Object.entries(files).map(([name, bytes]) => ({ name, size: bytes.length })),
    },
  }
}

async function save(path: string, files: Record<string, Buffer>) {
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(path, name), bytes)
}

function unsignedFiles(f: ReturnType<typeof fixture>): Record<string, Buffer> {
  return {
    [verifier.BUILD_MANIFEST_NAME]: Buffer.from(JSON.stringify(f.manifest)),
    [f.manifest.zip.name]: f.files[f.manifest.zip.name],
    [f.manifest.dmg.name]: f.files[f.manifest.dmg.name],
  }
}

describe('shared release assertions', () => {
  it('verifies the signed version, full HEAD and exact versioned filenames', () => {
    const f = fixture()
    expect(verifier.verifyReleaseManifest(f.bytes, f.signature, f.publicKey, expected)).toEqual(
      f.manifest,
    )
    expect(verifier.releaseAssetNames(expected)).toEqual(Object.keys(f.files))
    for (const changed of [
      { ...expected, version: '1.2.1' },
      { ...expected, commit: 'b'.repeat(40) },
    ])
      expect(() =>
        verifier.verifyReleaseManifest(f.bytes, f.signature, f.publicKey, changed),
      ).toThrow('version/HEAD')
  })

  it('rejects untrusted signatures and altered signed bytes', () => {
    const f = fixture()
    for (const [bytes, signature, key] of [
      [f.bytes, f.signature, fixture().publicKey],
      [Buffer.concat([f.bytes, Buffer.from(' ')]), f.signature, f.publicKey],
      [f.bytes, 'bad signature', f.publicKey],
    ])
      expect(() => verifier.verifyReleaseManifest(bytes, signature, key, expected)).toThrow()
  })

  it.each(['zip', 'dmg', 'alias', 'system'])(
    'rejects a validly signed but unexpected %s field',
    (field) => {
      const f = fixture()
      if (field === 'zip') f.manifest.zip.name = 'other.zip'
      if (field === 'dmg') f.manifest.dmg.name = 'old-version.dmg'
      if (field === 'alias') f.manifest.dmg.name = alias
      if (field === 'system') f.manifest.minimumSystemVersion = '14.0'
      const signed = f.encode()
      expect(() =>
        verifier.verifyReleaseManifest(signed.bytes, signed.signature, f.publicKey, expected),
      ).toThrow()
    },
  )

  it('validates all five files without changing their contents', async () => {
    const path = await directory()
    const f = fixture()
    await save(path, f.files)
    const result = await verifier.verifyReleaseDirectory(path, f.publicKey, expected)
    expect(result.manifest).toEqual(f.manifest)
    expect(Object.keys(result.files)).toEqual(Object.keys(f.files))
    for (const [name, bytes] of Object.entries(f.files)) {
      expect(result.files[name]).toEqual({ size: bytes.length, sha256: sha256(bytes) })
      expect(await readFile(join(path, name))).toEqual(bytes)
    }
  })

  it.each(['zip', 'dmg', 'alias'])(
    'rejects wrong size and same-size corruption of %s',
    async (kind) => {
      const path = await directory()
      const f = fixture()
      await save(path, f.files)
      const name = kind === 'alias' ? alias : f.manifest[kind as 'zip' | 'dmg'].name
      await writeFile(join(path, name), Buffer.alloc(f.files[name].length + 1))
      await expect(verifier.verifyReleaseDirectory(path, f.publicKey, expected)).rejects.toThrow(
        'Size mismatch',
      )
      await writeFile(join(path, name), Buffer.alloc(f.files[name].length))
      await expect(verifier.verifyReleaseDirectory(path, f.publicKey, expected)).rejects.toThrow(
        'SHA-256 mismatch',
      )
    },
  )

  it('rejects a missing alias, symlink asset and oversized manifest', async () => {
    const path = await directory()
    const f = fixture()
    await save(path, f.files)
    await rm(join(path, alias))
    await expect(verifier.verifyReleaseDirectory(path, f.publicKey, expected)).rejects.toThrow()
    await symlink(join(path, f.manifest.dmg.name), join(path, alias))
    await expect(verifier.verifyReleaseDirectory(path, f.publicKey, expected)).rejects.toThrow(
      'regular file',
    )
    await writeFile(join(path, MANIFEST_NAME), Buffer.alloc(MAX_METADATA + 1))
    await expect(verifier.verifyReleaseDirectory(path, f.publicKey, expected)).rejects.toThrow(
      '大小限制',
    )
  })

  it('checks both bundle version fields, identifier and app.asar hash', () => {
    const bundle = {
      bundleId: BUNDLE_ID,
      version: expected.version,
      buildVersion: expected.version,
      asarSha256: 'c'.repeat(64),
    }
    expect(() => verifier.verifyBundlePair(bundle, { ...bundle }, expected.version)).not.toThrow()
    for (const change of [
      { bundleId: 'wrong.bundle' },
      { version: '1.1.0' },
      { buildVersion: '1.1.0' },
      { asarSha256: 'd'.repeat(64) },
      { asarSha256: '' },
    ]) {
      expect(() =>
        verifier.verifyBundlePair(bundle, { ...bundle, ...change }, expected.version),
      ).toThrow()
      expect(() =>
        verifier.verifyBundlePair({ ...bundle, ...change }, bundle, expected.version),
      ).toThrow()
    }
  })

  it('requires the correct release state and one of each required attachment', () => {
    const f = fixture()
    expect(verifier.verifyReleaseMetadata(f.metadata, 'remote-draft', expected)).toEqual(
      f.metadata.assets,
    )
    for (const change of [
      { tagName: 'v1.1.9' },
      { isDraft: false },
      { isPrerelease: true },
      { assets: f.metadata.assets.slice(1) },
      { assets: [...f.metadata.assets, f.metadata.assets[0]] },
      { assets: f.metadata.assets.map((a) => ({ ...a, size: 0 })) },
      {
        assets: f.metadata.assets.map((a) => ({
          ...a,
          size: a.name === SIGNATURE_NAME ? MAX_METADATA + 1 : a.size,
        })),
      },
    ])
      expect(() =>
        verifier.verifyReleaseMetadata({ ...f.metadata, ...change }, 'remote-draft', expected),
      ).toThrow()
    expect(() => verifier.verifyReleaseMetadata(f.metadata, 'remote-public', expected)).toThrow()
    expect(() =>
      verifier.verifyReleaseMetadata({ ...f.metadata, isDraft: false }, 'remote-public', expected),
    ).not.toThrow()
  })

  it.each(['remote-draft', 'remote-public'])('rejects extra debug ZIPs in %s metadata', (mode) => {
    const f = fixture()
    const metadata = { ...f.metadata, isDraft: mode === 'remote-draft' }
    const debug = { name: 'debug.zip', size: 100 }
    for (const assets of [
      [...metadata.assets, debug],
      [...metadata.assets.slice(1), debug],
      [...metadata.assets.slice(1), metadata.assets[1]],
    ])
      expect(() =>
        verifier.verifyReleaseMetadata({ ...metadata, assets }, mode, expected),
      ).toThrow()
    expect(
      verifier.verifyReleaseMetadata(
        {
          ...metadata,
          assets: [...metadata.assets].reverse(),
        },
        mode,
        expected,
      ),
    ).toEqual(metadata.assets)
  })

  it('requires the fixed latest alias to redirect to this version', () => {
    const urls = [verifier.LATEST_ALIAS_URL, assetUrl(expected.version, alias)]
    expect(() => verifier.verifyAliasRedirect(urls, expected.version)).not.toThrow()
    for (const wrong of [urls.slice(0, 1), [urls[0], assetUrl('1.1.9', alias)], urls.slice(1)])
      expect(() => verifier.verifyAliasRedirect(wrong, expected.version)).toThrow('redirect')
  })
})

describe('unsigned build receipt', () => {
  it('validates only the receipt, ZIP and DMG without signed files or a key', async () => {
    const path = await directory()
    const f = fixture()
    await save(path, unsignedFiles(f))
    const result = await verifier.verifyUnsignedDirectory(path, expected)
    expect(result.manifest).toEqual(f.manifest)
    expect(Object.keys(result.files)).toEqual([f.manifest.zip.name, f.manifest.dmg.name])
    expect((await readdir(path)).sort()).toEqual(Object.keys(unsignedFiles(f)).sort())
  })

  it('enforces the manifest schema, package filenames, version and HEAD', () => {
    const f = fixture()
    expect(
      verifier.verifyUnsignedManifest(Buffer.from(JSON.stringify(f.manifest)), expected),
    ).toEqual(f.manifest)
    for (const change of [
      { version: '1.2.1' },
      { commit: 'b'.repeat(40) },
      { commit: 'short' },
      { schemaVersion: 2 },
      { repository: 'other/repo' },
      { bundleId: 'other.app' },
      { arch: 'x64' },
      { platform: 'linux' },
      { minimumSystemVersion: '14.0' },
      { zip: { ...f.manifest.zip, name: 'debug.zip' } },
      { dmg: { ...f.manifest.dmg, name: alias } },
      { dmg: { ...f.manifest.dmg, size: 0 } },
      { zip: { ...f.manifest.zip, sha256: 'invalid' } },
      { extra: true },
    ])
      expect(() =>
        verifier.verifyUnsignedManifest(
          Buffer.from(JSON.stringify({ ...f.manifest, ...change })),
          expected,
        ),
      ).toThrow()
    expect(() => verifier.verifyUnsignedManifest(Buffer.from('{invalid'), expected)).toThrow()
    expect(() => verifier.verifyUnsignedManifest(Buffer.alloc(MAX_METADATA + 1), expected)).toThrow(
      'size limit',
    )
  })

  it.each(['zip', 'dmg'] as const)(
    'rejects %s size/hash corruption before mount commands',
    async (kind) => {
      const path = await directory()
      const f = fixture()
      await save(path, unsignedFiles(f))
      const name = f.manifest[kind].name
      const run = vi.fn()
      for (const [length, error] of [
        [f.files[name].length + 1, 'Size mismatch'],
        [f.files[name].length, 'SHA-256 mismatch'],
      ] as const) {
        await writeFile(join(path, name), Buffer.alloc(length))
        await expect(
          verifier.verifyLocalUnsigned(
            {
              directory: path,
              appPath: join(path, 'missing.app'),
              expected,
            },
            { run },
          ),
        ).rejects.toThrow(error)
      }
      expect(run).not.toHaveBeenCalled()
    },
  )

  it('requires the unsigned receipt and never falls back to signed metadata', async () => {
    const path = await directory()
    const f = fixture()
    await save(path, f.files)
    await expect(verifier.verifyUnsignedDirectory(path, expected)).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await writeFile(join(path, verifier.BUILD_MANIFEST_NAME), Buffer.alloc(MAX_METADATA + 1))
    await expect(verifier.verifyUnsignedDirectory(path, expected)).rejects.toThrow('大小限制')
  })
})

describe('read-only DMG lifecycle', () => {
  it.each(
    ['local', 'local-unsigned'].flatMap((mode) =>
      ['matching', 'different asar', 'different bundle version'].map((scenario) => ({
        mode,
        scenario,
      })),
    ),
  )(
    'verifies $mode files and the $scenario mounted App without launching it',
    async ({ mode, scenario }) => {
      const path = await directory()
      const f = fixture()
      await save(path, mode === 'local' ? f.files : unsignedFiles(f))
      const appPath = join(path, APP_NAME)
      await mkdir(join(appPath, 'Contents/Resources'), { recursive: true })
      await writeFile(join(appPath, 'Contents/Resources/app.asar'), 'App contents')
      let mountpoint = ''
      let detached = false
      const run = async (command: string, args: string[]) => {
        if (command === '/usr/bin/plutil') {
          expect(args.slice(0, 4)).toEqual(['-convert', 'json', '-o', '-'])
          return JSON.stringify({
            CFBundleIdentifier: BUNDLE_ID,
            CFBundleShortVersionString: expected.version,
            CFBundleVersion:
              scenario === 'different bundle version' &&
              args[4].startsWith(mountpoint) &&
              mountpoint
                ? '1.1.0'
                : expected.version,
          })
        }
        expect(command).toBe('/usr/bin/hdiutil')
        if (args[0] === 'attach') {
          mountpoint = args[args.indexOf('-mountpoint') + 1]
          const resources = join(mountpoint, APP_NAME, 'Contents/Resources')
          await mkdir(resources, { recursive: true })
          await writeFile(
            join(resources, 'app.asar'),
            scenario === 'different asar' ? 'Wrong contents' : 'App contents',
          )
        } else detached = true
        return ''
      }
      const verify = mode === 'local' ? verifier.verifyLocal : verifier.verifyLocalUnsigned
      const result = verify(
        {
          directory: path,
          appPath,
          expected,
          ...(mode === 'local' ? { publicKey: f.publicKey } : {}),
          timeoutMs: 1000,
        },
        { run },
      )
      if (scenario === 'matching') expect((await result).manifest).toEqual(f.manifest)
      else await expect(result).rejects.toThrow(/SHA-256 mismatch|bundle identity\/version/)
      expect(detached).toBe(true)
      await expect(readdir(dirname(mountpoint))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('rejects an invalid local signature before running any bundle or mount command', async () => {
    const path = await directory()
    const f = fixture()
    await save(path, f.files)
    const run = vi.fn()
    await expect(
      verifier.verifyLocal(
        {
          directory: path,
          appPath: join(path, 'missing.app'),
          expected,
          publicKey: fixture().publicKey,
        },
        { run },
      ),
    ).rejects.toThrow('签名校验失败')
    expect(run).not.toHaveBeenCalled()
  })

  it.each(['success', 'inspection failure', 'attach failure', 'detach retry'])(
    'detaches in finally after %s',
    async (scenario) => {
      let mountpoint = ''
      const calls: string[][] = []
      const run = async (command: string, args: string[], options: { timeoutMs: number }) => {
        expect(command).toBe('/usr/bin/hdiutil')
        expect(options.timeoutMs).toBeGreaterThan(0)
        expect(options.timeoutMs).toBeLessThanOrEqual(120_000)
        calls.push(args)
        if (args[0] === 'attach') {
          mountpoint = args[args.indexOf('-mountpoint') + 1]
          expect(args).toEqual([
            'attach',
            '-readonly',
            '-nobrowse',
            '-noautoopen',
            '-mountpoint',
            mountpoint,
            '/tmp/test.dmg',
          ])
          if (scenario === 'attach failure') throw new Error('attach failed')
        }
        if (scenario === 'detach retry' && args[0] === 'detach' && !args.includes('-force'))
          throw new Error('busy')
      }
      const inspect = vi.fn(async (path: string) => {
        expect(path).toBe(join(mountpoint, APP_NAME))
        if (scenario === 'inspection failure') throw new Error('inspection failed')
        return 'verified'
      })
      const result = verifier.withMountedDmg('/tmp/test.dmg', inspect, { run })
      if (scenario.endsWith('failure')) await expect(result).rejects.toThrow('failed')
      else await expect(result).resolves.toBe('verified')
      expect(calls.some((args) => args[0] === 'detach')).toBe(true)
      if (scenario === 'attach failure') expect(inspect).not.toHaveBeenCalled()
      if (scenario === 'detach retry')
        expect(calls.at(-1)).toEqual(['detach', '-force', mountpoint])
      await expect(readdir(dirname(mountpoint))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('reports detach failure and preserves the possible mount rather than deleting it', async () => {
    let mountpoint = ''
    const run = async (_command: string, args: string[]) => {
      if (args[0] === 'attach') mountpoint = args[args.indexOf('-mountpoint') + 1]
      else throw new Error('still mounted')
    }
    await expect(
      verifier.withMountedDmg(
        '/tmp/test.dmg',
        async () => {
          throw new Error('bad bundle')
        },
        { run },
      ),
    ).rejects.toThrow('bad bundle; Could not detach DMG; retained')
    expect(await readdir(dirname(mountpoint))).toEqual(['volume'])
    directories.push(dirname(mountpoint)) // fake mount only; safe for the test to remove
  })
})

describe('remote release orchestration', () => {
  function remoteFixture() {
    const f = fixture()
    const seenDirectories: string[] = []
    const run = vi.fn(async (command: string, args: string[], options: { timeoutMs: number }) => {
      expect(command).toBe('gh')
      expect(options.timeoutMs).toBe(1000)
      if (args[0] === 'api') return JSON.stringify({ sha: expected.commit })
      if (args[1] === 'view') return JSON.stringify(f.metadata)
      expect(args.slice(0, 5)).toEqual([
        'release',
        'download',
        `v${expected.version}`,
        '--repo',
        REPOSITORY,
      ])
      const path = args[args.indexOf('--dir') + 1]
      seenDirectories.push(path)
      expect(await readdir(path)).toEqual([])
      expect(args.slice(args.indexOf('--dir') + 2)).toEqual(
        Object.keys(f.files).flatMap((name) => ['--pattern', name]),
      )
      await save(path, f.files)
      return ''
    })
    const request = vi.fn(
      async (
        url: string,
        options: {
          timeoutMs: number
          destination?: string
          maxBytes: number
        },
      ) => {
        expect(options.timeoutMs).toBe(1000)
        if (url.includes('/commits/'))
          return { bytes: Buffer.from(JSON.stringify({ sha: expected.commit })) }
        if (url.startsWith('https://api.github.com/')) {
          return {
            bytes: Buffer.from(
              JSON.stringify({
                tag_name: f.metadata.tagName,
                draft: f.metadata.isDraft,
                prerelease: f.metadata.isPrerelease,
                assets: f.metadata.assets,
              }),
            ),
          }
        }
        const name = url.split('/').at(-1)!
        const bytes = f.files[name]
        expect(options.maxBytes).toBe(bytes.length)
        const path = options.destination!
        if (!seenDirectories.includes(dirname(path))) seenDirectories.push(dirname(path))
        await writeFile(path, bytes)
        return {
          urls:
            url === verifier.LATEST_ALIAS_URL ? [url, assetUrl(expected.version, alias)] : [url],
        }
      },
    )
    const settings = { expected, publicKey: f.publicKey, timeoutMs: 1000 }
    return { f, run, request, seenDirectories, settings }
  }

  it('downloads exactly five draft assets with gh into new temporary directories', async () => {
    const r = remoteFixture()
    for (let i = 0; i < 2; i++)
      expect(
        (await verifier.verifyRemote({ ...r.settings, mode: 'remote-draft' }, r)).manifest,
      ).toEqual(r.f.manifest)
    expect(r.request).not.toHaveBeenCalled()
    expect(new Set(r.seenDirectories).size).toBe(2)
    for (const path of r.seenDirectories)
      await expect(readdir(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans downloaded files after draft integrity verification fails', async () => {
    const r = remoteFixture()
    r.f.files[alias] = Buffer.alloc(r.f.files[alias].length)
    await expect(verifier.verifyRemote({ ...r.settings, mode: 'remote-draft' }, r)).rejects.toThrow(
      'SHA-256 mismatch',
    )
    await expect(readdir(r.seenDirectories[0])).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans the isolated directory even when gh download fails part way through', async () => {
    const r = remoteFixture()
    const original = r.run.getMockImplementation()!
    r.run.mockImplementation(async (command, args, options) => {
      const result = await original(command, args, options)
      if (args[1] === 'download') throw new Error('download interrupted')
      return result
    })
    await expect(verifier.verifyRemote({ ...r.settings, mode: 'remote-draft' }, r)).rejects.toThrow(
      'download interrupted',
    )
    await expect(readdir(r.seenDirectories[0])).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a tag pointing elsewhere before download', async () => {
    const r = remoteFixture()
    r.run.mockImplementation(async (_command, args) =>
      JSON.stringify(args[0] === 'api' ? { sha: 'b'.repeat(40) } : r.f.metadata),
    )
    await expect(verifier.verifyRemote({ ...r.settings, mode: 'remote-draft' }, r)).rejects.toThrow(
      'Remote tag',
    )
    expect(r.seenDirectories).toEqual([])
  })

  it('compares downloaded sizes against GitHub metadata as well as the signed manifest', async () => {
    const r = remoteFixture()
    r.f.metadata.assets.find((a) => a.name === SIGNATURE_NAME)!.size++
    await expect(verifier.verifyRemote({ ...r.settings, mode: 'remote-draft' }, r)).rejects.toThrow(
      'differs from GitHub metadata',
    )
  })

  it('verifies published assets, latest twice and the public alias without invoking gh', async () => {
    const r = remoteFixture()
    r.f.metadata.isDraft = false
    const result = await verifier.verifyRemote({ ...r.settings, mode: 'remote-public' }, r)
    expect(result.manifest).toEqual(r.f.manifest)
    expect(result.latestVerified).toBe(true)
    expect(r.run).not.toHaveBeenCalled()
    expect(r.request.mock.calls.filter(([url]) => url.endsWith('/releases/latest'))).toHaveLength(2)
    expect(r.request.mock.calls.filter(([, options]) => options.destination)).toHaveLength(6)
    await expect(readdir(r.seenDirectories[0])).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['stale latest', 'stale alias redirect', 'corrupt latest alias', 'latest changed'])(
    'rejects %s after publication',
    async (scenario) => {
      const r = remoteFixture()
      r.f.metadata.isDraft = false
      const original = r.request.getMockImplementation()!
      let latestReads = 0
      r.request.mockImplementation(async (url, options) => {
        const response = await original(url, options)
        if (url.endsWith('/releases/latest')) {
          latestReads++
          if (scenario === 'stale latest' || (scenario === 'latest changed' && latestReads === 2)) {
            const metadata = JSON.parse(response.bytes!.toString())
            metadata.tag_name = 'v1.1.9'
            return { bytes: Buffer.from(JSON.stringify(metadata)) }
          }
        }
        if (url === verifier.LATEST_ALIAS_URL) {
          if (scenario === 'stale alias redirect') return { urls: [url, assetUrl('1.1.9', alias)] }
          if (scenario === 'corrupt latest alias')
            await writeFile(options.destination!, Buffer.alloc(r.f.files[alias].length))
        }
        return response
      })
      await expect(
        verifier.verifyRemote({ ...r.settings, mode: 'remote-public' }, r),
      ).rejects.toThrow()
      for (const path of r.seenDirectories)
        await expect(readdir(path)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )
})

describe('bounded unauthenticated public requests', () => {
  const url = assetUrl(expected.version, alias)

  it('streams to a new file, follows allowlisted redirects and omits authentication', async () => {
    const path = join(await directory(), 'download.dmg')
    const cdn = 'https://release-assets.githubusercontent.com/test?opaque=cdn'
    const fetchImpl = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.credentials).toBe('omit')
      expect(options.redirect).toBe('manual')
      expect(new Headers(options.headers).has('authorization')).toBe(false)
      expect(new Headers(options.headers).has('cookie')).toBe(false)
      expect(options.signal).toBeInstanceOf(AbortSignal)
      return _url === url
        ? new Response(null, { status: 302, headers: { location: cdn } })
        : new Response('DMG bytes')
    })
    const result = await verifier.fetchPublic(url, {
      destination: path,
      fetchImpl,
      timeoutMs: 1000,
    })
    expect(result.urls).toEqual([url, cdn])
    expect(result.bytes).toBeUndefined()
    expect(await readFile(path, 'utf8')).toBe('DMG bytes')
  })

  it('aborts the request if a destination cannot be created and never overwrites it', async () => {
    const path = join(await directory(), 'existing.dmg')
    await writeFile(path, 'keep')
    let signal: AbortSignal | undefined
    const fetchImpl = async (_url: string, options: RequestInit) => {
      signal = options.signal!
      return new Response('replacement')
    }
    await expect(verifier.fetchPublic(url, { destination: path, fetchImpl })).rejects.toThrow(
      'Public download failed',
    )
    expect(signal?.aborted).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('keep')
  })

  it.each([
    'http://github.com/test',
    'https://evil.test/file',
    'https://user:secret@github.com/file',
  ])('rejects an unsafe redirect to %s', async (location) => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location } }))
    await expect(verifier.fetchPublic(url, { fetchImpl })).rejects.toThrow('non-public')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('limits redirects, HTTP errors and both declared and streamed body sizes', async () => {
    const cases = [
      {
        response: () => new Response(null, { status: 302, headers: { location: url } }),
        error: 'redirects',
      },
      { response: () => new Response('not found', { status: 404 }), error: 'HTTP 404' },
      {
        response: () => new Response('abc', { headers: { 'content-length': '3' } }),
        error: 'size limit',
      },
      { response: () => new Response('abc'), error: 'size limit' },
    ]
    for (const item of cases)
      await expect(
        verifier.fetchPublic(url, { fetchImpl: item.response, maxBytes: 2, timeoutMs: 1000 }),
      ).rejects.toThrow(item.error)
  })

  it.each(['headers', 'body'])('times out while waiting for response %s', async (stage) => {
    const fetchImpl = async (_url: string, { signal }: { signal: AbortSignal }) => {
      if (stage === 'headers')
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1]))
            signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
          },
        }),
      )
    }
    await expect(verifier.fetchPublic(url, { fetchImpl, timeoutMs: 20 })).rejects.toThrow(
      'timed out',
    )
  })

  it('does not expose remote error messages or signed CDN query strings', async () => {
    await expect(
      verifier.fetchPublic(url, {
        fetchImpl: async () => {
          throw new Error('https://cdn.example/?token=secret')
        },
      }),
    ).rejects.toThrow(/^Public download failed$/)
  })
})

describe('CLI contract', () => {
  it('parses all modes and validates bounded timeout and mode-specific flags', () => {
    for (const mode of ['local', 'local-unsigned', 'assets', 'remote-draft', 'remote-public'])
      expect(
        verifier.parseArguments([mode, '--commit', expected.commit, '--version', expected.version]),
      ).toEqual({ mode, commit: expected.commit, version: expected.version })
    expect(verifier.parseArguments(['local', '--timeout-ms', '1000'])).toEqual({
      mode: 'local',
      timeoutMs: 1000,
    })
    for (const mode of ['local', 'local-unsigned', 'assets'])
      expect(verifier.parseArguments([mode, '--release-dir', 'downloaded'])).toEqual({
        mode,
        directory: 'downloaded',
      })
    expect(verifier.parseArguments(['local-unsigned', '--app', 'test.app'])).toEqual({
      mode: 'local-unsigned',
      appPath: 'test.app',
    })
    for (const args of [
      [],
      ['other'],
      ['local', '--wat', 'x'],
      ['local', '--commit'],
      ['local', '--version', '1.2.0', '--version', '1.2.1'],
      ['remote-public', '--app', 'test.app'],
      ['assets', '--app', 'test.app'],
      ['remote-draft', '--release-dir', 'release'],
      ...['0', '-1', 'NaN', 'Infinity', '900001', '1.5'].map((n) => ['local', '--timeout-ms', n]),
    ])
      expect(() => verifier.parseArguments(args)).toThrow()
  })

  it('runs natively under Node and prints help without App or account access', async () => {
    const script = new URL('../scripts/verify-release.mjs', import.meta.url).pathname
    const result = await execute(process.execPath, [script, '--help'], { timeout: 10_000 })
    expect(result.stdout).toContain('local|local-unsigned|assets|remote-draft|remote-public')
    expect(result.stdout).toContain('no private key or App launch')
    await expect(
      execute(process.execPath, [script, 'invalid'], { timeout: 10_000 }),
    ).rejects.toMatchObject({ code: 1 })
  })

  it('runs assets with default package/HEAD and local-unsigned without any key in an isolated checkout', async () => {
    const root = await directory()
    const scripts = join(root, 'scripts')
    const build = join(root, 'build')
    const assets = join(root, 'release')
    for (const path of [scripts, build, assets]) await mkdir(path)
    const source = new URL('../scripts/verify-release.mjs', import.meta.url).pathname
    const script = join(scripts, 'verify-release.mjs')
    await copyFile(source, script)
    await symlink(new URL('../electron', import.meta.url).pathname, join(root, 'electron'))
    await symlink(
      new URL('../scripts/release-assets.mjs', import.meta.url).pathname,
      join(scripts, 'release-assets.mjs'),
    )
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        type: 'module',
        name: expected.packageName,
        version: expected.version,
      }),
    )
    await execute('git', ['init', '-q', root])
    await execute('git', [
      '-C',
      root,
      '-c',
      'user.name=Release Test',
      '-c',
      'user.email=release-test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'fixture',
    ])
    const head = (await execute('git', ['-C', root, 'rev-parse', 'HEAD'])).stdout.trim()
    const f = fixture()
    f.manifest.commit = head
    const signed = f.encode()
    f.files[MANIFEST_NAME] = signed.bytes
    f.files[SIGNATURE_NAME] = Buffer.from(signed.signature + '\n')
    await save(assets, f.files)
    await writeFile(
      join(build, 'update-public-key.json'),
      JSON.stringify({
        algorithm: 'ed25519',
        publicKey: f.publicKey,
      }),
    )
    // No App bundle exists: assets must not call plutil, hdiutil or require build-manifest.json.
    const result = await execute(process.execPath, [script, 'assets'], { timeout: 10_000 })
    const report = JSON.parse(result.stdout)
    expect(report.mode).toBe('assets')
    expect(report.manifest.version).toBe(expected.version)
    expect(report.manifest.commit).toBe(head)
    expect(Object.keys(report.files)).toEqual(Object.keys(f.files))
    expect(report.bundle).toBeUndefined()
    await expect(
      execute(process.execPath, [script, 'assets', '--commit', 'b'.repeat(40)], {
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('version/HEAD') })
    await writeFile(join(assets, alias), Buffer.alloc(f.files[alias].length))
    await expect(
      execute(process.execPath, [script, 'assets'], { timeout: 10_000 }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('SHA-256 mismatch') })

    for (const name of [MANIFEST_NAME, SIGNATURE_NAME, alias]) await rm(join(assets, name))
    await rm(build, { recursive: true })
    await save(assets, unsignedFiles(f))
    await writeFile(join(assets, f.manifest.zip.name), Buffer.alloc(f.archive.length))
    // Reach unsigned asset verification with no public key, signature or alias on disk.
    // The intentional checksum failure stops before invoking macOS mount commands.
    await expect(
      execute(process.execPath, [script, 'local-unsigned'], { timeout: 10_000 }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('SHA-256 mismatch') })
  })

  it('terminates a hung subprocess with a bounded deadline', async () => {
    await expect(
      verifier.runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        timeoutMs: 30,
      }),
    ).rejects.toThrow('failed')
  })
})
