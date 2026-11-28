import { spawnSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compareVersions, REPOSITORY, STABLE } from '../electron/updates/protocol.ts'

const RECORD = '.release/source.json'
const SHA = /^[a-f0-9]{40}$/
const BOT = {
  GIT_AUTHOR_NAME: 'github-actions[bot]',
  GIT_COMMITTER_NAME: 'github-actions[bot]',
  GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
  GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
}

export function nextVersion(tags, base) {
  if (!STABLE.test(base)) throw new Error('package.json 必须使用稳定版本号')
  const versions = tags
    .filter((t) => /^v/.test(t) && STABLE.test(t.slice(1)))
    .map((t) => t.slice(1))
  const highest = versions.sort(compareVersions).at(-1)
  if (!highest || compareVersions(base, highest) > 0) return base
  const parts = highest.split('.')
  parts[2] = String(BigInt(parts[2]) + 1n)
  return parts.join('.')
}

// The queue serializes writers; ancestry also protects against out-of-order scheduling.
export function decideRelease(source, published, reservation, ancestor) {
  for (const release of published) {
    if (release.source === source) return { mode: 'verify', ...release }
    if (ancestor(source, release.source))
      return { mode: 'skip', reason: `${release.tag} 已包含本次源码` }
    if (!ancestor(release.source, source))
      throw new Error('已发布版本与当前 main 不在同一提交链，停止自动发布')
  }
  if (reservation && published.some((r) => compareVersions(r.version, reservation.version) >= 0))
    throw new Error(
      '此提交预留的版本号已落后于正式版本；请将修复合入 main 的新提交后发布，不得重用或移动标签',
    )
  return reservation ? { mode: 'build', ...reservation } : { mode: 'allocate' }
}

export function command(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 ** 2,
    timeout: 120000,
    ...options,
  })
  if (result.error) throw result.error
  if (result.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} failed: ${result.stderr ?? ''}`)
  return result.stdout?.trim() ?? ''
}

export function gitRepository(cwd = process.cwd()) {
  const git = (...args) => command('git', args, { cwd })
  const ancestor = (older, newer) => {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', older, newer], {
      cwd,
      encoding: 'utf8',
    })
    if (![0, 1].includes(result.status)) throw new Error(result.stderr || '无法检查提交祖先关系')
    return result.status === 0
  }
  const exists = (ref) => {
    const result = spawnSync('git', ['show-ref', '--verify', '--quiet', ref], { cwd })
    if (![0, 1].includes(result.status)) throw new Error(`无法读取 ${ref}`)
    return result.status === 0
  }
  const recordAt = (commit) => {
    if (!git('ls-tree', '--name-only', commit, '--', RECORD)) return undefined
    const record = JSON.parse(git('show', `${commit}:${RECORD}`))
    if (
      record.schemaVersion !== 1 ||
      record.repository !== REPOSITORY ||
      !SHA.test(record.source) ||
      !STABLE.test(record.version)
    )
      throw new Error('发布记录无效')
    if (git('show', '-s', '--format=%P', commit) !== record.source)
      throw new Error('发布记录与父提交不匹配')
    const paths = git('diff-tree', '--no-commit-id', '--name-only', '-r', commit).split('\n')
    if (paths.some((path) => !['package.json', RECORD].includes(path)))
      throw new Error('发布提交包含额外源码修改')
    const before = JSON.parse(git('show', `${record.source}:package.json`))
    const after = JSON.parse(git('show', `${commit}:package.json`))
    if (
      after.version !== record.version ||
      JSON.stringify({ ...before, version: after.version }) !== JSON.stringify(after)
    )
      throw new Error('发布提交必须只更改版本元数据')
    return record
  }
  const readTag = (tag) => {
    if (!tag.startsWith('v') || !STABLE.test(tag.slice(1))) throw new Error('无效的稳定版本标签')
    const commit = git('rev-parse', `refs/tags/${tag}^{commit}`)
    const record = recordAt(commit)
    if (record && record.version !== tag.slice(1)) throw new Error('版本标签与发布记录不匹配')
    return { tag, commit, version: tag.slice(1), source: record?.source ?? commit }
  }
  return { git, ancestor, exists, recordAt, readTag }
}

export async function reserveRelease(source, cwd = process.cwd()) {
  if (!SHA.test(source)) throw new Error('必须提供完整 main 提交 SHA')
  const { git, exists, recordAt } = gitRepository(cwd)
  const sourceTag = `release-source-${source}`
  if (exists(`refs/tags/${sourceTag}`)) {
    const commit = git('rev-parse', `refs/tags/${sourceTag}^{commit}`)
    const record = recordAt(commit)
    if (!record || record.source !== source) throw new Error('源码预留标签的发布记录不匹配')
    const tag = `v${record.version}`
    if (git('rev-parse', `refs/tags/${tag}^{commit}`) !== commit)
      throw new Error('预留的版本标签不匹配')
    const remoteRefs = new Map(
      git('ls-remote', '--refs', 'origin', `refs/tags/${tag}`, `refs/tags/${sourceTag}`)
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, ref] = line.split(/\s+/)
          return [ref, sha]
        }),
    )
    for (const ref of [`refs/tags/${tag}`, `refs/tags/${sourceTag}`]) {
      if (remoteRefs.get(ref) !== git('rev-parse', ref))
        throw new Error(
          '预留标签尚未完整持久化到远端，或与本地不一致；请从干净 checkout 重新运行任务',
        )
    }
    return { source, commit, version: record.version, tag }
  }
  if (git('status', '--porcelain')) throw new Error('工作区必须干净，拒绝丢弃改动')
  if (git('rev-parse', 'HEAD') !== source) throw new Error('必须在指定源码提交分配版本')
  const pkgPath = resolve(cwd, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  const version = nextVersion(git('tag', '--list').split('\n'), pkg.version)
  pkg.version = version
  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
  await mkdir(resolve(cwd, '.release'), { recursive: true })
  await writeFile(
    resolve(cwd, RECORD),
    JSON.stringify({ schemaVersion: 1, repository: REPOSITORY, source, version }, null, 2) + '\n',
  )
  git('add', '--', 'package.json', RECORD)
  command('git', ['commit', '-m', `chore(release): v${version}\n\nSource-Commit: ${source}`], {
    cwd,
    env: { ...process.env, ...BOT },
  })
  const commit = git('rev-parse', 'HEAD')
  const tag = `v${version}`
  git('tag', tag, commit)
  git('tag', sourceTag, commit)
  // Both refs are the durable allocation. Either both are stored or neither is stored.
  git('push', '--atomic', 'origin', `refs/tags/${tag}`, `refs/tags/${sourceTag}`)
  return { source, commit, version, tag }
}

function assertCI() {
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== REPOSITORY ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    !['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME)
  )
    throw new Error('自动发布仅允许本仓库 main 的 push 或手动工作流')
  const remote = command('git', ['remote', 'get-url', 'origin'])
  if (
    ![
      `https://github.com/${REPOSITORY}`,
      `https://github.com/${REPOSITORY}.git`,
      `git@github.com:${REPOSITORY}.git`,
    ].includes(remote)
  )
    throw new Error('origin 与发布仓库不匹配')
}

