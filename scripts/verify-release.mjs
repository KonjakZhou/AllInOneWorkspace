import { execFile } from 'node:child_process'
import { lstat, mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { hashFile, readLimited } from '../electron/updates/files.ts'
import {
  APP_NAME,
  BUNDLE_ID,
  MANIFEST_NAME,
  MAX_DOWNLOAD,
  MAX_METADATA,
  REPOSITORY,
  SIGNATURE_NAME,
  STABLE,
  assetUrl,
  manifestSchema,
  verifyManifest,
} from '../electron/updates/protocol.ts'
import { INSTALLER_ALIAS_NAME } from './release-assets.mjs'

const execute = promisify(execFile)
const ROOT = resolve(import.meta.dirname, '..')
export const DEFAULT_TIMEOUT_MS = 300_000
const MAX_TIMEOUT_MS = 900_000
const MODES = ['local', 'local-unsigned', 'assets', 'remote-draft', 'remote-public']
export const BUILD_MANIFEST_NAME = 'build-manifest.json'
export const LATEST_ALIAS_URL = `https://github.com/${REPOSITORY}/releases/latest/download/${INSTALLER_ALIAS_NAME}`

function timeout(value = DEFAULT_TIMEOUT_MS) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS)
    throw new Error(`timeout-ms must be an integer between 1 and ${MAX_TIMEOUT_MS}`)
  return value
}

// Importing this module performs no I/O. These assertions are shared by all modes.
export function releaseAssetNames(expected) {
  if (
    !STABLE.test(expected.version) ||
    !/^[a-f0-9]{40}$/.test(expected.commit) ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(expected.packageName)
  )
    throw new Error('Expected a stable version, full HEAD SHA and safe package name')
  return [
    `${expected.packageName}-${expected.version}-arm64.zip`,
    `${expected.packageName}-${expected.version}-arm64.dmg`,
    MANIFEST_NAME,
    SIGNATURE_NAME,
    INSTALLER_ALIAS_NAME,
  ]
}

function verifyExpectedManifest(manifest, expected, label) {
  const [zip, dmg] = releaseAssetNames(expected)
  if (manifest.version !== expected.version || manifest.commit !== expected.commit)
    throw new Error(`${label} does not match expected version/HEAD`)
  if (manifest.zip.name !== zip || manifest.dmg.name !== dmg)
    throw new Error(`${label} must name the expected versioned ZIP and DMG`)
  if (manifest.minimumSystemVersion !== '13.0')
    throw new Error(`${label} does not match the macOS 13.0 release policy`)
  return manifest
}

export function verifyReleaseManifest(bytes, signature, publicKey, expected) {
  return verifyExpectedManifest(
    verifyManifest(bytes, signature, publicKey),
    expected,
    'Signed manifest',
  )
}

export function verifyUnsignedManifest(bytes, expected) {
  if (bytes.length > MAX_METADATA) throw new Error('Unsigned manifest exceeds size limit')
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')))
  return verifyExpectedManifest(manifest, expected, 'Unsigned manifest')
}

export function verifyAssetDigest(actual, expected, name) {
  if (actual.size !== expected.size) throw new Error(`Size mismatch: ${name}`)
  if (actual.sha256 !== expected.sha256) throw new Error(`SHA-256 mismatch: ${name}`)
}

export function verifyBundlePair(app, mounted, version) {
  for (const [label, bundle] of [
    ['App', app],
    ['DMG App', mounted],
  ]) {
    if (
      bundle.bundleId !== BUNDLE_ID ||
      bundle.version !== version ||
      bundle.buildVersion !== version
    )
      throw new Error(`${label} bundle identity/version does not match ${version}`)
    if (!/^[a-f0-9]{64}$/.test(bundle.asarSha256))
      throw new Error(`${label} app.asar digest is missing or invalid`)
  }
  if (app.asarSha256 !== mounted.asarSha256)
    throw new Error('App and DMG app.asar SHA-256 mismatch')
}

