import { generateKeyPairSync, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { readFile, writeFile, mkdir, stat, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  manifestSchema,
  verifyManifest,
  MANIFEST_NAME,
  SIGNATURE_NAME,
  REPOSITORY,
  BUNDLE_ID,
  STABLE,
} from '../electron/updates/protocol.ts'
import { hashFile } from '../electron/updates/files.ts'
import { prepareReleaseFiles } from './release-assets.mjs'
const root = resolve(import.meta.dirname, '..')
process.chdir(root)
const keyFile = join(homedir(), '.config', 'all-in-one-workspace', 'release-signing', 'private.pem')
const publicFile = join(root, 'build', 'update-public-key.json')
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const run = (cmd, args, capture = false) => {
  const result = spawnSync(cmd, args, { encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
  if (result.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed${capture ? ': ' + result.stderr : ''}`)
  return result.stdout?.trim()
}
function clean() {
  if (run('git', ['status', '--porcelain'], true))
    throw new Error('请先提交源码和版本号，再制作正式发布包')
  if (!STABLE.test(pkg.version)) throw new Error('仅支持稳定的三段版本号')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pkg.name))
    throw new Error('发布包名称仅支持小写字母、数字和连字符，避免 GitHub 改写附件名')
}
async function publicKey() {
  return JSON.parse(await readFile(publicFile, 'utf8')).publicKey
}
async function privateKey() {
  const permissions = await stat(keyFile)
  if ((permissions.mode & 0o077) !== 0 || permissions.uid !== process.getuid())
    throw new Error('私钥必须属于当前用户，且权限为 0600')
  const key = createPrivateKey(await readFile(keyFile))
  const actual = Buffer.from(
    createPublicKey(key).export({ format: 'jwk' }).x,
    'base64url',
  ).toString('base64')
  if (actual !== (await publicKey())) throw new Error('发布私钥与应用内置公钥不匹配')
  return key
}
async function asset(extension) {
  const name = `${pkg.name}-${pkg.version}-arm64.${extension}`
  const path = join('release', name)
  return { name, size: (await stat(path)).size, sha256: await hashFile(path) }
}
async function signBuild(manifest, key) {
  if (
    manifest.commit !== run('git', ['rev-parse', 'HEAD'], true) ||
    manifest.version !== pkg.version
  )
    throw new Error('待签名构建不是当前源码和版本')
  for (const extension of ['zip', 'dmg']) {
    if (JSON.stringify(await asset(extension)) !== JSON.stringify(manifest[extension]))
      throw new Error('待签名安装包已变化，请重新构建')
  }
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n')
  const signature = sign(null, bytes, key).toString('base64')
  verifyManifest(bytes, signature, await publicKey())
  await writeFile(join('release', MANIFEST_NAME), bytes)
  await writeFile(join('release', SIGNATURE_NAME), signature + '\n')
  await prepareReleaseFiles('release', manifest)
}
const mode = process.argv[2]
if (mode === 'keygen') {
  const existing = await publicKey()
  if (existing) throw new Error('公钥已配置；不会覆盖现有更新信任。请使用备份私钥')
  try {
    await access(keyFile)
    throw new Error('私钥已存在；不会覆盖，请核对原公钥')
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  const keys = generateKeyPairSync('ed25519')
  const pub = Buffer.from(keys.publicKey.export({ format: 'jwk' }).x, 'base64url').toString(
    'base64',
  )
  await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 })
  await writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
    flag: 'wx',
  })
  await writeFile(
    publicFile,
    JSON.stringify({ algorithm: 'ed25519', publicKey: pub }, null, 2) + '\n',
  )
  console.log(
    `更新签名密钥已生成。请备份仓库外的私钥：${keyFile}\n仅提交 build/update-public-key.json。`,
  )
} else if (mode === 'build' || mode === 'build-unsigned') {
  clean()
  const commit = run('git', ['rev-parse', 'HEAD'], true)
  const key = mode === 'build' ? await privateKey() : undefined
  run('pnpm', ['test'])
  run('pnpm', ['dist'])
  clean()
  if (run('git', ['rev-parse', 'HEAD'], true) !== commit)
    throw new Error('打包期间源码提交发生变化，请重新打包')
  const manifest = manifestSchema.parse({
    schemaVersion: 1,
    repository: REPOSITORY,
    bundleId: BUNDLE_ID,
    version: pkg.version,
    commit,
    platform: 'darwin',
    arch: 'arm64',
    minimumSystemVersion: '13.0',
    zip: await asset('zip'),
    dmg: await asset('dmg'),
  })
  await writeFile(join('release', 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  if (key) await signBuild(manifest, key)
  console.log(
    key
      ? '发布包和签名已生成；请启动 App 验证后运行 pnpm release 创建草稿。'
      : '构建完成，等待验证后签名。',
  )
} else if (mode === 'sign') {
  clean()
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join('release', 'build-manifest.json'), 'utf8')),
  )
  await signBuild(manifest, await privateKey())
} else if (mode === 'draft') {
  clean()
  const bytes = await readFile(join('release', MANIFEST_NAME))
  const manifest = verifyManifest(
    bytes,
    await readFile(join('release', SIGNATURE_NAME), 'utf8'),
    await publicKey(),
  )
  if (
    manifest.version !== pkg.version ||
    manifest.commit !== run('git', ['rev-parse', 'HEAD'], true)
  )
    throw new Error('发布包不是当前源码，请重新打包')
  const tag = 'v' + pkg.version
  if (run('git', ['rev-list', '-n', '1', tag], true) !== manifest.commit)
    throw new Error('版本标签不对应打包提交')
  const remote = run('git', ['remote', 'get-url', 'origin'], true)
  if (
    ![
      `git@github.com:${REPOSITORY}.git`,
      `https://github.com/${REPOSITORY}.git`,
      `https://github.com/${REPOSITORY}`,
    ].includes(remote)
  )
    throw new Error('origin 与固定发布仓库不匹配')
  const ref = JSON.parse(run('gh', ['api', `repos/${REPOSITORY}/commits/${tag}`], true))
  if (ref.sha !== manifest.commit) throw new Error('请先推送正确的源码和标签')
  const existing = spawnSync(
    'gh',
    ['release', 'view', tag, '--repo', REPOSITORY, '--json', 'isDraft'],
    { encoding: 'utf8' },
  )
  if (existing.status === 0 && !JSON.parse(existing.stdout).isDraft)
    throw new Error('正式版本已发布，禁止覆盖；请使用新版本号')
  const files = await prepareReleaseFiles('release', manifest)
  if (existing.status === 0) {
    run('gh', ['release', 'upload', tag, ...files, '--repo', REPOSITORY, '--clobber'])
  } else {
    run('gh', [
      'release',
      'create',
      tag,
      ...files,
      '--repo',
      REPOSITORY,
      '--draft',
      '--verify-tag',
      '--title',
      tag,
      '--generate-notes',
    ])
  }
  const assets = JSON.parse(
    run('gh', ['release', 'view', tag, '--repo', REPOSITORY, '--json', 'assets,url'], true),
  )
  for (const name of files.map((path) => path.slice('release/'.length))) {
    const found = assets.assets.find((a) => a.name === name)
    if (!found || found.size !== (await stat(join('release', name))).size)
      throw new Error('草稿附件未上传完整，请重试')
  }
  console.log(`草稿已准备：${assets.url}\n请核对发布说明和安装包后，在 GitHub 点击发布。`)
} else throw new Error('Expected keygen, build, build-unsigned, sign or draft')
