/**
 * Tests for `dsh-wechat-send`.
 *
 * The command exists because an agent that writes its own sending script cannot be counted at all: it
 * reads the token out of the state file and posts to the service, so the channel never sees those
 * sends and cannot warn the user before the ten run out. So what these tests check is not "the command
 * can send" — that is `@dsh-wechat/core`'s job and its own tests cover it — but the three things the
 * command adds: it charges the **same** count the plugin charges, it sends the warning at the same
 * point, and it **keeps** a refused message instead of dropping it.
 *
 * The provider is injected throughout, so none of this needs a network, a bot, or a child process. The
 * state file is real, because the file is the contract between the command and the plugin: they are
 * separate processes, and the only thing they share is that document.
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { QUOTA_WARNING, SendRefusedError, StateStore, type QuotaEntry } from '@dsh-wechat/core'

import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_QUEUED,
  EXIT_USAGE,
  boundTarget,
  defaultCliProvider,
  helpText,
  parseArgs,
  runCli,
  type CliOutcome,
  type CliProvider,
  type CliTarget,
} from '../src/cli.ts'

/** The send count at which the user is asked for a new window. Read here so the tests are explicit. */
const WARN_AT = 8

/** Run the command with its output captured rather than written to the process streams. */
async function run(
  argv: readonly string[],
  provider?: CliProvider,
): Promise<{ code: number; out: string; err: string }> {
  const outcome: CliOutcome = await runCli(argv, { out: () => {}, err: () => {} }, provider)
  return { code: outcome.code, out: outcome.out.join('\n'), err: outcome.err.join('\n') }
}

/** A state file with one bound conversation, the way the plugin leaves it after an inbound message. */
async function seedState(
  home: string,
  options: { quota?: Record<string, QuotaEntry>; contextToken?: string } = {},
): Promise<string> {
  const file = join(home, 'wechat', 'state.json')
  const store = new StateStore(file)
  await store.update((state) => {
    state.accounts['test@im.bot'] = {
      accountId: 'test@im.bot',
      token: 'token',
      baseUrl: 'https://example.invalid',
      userId: 'peer@im.wechat',
    }
    state.contextTokens['test@im.bot'] = {
      'test@im.bot:peer@im.wechat': options.contextToken ?? 'ctx-token-1',
    }
    state.bindings['test@im.bot:peer@im.wechat'] = {
      conversationId: 'test@im.bot:peer@im.wechat',
      accountId: 'test@im.bot',
      peerId: 'peer@im.wechat',
      sessionId: 'session-bound',
      title: '微信那边',
      createdAt: 1,
      lastUsedAt: 1,
    }
    if (options.quota !== undefined) state.quota = options.quota
  })
  return file
}

/** Read one conversation's persisted quota. */
async function quotaOnDisk(file: string, conversationId: string): Promise<QuotaEntry | undefined> {
  return (await new StateStore(file).read()).quota?.[conversationId]
}

/** Read the persisted queue of messages the window refused. */
async function queueOnDisk(
  file: string,
): Promise<{ conversationId: string; text: string; path?: string }[]> {
  return (await new StateStore(file).read()).pendingNotifications ?? []
}

/**
 * A provider backed by a real state file, with an in-memory sender.
 *
 * The ledger is built exactly as the real one is — {@link cliProviderFor} does that below by hand
 * rather than importing it, so what a test asserts about the written state is the same shape a user's
 * machine gets.
 */
