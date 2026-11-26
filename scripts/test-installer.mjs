// Exercises the real Swift installer with local signed fixtures. No production app,
// user data, signing private key, or public Release is read or modified.
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, chmod } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { hashFile } from '../electron/updates/files.ts'
const root = await mkdtemp('/private/tmp/aio-updater-test-')
const children = []
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  assert.equal(result.status, 0, command)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, milliseconds = 30000) {
  const deadline = Date.now() + milliseconds
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(100)
  }
  throw new Error('installer test timed out')
}
try {
  const keys = generateKeyPairSync('ed25519')
  const publicKey = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString(
    'base64',
  )
  const source =
    `let trustedUpdateKey = ${JSON.stringify(publicKey)}\n` +
    (await readFile('native/UpdateInstaller.swift', 'utf8'))
  await writeFile(join(root, 'Installer.swift'), source)
  run('xcrun', [
    'swiftc',
    '-D',
    'UPDATE_TESTING',
    '-module-cache-path',
    join(root, 'modules'),
    join(root, 'Installer.swift'),
    '-o',
    join(root, 'installer'),
  ])
  await writeFile(
    join(root, 'Fixture.swift'),
    `import Foundation
import AppKit
let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
application.finishLaunching()
let args = CommandLine.arguments
if let index = args.firstIndex(of: "--aio-update-job"), let token = args.firstIndex(of: "--aio-update-nonce") {
  let job = args[index + 1], nonce = args[token + 1]
  if FileManager.default.fileExists(atPath: Bundle.main.bundlePath + "/Contents/no-health") { exit(1) }
  try nonce.write(toFile: job + "/health", atomically: true, encoding: .utf8)
  let end = Date().addingTimeInterval(20)
  while Date() < end {
    if (try? String(contentsOfFile: job + "/continue", encoding: .utf8)) == nonce { try "confirmed".write(toFile: job + "/opened-data", atomically: true, encoding: .utf8); exit(0) }
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
  }
  exit(2)
}
RunLoop.current.run(until: Date().addingTimeInterval(1))
`,
  )
  run('xcrun', [
    'swiftc',
    '-module-cache-path',
    join(root, 'modules'),
    join(root, 'Fixture.swift'),
    '-o',
    join(root, 'fixture'),
  ])
  async function app(path, version, noHealth = false) {
    await mkdir(join(path, 'Contents/MacOS'), { recursive: true })
    run('/bin/cp', [join(root, 'fixture'), join(path, 'Contents/MacOS/Fixture')])
    await writeFile(
      join(path, 'Contents/Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.allinone.workspace</string><key>CFBundleName</key><string>Update Test</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>${version}</string><key>CFBundleShortVersionString</key><string>${version}</string><key>LSUIElement</key><true/></dict></plist>`,
    )
    if (noHealth) await writeFile(join(path, 'Contents/no-health'), '')
  }
  for (const mode of [
    'success',
    'rollback',
    'cancel',
    'bad-signature',
    'read-only',
    'wrong-arch',
  ]) {
    const base = join(root, mode),
      target = join(base, 'All In One Workspace.app'),
      candidate = join(base, 'source', 'All In One Workspace.app'),
      job = join(base, 'job'),
      archive = join(base, 'update.zip'),
      nonce = randomUUID()
    await mkdir(job, { recursive: true })
    await app(target, '1.1.0')
    await app(candidate, '1.2.0', mode === 'rollback')
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', candidate, archive])
    const parent = spawn('/bin/sleep', ['120'])
    children.push(parent)
    const bytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        repository: 'KonjakZhou/AllInOneWorkspace',
        bundleId: 'local.allinone.workspace',
        version: '1.2.0',
        platform: 'darwin',
        arch: mode === 'wrong-arch' ? 'x64' : 'arm64',
        zip: {
          name: 'update.zip',
          size: (await stat(archive)).size,
          sha256: await hashFile(archive),
        },
      }),
    )
    await writeFile(join(job, 'manifest.json'), bytes)
    await writeFile(
      join(job, 'manifest.sig'),
      mode === 'bad-signature'
        ? Buffer.alloc(64).toString('base64')
        : sign(null, bytes, keys.privateKey).toString('base64'),
    )
    await writeFile(
      join(job, 'request.json'),
      JSON.stringify({
        target,
        archive,
        manifestPath: join(job, 'manifest.json'),
        signaturePath: join(job, 'manifest.sig'),
        parentPid: parent.pid,
        nonce,
        stage: join(base, '.aio-update-' + nonce),
        dataDirectory: join(base, 'data'),
      }),
    )
    if (mode === 'read-only') await chmod(base, 0o555)
    const installer = spawn(join(root, 'installer'), [job], { stdio: 'inherit' })
    children.push(installer)
    const status = async () => {
      try {
        return JSON.parse(await readFile(join(job, 'status.json'), 'utf8'))
      } catch {
        return undefined
      }
    }
    await waitFor(async () => ['prepared', 'failed'].includes((await status())?.phase))
    if (mode === 'cancel') await writeFile(join(job, 'cancel'), nonce)
    else if (mode !== 'bad-signature') {
      await writeFile(join(job, 'go'), nonce)
      parent.kill()
    }
    await waitFor(() => installer.exitCode !== null, 90000)
    const result = await status()
    if (mode === 'success') {
      assert.equal(result.phase, 'committed', JSON.stringify(result))
      assert.equal(installer.exitCode, 0)
      await waitFor(async () => {
        try {
          return (await readFile(join(job, 'opened-data'), 'utf8')) === 'confirmed'
        } catch {
          return false
        }
      })
      assert.match(await readFile(join(target, 'Contents/Info.plist'), 'utf8'), /1\.2\.0/)
    } else {
      assert.equal(result.phase, 'failed')
      assert.match(await readFile(join(target, 'Contents/Info.plist'), 'utf8'), /1\.1\.0/)
      if (mode === 'rollback') assert.match(result.message, /恢复旧版/)
    }
    if (mode === 'read-only') await chmod(base, 0o755)
    parent.kill()
    console.log(`PASS native installer: ${mode}`)
  }
} finally {
  for (const child of children) child.kill()
  await rm(root, { recursive: true, force: true })
}