// Normalized metadata from gh release view or the unauthenticated GitHub REST API.
export function verifyReleaseMetadata(release, mode, expected) {
  if (!['remote-draft', 'remote-public'].includes(mode))
    throw new Error('Expected a remote verification mode')
  if (
    release.tagName !== `v${expected.version}` ||
    release.isDraft !== (mode === 'remote-draft') ||
    release.isPrerelease !== false
  )
    throw new Error('Release tag, draft or prerelease state does not match verification mode')
  if (!Array.isArray(release.assets)) throw new Error('Release assets are missing')
  const allowed = releaseAssetNames(expected)
  if (
    release.assets.length !== allowed.length ||
    release.assets.some((asset) => !allowed.includes(asset?.name))
  )
    throw new Error('Release must contain exactly the five allowed assets')
  return allowed.map((name) => {
    const matches = release.assets.filter((asset) => asset.name === name)
    const limit = [MANIFEST_NAME, SIGNATURE_NAME].includes(name) ? MAX_METADATA : MAX_DOWNLOAD
    if (
      matches.length !== 1 ||
      !Number.isSafeInteger(matches[0].size) ||
      matches[0].size < 1 ||
      matches[0].size > limit
    )
      throw new Error(`Missing, duplicate or invalid release asset: ${name}`)
    return matches[0]
  })
}

export function verifyAliasRedirect(urls, version) {
  if (urls[0] !== LATEST_ALIAS_URL || urls[1] !== assetUrl(version, INSTALLER_ALIAS_NAME))
    throw new Error('Public latest alias did not redirect to the expected release')
}

export async function runCommand(command, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const result = await execute(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: timeout(timeoutMs),
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    })
    return result.stdout.trim()
  } catch (error) {
    // Do not echo subprocess output, environment variables or credential-bearing URLs.
    throw new Error(`${command} ${args[0] ?? ''} failed (${error.code ?? 'timeout/signal'})`)
  }
}

async function fingerprint(path) {
  const info = await lstat(path)
  if (!info.isFile()) throw new Error(`Expected a regular file: ${path}`)
  return { size: info.size, sha256: await hashFile(path) }
}

export async function verifyReleaseDirectory(directory, publicKey, expected) {
  const names = releaseAssetNames(expected)
  const bytes = await readLimited(join(directory, MANIFEST_NAME), MAX_METADATA)
  const signature = await readLimited(join(directory, SIGNATURE_NAME), MAX_METADATA)
  const manifest = verifyReleaseManifest(bytes, signature.toString('utf8'), publicKey, expected)
  const files = {}
  for (const name of names) files[name] = await fingerprint(join(directory, name))
  for (const asset of [manifest.zip, manifest.dmg])
    verifyAssetDigest(files[asset.name], asset, asset.name)
  verifyAssetDigest(files[INSTALLER_ALIAS_NAME], manifest.dmg, INSTALLER_ALIAS_NAME)
  return { manifest, files }
}

export async function verifyUnsignedDirectory(directory, expected) {
  const bytes = await readLimited(join(directory, BUILD_MANIFEST_NAME), MAX_METADATA)
  const manifest = verifyUnsignedManifest(bytes, expected)
  const files = {}
  for (const asset of [manifest.zip, manifest.dmg]) {
    files[asset.name] = await fingerprint(join(directory, asset.name))
    verifyAssetDigest(files[asset.name], asset, asset.name)
  }
  return { manifest, files }
}

export async function readBundle(path, run = runCommand, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const plist = JSON.parse(
    await run(
      '/usr/bin/plutil',
      ['-convert', 'json', '-o', '-', join(path, 'Contents/Info.plist')],
      {
        timeoutMs,
      },
    ),
  )
  const asar = await fingerprint(join(path, 'Contents/Resources/app.asar'))
  return {
    bundleId: plist.CFBundleIdentifier,
    version: plist.CFBundleShortVersionString,
    buildVersion: plist.CFBundleVersion,
    asarSha256: asar.sha256,
  }
}