function publishedReleases(repo) {
  const pages = JSON.parse(
    command('gh', ['api', '--paginate', '--slurp', `repos/${REPOSITORY}/releases?per_page=100`]),
  )
  return pages
    .flat()
    .filter(
      (r) => !r.draft && !r.prerelease && /^v/.test(r.tag_name) && STABLE.test(r.tag_name.slice(1)),
    )
    .map((r) => repo.readTag(r.tag_name))
    .sort((a, b) => compareVersions(b.version, a.version))
}

async function output(plan) {
  for (const [key, value] of Object.entries(plan)) {
    if (/[\r\n]/.test(String(value))) throw new Error('无效工作流输出')
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
  }
  console.log(JSON.stringify(plan, null, 2))
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `发布计划：\`${plan.mode}\` ${plan.tag ?? ''}\n\n源码：\`${plan.source ?? process.env.GITHUB_SHA}\`\n\n${plan.reason ?? ''}\n`,
    )
}

export async function main(mode) {
  assertCI()
  const repo = gitRepository()
  // Never force-fetch or move a version tag. Conflicts must stop the release.
  repo.git('fetch', 'origin', 'main', '--tags')
  const source = process.env.GITHUB_SHA
  if (!SHA.test(source ?? '') || !repo.ancestor(source, 'origin/main'))
    throw new Error('源码不属于远端 main')
  const published = publishedReleases(repo)
  if (mode === 'prepare') {
    let reservation
    if (repo.exists(`refs/tags/release-source-${source}`))
      reservation = await reserveRelease(source)
    let plan = decideRelease(source, published, reservation, repo.ancestor)
    if (plan.mode === 'allocate') plan = { mode: 'build', ...(await reserveRelease(source)) }
    if (['build', 'verify'].includes(plan.mode)) {
      if (repo.git('status', '--porcelain')) throw new Error('工作区不干净')
      repo.git('checkout', '--detach', plan.commit)
    }
    await output(plan)
  } else if (mode === 'publish') {
    const commit = repo.git('rev-parse', 'HEAD')
    const record = repo.recordAt(commit)
    if (!record || record.source !== source) throw new Error('当前构建不对应本次 main 提交')
    const reservation = repo.readTag(`v${record.version}`)
    if (reservation.commit !== commit) throw new Error('标签不对应本次构建')
    const decision = decideRelease(source, published, reservation, repo.ancestor)
    if (decision.mode !== 'build')
      throw new Error('发布状态已变化，请重新运行完整任务；不覆盖正式版本')
    command('gh', [
      'release',
      'edit',
      reservation.tag,
      '--repo',
      REPOSITORY,
      '--draft=false',
      '--prerelease=false',
      '--latest',
    ])
    console.log(`已正式发布 ${reservation.tag}`)
  } else throw new Error('Expected prepare or publish')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main(process.argv[2])
