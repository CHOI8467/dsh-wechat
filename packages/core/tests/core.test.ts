/**
 * Unit tests for the parts of the client that are easy to get subtly wrong:
 * uint64 identifier precision, inbound filtering, and the in-chat routing rules.
 *
 * These run without a network. The live protocol was verified separately against
 * the service; what is tested here is the logic that sits on top of it.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parseWireJson, extractRawIds, baseInfo, buildHeaders, assertSendAccepted, SendRefusedError } from '../src/http.ts'
import { conversationKey, extractText, toInbound, sendText } from '../src/channel.ts'
import { DEFAULT_SETTINGS, StateStore, SESSION_LIST_HISTORY, SESSION_LIST_TITLE_LIMIT, expirePendingNotifications, findSessionList, latestSessionList, queuePendingNotification, rememberSessionList, type ChannelSettings } from '../src/state.ts'
import {
  SessionRouter,
  SHORT_ID_LENGTH,
  LIST_ALL_GROUP_LIMIT,
  LIST_ALL_LIMIT,
  ambiguousTargetMessage,
  flattenSessionGroups,
  groupSessionRows,
  mintSessionId,
  relativeTime,
  renderSessionList,
  resolveTarget,
  shortId,
  splitCommand,
  HELP_TEXT,
} from '../src/router.ts'
import type { ListedSession, NumberedSession, SessionBinding, SessionGateway, TargetResolution } from '../src/router.ts'
import type { ChannelState } from '../src/state.ts'
import { chargeQuota, quotaLedgerFor, type QuotaEntry } from '../src/quota.ts'
import type { WeixinAccount, WeixinMessage } from '../src/types.ts'

/** A state with nothing in it, for exercising the queue helpers. */
function emptyState(): ChannelState {
  return { version: 1, accounts: {}, syncBufs: {}, contextTokens: {}, bindings: {}, sentMessages: {} }
}

const account: WeixinAccount = {
  accountId: 'fd17bd2d40c3@im.bot',
  token: 'test-token',
  baseUrl: 'https://ilinkai.weixin.qq.com',
}

// ---------------------------------------------------------------------------
// Wire parsing
// ---------------------------------------------------------------------------

test('parseWireJson keeps a 19-digit message id exact', () => {
  // Observed live: a plain JSON.parse rounds this value.
  const raw = '{"msgs":[{"message_id":7512920379619302536,"from_user_id":"u@im.wechat"}]}'
  assert.notEqual(JSON.parse(raw).msgs[0].message_id, '7512920379619302536')

  const parsed = parseWireJson<{ msgs: { message_id: string }[] }>(raw)
  assert.equal(parsed.msgs[0].message_id, '7512920379619302536')
})

test('parseWireJson leaves short numbers and plain text alone', () => {
  const raw = '{"seq":12,"note":"message_id 7512920379619302536 is quoted","n":7512920379619302536}'
  const parsed = parseWireJson<{ seq: number; note: string; n: number }>(raw)
  assert.equal(parsed.seq, 12)
  assert.equal(parsed.note, 'message_id 7512920379619302536 is quoted')
  // A bare number outside the guarded field names stays numeric.
  assert.equal(typeof parsed.n, 'number')
})

test('parseWireJson guards every identifier field', () => {
  const parsed = parseWireJson<{ msg_id: string; svr_id: string }>(
    '{"msg_id":7512920379619302536,"svr_id":123456789012345}',
  )
  assert.equal(parsed.msg_id, '7512920379619302536')
  assert.equal(parsed.svr_id, '123456789012345')
})

test('extractRawIds surfaces identifiers for lossless logging', () => {
  const ids = extractRawIds('{"message_id":7512920379619302536,"msg_id":7512920382394628488}')
  assert.deepEqual(ids, ['7512920379619302536', '7512920382394628488'])
})

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

test('buildHeaders mirrors the official client', () => {
  const anonymous = buildHeaders({})
  assert.equal(anonymous['iLink-App-Id'], 'bot')
  assert.equal(anonymous['iLink-App-ClientVersion'], '204009')
  assert.equal(anonymous.Authorization, undefined)
  assert.equal(anonymous.AuthorizationType, undefined)
  assert.ok(anonymous['X-WECHAT-UIN'].length > 0)

  const authed = buildHeaders({ token: 'abc' })
  assert.equal(authed.Authorization, 'Bearer abc')
  assert.equal(authed.AuthorizationType, 'ilink_bot_token')
})

test('baseInfo reports a stable channel version', () => {
  const info = baseInfo('probe/1')
  assert.equal(info.channel_version, '2.4.9')
  assert.equal(info.bot_agent, 'probe/1')
})

// ---------------------------------------------------------------------------
// Inbound conversion
// ---------------------------------------------------------------------------

function userMessage(overrides: Partial<WeixinMessage> = {}): WeixinMessage {
  return {
    message_id: '7512920379619302536',
    from_user_id: 'o9cq80ztWVe52FfXbkPElc2dANgk@im.wechat',
    to_user_id: 'fd17bd2d40c3@im.bot',
    message_type: 1,
    message_state: 2,
    context_token: 'AARzJWAFAAABAAAAAAC2',
    item_list: [{ type: 1, text_item: { text: '你好' } }],
    ...overrides,
  }
}

test('toInbound converts a text message and keeps the reply token', () => {
  const inbound = toInbound(account, userMessage())
  assert.ok(inbound)
  assert.equal(inbound.text, '你好')
  assert.equal(inbound.peerId, 'o9cq80ztWVe52FfXbkPElc2dANgk@im.wechat')
  assert.equal(inbound.contextToken, 'AARzJWAFAAABAAAAAAC2')
  assert.equal(inbound.conversationId, conversationKey(account.accountId, inbound.peerId))
})

test('toInbound drops the bot\'s own messages to prevent a reply loop', () => {
  assert.equal(toInbound(account, userMessage({ message_type: 2 })), undefined)
})

test('toInbound drops content with no usable text', () => {
  assert.equal(toInbound(account, userMessage({ item_list: [{ type: 2 }] })), undefined)
  assert.equal(toInbound(account, userMessage({ item_list: [] })), undefined)
  assert.equal(toInbound(account, userMessage({ from_user_id: '' })), undefined)
})

test('a media-only message survives with empty text and its attachment attached', () => {
  // Filtering on text alone is what made an incoming photo look like nothing had
  // been sent: the message was dropped before anything could download it.
  const inbound = toInbound(
    account,
    userMessage({
      item_list: [{ type: 2, image_item: { aeskey: '00'.repeat(16), media: { encrypt_query_param: 'p' } } }],
    }),
  )
  assert.ok(inbound, 'a photo with no caption must still reach the runtime')
  assert.equal(inbound.text, '')
  assert.equal(inbound.media?.length, 1)
  assert.equal(inbound.media?.[0].type, 2)
})

test('text and media in one message keep both', () => {
  const inbound = toInbound(
    account,
    userMessage({
      item_list: [
        { type: 1, text_item: { text: '看这张图' } },
        { type: 2, image_item: { media: { encrypt_query_param: 'p' } } },
      ],
    }),
  )
  assert.ok(inbound)
  assert.equal(inbound.text, '看这张图')
  assert.equal(inbound.media?.length, 1)
})

test('a text message carries no media array at all', () => {
  const inbound = toInbound(account, userMessage())
  assert.ok(inbound)
  assert.equal(inbound.media, undefined)
})

test('extractText prefers real text and accepts a voice transcript', () => {
  assert.equal(extractText(userMessage()), '你好')
  assert.equal(
    extractText({ item_list: [{ type: 3, voice_item: { text: '语音转写' } }] }),
    '语音转写',
  )
  assert.equal(
    extractText({ item_list: [{ type: 1, text_item: { text: 'a' } }, { type: 1, text_item: { text: 'b' } }] }),
    'a\nb',
  )
})

