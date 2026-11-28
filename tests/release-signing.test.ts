import { execFile } from 'node:child_process'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { REPOSITORY } from '../electron/updates/protocol'

const execute = promisify(execFile)
const script = new URL('../scripts/sign-ci-release.mjs', import.meta.url)
const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const dependencyRoot = await realpath(join(projectRoot, 'node_modules'))
const fakeKey = 'TEST ONLY: not a private key\n'
const directories: string[] = []
const context = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: REPOSITORY,
  GITHUB_REF: 'refs/heads/main',
  GITHUB_EVENT_NAME: 'push',
}

// Preserve HOME unchanged and never copy any real signing secret into a test.
const inheritedEnvironment = Object.fromEntries(
  Object.keys(process.env)
    .filter((key) => !key.startsWith('GITHUB_') && key !== 'UPDATE_SIGNING_PRIVATE_KEY')
    .map((key) => [key, process.env[key]]),
)

function environment(overrides: NodeJS.ProcessEnv = {}) {
  return {
    ...inheritedEnvironment,
    ...context,
    UPDATE_SIGNING_PRIVATE_KEY: fakeKey,
    RELEASE_SIGNING_TEST_MARKER: 'preserved',
    ...overrides,
  }
}

// Import/CLI probes have no filesystem write permission and cannot read the
// user's key directory, even if a future entry-point guard regresses.
const restrictedNode = [
  '--permission',
  `--allow-fs-read=${projectRoot}`,
  `--allow-fs-read=${dependencyRoot}`,
]

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'release-signing-test-'))
  directories.push(directory)
  return { directory, keyPath: join(directory, 'signing', 'private.pem') }
}