export async function withMountedDmg(dmg, inspect, { run = runCommand, timeoutMs } = {}) {
  const options = { timeoutMs: Math.min(timeout(timeoutMs), 120_000) }
  const directory = await mkdtemp(join(tmpdir(), 'aio-release-mount-'))
  const mountpoint = join(directory, 'volume')
  await mkdir(mountpoint)
  let failure
  try {
    await run(
      '/usr/bin/hdiutil',
      ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountpoint, resolve(dmg)],
      options,
    )
    return await inspect(join(mountpoint, APP_NAME))
  } catch (error) {
    failure = error
    throw error
  } finally {
    // Attempt detach even when attach failed: it may have mounted before timing out.
    try {
      await run('/usr/bin/hdiutil', ['detach', mountpoint], options)
    } catch {
      try {
        await run('/usr/bin/hdiutil', ['detach', '-force', mountpoint], options)
      } catch {
        // Never recursively remove a directory that might still contain a mounted volume.
        throw new Error(
          `${failure ? `${failure.message}; ` : ''}Could not detach DMG; retained ${directory}`,
        )
      }
    }
    await rm(directory, { recursive: true, force: true })
  }
}

async function verifyBuiltBundle(verified, { directory, appPath, expected, timeoutMs }, run) {
  const app = await readBundle(appPath, run, timeoutMs)
  await withMountedDmg(
    join(directory, verified.manifest.dmg.name),
    async (path) => verifyBundlePair(app, await readBundle(path, run, timeoutMs), expected.version),
    { run, timeoutMs },
  )
  return { ...verified, bundle: app }
}

export async function verifyLocal(settings, { run = runCommand } = {}) {
  const verified = await verifyReleaseDirectory(
    settings.directory,
    settings.publicKey,
    settings.expected,
  )
  return { mode: 'local', ...(await verifyBuiltBundle(verified, settings, run)) }
}

export async function verifyLocalUnsigned(settings, { run = runCommand } = {}) {
  const verified = await verifyUnsignedDirectory(settings.directory, settings.expected)
  return { mode: 'local-unsigned', ...(await verifyBuiltBundle(verified, settings, run)) }
}

function publicUrl(input) {
  const url = new URL(input)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    ![
      'github.com',
      'api.github.com',
      'release-assets.githubusercontent.com',
      'objects.githubusercontent.com',
    ].includes(url.hostname)
  )
    throw new Error('Refused a non-public GitHub download URL')
  return url.href
}

// One deadline covers redirects AND the response body. Streaming avoids buffering installers.
// Native fetch does not consult gh auth, GH_TOKEN, netrc or browser cookies.
export async function fetchPublic(
  url,
  {
    destination,
    maxBytes = MAX_METADATA,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = {},
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout(timeoutMs))
  const urls = []
  let file
  try {
    let current = publicUrl(url)
    for (let redirects = 0; redirects <= 5; redirects++) {
      urls.push(current)
      const response = await fetchImpl(current, {
        redirect: 'manual',
        credentials: 'omit',
        headers: { Accept: '*/*', 'User-Agent': 'AllInOneWorkspace-release-verification' },
        signal: controller.signal,
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get('location')
        if (!location) throw new Error('Redirect has no location')
        current = publicUrl(new URL(location, current).href)
        continue
      }
      if (response.status !== 200 || !response.body) {
        await response.body?.cancel()
        throw new Error(`Public download returned HTTP ${response.status}`)
      }
      if (Number(response.headers.get('content-length')) > maxBytes) {
        await response.body.cancel()
        throw new Error('Public download exceeds size limit')
      }
      if (destination) file = await open(destination, 'wx', 0o600)
      const chunks = []
      let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > maxBytes) throw new Error('Public download exceeds size limit')
        if (file) await file.writeFile(chunk)
        else chunks.push(Buffer.from(chunk))
      }
      return { urls, size, bytes: destination ? undefined : Buffer.concat(chunks) }
    }
    throw new Error('Too many public download redirects')
  } catch (error) {
    // Keep CDN query strings and other remote error text out of CI logs.
    if (controller.signal.aborted) throw new Error('Public download timed out')
    if (/^(Public download|Redirect has|Too many public|Refused a non-public)/.test(error.message))
      throw error
    throw new Error('Public download failed')
  } finally {
    clearTimeout(timer)
    controller.abort()
    await file?.close()
  }
}