test('group messages get their own conversation key', () => {
  const inbound = toInbound(account, userMessage({ group_id: 'g-1' }))
  assert.ok(inbound)
  assert.equal(inbound.groupId, 'g-1')
  assert.notEqual(inbound.conversationId, conversationKey(account.accountId, inbound.peerId))
})

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/** In-memory gateway that records every host call. */
class FakeGateway implements SessionGateway {
  readonly calls: string[] = []
  readonly prompts: { sessionId: string; text: string }[] = []
  sessions: ListedSession[] = []
  /** Sessions belonging to other workspaces, which `listOwnSessions` must exclude. */
  readonly foreign: ListedSession[] = []
  /**
   * Clock for seeded sessions, advanced a second per session.
   *
   * `Date.now()` gives two sessions created in the same millisecond the same timestamp, and the list
   * orders by it — so the order would be whatever the sort happened to do with the tie. Spacing the
   * values keeps the ordering a fact rather than a coincidence.
   */
  #clock = 1_700_000_000_000

  /** Next timestamp for a seeded session, a second after the previous one. */
  nextStamp(): number {
    this.#clock += 1_000
    return this.#clock
  }

  async ensureSession(sessionId: string, title: string): Promise<void> {
    this.calls.push(`ensure:${sessionId}:${title}`)
    if (!this.sessions.some((s) => s.sessionId === sessionId)) {
      // Spaced rather than `Date.now()`, so the list's ordering is a fact and not a tie to break.
      this.sessions.push({ sessionId, title, updatedAt: this.nextStamp() })
    }
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    this.prompts.push({ sessionId, text })
  }

  async listSessions(): Promise<ListedSession[]> {
    return [...this.sessions, ...this.foreign]
  }

  /** What `/list` shows by default: this workspace only. */
  async listOwnSessions(): Promise<ListedSession[]> {
    return [...this.sessions]
  }

  async cancel(sessionId: string): Promise<void> {
    this.calls.push(`cancel:${sessionId}`)
  }
}

/** In-memory binding store. */
function memoryStore() {
  let data: Record<string, SessionBinding> = {}
  return {
    async load() {
      return data
    },
    async save(next: Record<string, SessionBinding>) {
      data = next
    },
    peek: () => data,
  }
}

const conversation = {
  conversationId: 'fd17bd2d40c3@im.bot:user@im.wechat',
  accountId: 'fd17bd2d40c3@im.bot',
  peerId: 'user@im.wechat',
}

test('first message auto-binds a new session and returns a prompt decision', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  const result = await router.route({ ...conversation, text: '帮我看看这个 bug' })
  assert.equal(result.kind, 'prompt')
  if (result.kind !== 'prompt') return
  assert.equal(result.decision.created, true)
  assert.equal(result.decision.prompt, '帮我看看这个 bug')
  assert.match(result.decision.sessionId, /^session-[0-9a-f]{8}-[0-9a-f-]{36}$/)
  // Binding creates the session but delivery belongs to the caller, which owns
  // typing indicators, reply correlation, and streaming.
  assert.deepEqual(gateway.prompts, [])
  assert.ok(gateway.calls.some((call) => call.startsWith(`ensure:${result.decision.sessionId}:`)))
})

test('a second message reuses the same session', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  const first = await router.route({ ...conversation, text: 'one' })
  const second = await router.route({ ...conversation, text: 'two' })
  assert.equal(first.kind, 'prompt')
  assert.equal(second.kind, 'prompt')
  if (first.kind !== 'prompt' || second.kind !== 'prompt') return
  assert.equal(first.decision.sessionId, second.decision.sessionId)
  assert.equal(second.decision.created, false)
  // The reused session is re-ensured so a host restart cannot strand it.
  assert.ok(gateway.calls.some((call) => call.startsWith(`ensure:${first.decision.sessionId}:`)))
})

test('/new creates a distinct session', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  const first = await router.route({ ...conversation, text: 'hello' })
  const created = await router.route({ ...conversation, text: '/new 重构任务' })
  const after = await router.route({ ...conversation, text: '继续' })

  assert.equal(created.kind, 'reply')
  if (created.kind === 'reply') assert.match(created.text, /重构任务/)
  assert.equal(first.kind, 'prompt')
  assert.equal(after.kind, 'prompt')
  if (first.kind !== 'prompt' || after.kind !== 'prompt') return
  assert.notEqual(first.decision.sessionId, after.decision.sessionId)
})

test('/list marks the current session and /switch moves between them', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  const first = await router.route({ ...conversation, text: 'first session' })
  const created = await router.route({ ...conversation, text: '/new 第二个' })
  assert.equal(first.kind, 'prompt')
  assert.equal(created.kind, 'reply')
  if (first.kind !== 'prompt') return

  // The marker sits on the session we just created.
  const listed = await router.route({ ...conversation, text: '/list' })
  assert.equal(listed.kind, 'reply')
  if (listed.kind !== 'reply') return
  const markedLine = listed.text.split('\n').find((line) => line.includes('← 当前'))
  assert.ok(markedLine, 'expected a current-session marker')
  assert.match(markedLine, /第二个/)

  // Switch to the *first* session by its short id, which is unambiguous.
  const switched = await router.route({
    ...conversation,
    text: `/switch ${first.decision.sessionId}`,
  })
  assert.equal(switched.kind, 'reply')
  if (switched.kind === 'reply') assert.match(switched.text, /已切换/)

  const after = await router.route({ ...conversation, text: '/current' })
  if (after.kind !== 'reply') return
  assert.match(after.text, new RegExp(shortId(first.decision.sessionId)))
  assert.doesNotMatch(after.text, /第二个/)
})

test('/list shows this workspace and mentions the rest, and /list all shows everything', async () => {
  /*
   * The typed and spoken routes have to agree. Before this, `/list` printed every session on the
   * machine — sixty-six of them here, ten of which belonged to this workspace — while a spoken
   * request showed only the ten and said how many others existed. The same question giving two
   * different answers is what makes a command feel broken.
   */
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  await router.route({ ...conversation, text: 'one' })
  const mine = await gateway.listSessions()
  // A session belonging to another project, which the gateway reports separately.
  gateway.foreign.push({
    sessionId: 'session-ffff9999-ffff9999-x',
    title: '别处的工作',
    updatedAt: gateway.nextStamp(),
    workspace: 'C:\\Users\\me\\some_project',
  })

  const own = await router.route({ ...conversation, text: '/list' })
  assert.equal(own.kind, 'reply')
  if (own.kind !== 'reply') return
  // The count includes the held sessions, so the user knows the size of what they are not seeing.
  assert.match(own.text, new RegExp(`共 ${String(mine.length + 1)} 个`))
  assert.doesNotMatch(own.text, /别处的工作/, 'the default list is this workspace only')
  assert.match(own.text, /另有 1 个对话在其它工作区（some_project）/)
  // And how to reach them, or the hint is useless.
  assert.match(own.text, /\/list all/)

  const all = await router.route({ ...conversation, text: '/list all' })
  assert.equal(all.kind, 'reply')
  if (all.kind !== 'reply') return
  assert.match(all.text, /别处的工作/, 'the wider list shows it')
  assert.doesNotMatch(all.text, /另有/, 'nothing is being held back now')
  // Grouped rather than flat: each workspace gets its own heading, which is the only thing that says
  // which project a row came from.
  assert.match(all.text, /【微信会话】/)
  assert.match(all.text, /【some_project】/)
})

test('a listing groups by workspace, and numbers the rows it prints', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({
    gateway,
    store: memoryStore(),
    ownWorkspace: 'C:\\Users\\me\\dsh_wechat',
  })
  await router.route({ ...conversation, text: 'one' })
  gateway.foreign.push(
    {
      sessionId: 'session-bbbb2222-bbbb2222-x',
      title: '优化封面图',
      updatedAt: gateway.nextStamp(),
      workspace: 'C:\\Users\\me\\Desktop\\DH\\workplace',
    },
    {
      sessionId: 'session-cccc3333-cccc3333-x',
      title: '修 bug',
      updatedAt: gateway.nextStamp(),
      workspace: 'C:\\Users\\me\\Desktop\\DH\\workplace',
    },
  )

  const listed = await router.route({ ...conversation, text: '/list all' })
  assert.equal(listed.kind, 'reply')
  if (listed.kind !== 'reply') return

  const rows = listed.text.split('\n').filter((line) => /^\d+\. /.test(line))
  assert.equal(rows.length, 3)
  // The numbering runs on across headings, which is what makes a single number enough to reply with.
  assert.match(rows[0]!, /^1\. /)
  assert.match(rows[2]!, /^3\. /)
  // Every row ends with the short form of its own id, which is what `/switch <id>` accepts.
  for (const line of rows) {
    const id = /  ([0-9a-f]{1,6})$/.exec(line)?.[1]
    assert.ok(id, `no short id at the end of the row: ${line}`)
    assert.ok(id.length <= 6, `short id longer than six characters: ${id}`)
  }

  // And the numbering the reply reports is exactly what it printed, in the same order — this is what
  // the caller freezes so a quote can resolve against it later.
  assert.deepEqual(
    listed.numbered?.map((session) => session.sessionId),
    [
      gateway.sessions[0]!.sessionId,
      gateway.foreign[1]!.sessionId,
      gateway.foreign[0]!.sessionId,
    ],
    'own workspace first, then the others newest first',
  )
})

