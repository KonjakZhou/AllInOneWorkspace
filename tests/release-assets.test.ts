import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, readdir, symlink, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'
import { sha256, verifyManifest, type UpdateManifest } from '../electron/updates/protocol'
import { updateFixture } from './update-fixtures'

const execute = promisify(execFile)
const helper = new URL('../scripts/release-assets.mjs', import.meta.url).href
const alias = 'all-in-one-workspace-arm64.dmg'
const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'release-assets-'))
  directories.push(path)
  return path
}

async function version(path: string, value = '1.2.0', prefix = 'all-in-one-workspace') {
  const fixture = updateFixture(value)
  const dmg = Buffer.from('DMG content ' + value)
  fixture.manifest.zip.name = `${prefix}-${value}-arm64.zip`
  fixture.manifest.dmg = {
    name: `${prefix}-${value}-arm64.dmg`,
    size: dmg.length,
    sha256: sha256(dmg),
  }
  const signed = fixture.encode()
  await writeFile(join(path, fixture.manifest.zip.name), fixture.archive)
  await writeFile(join(path, fixture.manifest.dmg.name), dmg)
  await writeFile(join(path, 'update-mac-arm64.json'), signed.bytes)
  await writeFile(join(path, 'update-mac-arm64.json.sig'), signed.signature)
  return { ...fixture, dmg, signed }
}

// Run the production helper under Node, just as the release CLI does.
async function prepare(path: string, manifest: UpdateManifest): Promise<string[]> {
  const result = await execute(process.execPath, [
    '--input-type=module',
    '-e',
    'const { prepareReleaseFiles } = await import(process.argv[1]); console.log(JSON.stringify(await prepareReleaseFiles(process.argv[2], JSON.parse(process.argv[3]))))',
    helper,
    path,
    JSON.stringify(manifest),
  ])
  return JSON.parse(result.stdout)
}

it.each(['all-in-one-workspace', 'All.In.One.Workspace'])(
  'prepares five release files from %s without altering signed metadata',
  async (prefix) => {
    const path = await directory()
    const fixture = await version(path, '1.2.0', prefix)
    const files = await prepare(path, fixture.manifest)
    expect(files.map((file) => basename(file))).toEqual([
      fixture.manifest.zip.name,
      fixture.manifest.dmg.name,
      'update-mac-arm64.json',
      'update-mac-arm64.json.sig',
      alias,
    ])
    expect(await readFile(join(path, alias))).toEqual(fixture.dmg)
    expect(await readFile(join(path, fixture.manifest.dmg.name))).toEqual(fixture.dmg)
    const bytes = await readFile(join(path, 'update-mac-arm64.json'))
    const signature = await readFile(join(path, 'update-mac-arm64.json.sig'), 'utf8')
    expect(bytes).toEqual(fixture.signed.bytes)
    expect(verifyManifest(bytes, signature, fixture.publicKey)).toEqual(fixture.manifest)
  },
)

it('replaces a previous local alias with the new verified version', async () => {
  const path = await directory()
  const first = await version(path)
  await prepare(path, first.manifest)
  const second = await version(path, '1.2.1')
  await prepare(path, second.manifest)
  expect(await readFile(join(path, alias))).toEqual(second.dmg)
  expect(await readFile(join(path, first.manifest.dmg.name))).toEqual(first.dmg)
  expect((await readdir(path)).some((name) => name.endsWith('.tmp'))).toBe(false)
})

it.each(['zip', 'dmg'] as const)(
  'rejects a same-size corrupted %s before replacing an alias',
  async (type) => {
    const path = await directory()
    const fixture = await version(path)
    await writeFile(join(path, alias), 'previous download')
    const asset = fixture.manifest[type]
    await writeFile(join(path, asset.name), Buffer.alloc(asset.size, 0x42))
    await expect(prepare(path, fixture.manifest)).rejects.toThrow('发布包已变化')
    expect(await readFile(join(path, alias), 'utf8')).toBe('previous download')
    expect((await readdir(path)).some((name) => name.endsWith('.tmp'))).toBe(false)
  },
)

it('replaces an alias symlink without modifying its target', async () => {
  const path = await directory()
  const fixture = await version(path)
  const unrelated = join(path, 'unrelated-file')
  await writeFile(unrelated, 'keep this file')
  await symlink(unrelated, join(path, alias))
  await prepare(path, fixture.manifest)
  expect(await readFile(unrelated, 'utf8')).toBe('keep this file')
  expect((await lstat(join(path, alias))).isSymbolicLink()).toBe(false)
  expect(await readFile(join(path, alias))).toEqual(fixture.dmg)
})

it('refuses to replace an original signed asset with the alias', async () => {
  const path = await directory()
  const fixture = await version(path)
  fixture.manifest.dmg.name = alias
  await writeFile(join(path, alias), fixture.dmg)
  await expect(prepare(path, fixture.manifest)).rejects.toThrow('独立的版本附件')
  expect(await readFile(join(path, alias))).toEqual(fixture.dmg)
})
