import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { REPOSITORY } from '../electron/updates/protocol'

const execute = promisify(execFile)
const script = new URL('../scripts/ci-release.mjs', import.meta.url).href
const directories: string[] = []
const recordPath = '.release/source.json'
const personalEmail = 'fixture-person@example.invalid'
const botEmail = '41898282+github-actions[bot]@users.noreply.github.com'

// All Git subprocesses, including those started by the production script, use
// isolated configuration and can only contact local file remotes.
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(GIT_|GITHUB_|GH_)/.test(key)),
)
Object.assign(environment, {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_ALLOW_PROTOCOL: 'file',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_COUNT: '3',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'tag.gpgsign',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_CONFIG_KEY_2: 'init.templateDir',
  GIT_CONFIG_VALUE_2: '',
  GIT_AUTHOR_NAME: 'Fixture Person',
  GIT_AUTHOR_EMAIL: personalEmail,
  GIT_COMMITTER_NAME: 'Fixture Person',
  GIT_COMMITTER_EMAIL: personalEmail,
})

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

type Release = { source: string; commit: string; version: string; tag: string }
type Plan =
  ({ mode: 'build' | 'verify' } & Release) | { mode: 'allocate' } | { mode: 'skip'; reason: string }

// Execute the real ESM entry point under Node, without invoking main or gh.
// Passing data as argv also avoids shell interpolation of refs and JSON.
async function invoke<T>(method: string, args: unknown[], cwd = tmpdir()): Promise<T> {
  const { stdout } = await execute(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const api = await import(process.argv[1]);
const method = process.argv[2];
const args = JSON.parse(process.argv[3]);
let result;
if (method === 'decideRelease') {
  const [source, published, reservation, ancestry] = args;
  result = api.decideRelease(source, published, reservation,
    (older, newer) => older === newer || ancestry.some(([a, b]) => a === older && b === newer));
} else if (method === 'readTag') {
  result = api.gitRepository().readTag(...args);
} else {
  result = await api[method](...args);
}
console.log(JSON.stringify(result));`,
      script,
      method,
      JSON.stringify(args),
    ],
    { cwd, env: environment, timeout: 20_000 },
  )
  return JSON.parse(stdout)
}

async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execute('git', args, {
    cwd,
    env: environment,
    timeout: 20_000,
  })
  return stdout.trim()
}

async function writeJson(cwd: string, path: string, value: unknown) {
  await writeFile(join(cwd, path), JSON.stringify(value, null, 2) + '\n')
}

async function readJson(cwd: string, path: string) {
  return JSON.parse(await readFile(join(cwd, path), 'utf8'))
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ci-release-'))
  directories.push(root)
  const remote = join(root, 'origin.git')
  const work = join(root, 'work')
  await git(root, 'init', '--bare', '--initial-branch=main', remote)
  await git(root, 'clone', remote, work)
  // Local identity and inherited identity must both be overridden for releases.
  await git(work, 'config', 'user.name', 'Fixture Person')
  await git(work, 'config', 'user.email', personalEmail)
  const pkg = {
    name: 'ci-release-fixture',
    version: '1.2.10',
    private: true,
    scripts: { build: 'echo fixture' },
    dependencies: { fixture: '1.0.0' },
  }
  await writeJson(work, 'package.json', pkg)
  await writeFile(join(work, 'app.txt'), 'original source\n')
  await git(work, 'add', '--', 'package.json', 'app.txt')
  await git(work, 'commit', '-m', 'Fixture source')
  const source = await git(work, 'rev-parse', 'HEAD')
  await git(work, 'tag', 'v1.2.10')
  await git(work, 'push', '--set-upstream', 'origin', 'main', '--tags')
  return { root, remote, work, source, pkg }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

function reserve(cwd: string, source: string) {
  return invoke<Release>('reserveRelease', [source], cwd)
}

async function clone(f: Fixture, name: string) {
  const cwd = join(f.root, name)
  await git(f.root, 'clone', f.remote, cwd)
  return cwd
}

function refs(cwd: string) {
  return git(cwd, 'for-each-ref', '--format=%(refname) %(objectname)')
}

async function snapshot(cwd: string) {
  return {
    head: await git(cwd, 'rev-parse', 'HEAD'),
    refs: await refs(cwd),
    status: await git(cwd, 'status', '--porcelain=v1', '--untracked-files=all'),
    index: await git(cwd, 'ls-files', '--stage'),
    staged: await git(cwd, 'diff', '--cached', '--binary'),
    unstaged: await git(cwd, 'diff', '--binary'),
  }
}

describe('nextVersion', () => {
  it.each([
    { name: 'uses the package baseline without tags', tags: [], base: '1.2.10', next: '1.2.10' },
    {
      name: 'sorts patches numerically',
      tags: ['v1.2.10', 'v1.2.9'],
      base: '1.2.0',
      next: '1.2.11',
    },
    {
      name: 'sorts minor versions numerically',
      tags: ['v1.10.2', 'v1.9.99'],
      base: '1.2.0',
      next: '1.10.3',
    },
    {
      name: 'sorts major versions numerically',
      tags: ['v10.0.0', 'v9.99.99'],
      base: '1.2.0',
      next: '10.0.1',
    },
    {
      name: 'counts reserved version tags before publication',
      tags: ['v1.2.11', 'v1.2.10', `release-source-${'a'.repeat(40)}`],
      base: '1.2.10',
      next: '1.2.12',
    },
    {
      name: 'uses an explicitly raised baseline',
      tags: ['v1.99.99'],
      base: '2.0.0',
      next: '2.0.0',
    },
    {
      name: 'increments a baseline already tagged',
      tags: ['v1.2.10'],
      base: '1.2.10',
      next: '1.2.11',
    },
    {
      name: 'ignores unstable and unrelated tags',
      tags: [
        'v99.0.0-beta.1',
        'v99.0.0+build',
        'v01.0.0',
        '1.2.99',
        'release-source-1.2.99',
        'v1.2',
        '',
      ],
      base: '1.2.10',
      next: '1.2.10',
    },
    {
      name: 'retains integer precision beyond Number.MAX_SAFE_INTEGER',
      tags: ['v1.2.9007199254740993', 'v1.2.9007199254740992'],
      base: '1.2.0',
      next: '1.2.9007199254740994',
    },
  ])('$name', async ({ tags, base, next }) => {
    expect(await invoke('nextVersion', [tags, base])).toBe(next)
  })

  it.each(['1.2', 'v1.2.3', '01.2.3', '1.2.3-beta.1', '1.2.3+build', ''])(
    'rejects the unstable package baseline %j',
    async (base) => {
      await expect(invoke('nextVersion', [['v1.2.10'], base])).rejects.toThrow('稳定版本号')
    },
  )
})

describe('decideRelease', () => {
  const older = 'a'.repeat(40)
  const source = 'b'.repeat(40)
  const newer = 'c'.repeat(40)
  const unrelated = 'd'.repeat(40)
  const ancestry = [
    [older, source],
    [older, newer],
    [source, newer],
  ]
  const release = (source: string, version: string): Release => ({
    source,
    version,
    tag: `v${version}`,
    commit: 'e'.repeat(40),
  })
  const decide = (published: Release[], reservation?: Release) =>
    invoke<Plan>('decideRelease', [source, published, reservation ?? null, ancestry])

  it('allocates when there are no published versions or reservations', async () => {
    expect(await decide([])).toEqual({ mode: 'allocate' })
  })

  it('allocates for source descending from the published source', async () => {
    expect(await decide([release(older, '1.2.10')])).toEqual({ mode: 'allocate' })
  })

  it('verifies already published source instead of rebuilding a reservation', async () => {
    const published = release(source, '1.2.11')
    expect(await decide([published, release(older, '1.2.10')], published)).toEqual({
      mode: 'verify',
      ...published,
    })
    expect(await decide([published])).toEqual({ mode: 'verify', ...published })
  })

  it('skips old source already included in a newer release, even with a stale reservation', async () => {
    expect(await decide([release(newer, '1.2.12')], release(source, '1.2.11'))).toEqual({
      mode: 'skip',
      reason: 'v1.2.12 已包含本次源码',
    })
  })

  it('skips a delayed retry of an older published release when the latest already includes it', async () => {
    const published = release(source, '1.2.11')
    expect(await decide([release(newer, '1.2.12'), published], published)).toEqual({
      mode: 'skip',
      reason: 'v1.2.12 已包含本次源码',
    })
  })

  it('rejects a published source on another commit chain', async () => {
    await expect(decide([release(unrelated, '1.2.10')])).rejects.toThrow('不在同一提交链')
  })

  it('checks older published releases as well as the latest for divergent history', async () => {
    await expect(decide([release(older, '1.2.10'), release(unrelated, '1.2.9')])).rejects.toThrow(
      '不在同一提交链',
    )
  })

  it('builds an existing reservation without reallocating it', async () => {
    const reservation = release(source, '1.10.0')
    expect(await decide([], reservation)).toEqual({ mode: 'build', ...reservation })
    expect(await decide([release(older, '1.9.99')], reservation)).toEqual({
      mode: 'build',
      ...reservation,
    })
  })

  it.each(['1.2.9', '1.2.10'])(
    'rejects reservation %s at or below the published version',
    async (version) => {
      await expect(decide([release(older, '1.2.10')], release(source, version))).rejects.toThrow(
        '预留的版本号已落后',
      )
    },
  )
})

describe('reserveRelease with an isolated bare remote', () => {
  it('persists both tags on one release commit with only version metadata and a bot identity', async () => {
    const f = await fixture()
    const result = await reserve(f.work, f.source)
    expect(result).toEqual({
      source: f.source,
      commit: expect.stringMatching(/^[a-f0-9]{40}$/),
      version: '1.2.11',
      tag: 'v1.2.11',
    })
    expect(result.commit).not.toBe(f.source)
    for (const tag of [result.tag, `release-source-${f.source}`]) {
      expect(await git(f.remote, 'rev-parse', `refs/tags/${tag}^{commit}`)).toBe(result.commit)
    }
    expect(await git(f.remote, 'rev-parse', 'refs/heads/main')).toBe(f.source)
    expect(await git(f.remote, 'rev-parse', 'refs/tags/v1.2.10')).toBe(f.source)
    expect(await git(f.work, 'show', '-s', '--format=%P', result.commit)).toBe(f.source)
    expect(
      (await git(f.work, 'diff-tree', '--no-commit-id', '--name-only', '-r', result.commit))
        .split('\n')
        .sort(),
    ).toEqual([recordPath, 'package.json'].sort())
    expect(await readJson(f.work, 'package.json')).toEqual({ ...f.pkg, version: '1.2.11' })
    expect(await readJson(f.work, recordPath)).toEqual({
      schemaVersion: 1,
      repository: REPOSITORY,
      source: f.source,
      version: '1.2.11',
    })
    expect(await readFile(join(f.work, 'app.txt'), 'utf8')).toBe('original source\n')
    expect(await git(f.work, 'show', '-s', '--format=%an%n%ae%n%cn%n%ce', result.commit)).toBe(
      ['github-actions[bot]', botEmail, 'github-actions[bot]', botEmail].join('\n'),
    )
    expect(await git(f.work, 'show', '-s', '--format=fuller', result.commit)).not.toContain(
      personalEmail,
    )
    expect(await git(f.work, 'status', '--porcelain')).toBe('')
    expect(await invoke('readTag', [result.tag], f.remote)).toEqual(result)
  })

  it('leaves neither new remote tag behind when the source tag is rejected', async () => {
    const f = await fixture()
    const before = await refs(f.remote)
    // An update hook rejects only one ref: a non-atomic push would leave the
    // otherwise accepted version tag behind, so this exercises Git atomicity.
    await mkdir(join(f.remote, 'hooks'), { recursive: true })
    await writeFile(
      join(f.remote, 'hooks/update'),
      '#!/bin/sh\ncase "$1" in refs/tags/release-source-*) exit 1 ;; esac\nexit 0\n',
      { mode: 0o755 },
    )
    await expect(reserve(f.work, f.source)).rejects.toThrow('git push --atomic')
    expect(await refs(f.remote)).toBe(before)
  })

  it('does not accept unpushed local tags as a durable reservation when retrying a rejected push', async () => {
    const f = await fixture()
    const remoteBefore = await refs(f.remote)
    await mkdir(join(f.remote, 'hooks'), { recursive: true })
    await writeFile(join(f.remote, 'hooks/update'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await expect(reserve(f.work, f.source)).rejects.toThrow('git push --atomic')
    expect(await refs(f.remote)).toBe(remoteBefore)
    // The first attempt left both tags locally. With the remote still rejecting
    // writes, a retry cannot claim that those tags were durably reserved.
    await expect(reserve(f.work, f.source)).rejects.toThrow()
    expect(await refs(f.remote)).toBe(remoteBefore)
  })

  it('stops instead of claiming success when retrying in the same clone after remote rejection is lifted', async () => {
    const f = await fixture()
    const remoteBefore = await refs(f.remote)
    const hook = join(f.remote, 'hooks/update')
    await mkdir(join(f.remote, 'hooks'), { recursive: true })
    await writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await expect(reserve(f.work, f.source)).rejects.toThrow('git push --atomic')
    expect(await refs(f.remote)).toBe(remoteBefore)
    const localBefore = await snapshot(f.work)
    await rm(hook)

    // Removing the rejection does not persist the local tags. The current
    // recovery policy stops on the remote mismatch and requires a fresh clone.
    await expect(reserve(f.work, f.source)).rejects.toThrow('预留标签尚未完整持久化到远端')
    expect(await snapshot(f.work)).toEqual(localBefore)
    expect(await refs(f.remote)).toBe(remoteBefore)
  })

  it('reuses the persisted version and exact commit after cloning again', async () => {
    const f = await fixture()
    const first = await reserve(f.work, f.source)
    const retry = await clone(f, 'retry')
    const localBefore = await snapshot(retry)
    const remoteBefore = await refs(f.remote)
    expect(await reserve(retry, f.source)).toEqual(first)
    expect(await snapshot(retry)).toEqual(localBefore)
    expect(await refs(f.remote)).toBe(remoteBefore)
    expect(await invoke('readTag', [first.tag], retry)).toEqual(first)
  })

  it('allocates consecutive versions to consecutive main sources without rewriting main', async () => {
    const f = await fixture()
    const first = await reserve(f.work, f.source)
    const secondWork = await clone(f, 'second-source')
    await writeFile(join(secondWork, 'app.txt'), 'second source\n')
    await git(secondWork, 'add', '--', 'app.txt')
    await git(secondWork, 'commit', '-m', 'Second source')
    const secondSource = await git(secondWork, 'rev-parse', 'HEAD')
    await git(secondWork, 'push', 'origin', 'main')
    const second = await reserve(secondWork, secondSource)
    expect([first.version, second.version]).toEqual(['1.2.11', '1.2.12'])
    expect(second.source).toBe(secondSource)
    expect(second.commit).not.toBe(first.commit)
    expect(await git(f.remote, 'rev-parse', 'refs/heads/main')).toBe(secondSource)
    expect(await git(f.remote, 'show', '-s', '--format=%P', second.commit)).toBe(secondSource)
    for (const result of [first, second]) {
      for (const tag of [result.tag, `release-source-${result.source}`])
        expect(await git(f.remote, 'rev-parse', `refs/tags/${tag}^{commit}`)).toBe(result.commit)
    }
    const retry = await clone(f, 'retry-after-second')
    expect(await reserve(retry, f.source)).toEqual(first)
    expect(await reserve(retry, secondSource)).toEqual(second)
  })

  it.each(['unstaged', 'staged', 'untracked'] as const)(
    'rejects a new reservation in a %s working tree without losing changes',
    async (kind) => {
      const f = await fixture()
      const path = kind === 'untracked' ? 'notes.txt' : 'package.json'
      const contents =
        kind === 'untracked'
          ? 'Uncommitted personal notes\n'
          : JSON.stringify({ ...f.pkg, description: 'Keep my edit' }, null, 2) + '\n'
      await writeFile(join(f.work, path), contents)
      if (kind === 'staged') await git(f.work, 'add', '--', path)
      const before = await snapshot(f.work)
      const remoteBefore = await refs(f.remote)
      await expect(reserve(f.work, f.source)).rejects.toThrow('工作区必须干净')
      expect(await snapshot(f.work)).toEqual(before)
      expect(await readFile(join(f.work, path), 'utf8')).toBe(contents)
      expect(await refs(f.remote)).toBe(remoteBefore)
    },
  )

  it('preserves dirty files when reading an existing reservation', async () => {
    const f = await fixture()
    const first = await reserve(f.work, f.source)
    const retry = await clone(f, 'dirty-retry')
    await writeFile(join(retry, 'app.txt'), 'keep this tracked edit\n')
    await git(retry, 'add', '--', 'app.txt')
    await writeFile(join(retry, 'notes.txt'), 'keep this untracked file\n')
    const before = await snapshot(retry)
    const remoteBefore = await refs(f.remote)
    expect(await reserve(retry, f.source)).toEqual(first)
    expect(await snapshot(retry)).toEqual(before)
    expect(await readFile(join(retry, 'notes.txt'), 'utf8')).toBe('keep this untracked file\n')
    expect(await refs(f.remote)).toBe(remoteBefore)
  })

  it.each([
    { name: 'short SHA', source: 'abc123', error: '完整 main 提交 SHA' },
    { name: 'different HEAD', source: 'f'.repeat(40), error: '指定源码提交' },
  ])('rejects a $name without modifying the repository', async ({ source, error }) => {
    const f = await fixture()
    const before = await snapshot(f.work)
    await expect(reserve(f.work, source)).rejects.toThrow(error)
    expect(await snapshot(f.work)).toEqual(before)
  })
})

describe('reservation record validation', () => {
  type Forgery = {
    name: string
    error: string
    record?: Record<string, unknown>
    pkg?: Record<string, unknown>
    extraSource?: boolean
  }
  const forgeries: Forgery[] = [
    { name: 'unknown schema', record: { schemaVersion: 2 }, error: '发布记录无效' },
    { name: 'foreign repository', record: { repository: 'fixture/other' }, error: '发布记录无效' },
    { name: 'invalid source SHA', record: { source: 'abc123' }, error: '发布记录无效' },
    { name: 'unstable version', record: { version: '1.2.11-beta.1' }, error: '发布记录无效' },
    { name: 'false parent source', record: { source: 'f'.repeat(40) }, error: '父提交不匹配' },
    { name: 'extra source modification', extraSource: true, error: '额外源码修改' },
    { name: 'changed package fields', pkg: { name: 'forged-name' }, error: '只更改版本元数据' },
    {
      name: 'package and record version mismatch',
      pkg: { version: '1.2.12' },
      error: '只更改版本元数据',
    },
  ]

  it.each(forgeries)('rejects $name in a persisted reservation', async (forgery) => {
    const f = await fixture()
    await mkdir(join(f.work, '.release'))
    await writeJson(f.work, recordPath, {
      schemaVersion: 1,
      repository: REPOSITORY,
      source: f.source,
      version: '1.2.11',
      ...forgery.record,
    })
    await writeJson(f.work, 'package.json', { ...f.pkg, version: '1.2.11', ...forgery.pkg })
    if (forgery.extraSource) await writeFile(join(f.work, 'app.txt'), 'forged source\n')
    await git(f.work, 'add', '--', 'package.json', recordPath, 'app.txt')
    await git(f.work, 'commit', '-m', 'Forged release')
    await git(f.work, 'tag', 'v1.2.11')
    await git(f.work, 'tag', `release-source-${f.source}`)
    await git(
      f.work,
      'push',
      '--atomic',
      'origin',
      'refs/tags/v1.2.11',
      `refs/tags/release-source-${f.source}`,
    )
    const retry = await clone(f, 'forged-retry')
    const before = await snapshot(retry)
    const remoteBefore = await refs(f.remote)
    await expect(reserve(retry, f.source)).rejects.toThrow(forgery.error)
    expect(await snapshot(retry)).toEqual(before)
    expect(await refs(f.remote)).toBe(remoteBefore)
  })

  it('rejects a source reservation tag pointing to a legacy commit with no record', async () => {
    const f = await fixture()
    await git(f.work, 'tag', `release-source-${f.source}`)
    await expect(reserve(f.work, f.source)).rejects.toThrow('源码预留标签的发布记录不匹配')
  })

  it('rejects a source tag whose version tag points to a different commit', async () => {
    const f = await fixture()
    const result = await reserve(f.work, f.source)
    await git(f.work, 'tag', '--force', result.tag, f.source)
    const remoteBefore = await refs(f.remote)
    await expect(reserve(f.work, f.source)).rejects.toThrow('预留的版本标签不匹配')
    expect(await refs(f.remote)).toBe(remoteBefore)
  })

  it('rejects a version tag whose name disagrees with its release record', async () => {
    const f = await fixture()
    const result = await reserve(f.work, f.source)
    await git(f.work, 'tag', 'v1.2.12', result.commit)
    await expect(invoke('readTag', ['v1.2.12'], f.work)).rejects.toThrow('版本标签与发布记录不匹配')
  })
})

describe('gitRepository.readTag legacy releases', () => {
  it.each(['lightweight', 'annotated'] as const)(
    'uses the peeled commit as source for a legacy %s tag without a release record',
    async (kind) => {
      const f = await fixture()
      const tag = 'v1.2.9'
      if (kind === 'annotated') {
        await git(f.work, 'tag', '--annotate', tag, '--message', 'Legacy release', f.source)
        expect(await git(f.work, 'rev-parse', `refs/tags/${tag}`)).not.toBe(f.source)
      } else {
        await git(f.work, 'tag', tag, f.source)
      }
      expect(await invoke('readTag', [tag], f.work)).toEqual({
        tag,
        version: '1.2.9',
        commit: f.source,
        source: f.source,
      })
    },
  )

  it.each(['1.2.10', 'v1.2.10-beta.1', 'v01.2.10', 'release-source-deadbeef'])(
    'rejects non-stable version tag %s',
    async (tag) => {
      await expect(invoke('readTag', [tag])).rejects.toThrow('无效的稳定版本标签')
    },
  )
})
