/**
 * Reading the session list off disk.
 *
 * The encoding and file-naming rules here were both derived by inspecting a real store after getting
 * them wrong twice — the first attempt produced a folder name that matched nothing, and the second
 * produced a list with no titles. Each is asserted against the exact string observed on disk, so a
 * future change to either fails loudly here instead of quietly emptying the user's conversation list.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  compareSessionsNewestFirst,
  encodeWorkspaceDir,
  hasStoredSession,
  indexKeyFor,
  indexNamesFor,
  isSameWorkspace,
  listAllStoredSessions,
  listStoredSessions,
  storedSessionWorkspace,
} from '../src/session-index.ts'

/**
 * Remove a temporary store, retried.
 *
 * Windows can refuse the rmdir with ENOTEMPTY while a write is still settling, which surfaces as a
 * test failure rather than a cleanup problem.
 *
 * @param home - Directory to remove.
 */
async function removeHome(home: string): Promise<void> {
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}

test('the workspace folder name matches what the store actually writes', () => {
  // The shape observed on disk, with the account name replaced by a placeholder:
  // ~/.dsh/sessions/--C-Users-me-.dsh-dsh_wechat--. The rule is what matters, not whose account it was.
  assert.equal(
    encodeWorkspaceDir('C:\\Users\\me\\.dsh\\dsh_wechat'),
    '--C-Users-me-.dsh-dsh_wechat--',
  )
  // Runs of separators collapse: `C:` and the `\` after it share one dash, not two.
  assert.equal(encodeWorkspaceDir('C:\\a\\b'), '--C-a-b--')
  // Dots and underscores survive.
  assert.equal(encodeWorkspaceDir('/home/me/my_app'), '--home-me-my_app--')
})

test('the index key drops the session prefix, and both spellings are tried', () => {
  assert.equal(
    indexKeyFor('session-60301096-60301096-39c4-476d-aa41-946e29c149ef'),
    '60301096-60301096-39c4-476d-aa41-946e29c149ef',
  )
  // The store files the channel's own sessions under the full id and registry sessions under the
  // bare uuid, so both are attempted.
  assert.deepEqual(indexNamesFor('session-abc-123'), ['session-abc-123.json', 'abc-123.json'])
  // An id without the prefix has only one spelling.
  assert.deepEqual(indexNamesFor('abc-123'), ['abc-123.json'])
})

test('workspace comparison tolerates separators and case', () => {
  assert.equal(isSameWorkspace('C:\\Users\\me\\x', 'C:/Users/me/x', true), true)
  assert.equal(isSameWorkspace('C:\\Users\\me\\x\\', 'c:\\users\\ME\\x', true), true)
  // A different directory is not the same directory, however similar.
  assert.equal(isSameWorkspace('C:\\Users\\me\\x2', 'C:/Users/me/x', true), false)
})

test('on a case-sensitive filesystem, case distinguishes two directories', () => {
  /*
   * The bug this exists for: the comparison lower-cased every path on every platform. Correct on
   * Windows, wrong on Linux, where `/home/me/Projects` and `/home/me/projects` are two directories —
   * so a stranger's sessions would be counted as the channel's own and adopted under a workspace
   * they do not belong to.
   */
  assert.equal(
    isSameWorkspace('/home/me/Projects', '/home/me/projects', false),
    false,
    'case matters where the filesystem says it does',
  )
  assert.equal(isSameWorkspace('/home/me/x/', '/home/me/x', false), true, 'separators still normalise')
  assert.equal(isSameWorkspace('/home/me/x', '/home/me/x', false), true)
})

/**
 * Build a store shaped like the real one.
 *
 * @param root - Temporary directory to build under.
 * @param workspace - Workspace the sessions belong to.
 * @param sessions - Sessions to write, as `[id, title]`.
 * @param otherWorkspace - Optional second workspace with one session of its own.
 */