/**
 * The workspace headings of a rendered listing, with the rows printed under each.
 *
 * Read back out of the message rather than out of the renderer's own structures, because the bug this
 * is used to catch was visible only in the text the user receives.
 *
 * @param text - A rendered listing.
 * @returns Headings in display order, each mapped to its numbered rows.
 */
function listingGroups(text: string): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of text.split('\n')) {
    const heading = /^【(.+)】$/.exec(line)
    if (heading) {
      current = []
      groups.set(heading[1]!, current)
      continue
    }
    if (current !== undefined && /^\d+\. /.test(line)) current.push(line)
  }
  return groups
}

test('/list all gives every workspace a share, so the busiest one cannot crowd the others out', async () => {
  /*
   * The failure this exists for: the row limit was applied to the whole machine *before* the rows were
   * grouped, and this workspace is almost always the busiest one. So `/list all` printed rows from this
   * workspace alone, grouping then produced a single heading, and the reply was indistinguishable from
   * plain `/list` — the user asked to see every conversation and was shown one workspace twice.
   *
   * The assertion is therefore about the number of *headings*. Under a single global cut this test sees
   * one, whatever the row count says.
   */
  const gateway = new FakeGateway()
  const router = new SessionRouter({
    gateway,
    store: memoryStore(),
    ownWorkspace: 'C:\\Users\\me\\dsh_wechat',
  })

  // The other workspaces are seeded first, and are therefore older than everything this workspace
  // holds: a global top ten would be nothing but this workspace, which is the state being reproduced.
  gateway.foreign.push(
    {
      sessionId: 'session-ffff9999-ffff9999-x',
      title: '别处的工作',
      updatedAt: gateway.nextStamp(),
      workspace: 'C:\\Users\\me\\some_project',
    },
    {
      sessionId: 'session-eeee8888-eeee8888-x',
      title: '另一个项目',
      updatedAt: gateway.nextStamp(),
      workspace: 'C:\\Users\\me\\dsh_orb',
    },
  )
  for (let index = 0; index < 12; index += 1) {
    gateway.sessions.push({
      sessionId: `session-${String(index).padStart(4, '0')}aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      title: `本工作区 ${String(index)}`,
      updatedAt: gateway.nextStamp(),
      workspace: 'C:\\Users\\me\\dsh_wechat',
    })
  }

  const all = await router.route({ ...conversation, text: '/list all' })
  assert.equal(all.kind, 'reply')
  if (all.kind !== 'reply') return

  const groups = listingGroups(all.text)
  assert.ok(groups.size >= 2, `expected rows from several workspaces, got:\n${all.text}`)
  assert.ok(groups.has('some_project'), 'a workspace other than this one has to be visible')
  assert.ok(groups.has('dsh_orb'))
  // Every workspace gets the same share, this one included — that equality is what makes room for the
  // others; a larger share here would put the bug back.
  assert.equal(groups.get('微信会话')?.length, LIST_ALL_GROUP_LIMIT)
  // A workspace with a single conversation is still shown in full.
  assert.equal(groups.get('some_project')?.length, 1)

  // The total stays bounded, so "see every workspace" cannot turn into an unreadable message.
  const rows = all.text.split('\n').filter((line) => /^\d+\. /.test(line))
  assert.equal(rows.length, LIST_ALL_GROUP_LIMIT + 1 + 1)
  assert.ok(rows.length <= LIST_ALL_LIMIT)
  // Truncation is counted rather than silent, and the wording is the quota's rather than "older":
  // rows dropped by a share can be newer than rows still on screen.
  assert.match(all.text, new RegExp(`每个工作区最多显示 ${String(LIST_ALL_GROUP_LIMIT)} 个`))
  assert.match(all.text, /（还有 9 个对话未显示）/)
  // The trailing id is explained as a way to switch, with an example taken from this very listing —
  // printing it without saying what it is for is what left it looking like decoration.
  const newestOwn = gateway.sessions.at(-1)!
  assert.match(all.text, /行尾那个 6 位 id/)
  assert.match(all.text, new RegExp(`如第 1 行的 ${shortId(newestOwn.sessionId)}`))

  // And the default list is unchanged: this workspace only, still up to its own ten rows.
  const own = await router.route({ ...conversation, text: '/list' })
  assert.equal(own.kind, 'reply')
  if (own.kind !== 'reply') return
  const ownGroups = listingGroups(own.text)
  assert.deepEqual(
    [...ownGroups.keys()],
    ['微信会话'],
    'the default list is still this workspace only',
  )
  assert.equal(ownGroups.get('微信会话')?.length, 10)
  assert.doesNotMatch(own.text, /别处的工作|另一个项目/)
  assert.match(own.text, /另有 2 个对话在其它工作区/)
})

test('/list all stops at a readable length however many workspaces there are', () => {
  /*
   * The other half of the requirement: a share per workspace is not a bound on its own. Six workspaces
   * at four rows each is twenty-four rows, which is a wall of text on a phone — so the total is capped
   * as well, and what does not fit is counted out loud.
   */
  const rows: ListedSession[] = []
  for (let group = 0; group < 6; group += 1) {
    for (let row = 0; row < 4; row += 1) {
      rows.push({
        sessionId: `session-${String(group)}${String(row)}aaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
        title: `项目 ${String(group)} 的第 ${String(row)} 个`,
        updatedAt: 1_800_000_000_000 - group * 1_000 - row,
        workspace: `C:\\Users\\me\\project${String(group)}`,
      })
    }
  }

  const groups = groupSessionRows(rows, {
    ownLabel: '微信会话',
    limit: LIST_ALL_LIMIT,
    groupLimit: LIST_ALL_GROUP_LIMIT,
  })
  assert.equal(flattenSessionGroups(groups).length, LIST_ALL_LIMIT, 'the cap is the cap')
  assert.equal(groups.length, LIST_ALL_LIMIT / LIST_ALL_GROUP_LIMIT, 'four whole workspaces fit')
  assert.deepEqual(
    groups.map((group) => group.label),
    ['project0', 'project1', 'project2', 'project3'],
    'the budget goes to the most recently active workspaces',
  )

  const text = renderSessionList(groups, undefined, {
    total: rows.length,
    groupLimit: LIST_ALL_GROUP_LIMIT,
  })
  // 24 conversations, 12 printed, so 12 are owed an explanation.
  assert.match(text, /（还有 12 个对话未显示）/)
  assert.match(text, /共 24 个对话（每个工作区最多显示 3 个）/)
})