async function makeProvider(
  home: string,
  options: {
    /** Text to reject, or true to reject every send. */
    refuse?: true | ((text: string) => boolean)
    contextToken?: string
    quota?: Record<string, QuotaEntry>
  } = {},
): Promise<{ provider: CliProvider; sent: string[]; file: string; logs: string[]; charges: number[] }> {
  const file = await seedState(home, {
    ...(options.contextToken === undefined ? {} : { contextToken: options.contextToken }),
    ...(options.quota === undefined ? {} : { quota: options.quota }),
  })
  const store = new StateStore(file)
  const sent: string[] = []
  const logs: string[] = []
  const charges: number[] = []
  const refuse = options.refuse ?? false
  const shouldRefuse = (text: string): boolean =>
    refuse === true ? true : refuse !== false && refuse(text)

  const provider: CliProvider = {
    stateFile: file,
    target: async () => boundTarget(await store.read()),
    log: (line) => logs.push(line),
    quota: {
      async charge(conversationId, token, chargeOptions = {}) {
        const stored = (await store.read()).quota?.[conversationId]
        const fresh = stored === undefined || stored.token !== token
        const sentCount = (fresh ? 0 : stored.used) + 1
        const alreadyWarned = chargeOptions.warned ?? (fresh ? false : stored.warned)
        const warn = !alreadyWarned && sentCount >= WARN_AT
        const used = warn ? sentCount + 1 : sentCount
        const entry: QuotaEntry = {
          ...(token === undefined ? {} : { token }),
          used,
          warned: warn || alreadyWarned,
        }
        await store.update((state) => {
          ;(state.quota ??= {})[conversationId] = entry
        })
        charges.push(used)
        return { entry, warn, used }
      },
    },
    deliver: async (request) => {
      if (shouldRefuse(request.text)) throw new SendRefusedError('发送被微信拒绝：prepare failed', -2)
      sent.push(request.text)
      return { clientId: 'test' }
    },
  }
  return { provider, sent, file, logs, charges }
}