// Run the actual helper in a separate Node process so its environment cleanup
// cannot affect Vitest or another test. Operations use only the supplied temp path.
async function runScenario<T>(
  f: Awaited<ReturnType<typeof fixture>>,
  body: string,
  data: Record<string, unknown> = {},
) {
  const result = await execute(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const { withTemporarySigningKey } = await import(process.argv[1]);
const args = JSON.parse(process.argv[2]);
const keyPath = args.keyPath;
const secret = process.env.UPDATE_SIGNING_PRIVATE_KEY;
const originalHome = process.env.HOME;
const hasSecret = () => Object.hasOwn(process.env, 'UPDATE_SIGNING_PRIVATE_KEY');
${body}`,
      script.href,
      JSON.stringify({ ...data, keyPath: f.keyPath }),
    ],
    { env: environment(), cwd: f.directory, timeout: 20_000 },
  )
  return JSON.parse(result.stdout) as T
}

describe('temporary CI signing key lifecycle', () => {
  it('creates a 0600 key, keeps it through the async operation, and excludes the secret from operation and child environments', async () => {
    const f = await fixture()
    const result = await runScenario(
      f,
      `
let during;
const returned = await withTemporarySigningKey(secret, keyPath, async (path) => {
  const child = await execute(process.execPath, ['--input-type=module', '--eval',
    "import { existsSync } from 'node:fs'; console.log(JSON.stringify({ hasSecret: Object.hasOwn(process.env, 'UPDATE_SIGNING_PRIVATE_KEY'), keyExists: existsSync(process.argv[1]), marker: process.env.RELEASE_SIGNING_TEST_MARKER }))",
    path]);
  during = {
    suppliedPathMatches: path === keyPath,
    contentMatches: (await readFile(path, 'utf8')) === secret,
    mode: (await stat(path)).mode & 0o777,
    hasSecret: hasSecret(),
    child: JSON.parse(child.stdout),
  };
  return { signed: true };
});
console.log(JSON.stringify({ during, returned, keyExists: existsSync(keyPath), hasSecret: hasSecret(), homeUnchanged: process.env.HOME === originalHome }));`,
    )
    expect(result).toEqual({
      during: {
        suppliedPathMatches: true,
        contentMatches: true,
        mode: 0o600,
        hasSecret: false,
        child: { hasSecret: false, keyExists: true, marker: 'preserved' },
      },
      returned: { signed: true },
      keyExists: false,
      hasSecret: false,
      homeUnchanged: true,
    })
    expect((await stat(dirname(f.keyPath))).mode & 0o777).toBe(0o700)
    await expect(lstat(f.keyPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['synchronous throw', 'async rejection', 'failed subprocess'])(
    'removes its key and leaves the secret scrubbed after %s',
    async (failure) => {
      const f = await fixture()
      const result = await runScenario(
        f,
        `
const expected = new Error('fixture signing failure');
let during;
const observe = () => {
  during = { contentMatches: readFileSync(keyPath, 'utf8') === secret, hasSecret: hasSecret() };
};
const operation = args.failure === 'synchronous throw' ? () => {
  observe();
  throw expected;
} : async () => {
  observe();
  await Promise.resolve();
  if (args.failure === 'failed subprocess') await execute(process.execPath, ['--eval', 'process.exit(23)']);
  throw expected;
};
let caught;
try { await withTemporarySigningKey(secret, keyPath, operation); }
catch (error) { caught = { sameError: error === expected, code: error.code ?? null }; }
console.log(JSON.stringify({ during, caught, keyExists: existsSync(keyPath), hasSecret: hasSecret(), homeUnchanged: process.env.HOME === originalHome }));`,
        { failure },
      )
      expect(result).toEqual({
        during: { contentMatches: true, hasSecret: false },
        caught: {
          sameError: failure !== 'failed subprocess',
          code: failure === 'failed subprocess' ? 23 : null,
        },
        keyExists: false,
        hasSecret: false,
        homeUnchanged: true,
      })
      await expect(lstat(f.keyPath)).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )

  it('rejects an existing key without changing its bytes, permissions or running the operation', async () => {
    const f = await fixture()
    await mkdir(dirname(f.keyPath), { mode: 0o700 })
    const original = 'TEST ONLY: pre-existing key must survive\n'
    await writeFile(f.keyPath, original, { mode: 0o640 })
    const before = await stat(f.keyPath)
    const result = await runScenario(
      f,
      `
let called = false;
let code;
try { await withTemporarySigningKey(secret, keyPath, () => { called = true; }); }
catch (error) { code = error.code; }
console.log(JSON.stringify({ called, code, hasSecret: hasSecret(), homeUnchanged: process.env.HOME === originalHome }));`,
    )
    expect(result).toEqual({ called: false, code: 'EEXIST', hasSecret: false, homeUnchanged: true })
    expect(await readFile(f.keyPath, 'utf8')).toBe(original)
    const after = await stat(f.keyPath)
    expect({ mode: after.mode, ino: after.ino, mtimeMs: after.mtimeMs }).toEqual({
      mode: before.mode,
      ino: before.ino,
      mtimeMs: before.mtimeMs,
    })
  })

  it('refuses an existing key symlink without following it or deleting its target', async () => {
    const f = await fixture()
    await mkdir(dirname(f.keyPath), { mode: 0o700 })
    const target = join(f.directory, 'original.pem')
    await writeFile(target, 'TEST ONLY: symlink target\n', { mode: 0o600 })
    await symlink(target, f.keyPath)
    const result = await runScenario(
      f,
      `
let called = false;
let code;
try { await withTemporarySigningKey(secret, keyPath, () => { called = true; }); }
catch (error) { code = error.code; }
console.log(JSON.stringify({ called, code, hasSecret: hasSecret() }));`,
    )
    expect(result).toEqual({ called: false, code: 'EEXIST', hasSecret: false })
    expect((await lstat(f.keyPath)).isSymbolicLink()).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('TEST ONLY: symlink target\n')
  })

  it.each([
    { name: 'missing', data: {} },
    { name: 'empty', data: { value: '' } },
    { name: 'whitespace-only', data: { value: ' \n\t' } },
    { name: 'null', data: { value: null } },
  ])(
    'rejects a $name secret before creating the key directory or running the operation',
    async ({ data }) => {
      const f = await fixture()
      const result = await runScenario(
        f,
        `
let called = false;
let message;
try { await withTemporarySigningKey(args.value, keyPath, () => { called = true; }); }
catch (error) { message = error.message; }
console.log(JSON.stringify({ called, message, keyExists: existsSync(keyPath), hasSecret: hasSecret() }));`,
        data,
      )
      expect(result).toEqual({
        called: false,
        message: 'release 环境缺少 UPDATE_SIGNING_PRIVATE_KEY',
        keyExists: false,
        hasSecret: false,
      })
      await expect(lstat(dirname(f.keyPath))).rejects.toMatchObject({ code: 'ENOENT' })
    },
  )
})

describe('signing CI entry point', () => {
  it('can be imported without executing, touching the key path or consuming the secret', async () => {
    const { stdout } = await execute(
      process.execPath,
      [
        ...restrictedNode,
        '--input-type=module',
        '--eval',
        `const secret = process.env.UPDATE_SIGNING_PRIVATE_KEY;
const helper = await import(process.argv[1]);
console.log(JSON.stringify({ helper: typeof helper.withTemporarySigningKey, main: typeof helper.main, secretUnchanged: process.env.UPDATE_SIGNING_PRIVATE_KEY === secret }));`,
        script.href,
      ],
      { env: environment({ GITHUB_ACTIONS: 'false' }), timeout: 20_000 },
    )
    expect(JSON.parse(stdout)).toEqual({
      helper: 'function',
      main: 'function',
      secretUnchanged: true,
    })
  })

  it.each([
    ['outside Actions', { GITHUB_ACTIONS: undefined }],
    ['false Actions flag', { GITHUB_ACTIONS: 'false' }],
    ['another repository', { GITHUB_REPOSITORY: 'fixture/fork' }],
    ['missing repository', { GITHUB_REPOSITORY: undefined }],
    ['feature branch', { GITHUB_REF: 'refs/heads/feature' }],
    ['tag ref', { GITHUB_REF: 'refs/tags/v1.2.11' }],
    ['missing ref', { GITHUB_REF: undefined }],
    ['pull request', { GITHUB_EVENT_NAME: 'pull_request' }],
    ['privileged pull request', { GITHUB_EVENT_NAME: 'pull_request_target' }],
    ['workflow run', { GITHUB_EVENT_NAME: 'workflow_run' }],
    ['scheduled event', { GITHUB_EVENT_NAME: 'schedule' }],
    ['missing event', { GITHUB_EVENT_NAME: undefined }],
  ] as const)(
    'rejects %s via the actual CLI before attempting key access',
    async (_, overrides) => {
      await expect(
        execute(process.execPath, [...restrictedNode, fileURLToPath(script)], {
          env: environment(overrides),
          timeout: 20_000,
        }),
      ).rejects.toThrow('仅在本仓库 main 的 push 或手动 CI 签名步骤中使用')
    },
  )

  it.each(['push', 'workflow_dispatch'])(
    'accepts the intended %s context but stops before key access if the secret is absent',
    async (event) => {
      await expect(
        execute(process.execPath, [...restrictedNode, fileURLToPath(script)], {
          env: environment({ GITHUB_EVENT_NAME: event, UPDATE_SIGNING_PRIVATE_KEY: undefined }),
          timeout: 20_000,
        }),
      ).rejects.toThrow('release 环境缺少 UPDATE_SIGNING_PRIVATE_KEY')
    },
  )
})