test('the same listing is byte-identical however the store hands the rows over', () => {
  /*
   * The regression this exists for: `/list all` printed a different order on every run, and a
   * different "上次时间" beside the same conversation. The order came from the directory walk and the
   * time from a file's mtime, so neither was a property of the data — and with several sessions
   * sharing a timestamp (imports, bulk runs) there was no tie-break to save it.
   *
   * Two things are checked together, because they are one bug: equal timestamps must still order
   * deterministically, and the input order must not be able to reach the output at all.
   */
  const stamp = 1_700_000_000_000
  const rows: ListedSession[] = [
    { sessionId: 'session-aaaa1111-aaaa1111-x', title: '甲', updatedAt: stamp },
    { sessionId: 'session-bbbb2222-bbbb2222-x', title: '乙', updatedAt: stamp },
    { sessionId: 'session-cccc3333-cccc3333-x', title: '丙', updatedAt: stamp },
    { sessionId: 'session-dddd4444-dddd4444-x', title: '丁', updatedAt: stamp - 1 },
  ]
  const render = (input: readonly ListedSession[]): string =>
    renderSessionList(groupSessionRows(input, { ownLabel: '微信会话' }), undefined, {
      now: stamp + 60_000,
    })

  const forward = render(rows)
  const backward = render([...rows].reverse())
  assert.equal(forward, backward, 'the input order must not survive into the output')
  // Byte-for-byte, not merely "same rows": this is the assertion the pnpm test run makes on the
  // rendered message, so any instability shows up here first.
  assert.equal(render([...rows].reverse()), forward)

  // The tie is broken on the id, ascending, so the equal-timestamp rows come out in a fixed order —
  // and the older one still follows them, because time is still the first key.
  const order = forward
    .split('\n')
    .filter((line) => /^\d+\. /.test(line))
    .map((line) => /^\d+\. (\S+)/.exec(line)?.[1])
  assert.deepEqual(order, ['甲', '乙', '丙', '丁'])
})

test('relative times read the way a person says them', () => {
  const now = 1_800_000_000_000
  assert.equal(relativeTime(now - 10_000, now), '刚刚')
  assert.equal(relativeTime(now - 3 * 60_000, now), '3 分钟前')
  assert.equal(relativeTime(now - 2 * 3_600_000, now), '2 小时前')
  assert.equal(relativeTime(now - 25 * 3_600_000, now), '昨天')
  assert.equal(relativeTime(now - 3 * 24 * 3_600_000, now), '3 天前')
  // A week on, a date is more use than a count nobody converts in their head.
  assert.doesNotMatch(relativeTime(now - 30 * 24 * 3_600_000, now), /前/)
})

test('a pinned listing decides what a number means', async () => {
  /*
   * Why this matters: a number identifies a row of a *listing*, and a listing is a photograph of a
   * machine that keeps moving. Answering "2" from whatever is newest at that moment means the user
   * can point at one conversation and land in another — which is the failure the quote-pinned
   * numbering exists to remove.
   *
   * The same argument is deliberately read twice below, against two different listings, and it has to
   * mean two different conversations.
   */
  const gateway = new FakeGateway()
  const store = memoryStore()
  const router = new SessionRouter({ gateway, store })

  const first = await router.route({ ...conversation, text: '第一条' })
  assert.equal(first.kind, 'prompt')
  if (first.kind !== 'prompt') return
  await router.route({ ...conversation, text: '/new 第二个' })
  const newest = store.peek()[conversation.conversationId]?.sessionId
  assert.ok(newest && newest !== first.decision.sessionId)

  // What the user was shown: the older conversation on row 1, the newer one on row 2.
  const pinned: NumberedSession[] = [
    { sessionId: first.decision.sessionId, title: '第一条' },
    { sessionId: newest, title: '第二个' },
  ]

  const toFirst = await router.route({ ...conversation, text: '/switch 1', numbered: pinned })
  assert.equal(toFirst.kind, 'reply')
  if (toFirst.kind === 'reply') assert.match(toFirst.text, /已切换到「第一条」/)
  assert.equal(store.peek()[conversation.conversationId]?.sessionId, first.decision.sessionId)

  const toSecond = await router.route({ ...conversation, text: '/switch 2', numbered: pinned })
  assert.equal(toSecond.kind, 'reply')
  if (toSecond.kind === 'reply') assert.match(toSecond.text, /已切换到「第二个」/)
  assert.equal(store.peek()[conversation.conversationId]?.sessionId, newest)

  // The live list is ordered the other way round, so the same "2" without a pin names the *other*
  // conversation. Both behaviours are wanted: a pin is what makes the number mean what the user saw.
  await router.route({ ...conversation, text: '/switch 2' })
  assert.equal(
    store.peek()[conversation.conversationId]?.sessionId,
    first.decision.sessionId,
    'unpinned numbers still come from the live list',
  )
})

test('a numbered listing survives a save and a reload', async () => {
  /*
   * The field this covers is a new one in `state.json`, and the store's reader is an allowlist: a
   * field added to `ChannelState` and forgotten in `normalize` saves perfectly and is gone after the
   * next restart. That has happened here before, with settings, so the round trip is asserted rather
   * than assumed.
   *
   * The extra `update(() => {})` is the part that matters: every write re-reads and re-normalizes,
   * so a field the normalizer drops disappears on the *next* write and takes one more restart to
   * notice.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-state-'))
  try {
    const file = join(home, 'state.json')
    const store = new StateStore(file)
    await store.update((state) => {
      rememberSessionList(state, 'acct', 'acct:peer', {
        messageId: 'msg-1',
        sessions: [{ sessionId: 'session-aaaa1111-aaaa1111-x', title: '甲' }],
        at: 1_700_000_000_000,
      })
      rememberSessionList(state, 'acct', 'acct:peer', {
        messageId: 'msg-2',
        sessions: [
          { sessionId: 'session-aaaa1111-aaaa1111-x', title: '甲' },
          { sessionId: 'session-bbbb2222-bbbb2222-x', title: '乙' },
        ],
        at: 1_700_000_001_000,
      })
    })
    await store.update(() => {})

    const reloaded = await new StateStore(file).read()
    assert.deepEqual(findSessionList(reloaded, 'acct', 'msg-2')?.sessions, [
      { sessionId: 'session-aaaa1111-aaaa1111-x', title: '甲' },
      { sessionId: 'session-bbbb2222-bbbb2222-x', title: '乙' },
    ])
    // The older one is still there, keyed by its own message id.
    assert.equal(findSessionList(reloaded, 'acct', 'msg-1')?.sessions.length, 1)
    // And the conversation's newest listing is the one a bare number answers from.
    assert.equal(latestSessionList(reloaded, 'acct', 'acct:peer')?.messageId, 'msg-2')
    // Another account sees nothing, so a shared machine cannot resolve across bots.
    assert.equal(findSessionList(reloaded, 'other', 'msg-2'), undefined)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a malformed numbered listing is dropped instead of resolving a number to nothing', async () => {
  /*
   * Read back and acted on: a row without a session id would reach the session controller as a
   * request to adopt `undefined`. Dropping the entry costs one stale number; guessing at what the
   * user was looking at costs a switch to the wrong conversation.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-state-'))
  try {
    const file = join(home, 'state.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        sessionLists: {
          acct: {
            'acct:peer': [
              { messageId: 'msg-1', at: 1, sessions: [{ sessionId: 'session-aaaa-x', title: '甲' }] },
              { messageId: '', at: 2, sessions: [{ sessionId: 'session-bbbb-x', title: '乙' }] },
              { messageId: 'msg-3', at: 3, sessions: [] },
              { messageId: 'msg-4', at: 4, sessions: [{ sessionId: 7, title: '丙' }] },
              { messageId: 'msg-5', at: 'soon', sessions: [{ sessionId: 'session-eeee-x', title: '戊' }] },
              'not an entry',
            ],
          },
          'not-an-account': 'nope',
        },
      }),
      'utf8',
    )

    const state = await new StateStore(file).read()
    assert.equal(findSessionList(state, 'acct', 'msg-1')?.sessions.length, 1, 'the good one stays')
    assert.equal(findSessionList(state, 'acct', 'msg-3'), undefined, 'an empty numbering is unusable')
    assert.equal(findSessionList(state, 'acct', 'msg-4'), undefined, 'a non-string id is unusable')
    assert.equal(findSessionList(state, 'acct', 'msg-5'), undefined, 'a non-numeric time is unusable')
    assert.equal(state.sessionLists?.acct?.['acct:peer']?.length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a stored listing keeps its rows and trims a paragraph-long title', () => {
  // The state file is rewritten whole on every change, and a session is named from the user's first
  // sentence — so an untrimmed title would make every later write carry a paragraph times fifty.
  const state = emptyState()
  const paragraph = '请'.repeat(4_000)
  rememberSessionList(state, 'acct', 'acct:peer', {
    messageId: 'msg-1',
    sessions: [{ sessionId: 'session-aaaa1111-aaaa1111-x', title: paragraph }],
    at: 1_700_000_000_000,
  })
  const stored = latestSessionList(state, 'acct', 'acct:peer')?.sessions[0]
  assert.equal(stored?.sessionId, 'session-aaaa1111-aaaa1111-x')
  assert.equal(stored?.title.length, SESSION_LIST_TITLE_LIMIT)
  assert.ok(paragraph.startsWith(stored?.title ?? ''), 'the head of the title, not a rewrite')
})

test('only the newest few listings are kept, so the state file cannot grow without bound', () => {
  const state = emptyState()
  for (let i = 0; i < SESSION_LIST_HISTORY + 4; i += 1) {
    rememberSessionList(state, 'acct', 'acct:peer', {
      messageId: `msg-${String(i)}`,
      sessions: [{ sessionId: `session-${String(i)}-x`, title: `第 ${String(i)} 个` }],
      at: 1_700_000_000_000 + i,
    })
  }
  const kept = state.sessionLists?.acct?.['acct:peer'] ?? []
  assert.equal(kept.length, SESSION_LIST_HISTORY)
  // The newest survive, which is what matters: only a recent list is ever quoted.
  assert.equal(latestSessionList(state, 'acct', 'acct:peer')?.messageId, `msg-${String(SESSION_LIST_HISTORY + 3)}`)
  assert.equal(findSessionList(state, 'acct', 'msg-0'), undefined, 'the oldest is gone')
})

test('a binding moves on, and switching back points at that session again', async () => {
  /*
   * This replaced a test of the session-owner map, which was removed.
   *
   * The map existed to answer "which conversation does this session belong to?" for sessions a
   * conversation had left, because `bindings` only records where it is now. That turned out to be
   * unnecessary — and actively harmful: a session the conversation had moved away from stayed an
   * owner forever, and ownership was being read as permission to send messages. A conversation that
   * switched away left its former session able to speak for it indefinitely.
   *
   * What actually has to hold is the pair below: the binding moves, and switching back restores it.
   */
  const gateway = new FakeGateway()
  const store = memoryStore()
  const router = new SessionRouter({ gateway, store })

  const first = await router.route({ ...conversation, text: 'one' })
  assert.equal(first.kind, 'prompt')
  if (first.kind !== 'prompt') return
  await router.route({ ...conversation, text: '/new 修复登录' })

  // The binding moved: the old session is no longer the one this conversation points at.
  assert.equal(
    Object.values(store.peek()).some((entry) => entry.sessionId === first.decision.sessionId),
    false,
    'the binding really did move on',
  )

  // And switching back by short id restores it, so tools called from it resolve again — which is the
  // case the owner map was built for, now handled by the binding itself.
  const back = await router.route({ ...conversation, text: `/switch ${shortId(first.decision.sessionId)}` })
  assert.equal(back.kind, 'reply')
  if (back.kind !== 'reply') return
  assert.match(back.text, /已切换/)
  assert.equal(
    Object.values(store.peek())[0]?.sessionId,
    first.decision.sessionId,
    'switching back makes it the bound session again',
  )
})