async function seedStore(
  root: string,
  workspace: string,
  sessions: [string, string][],
  otherWorkspace?: { cwd: string; id: string; title: string },
): Promise<void> {
  const indexDir = join(root, 'storages', 'session_projcache', 'sessions')
  // The store creates both trees itself; a test writing into them has to as well.
  await mkdir(indexDir, { recursive: true })
  const write = async (cwd: string, id: string, title: string): Promise<void> => {
    const dir = join(root, 'sessions', encodeWorkspaceDir(cwd), id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x')
    // The index is filed under the full id for the channel's own sessions, which is what the real
    // store does.
    await writeFile(
      join(indexDir, `${id}.json`),
      JSON.stringify({ version: 7, record: { identity: { cwd }, rows: { title: { val: title } } } }),
    )
  }
  for (const [id, title] of sessions) await write(workspace, id, title)
  if (otherWorkspace !== undefined) {
    await write(otherWorkspace.cwd, otherWorkspace.id, otherWorkspace.title)
  }
}

/**
 * Record a session with an explicit last-prompt time, as the real store does.
 *
 * @param root - Temporary DSH home.
 * @param cwd - Workspace the session belongs to.
 * @param id - Session id.
 * @param title - Title the store should report.
 * @param lastPromptAt - Value for `sessionListMetadata.lastPromptAt`.
 * @param mtimeSeconds - When to stamp the transcript file, to prove mtime is not read.
 */
async function seedRecorded(
  root: string,
  cwd: string,
  id: string,
  title: string,
  lastPromptAt: number,
  mtimeSeconds?: number,
): Promise<void> {
  const dir = join(root, 'sessions', encodeWorkspaceDir(cwd), id)
  await mkdir(dir, { recursive: true })
  const transcript = join(dir, 'session.v4.jsonl.zstd')
  await writeFile(transcript, 'x')
  await mkdir(join(root, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  await writeFile(
    join(root, 'storages', 'session_projcache', 'sessions', `${id}.json`),
    JSON.stringify({
      version: 7,
      record: {
        identity: { cwd, createdAt: 1 },
        rows: { title: { val: title }, sessionListMetadata: { val: { lastPromptAt } } },
      },
    }),
  )
  if (mtimeSeconds !== undefined) await utimes(transcript, mtimeSeconds, mtimeSeconds)
}

test('the ordering key is the session record, not the file that happens to be newest', async () => {
  /*
   * The bug this pins: `/list all` showed a different "上次时间" for the same conversation on every
   * run, and a different order to match. The time came from the newest mtime in the session folder,
   * which *any* write moves — a background turn, a tool call, the store compacting itself. The record
   * inside the index moves only when the conversation does.
   *
   * The mtimes here are deliberately the wrong way round, so a listing that read them would come out
   * backwards.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    const workspace = join(home, 'dsh_wechat')
    const newerId = 'session-bbbb2222-bbbb2222-x'
    const olderId = 'session-aaaa1111-aaaa1111-x'
    await seedRecorded(home, workspace, newerId, '新的', 1_700_000_100_000, 1_000_000)
    await seedRecorded(home, workspace, olderId, '旧的', 1_700_000_000_000, 2_000_000)

    const listed = await listStoredSessions(home, workspace)
    assert.deepEqual(
      listed.map((session) => session.title),
      ['新的', '旧的'],
    )
    // The value itself is the recorded one, not a file timestamp.
    assert.equal(listed[0]?.updatedAt, 1_700_000_100_000)
    assert.equal(listed[1]?.updatedAt, 1_700_000_000_000)
  } finally {
    await removeHome(home)
  }
})

test('equal timestamps still order completely, and the same store lists identically twice', async () => {
  /*
   * The second half of the same bug. Timestamps collide in practice — a bulk import, a seeded
   * profile, several sessions created in one second — and a sort with only one key leaves ties in
   * whatever order the directory walk produced. The store must not be able to reach the output.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    const workspace = join(home, 'dsh_wechat')
    const stamp = 1_700_000_000_000
    await seedRecorded(home, workspace, 'session-cccc3333-cccc3333-x', '丙', stamp)
    await seedRecorded(home, workspace, 'session-aaaa1111-aaaa1111-x', '甲', stamp)
    await seedRecorded(home, workspace, 'session-bbbb2222-bbbb2222-x', '乙', stamp)

    const first = await listStoredSessions(home, workspace)
    const second = await listStoredSessions(home, workspace)
    assert.deepEqual(
      first.map((session) => session.sessionId),
      second.map((session) => session.sessionId),
    )
    // Byte-for-byte on the rendered value, which is what the user sees.
    assert.equal(JSON.stringify(first), JSON.stringify(second))
    // The tie is broken on the session id, ascending.
    assert.deepEqual(
      first.map((session) => session.title),
      ['甲', '乙', '丙'],
    )
  } finally {
    await removeHome(home)
  }
})

test('the groups of a full listing come out in a fixed order', async () => {
  /*
   * The map a grouped listing is rendered from keeps insertion order, so leaving it to the directory
   * walk put the workspaces in a different order on every run — the same instability one level up.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    const alpha = join(home, 'alpha')
    const beta = join(home, 'beta')
    await seedRecorded(home, beta, 'session-bbbb2222-bbbb2222-x', '贝塔', 1_700_000_500_000)
    await seedRecorded(home, alpha, 'session-aaaa1111-aaaa1111-x', '阿尔法', 1_700_000_500_000)
    await seedRecorded(home, alpha, 'session-cccc3333-cccc3333-x', '阿尔法旧', 1_700_000_000_000)

    const grouped = await listAllStoredSessions(home)
    const order = [...grouped.keys()]
    // Equal recency, so the path decides — and a path is a property of the store, not of the walk.
    assert.deepEqual(order, [alpha, beta])
    assert.deepEqual(
      (grouped.get(alpha) ?? []).map((session) => session.title),
      ['阿尔法', '阿尔法旧'],
    )
    // Asked twice, answered the same way.
    assert.deepEqual([...(await listAllStoredSessions(home)).keys()], order)
  } finally {
    await removeHome(home)
  }
})

test('a record with no last-prompt time falls back to when it was created', async () => {
  // Older index entries predate `sessionListMetadata`, and a session created but never prompted has
  // no prompt time at all. Reporting 0 for both would sink every old conversation to the bottom of
  // the list, which is not what "when did I last use this" means.
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    const workspace = join(home, 'dsh_wechat')
    const indexDir = join(home, 'storages', 'session_projcache', 'sessions')
    await mkdir(indexDir, { recursive: true })
    const id = 'session-dddd4444-dddd4444-x'
    await mkdir(join(home, 'sessions', encodeWorkspaceDir(workspace), id), { recursive: true })
    await writeFile(
      join(indexDir, `${id}.json`),
      JSON.stringify({ record: { identity: { cwd: workspace, createdAt: 1_700_000_123_456 } } }),
    )

    const listed = await listStoredSessions(home, workspace)
    assert.equal(listed[0]?.updatedAt, 1_700_000_123_456)
    assert.equal(listed[0]?.title, '')
  } finally {
    await removeHome(home)
  }
})

test('the comparator is total, so it cannot leave a tie to the sort', () => {
  const stamp = 1_700_000_000_000
  const a = { sessionId: 'session-aaaa1111-aaaa1111-x', updatedAt: stamp }
  const b = { sessionId: 'session-bbbb2222-bbbb2222-x', updatedAt: stamp }
  assert.ok(compareSessionsNewestFirst(a, b) < 0)
  assert.ok(compareSessionsNewestFirst(b, a) > 0)
  assert.equal(compareSessionsNewestFirst(a, { ...a }), 0)
  // Newer always wins, whatever the ids are.
  assert.ok(compareSessionsNewestFirst({ ...b, updatedAt: stamp + 1 }, a) < 0)
})

test('sessions of the channel workspace are listed with their titles', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    const workspace = join(home, 'dsh_wechat')
    await seedStore(home, workspace, [
      ['session-aaaa1111-aaaa1111-x', '修复登录'],
      ['session-bbbb2222-bbbb2222-x', '写周报'],
    ])

    const listed = await listStoredSessions(home, workspace)
    assert.deepEqual(
      listed.map((session) => session.title).sort(),
      ['修复登录', '写周报'].sort(),
    )
    assert.ok(listed.every((session) => session.sessionId.startsWith('session-')))
  } finally {
    await removeHome(home)
  }
})

test('sessions from another workspace are never offered', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    const workspace = join(home, 'dsh_wechat')
    const foreign = join(home, 'some_other_project')
    await seedStore(
      home,
      workspace,
      [['session-aaaa1111-aaaa1111-x', '我的对话']],
      { cwd: foreign, id: 'session-cccc3333-cccc3333-x', title: '别人的对话' },
    )

    const listed = await listStoredSessions(home, workspace)
    // A session from another workspace cannot be adopted — the host pins `cwd` — so offering it
    // would be offering a conversation that fails the moment it is picked.
    assert.deepEqual(
      listed.map((session) => session.title),
      ['我的对话'],
    )
  } finally {
    await removeHome(home)
  }
})

test('a session whose record contradicts its folder is dropped', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    const workspace = join(home, 'dsh_wechat')
    const folder = join(home, 'sessions', encodeWorkspaceDir(workspace))
    const id = 'session-dddd4444-dddd4444-x'
    await mkdir(join(folder, id), { recursive: true })
    await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await writeFile(join(folder, id, 'session.v4.jsonl.zstd'), 'x')
    // Filed under the workspace folder but recording a different `cwd`: the folder name is a lossy
    // encoding, so the record is what decides.
    await writeFile(
      join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`),
      JSON.stringify({
        record: { identity: { cwd: 'C:\\elsewhere' }, rows: { title: { val: 'x' } } },
      }),
    )

    assert.deepEqual(await listStoredSessions(home, workspace), [])
  } finally {
    await removeHome(home)
  }
})

test('a record that exists but cannot be read is not the same as no record at all', async () => {
  /*
   * What this distinction protects: a bound session that the store cannot *read* must not be reported
   * as deleted, because the channel's answer to "deleted" is to start a new conversation. A damaged
   * store does not heal, so that answer would be given again every time the binding aged past the
   * grace window — losing the history each round while saying nothing about why.
   *
   * `storedSessionWorkspace` cannot tell the two apart (it answers undefined for both); this is the
   * question that can.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    const workspace = join(home, 'dsh_wechat')
    const indexPath = join(home, 'storages', 'session_projcache', 'sessions')

    // A readable record, a corrupt one, and one whose index row was evicted while the session's own
    // directory survived — the index is a projection *cache*, so that is a state the store can be in.
    await seedStore(home, workspace, [['session-aaaa1111-aaaa1111-x', '好的']])
    const corrupt = 'session-eeee5555-eeee5555-x'
    await writeFile(join(indexPath, `${corrupt}.json`), '{')
    const evicted = 'session-ffff6666-ffff6666-x'
    await mkdir(join(home, 'sessions', encodeWorkspaceDir(workspace), evicted), { recursive: true })
    await writeFile(join(home, 'sessions', encodeWorkspaceDir(workspace), evicted, 'v.jsonl'), 'x')

    assert.equal(await hasStoredSession(home, 'session-aaaa1111-aaaa1111-x'), true)
    assert.equal(await storedSessionWorkspace(home, corrupt), undefined, 'a broken record reads empty')
    assert.equal(await hasStoredSession(home, corrupt), true, 'but the session is still there')
    assert.equal(await storedSessionWorkspace(home, evicted), undefined)
    assert.equal(await hasStoredSession(home, evicted), true, 'its own directory is evidence enough')
    assert.equal(await hasStoredSession(home, 'session-99999999-99999999-x'), false)
    // A store that is not there at all holds nothing, and must not throw.
    assert.equal(await hasStoredSession(join(home, 'nope'), 'session-99999999-99999999-x'), false)
  } finally {
    await removeHome(home)
  }
})

test('a missing store is an empty list, not a failure', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    // A fresh install has no store at all, and that must not throw — the channel still has to
    // answer /list with whatever it does know.
    assert.deepEqual(await listStoredSessions(join(home, 'nope'), 'C:\\x'), [])
  } finally {
    await removeHome(home)
  }
})

test('one unreadable index entry does not hide the others', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-store-'))
  try {
    const workspace = join(home, 'dsh_wechat')
    await seedStore(home, workspace, [['session-aaaa1111-aaaa1111-x', '好的']])
    const broken = 'session-eeee5555-eeee5555-x'
    const folder = join(home, 'sessions', encodeWorkspaceDir(workspace), broken)
    await mkdir(folder, { recursive: true })
    await mkdir(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
    await writeFile(join(folder, 'session.v4.jsonl.zstd'), 'x')
    await writeFile(join(home, 'storages', 'session_projcache', 'sessions', `${broken}.json`), '{')

    const listed = await listStoredSessions(home, workspace)
    assert.equal(listed.length, 2, 'the damaged entry is still listed, just untitled')
    assert.equal(listed.find((session) => session.sessionId === broken)?.title, '')
    assert.equal(listed.find((session) => session.sessionId.startsWith('session-aaaa'))?.title, '好的')
  } finally {
    await removeHome(home)
  }
})
