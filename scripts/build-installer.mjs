import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
const key = JSON.parse(
  await readFile(new URL('../build/update-public-key.json', import.meta.url), 'utf8'),
).publicKey
if (key && Buffer.from(key, 'base64').length !== 32) throw new Error('Invalid updater public key')
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('Installer build currently requires macOS arm64')
await mkdir('out/installer', { recursive: true })
const source =
  `let trustedUpdateKey = ${JSON.stringify(key)}\n` +
  (await readFile('native/UpdateInstaller.swift', 'utf8'))
await writeFile('out/installer/UpdateInstaller.swift', source)
const result = spawnSync(
  'xcrun',
  [
    'swiftc',
    '-O',
    '-target',
    'arm64-apple-macos13.0',
    '-module-cache-path',
    'out/installer/module-cache',
    'out/installer/UpdateInstaller.swift',
    '-o',
    'out/installer/aio-update-installer',
  ],
  { stdio: 'inherit' },
)
if (result.status !== 0) process.exit(result.status ?? 1)