test('a message is sent, and the window is charged', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  try {
    const { provider, sent, file } = await makeProvider(home)
    const result = await run(['构建完成了'], provider)

    assert.equal(result.code, EXIT_OK)
    assert.match(result.out, /已通过微信发送：消息/)
    assert.deepEqual(sent, ['构建完成了'], 'the text goes out as one message')
    assert.deepEqual(
      await quotaOnDisk(file, 'test@im.bot:peer@im.wechat'),
      { token: 'ctx-token-1', used: 1, warned: false },
      'the charge is written to the file the plugin reads',
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the count continues from what is already on disk, so script and plugin share one ten', async () => {
  /*
   * This is the whole reason the command exists. The plugin already sent six messages of this window;
   * the script's seventh send has to be the seventh, not the first. Counted separately, the plugin and
   * the script would each believe they had ten, the user would never be warned in time, and the tail of
   * the series would be refused with nothing having said so.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  try {
    const { provider, file } = await makeProvider(home, {
      quota: { 'test@im.bot:peer@im.wechat': { token: 'ctx-token-1', used: 6, warned: false } },
    })
    const result = await run(['第七条'], provider)

    assert.equal(result.code, EXIT_OK)
    assert.equal(
      (await quotaOnDisk(file, 'test@im.bot:peer@im.wechat'))?.used,
      7,
      'the plugin\'s six are counted, not discarded',
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the eighth send asks the user for a new window, and the ask is charged too', async () => {
  /*
   * The plugin does this at its own eighth send; a script has to behave identically, or the user is
   * asked only when the agent happens to use the tool and never when it writes a loop.
   *
   * `used` ends at nine rather than eight because the warning is itself a message and spends a slot.
   * That is not bookkeeping nicety: it is what stops the arithmetic from claiming a slot is free when
   * the user has already received nine things.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  try {
    const { provider, sent, file } = await makeProvider(home, {
      quota: { 'test@im.bot:peer@im.wechat': { token: 'ctx-token-1', used: 7, warned: false } },
    })
    const result = await run(['第八条'], provider)

    assert.equal(result.code, EXIT_OK)
    assert.deepEqual(sent, ['第八条', QUOTA_WARNING], 'the warning is sent through the same path')
    assert.match(result.out, /微信这边一个回复窗口最多连发/, 'and the script is told it happened')
    assert.deepEqual(await quotaOnDisk(file, 'test@im.bot:peer@im.wechat'), {
      token: 'ctx-token-1',
      used: 9,
      warned: true,
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the ask happens once, however many sends follow it', async () => {
  // Repeating it would spend the remaining slots on asking. The flag is what the plugin relies on and
  // what the file has to carry across processes.
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  try {
    const { provider, sent } = await makeProvider(home, {
      quota: { 'test@im.bot:peer@im.wechat': { token: 'ctx-token-1', used: 8, warned: true } },
    })
    const first = await run(['第九条'], provider)
    const second = await run(['第十条'], provider)

    assert.equal(first.code, EXIT_OK)
    assert.equal(second.code, EXIT_OK)
    assert.deepEqual(
      sent.filter((text) => text === QUOTA_WARNING),
      [],
      'a window that has already asked stays quiet',
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a new token starts the count over, because the user wrote back', async () => {
  // The platform issues a fresh ten with every inbound message. The token is the only signal this side
  // gets, which is why it is stored beside the count.
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  try {
    const { provider, file } = await makeProvider(home, {
      contextToken: 'ctx-token-2',
      quota: { 'test@im.bot:peer@im.wechat': { token: 'ctx-token-1', used: 10, warned: true } },
    })
    const result = await run(['新窗口第一条'], provider)

    assert.equal(result.code, EXIT_OK)
    assert.deepEqual(await quotaOnDisk(file, 'test@im.bot:peer@im.wechat'), {
      token: 'ctx-token-2',
      used: 1,
      warned: false,
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a refused send is queued, not lost, and says so', async () => {
  /*
   * The outcome that matters most: the window closed, so WeChat refused the send. Nothing on this side
   * can reopen it — only the user writing can — so the message is kept in the same queue the plugin
   * flushes on their next message, and the exit code says "queued" rather than "failed" so a script
   * does not retry into a closed window.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  try {
    const { provider, file } = await makeProvider(home, { refuse: true })
    const result = await run(['这条会被拒'], provider)

    assert.equal(result.code, EXIT_QUEUED, 'queued is not a failure')
    assert.match(result.err, /微信拒绝了这次发送/)
    assert.match(result.err, /已排队，等用户回消息后补发/)

    const queue = await queueOnDisk(file)
    assert.equal(queue.length, 1, 'exactly one entry waits for the window to reopen')
    assert.equal(queue[0]?.conversationId, 'test@im.bot:peer@im.wechat')
    assert.equal(queue[0]?.text, '这条会被拒')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a refused message with a file keeps the path, so the plugin can send the attachment', async () => {
  // The queue holds a path and never the bytes: it is rewritten on every change, and embedding
  // attachments would grow the state file with every missed screenshot.
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  try {
    const file = join(home, '报告.pdf')
    // Created, because this path is sent for real now: a stubbed uploader used to accept a
    // path that did not exist, which hid the fact that the file was never there.
    await writeFile(file, 'report')
    const { provider } = await makeProvider(home, { refuse: true })
    const result = await run(['报告如下', '--file', file], provider)

    assert.equal(result.code, EXIT_QUEUED)
    const queue = await queueOnDisk(provider.stateFile)
    assert.equal(queue[0]?.text, '报告如下')
    assert.equal(queue[0]?.path, file, 'the attachment travels with its caption')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a failure that would repeat is not queued', async () => {
  /*
   * A missing file or a dead network fails the same way next time, so turning it into a backlog would
   * hide the error behind a delay instead of reporting it. Only a refusal — which the *service* made,
   * and which the user's next message really does undo — is worth keeping.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  try {
    const { provider } = await makeProvider(home)
    provider.deliver = async () => {
      throw new Error('网络断了')
    }
    const result = await run(['这条不该排队'], provider)

    assert.equal(result.code, EXIT_FAILED)
    assert.match(result.err, /发送失败/)
    assert.match(result.err, /网络断了/)
    assert.deepEqual(await queueOnDisk(provider.stateFile), [], 'nothing is queued')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a refusal that cannot even be queued is reported as a failure', async () => {
  // Then the message really is gone, and saying so is the only honest outcome: the user is waiting for
  // something that will never arrive, and a "queued" claim would leave them waiting.
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  try {
    const { provider } = await makeProvider(home, { refuse: true })
    // A state path that cannot be written: its parent is a file, not a directory.
    provider.stateFile = join(home, 'wechat', 'state.json', 'nested', 'state.json')
    const result = await run(['保不住的消息'], provider)

    assert.equal(result.code, EXIT_FAILED)
    assert.match(result.err, /排队也失败了/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('with no bound conversation the command says what to do and sends nothing', async () => {
  // The state file is shared with the plugin, so "no conversation" is a real first-run state rather
  // than a mistake, and the message has to say which file was read.
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  try {
    const file = join(home, 'wechat', 'state.json')
    await new StateStore(file).update(() => {})
    const sent: string[] = []
    const store = new StateStore(file)
    const result = await run(['有人吗'], {
      stateFile: file,
      target: async () => boundTarget(await store.read()),
      quota: { charge: async () => ({ entry: { used: 1, warned: false }, warn: false, used: 1 }) },
      deliver: async (request) => {
        sent.push(request.text)
        return {}
      },
    })

    assert.equal(result.code, EXIT_USAGE)
    assert.match(result.err, /还没有绑定的微信对话/)
    assert.match(result.err, /state\.json/, 'the file it read is named')
    assert.deepEqual(sent, [], 'nothing leaves')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('--help describes the command, its counting, and every exit code', async () => {
  const result = await run(['--help'])

  assert.equal(result.code, EXIT_OK)
  assert.equal(result.err, '', 'help is not an error')
  const text = result.out
  assert.match(text, /用法：/)
  assert.match(text, /--file <路径>/)
  assert.match(text, /最多连发 10 条/)
  assert.match(text, /和插件共用同一份计数|与插件共用同一份计数/)
  // Every code the command can return has to be documented, because a script branches on them.
  for (const code of [EXIT_OK, EXIT_FAILED, EXIT_USAGE, EXIT_QUEUED]) {
    assert.match(text, new RegExp(`^\\s*${String(code)}\\s`, 'm'), `exit code ${String(code)} is listed`)
  }
  assert.match(text, /不要重试/, 'a queued message must not be retried')
  assert.equal(text, helpText(), 'the text has one source')
})

test('an unusable command line is refused instead of guessing', async () => {
  const none = await run([])
  assert.equal(none.code, EXIT_USAGE)
  assert.match(none.err, /至少要给一条消息/)

  const two = await run(['第一条', '第二条'])
  assert.equal(two.code, EXIT_USAGE)
  assert.match(two.err, /只能给一条消息/)
  // Two messages in one call would be counted as one, which is exactly how a series overruns.
  assert.match(two.err, /分多次调用/)

  const unknown = await run(['--nope', '内容'])
  assert.equal(unknown.code, EXIT_USAGE)
  assert.match(unknown.err, /认不出的参数：--nope/)

  const emptyFile = await run(['内容', '--file'])
  assert.equal(emptyFile.code, EXIT_USAGE)
  assert.match(emptyFile.err, /--file 后面要跟一个文件路径/)
})

test('parseArgs accepts the file option in both spellings and keeps a lone dash positional', () => {
  assert.deepEqual(parseArgs(['内容', '--file', 'a.png']), {
    help: false,
    message: '内容',
    file: 'a.png',
    extra: [],
  })
  assert.deepEqual(parseArgs(['--file=a.png', '内容']), {
    help: false,
    message: '内容',
    file: 'a.png',
    extra: [],
  })
  assert.deepEqual(parseArgs(['--file', 'a.png']), {
    help: false,
    file: 'a.png',
    extra: [],
  })
  // A file-only send is a real use: a report with no caption.
  assert.equal(parseArgs(['--file=a.png']).message, undefined)
  assert.deepEqual(parseArgs(['-']).message, '-')
  assert.equal(parseArgs(['-h']).help, true)
})

test('a file-only send uploads and charges the window', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  try {
    const path = join(home, 'report.pdf')
    // On disk, because the command checks readability before it asks for an uploader: a
    // stubbed attach used to accept any path, so a file that never existed went unnoticed.
    await writeFile(path, 'report')
    const { provider, file, charges } = await makeProvider(home)
    const attached: string[] = []
    provider.attach = async ({ path: target }) => {
      attached.push(target)
      return { fileName: 'report.pdf', size: 12 }
    }
    const result = await run(['--file', path], provider)

    assert.equal(result.code, EXIT_OK)
    assert.deepEqual(attached, [path])
    assert.match(result.out, /已通过微信发送：文件 report\.pdf/)
    assert.deepEqual(charges, [1], 'an attachment spends one slot of the same window')
    assert.equal((await quotaOnDisk(file, 'test@im.bot:peer@im.wechat'))?.used, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a file sent with a caption sends the text first, then the attachment', async () => {
  // The caption has to arrive before the file, or the attachment lands with no explanation. Two
  // messages means two slots, and both are charged.
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  try {
    const path = join(home, 'photo.png')
    // On disk, for the same reason as the file-only case: the command now reads before it
    // asks for an uploader, so a path that was never created is a failure rather than a stub.
    await writeFile(path, 'png')
    const { provider, sent, charges } = await makeProvider(home)
    provider.attach = async () => ({ fileName: 'photo.png', size: 3 })
    const result = await run(['照片来啦', '--file', path], provider)

    assert.equal(result.code, EXIT_OK)
    assert.deepEqual(sent, ['照片来啦'], 'the caption goes out as text')
    assert.deepEqual(charges, [1, 2], 'both pieces spend a slot')
    assert.match(result.out, /已通过微信发送：消息、文件 photo\.png/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a missing file fails with the path named, and sends nothing', async () => {
  // In a script that sends several files, "ENOENT" without the path is the one detail that decides
  // whether the failure can be acted on.
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  try {
    /*
     * A provider built from the temporary home, and never the default one.
     *
     * The default provider reads the state file of whoever is running the tests. On a developer's
     * machine that file exists and has a binding, so the run gets as far as reading the file and
     * fails with EXIT_FAILED. On a CI runner there is no such file, the command stops earlier at
     * "no bound conversation", and the exit code is EXIT_USAGE — the same assertion, failing only
     * where nobody had bound WeChat. Passing the provider is what makes the test about the missing
     * file rather than about the machine it runs on.
     */
    const { provider } = await makeProvider(home)
    const missing = join(home, '已经不在了.docx')
    // File-only, so nothing is sent before the attachment is read: the order is what makes the
    // failure land on the file rather than on a caption that went out first.
    const result = await run(['--file', missing], provider)

    assert.equal(result.code, EXIT_FAILED)
    assert.match(result.err, /读不到文件/)
    assert.match(result.err, /已经不在了\.docx/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the charge the command writes is one the plugin can read back', async () => {
  /*
   * The cross-process half of "shared count", checked against the file rather than against the object
   * the command happened to hold: the plugin reads this document on its next send, and a field the
   * normalizer drops would leave it counting from zero in silence.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  try {
    const { provider, file } = await makeProvider(home)
    await run(['第一条'], provider)
    await run(['第二条'], provider)

    const raw = JSON.parse(await readFile(file, 'utf8')) as { quota?: Record<string, QuotaEntry> }
    assert.deepEqual(raw.quota?.['test@im.bot:peer@im.wechat'], {
      token: 'ctx-token-1',
      used: 2,
      warned: false,
    })
    // And through the normalizing reader, which is what the plugin actually uses.
    assert.equal((await quotaOnDisk(file, 'test@im.bot:peer@im.wechat'))?.used, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the resolved target carries the reply token, so the message lands in the conversation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  try {
    const file = await seedState(home)
    const store = new StateStore(file)
    const target = boundTarget(await store.read())
    assert.equal(target.ok, true)
    if (!target.ok) return
    const resolved: CliTarget = target.target
    assert.equal(resolved.conversationId, 'test@im.bot:peer@im.wechat')
    assert.equal(resolved.peerId, 'peer@im.wechat')
    assert.equal(resolved.contextToken, 'ctx-token-1')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('the real provider builds the send from core and still charges the window', async () => {
  /*
   * Everything above injects the sender, which proves the counting but not the wiring. This one drives
   * `defaultCliProvider` — the object the installed command actually builds — against a stubbed
   * transport, so what is checked is the part a user would hit first: the state file is read, the
   * reply token is carried, `@dsh-wechat/core` produces the request, and the charge lands in the file
   * the plugin reads.
   *
   * The stub replaces `fetch` for the duration, which is the same technique the plugin's own tests
   * use for the media path: asserting on the wire is the only way to show a request was really built
   * rather than merely described.
   */
  const home = await mkdtemp(join(tmpdir(), 'dsh-wechat-cli-'))
  const realFetch = globalThis.fetch
  try {
    const file = await seedState(home)
    const bodies: string[] = []
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
      if (typeof init?.body === 'string') bodies.push(init.body)
      return new Response(JSON.stringify({ message_id: '7514' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const result = await run(['真实通路'], defaultCliProvider(file))

    assert.equal(result.code, EXIT_OK)
    assert.equal(bodies.length, 1, 'exactly one sendmessage request')
    const sent = JSON.parse(bodies[0] ?? '{}') as {
      msg?: { to_user_id?: string; context_token?: string; item_list?: { text_item?: { text?: string } }[] }
    }
    assert.equal(sent.msg?.to_user_id, 'peer@im.wechat')
    // The reply token is what makes the message land in the existing conversation rather than start a
    // new one — the same requirement the plugin's own sends honour.
    assert.equal(sent.msg?.context_token, 'ctx-token-1')
    assert.equal(sent.msg?.item_list?.[0]?.text_item?.text, '真实通路')
    assert.deepEqual(await quotaOnDisk(file, 'test@im.bot:peer@im.wechat'), {
      token: 'ctx-token-1',
      used: 1,
      warned: false,
    })
  } finally {
    globalThis.fetch = realFetch
    await rm(home, { recursive: true, force: true })
  }
})