function normalizePublicRelease(release) {
  return {
    tagName: release.tag_name,
    isDraft: release.draft,
    isPrerelease: release.prerelease,
    assets: release.assets,
  }
}

export async function verifyRemote(
  { mode, expected, publicKey, timeoutMs = DEFAULT_TIMEOUT_MS },
  { run = runCommand, request = fetchPublic } = {},
) {
  if (!['remote-draft', 'remote-public'].includes(mode)) throw new Error('Expected a remote mode')
  timeout(timeoutMs)
  const names = releaseAssetNames(expected)
  const tag = `v${expected.version}`
  // A new, private directory on every run prevents local release/ files masking failed downloads.
  const directory = await mkdtemp(join(tmpdir(), 'aio-release-download-'))
  try {
    const api = async (path) => {
      const result = await request(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
        timeoutMs,
        maxBytes: 1024 * 1024,
      })
      return JSON.parse(result.bytes.toString('utf8'))
    }
    let metadata
    let assets
    if (mode === 'remote-draft') {
      metadata = JSON.parse(
        await run(
          'gh',
          [
            'release',
            'view',
            tag,
            '--repo',
            REPOSITORY,
            '--json',
            'tagName,isDraft,isPrerelease,assets',
          ],
          { timeoutMs },
        ),
      )
      assets = verifyReleaseMetadata(metadata, mode, expected)
      const commit = JSON.parse(
        await run('gh', ['api', `repos/${REPOSITORY}/commits/${tag}`], { timeoutMs }),
      )
      if (commit.sha !== expected.commit) throw new Error('Remote tag does not match expected HEAD')
      await run(
        'gh',
        [
          'release',
          'download',
          tag,
          '--repo',
          REPOSITORY,
          '--dir',
          directory,
          ...names.flatMap((name) => ['--pattern', name]),
        ],
        { timeoutMs },
      )
    } else {
      metadata = normalizePublicRelease(await api(`releases/tags/${tag}`))
      assets = verifyReleaseMetadata(metadata, mode, expected)
      if ((await api(`commits/${tag}`)).sha !== expected.commit)
        throw new Error('Remote tag does not match expected HEAD')
      verifyReleaseMetadata(normalizePublicRelease(await api('releases/latest')), mode, expected)
      for (const asset of assets)
        await request(assetUrl(expected.version, asset.name), {
          destination: join(directory, asset.name),
          maxBytes: asset.size,
          timeoutMs,
        })
    }
    const verified = await verifyReleaseDirectory(directory, publicKey, expected)
    for (const asset of assets)
      if (verified.files[asset.name].size !== asset.size)
        throw new Error(`Downloaded asset differs from GitHub metadata: ${asset.name}`)
    if (mode === 'remote-public') {
      const latestAlias = join(directory, 'latest-alias.dmg')
      const result = await request(LATEST_ALIAS_URL, {
        destination: latestAlias,
        maxBytes: verified.manifest.dmg.size,
        timeoutMs,
      })
      verifyAliasRedirect(result.urls, expected.version)
      verifyAssetDigest(
        await fingerprint(latestAlias),
        verified.manifest.dmg,
        'public latest installer alias',
      )
      // Detect latest moving during a long installer download.
      verifyReleaseMetadata(normalizePublicRelease(await api('releases/latest')), mode, expected)
    }
    return { mode, ...verified, latestVerified: mode === 'remote-public' }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export function parseArguments(args) {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return { help: true }
  const [mode, ...rest] = args
  if (!MODES.includes(mode)) throw new Error(`Expected mode: ${MODES.join(' | ')}`)
  const options = { mode }
  const keys = {
    '--version': 'version',
    '--commit': 'commit',
    '--release-dir': 'directory',
    '--app': 'appPath',
    '--timeout-ms': 'timeoutMs',
  }
  for (let i = 0; i < rest.length; i += 2) {
    const key = keys[rest[i]]
    const value = rest[i + 1]
    if (!key || !value || value.startsWith('--') || Object.hasOwn(options, key))
      throw new Error(`Unknown, missing or duplicate option: ${rest[i]}`)
    if (key === 'directory' && !['local', 'local-unsigned', 'assets'].includes(mode))
      throw new Error(`${rest[i]} is only supported in local, local-unsigned or assets mode`)
    if (key === 'appPath' && !['local', 'local-unsigned'].includes(mode))
      throw new Error(`${rest[i]} is only supported in local or local-unsigned mode`)
    options[key] = key === 'timeoutMs' ? timeout(Number(value)) : value
  }
  return options
}

async function main(args) {
  const options = parseArguments(args)
  if (options.help) {
    console.log(`Usage: node scripts/verify-release.mjs <${MODES.join('|')}> [options]
  --version X.Y.Z       Expected version (default: repository package.json)
  --commit SHA          Expected full commit SHA (default: repository HEAD)
  --timeout-ms N        Per command/request deadline, including body (default: ${DEFAULT_TIMEOUT_MS}; max: ${MAX_TIMEOUT_MS})
  --release-dir PATH    Assets directory for local/local-unsigned/assets (default: repository release/)
  --app PATH            App for local/local-unsigned (default: release-dir/mac-arm64/${APP_NAME})

local: after signing, verify signed assets and read-only mounted DMG against App.
local-unsigned: verify build-manifest.json, ZIP/DMG and mounted DMG against App; no key, signature or alias.
assets: verify signed five-asset directory only; no App or mounting required.
remote-draft: verify draft metadata/tag and all five assets downloaded with gh.
remote-public: verify published assets, latest and fixed alias using unauthenticated HTTPS.
Signed modes trust only build/update-public-key.json; no private key or App launch is needed.
Success prints a JSON report; any failure exits nonzero. Remote temporary files are removed.`)
    return
  }
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const expected = {
    packageName: pkg.name,
    version: options.version ?? pkg.version,
    commit:
      options.commit ??
      (await runCommand('git', ['rev-parse', 'HEAD'], { timeoutMs: options.timeoutMs })),
  }
  releaseAssetNames(expected)
  let publicKey
  if (options.mode !== 'local-unsigned') {
    const trust = JSON.parse(await readFile(join(ROOT, 'build/update-public-key.json'), 'utf8'))
    if (trust.algorithm !== 'ed25519') throw new Error('Expected the repository Ed25519 public key')
    publicKey = trust.publicKey
  }
  const directory = resolve(options.directory ?? join(ROOT, 'release'))
  const settings = {
    ...options,
    expected,
    publicKey,
    directory,
    appPath: resolve(options.appPath ?? join(directory, 'mac-arm64', APP_NAME)),
  }
  let result
  if (options.mode === 'local') result = await verifyLocal(settings)
  else if (options.mode === 'local-unsigned') result = await verifyLocalUnsigned(settings)
  else if (options.mode === 'assets')
    result = { mode: 'assets', ...(await verifyReleaseDirectory(directory, publicKey, expected)) }
  else result = await verifyRemote(settings)
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Release verification failed: ${error.message}`)
    process.exitCode = 1
  })