test('routing state survives a new router instance', async () => {
  const gateway = new FakeGateway()
  const store = memoryStore()
  const router = new SessionRouter({ gateway, store })
  const first = await router.route({ ...conversation, text: 'one' })

  const reborn = new SessionRouter({ gateway, store })
  const second = await reborn.route({ ...conversation, text: 'two' })

  assert.equal(first.kind, 'prompt')
  assert.equal(second.kind, 'prompt')
  if (first.kind !== 'prompt' || second.kind !== 'prompt') return
  assert.equal(first.decision.sessionId, second.decision.sessionId)
})

test('/cancel and /current are answered locally', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })

  // With no binding yet, both commands answer with guidance instead of calling out.
  const noSession = await router.route({ ...conversation, text: '/cancel' })
  assert.equal(noSession.kind, 'reply')
  if (noSession.kind === 'reply') assert.match(noSession.text, /没有对话/)
  assert.equal(gateway.calls.length, 0)

  const bound = await router.route({ ...conversation, text: 'work' })
  assert.equal(bound.kind, 'prompt')

  const current = await router.route({ ...conversation, text: '/current' })
  assert.equal(current.kind, 'reply')
  if (current.kind === 'reply') assert.match(current.text, /当前对话/)

  const cancelled = await router.route({ ...conversation, text: '/cancel' })
  assert.equal(cancelled.kind, 'reply')
  if (cancelled.kind === 'reply') assert.match(cancelled.text, /已请求中断/)
  assert.ok(gateway.calls.some((call) => call.startsWith('cancel:')))
})

test('an unknown command explains itself instead of reaching the agent', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  const result = await router.route({ ...conversation, text: '/nope' })
  assert.equal(result.kind, 'reply')
  if (result.kind === 'reply') assert.match(result.text, /未知指令/)
  assert.equal(gateway.prompts.length, 0)
})

test('/help returns the command list and never prompts', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  const result = await router.route({ ...conversation, text: '/help' })
  assert.equal(result.kind, 'reply')
  if (result.kind === 'reply') assert.equal(result.text, HELP_TEXT)
  assert.equal(gateway.prompts.length, 0)
})

// ---------------------------------------------------------------------------
// State store
// ---------------------------------------------------------------------------

test('a store seeds from an existing file without losing its contents', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wechat-state-'))
  try {
    const file = join(dir, 'state.json')
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        accounts: { 'bot@im.bot': { accountId: 'bot@im.bot', token: 't', baseUrl: 'u' } },
        syncBufs: { 'bot@im.bot': 'cursor' },
        contextTokens: { 'bot@im.bot': { conv: 'ctx' } },
        bindings: {},
        autoStart: true,
      }),
      'utf8',
    )

    const store = new StateStore(file)
    // Concurrent reads must all observe the file, not a fallback empty state. A
    // non-idempotent load would cache the empty state and drop the account.
    const [first, second, third] = await Promise.all([store.read(), store.read(), store.read()])
    for (const state of [first, second, third]) {
      assert.ok(state.accounts['bot@im.bot'], 'seeded account must survive concurrent reads')
      assert.equal(state.syncBufs['bot@im.bot'], 'cursor')
      assert.equal(state.autoStart, true)
    }

    // A write issued while the load was in flight must build on the file, not on
    // an empty state.
    const store2 = new StateStore(file)
    const read = store2.read()
    const update = store2.update((state) => {
      state.autoStart = false
    })
    await Promise.all([read, update])
    const after = await store2.read()
    assert.ok(after.accounts['bot@im.bot'], 'concurrent write must not discard the account')
    assert.equal(after.autoStart, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

test('every setting survives a save and a reload', async () => {
  /*
   * The reload is the step that used to eat them. `StateStore.update` re-reads and re-normalizes
   * before persisting, and the normalizer kept a hand-copied list of seven settings — so anything
   * added after it was written (`permissionPreset`, `allowCrossSessionNotify`, `workspacePath`) was
   * dropped on the very next write and gone by the next restart.
   *
   * The count check below is the part that keeps this honest: a setting added to the defaults
   * without a line here would leave the test passing while covering less than it claims.
   */
  const wanted: ChannelSettings = {
    mergeWindowMs: 4_321,
    maxReplyChars: 1_234,
    settleMs: 987,
    quoteHistory: 7,
    autoReplyAttachments: false,
    requireConfirmation: false,
    permissionPreset: 'auto',
    allowCrossSessionNotify: false,
    workspacePath: 'C:\\chosen-workspace',
    presenceNote: 'round-trip note',
  }
  assert.equal(
    Object.keys(wanted).length,
    Object.keys(DEFAULT_SETTINGS).length,
    'this test names every setting in DEFAULT_SETTINGS',
  )

  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-state-'))
  try {
    const file = join(home, 'state.json')
    const store = new StateStore(file)
    await store.update((state) => {
      state.settings = wanted
    })
    // Forces the read-normalize-write cycle that dropped them.
    await store.update(() => {})
    const stored = (await new StateStore(file).read()).settings ?? {}
    assert.deepEqual(stored, wanted)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('splitCommand tolerates a missing separator, as typed on a phone', () => {
  assert.deepEqual(splitCommand('/list'), { command: '/list', args: '' })
  assert.deepEqual(splitCommand('/NEW  我的 任务 '), { command: '/new', args: '我的 任务' })
  // The common phone-keyboard case: the space never got typed. A numeric argument
  // is unambiguous, and CJK text is too.
  assert.deepEqual(splitCommand('/switch1'), { command: '/switch', args: '1' })
  assert.deepEqual(splitCommand('/new我的任务'), { command: '/new', args: '我的任务' })
  // A colon works in place of the space.
  assert.deepEqual(splitCommand('/switch:2'), { command: '/switch', args: '2' })
  // A command-looking prefix followed by an ASCII letter is a different word, not a
  // glued argument: otherwise `/news` would silently create a session. A short id
  // that starts with a letter therefore needs its separator.
  assert.deepEqual(splitCommand('/news'), { command: '/news', args: '' })
  assert.deepEqual(splitCommand('/switchabc123'), { command: '/switchabc123', args: '' })
  assert.deepEqual(splitCommand('/switch abc123'), { command: '/switch', args: 'abc123' })
})

test('a missing separator still switches the session', async () => {
  const gateway = new FakeGateway()
  const router = new SessionRouter({ gateway, store: memoryStore() })
  const first = await router.route({ ...conversation, text: 'one' })
  await router.route({ ...conversation, text: '/new 第二个' })
  assert.equal(first.kind, 'prompt')
  if (first.kind !== 'prompt') return

  /*
   * The position is read from the list rather than assumed to be 1.
   *
   * Both sessions used to be stamped in the same millisecond, so which one sorted first was a tie
   * the sort happened to break — and the test only ever passed because the tie broke the way it
   * needed. With the timestamps spaced, the newer session sorts first and the older one is second.
   */
  const listed = await router.route({ ...conversation, text: '/list' })
  if (listed.kind !== 'reply') return
  const position = listed.text
    .split('\n')
    .filter((line) => /^\d+\. /.test(line))
    .findIndex((line) => line.includes(shortId(first.decision.sessionId)))
  assert.ok(position >= 0, `the first session is missing from the list: ${listed.text}`)

  // Switch by list position with no space, the way it gets typed on a phone.
  const switched = await router.route({ ...conversation, text: `/switch${String(position + 1)}` })
  assert.equal(switched.kind, 'reply')
  if (switched.kind === 'reply') assert.match(switched.text, /已切换/)

  const current = await router.route({ ...conversation, text: '/current' })
  if (current.kind !== 'reply') return
  assert.match(current.text, new RegExp(shortId(first.decision.sessionId)))
})

/** One row as the gateway hands it over. Times are irrelevant to resolution, so they stay zero. */
function row(sessionId: string, title = '甲', workspace?: string): ListedSession {
  return { sessionId, title, updatedAt: 0, ...(workspace === undefined ? {} : { workspace }) }
}

/**
 * The session a resolution found, or undefined when it found none or several.
 *
 * @param resolution - What `resolveTarget` returned.
 */
function found(resolution: TargetResolution): NumberedSession | undefined {
  return resolution.kind === 'found' ? resolution.session : undefined
}

test('resolveTarget accepts an index, a full id, the short id, and a title', () => {
  // Realistically shaped ids, minted the same way the router mints them.
  const first = mintSessionId(() => 'aaaa1111-2222-3333-4444-555566667777')
  const second = mintSessionId(() => 'bbbb1111-2222-3333-4444-555566667777')
  const sessions = [row(first, '甲'), row(second, '乙')]
  assert.equal(found(resolveTarget('1', sessions))?.title, '甲')
  assert.equal(found(resolveTarget('2', sessions))?.title, '乙')
  assert.equal(found(resolveTarget(second, sessions))?.title, '乙')
  // The short id `/list` prints is exactly what `/switch` accepts.
  assert.equal(found(resolveTarget(shortId(second), sessions))?.title, '乙')
  assert.equal(found(resolveTarget('甲', sessions))?.title, '甲')
  assert.equal(resolveTarget('', sessions).kind, 'none')
  assert.equal(resolveTarget('9', sessions).kind, 'none')
  // A suffix shared by several sessions is ambiguous and must not guess.
  assert.equal(resolveTarget('4444-555566667777', sessions).kind, 'ambiguous')
  assert.equal(resolveTarget('session-', sessions).kind, 'none')
})

test('a number answers from the shown list while a name may reach any workspace', () => {
  /*
   * The two pools are not the same, and conflating them is what made a listed conversation
   * unselectable: a session from another workspace shows up in `/list all`, but a number refers to a
   * row of that listing while a title has to be findable wherever it lives.
   */
  const mine = [row('session-aaaa1111-aaaa1111-x', '我的')]
  const every = [mine[0]!, row('session-bbbb2222-bbbb2222-x', '别处的')]

  // A number counts the rows the user saw, so with only one own session, 2 is not a shown row.
  assert.equal(found(resolveTarget('1', every, mine))?.title, '我的')
  assert.equal(resolveTarget('2', every, mine).kind, 'none')
  // With everything shown, 2 is the foreign session.
  assert.equal(found(resolveTarget('2', every, every))?.title, '别处的')
  // A name is searched across everything, however few rows were displayed.
  assert.equal(found(resolveTarget('别处的', every, mine))?.title, '别处的')
  // A short id likewise, which is the form `/list` prints beside each row.
  assert.equal(found(resolveTarget('bbbb', every, mine))?.title, '别处的')
  // Omitting the third argument keeps the old behaviour: one pool for both.
  assert.equal(found(resolveTarget('2', every))?.title, '别处的')
})

test('a title is matched loosely, but never ambiguously', () => {
  /*
   * Real request that failed: 「切换回北京今天天气如何**会话**」 against a session titled
   * 「北京今天天气如何」. Exact matching alone loses to two characters the user added from habit.
   */
  const sessions = [
    row('session-1111aaaa-1111aaaa-x', '北京今天天气如何'),
    row('session-2222bbbb-2222bbbb-x', '解题辅导会话'),
    row('session-3333cccc-3333cccc-x', '写周报'),
  ]

  // The user's own wording, with a word appended.
  assert.equal(found(resolveTarget('北京今天天气如何会话', sessions))?.title, '北京今天天气如何')
  // A fragment they remember.
  assert.equal(found(resolveTarget('北京', sessions))?.title, '北京今天天气如何')
  assert.equal(found(resolveTarget('周报', sessions))?.title, '写周报')
  // Exact still wins.
  assert.equal(found(resolveTarget('写周报', sessions))?.title, '写周报')

  /*
   * Ambiguity must fail rather than pick one. Both titles here contain 「会话」, so asking for it
   * cannot say which was meant — and a wrong guess moves the conversation somewhere the user did not
   * ask for, which is worse than the failure.
   */
  const ambiguous = [
    row('session-5555eeee-5555eeee-x', '解题辅导会话'),
    row('session-6666ffff-6666ffff-x', '写周报会话'),
  ]
  assert.equal(resolveTarget('会话', ambiguous).kind, 'none')
  // Nothing matches, so nothing moves.
  assert.equal(resolveTarget('不存在的会话', sessions).kind, 'none')
  // An untitled session must not be selected by every argument that contains nothing — a title of ''
  // is a substring of everything.
  assert.equal(
    resolveTarget('随便什么', [{ sessionId: 'session-4444dddd-4444dddd-x', title: '' }]).kind,
    'none',
  )
})

test('a short id two conversations share fails instead of picking one', () => {
  /*
   * The printed id is the first few hex characters of the session id, so two conversations *can*
   * share one — six hex digits is 16 777 216 values, and a machine with a few hundred sessions still
   * collides eventually. The answer has to be "your id is too short", naming the candidates: silently
   * switching to whichever was found first would move the user's work somewhere they never asked for.
   */
  const clashA = 'session-e716f0aa-e716f0aa-47fd-4e61-bec6-d21d19457f37'
  const clashB = 'session-e716f0bb-e716f0bb-47fd-4e61-bec6-d21d19457f37'
  const sessions = [row(clashA, '写周报'), row(clashB, '查北京天气')]

  assert.equal(shortId(clashA), shortId(clashB), 'the fixtures really do collide')
  const resolution = resolveTarget(shortId(clashA), sessions)
  assert.equal(resolution.kind, 'ambiguous')
  if (resolution.kind !== 'ambiguous') return
  assert.deepEqual(
    resolution.candidates.map((session) => session.title),
    ['写周报', '查北京天气'],
  )

  // A longer id identifies one, which is exactly what the failure message tells the user to send.
  assert.equal(found(resolveTarget('e716f0a', sessions))?.title, '写周报')
  assert.equal(found(resolveTarget('e716f0b', sessions))?.title, '查北京天气')
  assert.equal(found(resolveTarget(clashA, sessions))?.title, '写周报')

  // And the message says so, in words, with both candidates printed.
  const message = ambiguousTargetMessage(shortId(clashA), resolution.candidates)
  assert.match(message, /有多个会话匹配「e716f0」/)
  assert.match(message, /更长的 id/)
  assert.match(message, /e716f0aa · 写周报/)
  assert.match(message, /e716f0bb · 查北京天气/)
})

test('shortId stays readable, stays within six characters, and round-trips', () => {
  const id = mintSessionId(() => '1a2b3c4d-9f8e-7d6c-5b4a-392817061524')
  assert.equal(id, 'session-1a2b3c4d-1a2b3c4d-9f8e-7d6c-5b4a-392817061524')
  assert.equal(shortId(id), '1a2b3c')
  // The bound is the requirement: an id the user has to copy is not one they will use.
  assert.equal(SHORT_ID_LENGTH <= 6, true)
  const sessions = [row(id, 'x')]
  assert.equal(found(resolveTarget(shortId(id), sessions))?.sessionId, id)
  // A foreign id still yields something printable rather than throwing — and still within the bound.
  assert.ok(shortId('not-a-session-id').length <= SHORT_ID_LENGTH)
  assert.ok(shortId('session-').length <= SHORT_ID_LENGTH)
})

/*
 * A refused send must not look like a delivered one.
 *
 * The service answers HTTP 200 either way, so the only signal is the code in the body — and it uses
 * `errcode` for one refusal and `ret` for another, which is why both are checked. Before this, a
 * refusal was reported to the user as "已通过微信发送" while the phone received nothing.
 */
test('a send refused with errcode throws instead of returning an id', () => {
  // The class matters as much as the message: the channel queues a refused message for the next open
  // window, and must not do that for a failure that would repeat.
  assert.throws(
    () => assertSendAccepted({ errcode: -14, errmsg: 'session timeout' }),
    (error: unknown) => error instanceof SendRefusedError && error.errcode === -14,
  )
})

test('a send refused with ret throws, naming the code the service gave', () => {
  // Verified against the live service: this shape is what a dead session returns for a fully headed
  // request, while the same refusal through a bare request comes back as `errcode`.
  assert.throws(
    () => assertSendAccepted({ ret: -2, errmsg: 'prepare failed' }),
    (error: unknown) =>
      error instanceof SendRefusedError && /errcode=-2.*prepare failed/.test(error.message),
  )
})

test('a refusal records every field the service gave, without inventing one', () => {
  /*
   * The log is the only instrument for telling the two shared-code refusals apart, so what it carries
   * decides whether the next investigation is even possible. Three things have to hold:
   *
   * - the `errmsg` is kept, because `-2 prepare failed` (a session needing an inbound message) and
   *   `-2 rate limited` (a session needing a pause) share a code and differ only here;
   * - `ret` is kept when present, since the send path has been seen populating `ret` while the
   *   polling path populates `errcode`;
   * - an absent field is omitted rather than printed as `undefined`, which reads as a value and sends
   *   the next reader looking for a `ret` that was never sent.
   */
  assert.throws(
    () => assertSendAccepted({ ret: -2, errmsg: 'prepare failed' }),
    (error: unknown) =>
      error instanceof SendRefusedError &&
      /ret=-2 errcode=-2 errmsg=prepare failed/.test(error.message) &&
      !/undefined/.test(error.message),
  )
  // The other shape: `errcode` alone, which must not grow a phantom `ret=`.
  assert.throws(
    () => assertSendAccepted({ errcode: -2, errmsg: 'rate limited' }),
    (error: unknown) =>
      error instanceof SendRefusedError &&
      /errcode=-2 errmsg=rate limited/.test(error.message) &&
      !/ret=/.test(error.message),
  )
})

test('a send the service accepted is left alone', () => {
  // Both the plain success and an explicit zero must pass: a strict `errmsg === undefined` check
  // would reject a perfectly good delivery.
  assertSendAccepted({ message_id: '1' })
  assertSendAccepted({ message_id: '1', ret: 0 })
  assertSendAccepted({ message_id: '1', errcode: 0, errmsg: '' })
})

test('queuePendingNotification stamps an id and a time, and drops the oldest when full', () => {
  const state = emptyState()
  for (let i = 0; i < 3; i += 1) {
    queuePendingNotification(state, { conversationId: 'c', text: `第 ${String(i)} 条` }, 1000 + i, 2)
  }
  assert.deepEqual(
    state.pendingNotifications?.map((entry) => entry.text),
    ['第 1 条', '第 2 条'],
    'the oldest goes first: the queue is a backlog, read in order',
  )
  assert.equal(state.pendingNotifications?.[0].queuedAt, 1001, 'the injected clock is used')
  assert.ok(state.pendingNotifications?.[0].id, 'every entry gets an identity')
  assert.notEqual(
    state.pendingNotifications?.[0].id,
    state.pendingNotifications?.[1].id,
    'two identical messages queued in the same millisecond stay distinguishable',
  )
})

test('expirePendingNotifications keeps the fresh and drops the stale', () => {
  const state = emptyState()
  queuePendingNotification(state, { conversationId: 'c', text: '旧的' }, 0)
  queuePendingNotification(state, { conversationId: 'c', text: '新的' }, 9_000)

  const dropped = expirePendingNotifications(state, 10_000, 5_000)

  assert.deepEqual(dropped.map((entry) => entry.text), ['旧的'])
  assert.deepEqual(state.pendingNotifications?.map((entry) => entry.text), ['新的'])
})

test('a malformed pending entry is dropped when the state is read back', async () => {
  /*
   * This array is read from a user-editable file and then sent, so an entry missing its conversation
   * would reach the send path as `undefined` — a crash on the one path that exists to survive a
   * failure.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-state-'))
  try {
    const store = new StateStore(join(home, 'state.json'))
    const good = { id: 'k', conversationId: 'c', text: '好的', queuedAt: 1 }
    await store.update((state) => {
      state.pendingNotifications = [
        good,
        { conversationId: 'c', text: '没有 id' },
        { id: 'x', text: '没有 conversation' },
        { id: 'y', conversationId: 'c', text: 42 },
      ] as never
    })

    const read = await new StateStore(join(home, 'state.json')).read()
    assert.deepEqual(read.pendingNotifications, [good], 'only the well-formed entry survives')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Reply-window quota
// ---------------------------------------------------------------------------

/** One conversation's quota entry, as the state file stores it. */
function quotaOf(state: ChannelState, conversationId: string): QuotaEntry | undefined {
  return state.quota?.[conversationId]
}

test('the quota count survives a write, a fresh read, and another write', async () => {
  /*
   * The reason this test exists at all: `normalize()` is an allowlist, and a field added to
   * `ChannelState` without a line there is discarded by the very next write. That is exactly how the
   * settings page spent several releases losing everything the user saved (`HANDBOOK-DEV.md` §4.9) —
   * saved fine, gone after a restart.
   *
   * The count is now the same kind of data and matters more than most: it decides whether the user is
   * asked for a new window *before* the last slot is spent, so silently resetting it to zero on every
   * write means the ask comes too late and the tail of a series is refused.
   *
   * The second `update` is the step that used to eat things: every write re-reads and re-normalizes
   * the file first.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-quota-'))
  try {
    const file = join(home, 'state.json')
    const wanted: QuotaEntry = { token: 'ctx-token-1', used: 9, warned: true }
    const store = new StateStore(file)
    await store.update((state) => {
      state.quota = { 'bot@im.bot:peer@im.wechat': wanted }
    })
    await store.update(() => {})

    const stored = quotaOf(await new StateStore(file).read(), 'bot@im.bot:peer@im.wechat')
    assert.deepEqual(stored, wanted, 'the count is still there after a reload and a rewrite')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a malformed quota entry is dropped when the state is read back', async () => {
  // `used` reaches arithmetic that decides whether to ask for a new window. A string there would
  // compare as false forever, so the warning would silently never fire; an entry with no `warned`
  // would make the same ask repeat on every send and spend the remaining slots on asking.
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-quota-'))
  try {
    const file = join(home, 'state.json')
    const good: QuotaEntry = { token: 'ctx', used: 3, warned: false }
    const store = new StateStore(file)
    await store.update((state) => {
      state.quota = {
        good,
        'used-is-a-string': { token: 'ctx', used: '3', warned: false },
        'warned-missing': { token: 'ctx', used: 3 },
        'used-is-negative': { token: 'ctx', used: -1, warned: false },
        'token-is-a-number': { token: 7, used: 1, warned: false },
      } as never
    })

    assert.deepEqual(
      Object.keys((await new StateStore(file).read()).quota ?? {}),
      ['good'],
      'only the well-formed entry survives',
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the count starts at one and asks for a new window two short of the limit', () => {
  /*
   * Three things are pinned here, and each of them is a way the ask can fail to arrive in time:
   *
   * 1. A conversation with no stored entry is a fresh window, counted from one rather than two.
   * 2. The ask happens at eight, not at ten — the warning is itself a message, so an ask at the limit
   *    would be an ask with no slot left to carry it.
   * 3. The warning is charged in the same step, so the count matches what the service actually saw.
   */
  const first = chargeQuota({ token: 'ctx' })
  assert.deepEqual(first.entry, { token: 'ctx', used: 1, warned: false })
  assert.equal(first.warn, false, 'nothing to ask for on the first send of a window')

  const seventh = chargeQuota({ stored: { token: 'ctx', used: 6, warned: false }, token: 'ctx' })
  assert.equal(seventh.warn, false, 'seven sends is still quiet')

  const eighth = chargeQuota({ stored: { token: 'ctx', used: 7, warned: false }, token: 'ctx' })
  assert.equal(eighth.warn, true, 'the eighth send is the one that carries the ask')
  assert.equal(eighth.used, 9, 'the ask itself spends a slot, so the count reflects it')
  assert.equal(eighth.entry.warned, true)
})

test('the ask happens once per window, never twice', () => {
  // The ninth and every later send must stay quiet. Repeating the ask would spend the remaining slots
  // on asking, which is the loop this flag exists to break.
  const ninth = chargeQuota({ stored: { token: 'ctx', used: 9, warned: true }, token: 'ctx' })
  assert.equal(ninth.warn, false)
  assert.equal(ninth.used, 10)

  const tenth = chargeQuota({ stored: { token: 'ctx', used: 10, warned: true }, token: 'ctx' })
  assert.equal(tenth.warn, false, 'a spent window is not asked about again')
  assert.equal(tenth.used, 11, 'countermanding nothing here: the arithmetic keeps counting')
})

test('a new token resets both the count and the ask', () => {
  /*
   * The platform issues a fresh ten with every inbound message, and nothing tells this side when that
   * happens except the token changing. A conversation stamped with the previous window therefore has
   * to start over completely — count *and* flag, or the second window would never ask.
   */
  const fresh = chargeQuota({ stored: { token: 'ctx-1', used: 10, warned: true }, token: 'ctx-2' })
  assert.deepEqual(fresh.entry, { token: 'ctx-2', used: 1, warned: false })
  assert.equal(fresh.warn, false)
})

test('a window with no stored token is its own window', () => {
  // What a restart before the first inbound message looks like. Treating `undefined` as a value rather
  // than as "no window" is what keeps the arithmetic honest when the token later appears.
  const none = chargeQuota({ token: undefined })
  assert.deepEqual(none.entry, { used: 1, warned: false })

  const stamped = chargeQuota({ stored: none.entry, token: 'ctx' })
  assert.deepEqual(stamped.entry, { token: 'ctx', used: 1, warned: false }, 'a real token is a new window')
})

test('the ledger charges the entry it read from the file', async () => {
  // The end-to-end shape of the thing: a charge read from disk, written back, and read again by a
  // second reader. This is the property the command line depends on — it is a separate process, so
  // its charges have to be visible to the plugin through the file and nothing else.
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-quota-'))
  try {
    const file = join(home, 'state.json')
    const ledger = quotaLedgerFor(new StateStore(file))
    // Seven sends, so the next charge is the eighth — the one that carries the ask.
    for (let index = 0; index < 7; index += 1) await ledger.charge('conv', 'ctx')

    const charge = await ledger.charge('conv', 'ctx')
    assert.equal(charge.warn, true, 'the eighth send of a window asks for a new one')
    assert.equal(charge.used, 9)

    const stored = quotaOf(await new StateStore(file).read(), 'conv')
    assert.deepEqual(stored, { token: 'ctx', used: 9, warned: true }, 'and it is on disk, not in memory')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a changed token makes the next charge start from one again', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-quota-'))
  try {
    const file = join(home, 'state.json')
    const ledger = quotaLedgerFor(new StateStore(file))
    for (let index = 0; index < 9; index += 1) await ledger.charge('conv', 'ctx-1')

    const charge = await ledger.charge('conv', 'ctx-2')
    assert.equal(charge.used, 1, 'the inbound message that carried ctx-2 opened a fresh window')
    assert.equal(charge.warn, false)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('sendText surfaces a refusal rather than reporting success', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ret: -2, errmsg: 'prepare failed' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

  try {
    await assert.rejects(
      async () => await sendText({ account, to: 'u@im.wechat', text: 'hi' }),
      /errcode=-2/,
    )
  } finally {
    globalThis.fetch = realFetch
  }
})

test('setTyping asks for the ticket with the required ilink_user_id', async () => {
  /*
   * The request that made "typing…" a no-op for the whole life of the project.
   *
   * `getconfig` requires `ilink_user_id`. An empty body gets `ret: -2, 'ilink_user_id required'` back
   * with HTTP 200, `typing_ticket` comes back undefined, and `setTyping` returns early. Nothing
   * throws — that method deliberately swallows everything, being cosmetic — so the feature was
   * implemented, wired up, and never once visible.
   */
  const bodies: { url: string; body: string }[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: { body?: unknown }) => {
    const body = typeof init?.body === 'string' ? init.body : ''
    bodies.push({ url: String(url), body })
    const payload = String(url).includes('getconfig')
      ? { ret: 0, typing_ticket: 'ticket-1' }
      : { ret: 0 }
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const { ChannelMonitor } = await import('../src/channel.ts')
    const monitor = new ChannelMonitor({ account, onMessage: async () => {} })
    await monitor.setTyping('peer@im.wechat', true)

    const config = bodies.find((entry) => entry.url.includes('getconfig'))
    assert.ok(config, 'the ticket is fetched first')
    assert.match(config.body, /"ilink_user_id":"peer@im\.wechat"/, 'and it carries the peer id')

    const typing = bodies.find((entry) => entry.url.includes('sendtyping'))
    assert.ok(typing, 'then the indicator is sent')
    assert.match(typing.body, /"typing_ticket":"ticket-1"/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('setTyping records a refused getconfig instead of failing silently', async () => {
  // A ticket that cannot be fetched is invisible by design, so the log is the only place it could ever
  // be noticed. This assertion is what would have caught the missing parameter immediately.
  const errors: unknown[] = []
  const realFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ret: -2, errmsg: 'ilink_user_id required' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch

  try {
    const { ChannelMonitor } = await import('../src/channel.ts')
    const monitor = new ChannelMonitor({
      account,
      onMessage: async () => {},
      onError: (error) => errors.push(error),
    })
    await monitor.setTyping('peer@im.wechat', true)

    assert.equal(errors.length, 1, 'the refusal is recorded')
    assert.match(String(errors[0]), /ilink_user_id required/)
  } finally {
    globalThis.fetch = realFetch
  }
})
