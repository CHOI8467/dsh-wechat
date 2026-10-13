/**
 * Conversation routing: one WeChat conversation maps to one DSH session, and the
 * user switches between them with in-chat commands.
 *
 * Why commands rather than a picker: WeChat gives a channel exactly one chat
 * surface, so a session list has to live inside the message stream. Tencent's own
 * client uses the same technique (it handles `/echo` and `/toggle-debug` in chat),
 * and the protocol's tool-call item types could eventually render something
 * richer. Commands work today, on every client, with no extra payload.
 *
 * Session ids are minted by this router in DSH's own format (`session-<uuid>`) and
 * handed to the session controller, which adopts an existing session with that id
 * or creates one. The mapping is what survives a restart, so a chat keeps talking
 * to the same session across reboots.
 *
 * @module @dsh-wechat/core/router
 */

import { randomUUID } from 'node:crypto'

import { compareSessionsNewestFirst, isSameWorkspace } from './session-index.ts'

/** One conversation's binding to a DSH session. */
export interface SessionBinding {
  conversationId: string
  accountId: string
  peerId: string
  /** DSH session id, in the platform's own `session-<uuid>` form. */
  sessionId: string
  /** Human label shown in `/list`, captured when the session was bound. */
  title: string
  createdAt: number
  lastUsedAt: number
}

/**
 * The part of a session a numbering needs.
 *
 * Deliberately just these two fields: a numbering is written to the state file so a quote can pin it,
 * and the row it names must stay switchable after a restart — which title and id are enough for.
 */
export interface NumberedSession {
  sessionId: string
  title: string
}

/** One conversation as a listing shows it. */
export interface ListedSession extends NumberedSession {
  updatedAt: number
  /**
   * Working directory the session belongs to, when the channel knows it.
   *
   * Absent means "this workspace's own", which is the only thing a conversation can vouch for — see
   * {@link sessionFolders}.
   */
  workspace?: string
}

/**
 * The rows a numbering printed, and the number printed beside the first of them.
 *
 * The pair travels together because a number is only meaningful with its offset: numbering runs on
 * across screens, so a second screen of ten starts at 11, and a reply of "13" read from row 1 would
 * name a conversation the user never saw.
 */
export interface NumberedRows {
  sessions: NumberedSession[]
  /** 1-based number printed beside `sessions[0]`. 1 on a first screen, 11 on the second of ten. */
  first: number
}

/**
 * Where a conversation is in the two-level browser.
 *
 * Persisted because 「查看其余」 carries no target: it means "the next ten of what I am looking at",
 * and this is the only record of what that is. Keyed per conversation, because one plugin serves
 * several chats.
 */
export interface BrowsePosition {
  /** `folders` is the workspace list; `sessions` is one workspace's conversations. */
  level: 'folders' | 'sessions'
  /** Directory whose conversations are shown at the `sessions` level; `''` is the channel's own. */
  workspace: string
  /** 1-based screen last shown. */
  page: number
  /** When it was last advanced, so an abandoned position can be retired. */
  at: number
}

/**
 * One workspace as the first level of the browser lists it.
 *
 * A folder rather than a row: the first level answers "which project", not "which conversation", and
 * a conversation is only reachable after one has been chosen.
 */
export interface SessionFolder {
  /** Absolute directory; `''` for the channel's own workspace. */
  path: string
  /** Name printed in the list and accepted back when entering. */
  label: string
  /** Conversations inside, so the user can tell a project they work in from one they do not. */
  count: number
}

/** Why the router handed work to the agent, for logging. */
export interface RouteDecision {
  /** Session the prompt belongs to. */
  sessionId: string
  /** Text to send to the agent. */
  prompt: string
  /** True when this message started a brand new session. */
  created: boolean
  /**
   * A sentence to send to the user before the prompt, when the conversation had to be moved.
   *
   * Carried back rather than sent here because core has no way to send anything: the caller owns
   * every outbound message. It is not optional decoration — a rebind without it looks to the user
   * like their conversation was replaced at random, and the one thing they can do about it is be
   * told.
   */
  notice?: string
}

/** Result of routing one message. */
export type RouteResult =
  | {
      kind: 'reply'
      text: string
      /**
       * The rows this reply numbered, in the order it printed them.
       *
       * Travels back to the caller because only the caller knows the id the service assigns to the
       * message it is about to send — and that id is what a later quote of the list refers to. Handing
       * the numbering over here is what lets a quote pin the numbers the user is looking at, instead
       * of re-deriving them from sessions that have moved on since.
       */
      numbered?: NumberedRows
      /**
       * Where this reply left the conversation in the browser, when it was a screen of a listing.
       *
       * Absent everywhere else, which is the signal to forget any position: a listing is a place the
       * user is standing, and every other outcome means they walked away from it.
       */
      browse?: BrowsePosition
    }
  | { kind: 'prompt'; decision: RouteDecision }

/**
 * One model a conversation can be moved to.
 *
 * Flattened and provider-labelled by the host, because core must not know what a provider is. What
 * it needs is the two opaque strings `selectModel` takes back, plus enough labels to show a row and
 * to match what the user typed.
 */
export interface ModelOption {
  /** Provider id, handed straight back to the host when this model is chosen. */
  provider: string
  /** Provider label, shown beside the model so two providers' identical ids are told apart. */
  providerName: string
  /** Model id, handed straight back to the host. */
  model: string
  /** Model label, which is what the user reads and usually types. */
  name: string
  /** Reasoning effort to select the model with, when the model exposes one. */
  reasoningEffort?: string
}

/** Which model a session runs on. Opaque to core: two ids from the host. */
export interface ModelSelection {
  provider: string
  model: string
}

/** Every model on offer, plus the one the host reported as current. */
export interface ModelListing {
  /**
   * The selection the host reports, when it reports one.
   *
   * The host exposes a deployment default rather than a per-session read, so this is what the list
   * marks. Because choosing a model also saves it as that default, the mark follows every switch
   * made through this channel.
   */
  current?: ModelSelection
  models: readonly ModelOption[]
  /** Providers whose models could not be listed, with the host's own reason. */
  failures?: readonly { name: string; message: string }[]
}

/**
 * Whether the session a conversation is bound to can still take a message.
 *
 * Three answers, because two different failures look identical from the phone. An **archived**
 * session is still on disk and still accepts a prompt — DSH records the archive in the workspace
 * registry and rejects the *step* the prompt proposes, so the turn ends blocked with no error and
 * nothing said. A **missing** session has no record at all, so the prompt lands nowhere. Either way
 * the user's message is swallowed in silence, which is the failure this vocabulary exists to name.
 */
export type SessionState = 'usable' | 'archived' | 'missing'

/**
 * The session surface this router needs from the host.
 *
 * Keeping it narrow means the routing rules are unit-testable without booting DSH,
 * and it documents exactly which host calls the channel depends on.
 */
export interface SessionGateway {
  /** Bind or resume a session with this id. Implementations should be idempotent. */
  ensureSession(sessionId: string, title: string): Promise<void>
  /** Hand a prompt to a session. */
  prompt(sessionId: string, text: string): Promise<void>
  /**
   * Recent sessions, newest first, for the whole-machine levels of the browser.
   *
   * Each row should carry its `workspace` so the listing can group by it. A row without one is
   * treated as belonging to the channel's own workspace.
   */
  listSessions(): Promise<ListedSession[]>
  /**
   * Sessions belonging to the channel's own workspace.
   *
   * Optional because only the host knows where a session lives. `/list` uses it to show just this
   * workspace's conversations and merely mention the rest; without it, every session is treated as
   * the channel's own and the list shows the whole machine.
   */
  listOwnSessions?(): Promise<ListedSession[]>
  /** Abort whatever the session is currently doing. */
  cancel(sessionId: string): Promise<void>
  /**
   * Models a session may be moved to, and the one the host says is in use.
   *
   * Optional for the same reason as {@link SessionGateway.listOwnSessions}: only the host knows
   * which models exist. A composition without a catalog answers that it has none, rather than
   * throwing out of a command the user typed.
   */
  listModels?(): Promise<ModelListing>
  /**
   * Point a session at one model. Throws with the host's own reason when it cannot.
   *
   * The reasoning effort travels with the model rather than being left to the host to default,
   * because leaving it out would hand a decision to a resolve step the user cannot see: the same
   * model at a different effort is a different answer.
   */
  selectModel?(
    sessionId: string,
    provider: string,
    model: string,
    reasoningEffort?: string,
  ): Promise<ModelSelection>
  /**
   * Whether a session a conversation is already bound to can still take work.
   *
   * **Optional, and the router behaves exactly as it did before without it.** A gateway that cannot
   * answer must not cost the user a message, so an absent probe is not an error and not a reason to
   * rebind — the binding is reused as it always was.
   *
   * It exists because both of the ways a bound session goes dead are invisible downstream: the
   * prompt is accepted and nothing is ever answered, and no layer logs a thing. Asking *before*
   * reuse is the only point at which the channel can tell the difference between a session that
   * works and one that will swallow the message.
   *
   * A throw is not a verdict. The router treats a failed probe as `usable` and writes a diagnostic
   * line, because a broken probe losing the user's message would be worse than a stale binding.
   */
  sessionState?(sessionId: string): Promise<SessionState>
}

/**
 * How long a binding must have existed before a `missing` verdict is believed.
 *
 * This is not a nicety; it is what a live run cost. The first version of this check replaced a
 * binding whenever the probe answered `missing`, and the machine immediately produced an endless
 * run of new sessions: a session has **no record on disk until its first turn writes one**, so every
 * message that arrived before that write judged the session it had just created to be missing, and
 * created another one. The user saw a new conversation per message.
 *
 * The age of the *binding* is what separates "its record is not written yet" from "it is actually
 * gone": the binding is created before the session's first prompt, so a young binding is expected to
 * be recordless, while an old one that still has no record is a session that has been deleted. Two
 * minutes is far longer than a first write takes and short enough that a deleted session is repaired
 * during the same exchange the user would otherwise have lost.
 *
 * `archived` is deliberately not subject to this. The archive set lives in the workspace registry,
 * which answers immediately and knows nothing about whether a record has been written yet — there is
 * no race here to be tolerant of, and an archived session never becomes usable by waiting.
 */
export const MISSING_BINDING_GRACE_MS = 2 * 60 * 1000

/** Everything persisted for routing, injected so the store stays pluggable. */
export interface BindingStore {
  load(): Promise<Record<string, SessionBinding>>
  save(bindings: Record<string, SessionBinding>): Promise<void>
}

export interface SessionRouterOptions {
  gateway: SessionGateway
  store: BindingStore
  /** Display name used when auto-creating a session title. */
  titlePrefix?: string
  /**
   * Directory the channel's own sessions live in.
   *
   * Only used to decide which rows belong under the channel's own heading. The store records absolute
   * directories, so without it the channel's workspace would be labelled with its folder name
   * (`dsh_wechat`) instead of the name the user knows it by.
   */
  ownWorkspace?: string
  /** Heading for the channel's own workspace. */
  ownWorkspaceLabel?: string
  /**
   * Sink for routing facts that have to end up in a log.
   *
   * The router cannot write to a log itself — core imports nothing from the host — and the facts that
   * matter most here are precisely the ones with no other trace: a binding replaced because its
   * session died, a rebind *skipped* because the binding is too young to judge, and a probe that
   * threw and was therefore treated as `usable`. Each of those is a decision a person diagnosing a
   * silence needs to see, and none of them is visible in the message that was routed.
   *
   * Lines are English, like the rest of the channel's log, and each names the conversation, the
   * session, the verdict and what was done with it.
   */
  onDiagnostic?: (line: string) => void
}

/**
 * Routes WeChat messages to DSH sessions and implements the in-chat commands.
 */
export class SessionRouter {
  readonly #gateway: SessionGateway
  readonly #store: BindingStore
  readonly #titlePrefix: string
  readonly #ownWorkspace: string | undefined
  readonly #ownWorkspaceLabel: string
  readonly #onDiagnostic: ((line: string) => void) | undefined
  #bindings: Record<string, SessionBinding> | undefined

  constructor(options: SessionRouterOptions) {
    this.#gateway = options.gateway
    this.#store = options.store
    this.#titlePrefix = options.titlePrefix ?? '微信'
    this.#ownWorkspace = options.ownWorkspace
    this.#ownWorkspaceLabel = options.ownWorkspaceLabel ?? '微信会话'
    this.#onDiagnostic = options.onDiagnostic
  }

  /**
   * Route one inbound message.
   *
   * @param params.conversationId - Stable conversation key.
   * @param params.accountId - Bot account the message arrived on.
   * @param params.peerId - Counterparty user id.
   * @param params.text - Message text.
   * @param params.numbered - The rows a bare number refers to, when the caller knows of a listing the
   *   user is looking at — a quoted list, or the newest one sent into this conversation.
   * @param params.heldHint - Wording for the "there are more conversations elsewhere" sentence, which
   *   differs between a typed `/list` and a spoken request.
   * @param params.browse - Where this conversation was left in the listing browser, when it is
   *   somewhere. Without it a bare number is an ordinary message, as it always was.
   * @returns Either text to reply with directly, or a prompt for a session. A prompt decision may
   *   carry a `notice` when the conversation had to be moved to a new session first — see
   *   {@link SessionGateway.sessionState}.
   */
  async route(params: {
    conversationId: string
    accountId: string
    peerId: string
    text: string
    numbered?: NumberedRows
    heldHint?: string
    browse?: BrowsePosition
  }): Promise<RouteResult> {
    const text = params.text.trim()

    if (text.startsWith('/')) {
      return await this.#command(params, text)
    }

    /*
     * A reply to a listing is answered here, before the agent is woken.
     *
     * It has to be, because the browsing position is the channel's own bookkeeping: the agent sees
     * "2" and has no way to know whether that means a folder, a conversation, or the answer to
     * something it asked. The router does know, so it decides — and returns nothing when the message
     * is not a step at all, which keeps an ordinary remark during a listing on its way to the agent.
     */
    if (params.browse !== undefined && text !== '') {
      const browsed = await this.#browseReply(params, text, params.browse)
      if (browsed !== undefined) return browsed
    }

    const bindings = await this.#load()
    let binding = bindings[params.conversationId]
    let created = false
    let notice: string | undefined
    if (binding === undefined) {
      binding = await this.#bind(params, undefined)
      created = true
    } else {
      /*
       * Ask whether the bound session still works *before* reusing it.
       *
       * Both ways it can be dead are silent from here on down: an archived session accepts the
       * prompt and then has its step rejected, and a session gone from disk receives nothing. The
       * message is then lost with no reply from the phone's point of view and no line in any log,
       * and there is nothing the user can do about it — which is what this check is for.
       */
      const dead = await this.#deadState(binding)
      if (dead !== undefined) {
        /*
         * A dead binding is replaced rather than repaired or unarchived.
         *
         * The conversation has to keep working, and the one thing that is definitely still usable is
         * a session this channel creates itself; unarchiving would be the plugin reaching into a
         * decision the user made on the desktop, and a session deleted on disk has nothing left to
         * repair. `/switch` is still there for anyone who wants the old conversation back.
         */
        const previous = binding
        binding = await this.#bind(params, undefined)
        created = true
        notice = replacedBindingNotice(previous.title, dead, binding.title)
        this.#diagnose(
          `session-state: binding moved conversation=${params.conversationId} ` +
            `from=${previous.sessionId} to=${binding.sessionId} state=${dead} ` +
            `bindingAge=${String(Math.round((Date.now() - previous.createdAt) / 1000))}s`,
        )
      } else {
        // DSH may have restarted since this binding was made; make sure the session
        // is live before handing it a prompt.
        await this.#gateway.ensureSession(binding.sessionId, binding.title)
      }
    }

    binding.lastUsedAt = Date.now()
    await this.#store.save(bindings)

    return {
      kind: 'prompt',
      decision: {
        sessionId: binding.sessionId,
        prompt: text,
        created,
        ...(notice === undefined ? {} : { notice }),
      },
    }
  }

  /** Currently bound session for a conversation, if any. */
  async current(conversationId: string): Promise<SessionBinding | undefined> {
    return (await this.#load())[conversationId]
  }

  async #command(
    params: {
      conversationId: string
      accountId: string
      peerId: string
      numbered?: NumberedRows
      heldHint?: string
    },
    text: string,
  ): Promise<RouteResult> {
    const { command, args } = splitCommand(text)
    const bindings = await this.#load()

    switch (command) {
      case '/help':
        return { kind: 'reply', text: HELP_TEXT }

      case '/new': {
        const binding = await this.#bind(params, args || undefined)
        // Rebinding is the point of `/new`: the conversation must now *be* the new session, or the
        // next message lands in the old one and the new session exists but is unreachable.
        bindings[params.conversationId] = binding
        await this.#store.save(bindings)
        return {
          kind: 'reply',
          text: `已新建对话「${binding.title}」。\n${shortId(binding.sessionId)}\n\n从现在起，你的消息发到这里。`,
        }
      }

      case '/list': {
        /*
         * Two levels, one screen of ten at a time.
         *
         * The list used to be a single flattened table with a cut across it, and a cut is a dead end:
         * whatever fell past row ten existed but could not be reached, and the sentence that counted
         * it was the only sign it was there. So the first level lists the workspaces and the second
         * lists one workspace's conversations, and 「查看其余」 walks either level ten rows at a time.
         * Both levels number continuously across screens, because the number is what the user replies
         * with and it has to keep meaning one row for as long as they are reading.
         *
         * `/list` opens this workspace's own conversations directly — that is the listing people
         * actually want, and making them choose a folder to reach it would be a step for nothing.
         * `/list all` opens the workspace list, which is the only way to reach the rest.
         */
        const all = await this.#gateway.listSessions()
        const own = await this.#ownSessions(all)
        const currentId = bindings[params.conversationId]?.sessionId
        const now = Date.now()

        if (args.trim().toLowerCase() === 'all') {
          const folders = this.#folders(all)
          if (folders.length === 0) {
            return { kind: 'reply', text: '还没有任何对话，直接发消息就会新建一个。' }
          }
          return {
            kind: 'reply',
            text: renderFolderScreen(folders, 1),
            browse: { level: 'folders', workspace: '', page: 1, at: now },
          }
        }

        if (own.length === 0) {
          const ownIds = new Set(own.map((session) => session.sessionId))
          const held = all.filter((session) => !ownIds.has(session.sessionId))
          if (held.length === 0) {
            return { kind: 'reply', text: '还没有任何对话，直接发消息就会新建一个。' }
          }
          /*
           * Nothing to page through, so no position is left behind: 「查看其余」 would have no second
           * screen to show, and a position that only ever answers "已经到底了" is worse than none.
           */
          return { kind: 'reply', text: heldOnlyList(held, this.#ownWorkspaceLabel) }
        }

        const screen = renderSessionScreen(this.#rowsIn('', all, own), {
          label: this.#ownWorkspaceLabel,
          page: 1,
          ...(currentId === undefined ? {} : { currentId }),
          ...this.#heldHintFor(own, all, params.heldHint),
        })
        return {
          kind: 'reply',
          text: screen.text,
          numbered: screen.numbered,
          browse: { level: 'sessions', workspace: '', page: 1, at: now },
        }
      }

      case '/switch': {
        // Shared with a reply inside a folder, so a number, an id and a name mean the same thing
        // whichever way they were typed.
        const switched = await this.#switchTo(params, args, { mode: 'command' })
        /*
         * `mode: 'command'` answers every outcome, so this fallback is unreachable — it exists to say
         * so in the types rather than with an assertion, because a future change that let a command
         * resolve to nothing would otherwise become silence instead of a message.
         */
        return switched ?? { kind: 'reply', text: UNKNOWN_TARGET }
      }

      case '/model': {
        /*
         * Models are listed for the *deployment*, and chosen for the *bound session*.
         *
         * The asymmetry is the host's: the catalog is deployment-wide, while a selection is
         * session-local. So the list is the same wherever it is asked for, and a switch only means
         * something once there is a conversation for it to apply to.
         */
        if (this.#gateway.listModels === undefined) {
          return { kind: 'reply', text: '当前组合没有模型列表，无法查看或切换模型。' }
        }
        const listing = await this.#gateway.listModels()
        const value = args.trim()
        if (value === '') return { kind: 'reply', text: renderModelList(listing) }

        const chosen = resolveModelOption(value, listing.models)
        if (chosen === undefined) {
          // Named back, because the user typed it and a phone keyboard makes typos normal. The next
          // step is spelled out for the same reason `/switch` does it: the alternative is a user who
          // does not know whether the model does not exist or the name was written differently.
          return {
            kind: 'reply',
            text: `找不到模型「${value}」。回复 /model 看清单，再回复编号或模型名字。`,
          }
        }

        const binding = bindings[params.conversationId]
        if (binding === undefined) {
          return { kind: 'reply', text: '当前没有对话。先发一条消息新建一个，再切模型。' }
        }
        if (this.#gateway.selectModel === undefined) {
          return { kind: 'reply', text: '当前组合不支持切换模型。' }
        }
        try {
          const selected = await this.#gateway.selectModel(
            binding.sessionId,
            chosen.provider,
            chosen.model,
            chosen.reasoningEffort,
          )
          // The model id is repeated on its own line, exactly as `/switch` repeats the session id:
          // it is what the user has to type, and a label alone does not identify a model.
          return {
            kind: 'reply',
            text: `已把「${binding.title}」切换到 ${chosen.name}（${chosen.providerName}）。\n${selected.model}`,
          }
        } catch (error) {
          /*
           * The host's own words, not a generic failure.
           *
           * `selectModel` is the only place that knows why a choice was refused — an unconfigured
           * provider, a key that is missing, a model withdrawn since the list was rendered — and a
           * message that hides that leaves the user with nothing to act on.
           */
          const reason = error instanceof Error ? error.message : String(error)
          return { kind: 'reply', text: `切换模型失败：${reason}` }
        }
      }

      case '/current': {
        const binding = bindings[params.conversationId]
        if (binding === undefined) return { kind: 'reply', text: '当前没有对话，发任意消息就会新建一个。' }
        return {
          kind: 'reply',
          text: `当前对话「${binding.title}」\n${shortId(binding.sessionId)}\n最后使用：${new Date(binding.lastUsedAt).toLocaleString('zh-CN')}`,
        }
      }

      case '/cancel': {
        const binding = bindings[params.conversationId]
        if (binding === undefined) return { kind: 'reply', text: '当前没有对话。' }
        await this.#gateway.cancel(binding.sessionId)
        return { kind: 'reply', text: '已请求中断当前任务。' }
      }

      default:
        return { kind: 'reply', text: `未知指令 ${command}。\n\n${HELP_TEXT}` }
    }
  }

  /** Create a binding, its session, and persist it. */
  async #bind(
    params: { conversationId: string; accountId: string; peerId: string },
    requestedTitle: string | undefined,
  ): Promise<SessionBinding> {
    const bindings = await this.#load()
    const sessionId = mintSessionId()
    const title = requestedTitle?.trim() || `${this.#titlePrefix} ${shortId(sessionId)}`
    await this.#gateway.ensureSession(sessionId, title)
    const now = Date.now()
    const binding: SessionBinding = {
      conversationId: params.conversationId,
      accountId: params.accountId,
      peerId: params.peerId,
      sessionId,
      title,
      createdAt: now,
      lastUsedAt: now,
    }
    bindings[params.conversationId] = binding
    await this.#store.save(bindings)
    return binding
  }

  async #load(): Promise<Record<string, SessionBinding>> {
    this.#bindings ??= await this.#store.load()
    return this.#bindings
  }

  /**
   * Whether a bound session can no longer take work, and therefore has to be replaced.
   *
   * Three outcomes, and each one is deliberate:
   *
   *  - The gateway has no probe → `undefined`, and the binding is reused. This is the behaviour the
   *    channel had before the probe existed, and a composition that cannot answer must not be
   *    punished for it.
   *  - The probe throws → `undefined` plus a diagnostic line. A broken probe is not evidence that
   *    the session is dead, and rebinding on it would throw away a working conversation; treating it
   *    as usable keeps the message on its way.
   *  - `missing` on a binding younger than {@link MISSING_BINDING_GRACE_MS} → `undefined` plus a
   *    diagnostic line. The session's first turn is what writes its record, so a fresh binding is
   *    *expected* to look missing; believing it is what produced an endless run of new sessions on a
   *    live machine.
   *
   * @param binding - The binding about to be reused.
   * @returns `archived` or `missing` when it must be replaced, `undefined` when it may be reused.
   */
  async #deadState(binding: SessionBinding): Promise<SessionState | undefined> {
    const probe = this.#gateway.sessionState
    if (probe === undefined) return undefined

    let state: SessionState
    try {
      state = await probe.call(this.#gateway, binding.sessionId)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.#diagnose(
        `session-state: probe failed conversation=${binding.conversationId} ` +
          `session=${binding.sessionId} error=${JSON.stringify(reason)} — treated as usable`,
      )
      return undefined
    }

    if (state === 'usable') return undefined

    if (state === 'missing') {
      const ageMs = Date.now() - binding.createdAt
      if (ageMs < MISSING_BINDING_GRACE_MS) {
        this.#diagnose(
          `session-state: ${binding.sessionId} reported missing but its binding is only ` +
            `${String(Math.round(ageMs / 1000))}s old (grace ${String(MISSING_BINDING_GRACE_MS / 1000)}s) ` +
            `— reusing it, its first turn has probably not written a record yet`,
        )
        return undefined
      }
    }

    return state
  }

  /**
   * Report one routing decision to the host's log, when a sink was given.
   *
   * @param line - The line to write.
   */
  #diagnose(line: string): void {
    this.#onDiagnostic?.(line)
  }

  /**
   * The conversations belonging to the channel's own workspace.
   *
   * @param fallback - The full list, used when the composition cannot tell the two apart. Without a
   *   workspace-aware gateway everything counts as this workspace's own, which is the old behaviour
   *   and the best available answer.
   * @returns This workspace's rows.
   */
  async #ownSessions(fallback: ListedSession[]): Promise<ListedSession[]> {
    return (await this.#gateway.listOwnSessions?.()) ?? fallback
  }

  /** The workspaces this machine has conversations in, in the order the first level prints them. */
  #folders(rows: readonly ListedSession[]): SessionFolder[] {
    return sessionFolders(rows, {
      ...(this.#ownWorkspace === undefined ? {} : { ownWorkspace: this.#ownWorkspace }),
      ownLabel: this.#ownWorkspaceLabel,
    })
  }

  /** Whether a folder is the channel's own workspace. */
  #isOwnFolder(path: string): boolean {
    if (path === '') return true
    return this.#ownWorkspace !== undefined && isSameWorkspace(path, this.#ownWorkspace)
  }

  /**
   * The conversations inside one folder, newest first.
   *
   * The own workspace is asked for by name rather than filtered out of the whole-machine list, so a
   * gateway that reports the two separately cannot have its own rows go missing here.
   *
   * Sorted here rather than trusted from the gateway, for the same reason `/switch` sorts its own
   * pool: the number a reply uses is a position in *this* order, and a gateway that handed its rows
   * over in directory order would make the same number mean two different things depending on which
   * listing it came from.
   *
   * @param path - Folder directory, `''` for the channel's own.
   * @param all - Every conversation the machine knows.
   * @param own - The channel's own conversations.
   * @returns Its rows, newest first.
   */
  #rowsIn(path: string, all: readonly ListedSession[], own: readonly ListedSession[]): ListedSession[] {
    const rows = this.#isOwnFolder(path)
      ? own
      : all.filter(
          (session) => session.workspace !== undefined && isSameWorkspace(session.workspace, path),
        )
    return [...rows].sort(compareSessionsNewestFirst)
  }

  /** The name a folder is printed and recognised by. */
  #folderLabel(path: string): string {
    if (this.#isOwnFolder(path)) return this.#ownWorkspaceLabel
    return workspaceLabel(path) || path
  }

  /**
   * The sentence a folder screen adds about the conversations it cannot show.
   *
   * Only the channel's own folder gets one: the user asked for this workspace's conversations and
   * the rest are somewhere they did not ask about, so they are counted and named rather than left
   * invisible. Inside another folder the same sentence would be noise — that is the folder they
   * chose, and its contents are what they are looking at.
   *
   * @param own - The channel's own conversations.
   * @param all - Every conversation the machine knows.
   * @param hint - Caller's wording for reaching the rest, which differs between typed and spoken.
   */
  #heldHintFor(
    own: readonly ListedSession[],
    all: readonly ListedSession[],
    hint: string | undefined,
  ): { held?: { count: number; names?: readonly string[] }; heldHint?: string } {
    const ownIds = new Set(own.map((session) => session.sessionId))
    const held = all.filter((session) => !ownIds.has(session.sessionId))
    if (held.length === 0) return {}
    return {
      held: { count: held.length, names: heldNames(held) },
      ...(hint === undefined ? {} : { heldHint: hint }),
    }
  }

  /**
   * Answer a message from a conversation that is part-way through a listing.
   *
   * 「查看其余」 has no target, so it can only be understood against where the user is standing —
   * which is the whole reason the position is persisted. A number or a name is read as a step in the
   * level they are on: a workspace at the first, a conversation at the second.
   *
   * Returns nothing when the message is not a step. That is deliberate and load-bearing: a remark
   * typed while a listing is on screen — a question, an instruction, an answer to something the
   * agent asked — has to reach the agent, so the browser only claims what it can actually resolve.
   *
   * @param params - The routing parameters, for the numbering and the caller's held wording.
   * @param text - The message, already trimmed.
   * @param position - Where the conversation is in the browser.
   * @returns A reply with the new position, or undefined when this is not a step.
   */
  async #browseReply(
    params: {
      conversationId: string
      accountId: string
      peerId: string
      numbered?: NumberedRows
      heldHint?: string
    },
    text: string,
    position: BrowsePosition,
  ): Promise<RouteResult | undefined> {
    const bindings = await this.#load()
    const all = await this.#gateway.listSessions()
    const own = await this.#ownSessions(all)
    const currentId = bindings[params.conversationId]?.sessionId
    const now = Date.now()

    if (position.level === 'folders') {
      const folders = this.#folders(all)
      if (isShowRest(text)) {
        const { pages } = browsePage(folders, position.page)
        if (position.page >= pages) {
          return {
            kind: 'reply',
            text: `会话夹只有 ${String(pages)} 页，已经到底了。\n回复编号或名字进入。`,
            // Kept, not cleared: nothing changed, and the user is plainly still reading.
            browse: position,
          }
        }
        return {
          kind: 'reply',
          text: renderFolderScreen(folders, position.page + 1),
          browse: { ...position, page: position.page + 1, at: now },
        }
      }

      const resolution = resolveFolder(text, folders)
      if (resolution.kind === 'ambiguous') {
        return {
          kind: 'reply',
          text: ambiguousFolderMessage(text, resolution.candidates, folders),
          browse: position,
        }
      }
      if (resolution.kind === 'none') return undefined

      const folder = resolution.folder
      const rows = this.#rowsIn(folder.path, all, own)
      const screen = renderSessionScreen(rows, {
        label: folder.label,
        page: 1,
        ...(currentId === undefined ? {} : { currentId }),
        ...(this.#isOwnFolder(folder.path) ? this.#heldHintFor(own, all, params.heldHint) : {}),
      })
      return {
        kind: 'reply',
        text: screen.text,
        numbered: screen.numbered,
        browse: { level: 'sessions', workspace: folder.path, page: 1, at: now },
      }
    }

    const rows = this.#rowsIn(position.workspace, all, own)
    if (isShowRest(text)) {
      const { pages } = browsePage(rows, position.page)
      if (position.page >= pages) {
        return {
          kind: 'reply',
          text: `【${this.#folderLabel(position.workspace)}】只有 ${String(pages)} 页，已经到底了。\n回复编号或行尾 6 位 id 切换。`,
          browse: position,
        }
      }
      const currentId = bindings[params.conversationId]?.sessionId
      const screen = renderSessionScreen(rows, {
        label: this.#folderLabel(position.workspace),
        page: position.page + 1,
        ...(currentId === undefined ? {} : { currentId }),
        ...(this.#isOwnFolder(position.workspace)
          ? this.#heldHintFor(own, all, params.heldHint)
          : {}),
      })
      return {
        kind: 'reply',
        text: screen.text,
        numbered: screen.numbered,
        browse: { ...position, page: position.page + 1, at: now },
      }
    }

    /*
     * Anything else is read the way `/switch` reads a target, so a number, a trailing id and a name
     * all work and both routes resolve identically.
     *
     * The screen is passed as the last resort for a number, so a reply still works if the listing it
     * answers was never frozen — a state write that failed, say. The numbering the caller supplies
     * wins when it has one, because that is the numbering the user is actually looking at.
     */
    return await this.#switchTo(params, text, {
      mode: 'reply',
      fallback: screenRows(rows, position.page),
    })
  }

  /**
   * Move this conversation to the session an argument names.
   *
   * Shared by `/switch` and by a reply inside a folder: one resolver, so a number cannot mean one
   * thing to the typed command and another to a reply.
   *
   * @param params - The routing parameters.
   * @param args - What the user typed or replied with.
   * @param options.mode - `command` answers a failure with guidance; `reply` returns nothing instead,
   *   so a message that merely failed to name a conversation still reaches the agent.
   * @param options.fallback - Numbering to read a number against when the caller has no frozen one.
   * @returns The confirmation, or undefined when nothing resolved and the caller asked to stay quiet.
   */
  async #switchTo(
    params: { conversationId: string; accountId: string; peerId: string; numbered?: NumberedRows },
    args: string,
    options: { mode: 'command' | 'reply'; fallback?: NumberedRows },
  ): Promise<RouteResult | undefined> {
    /*
     * A number is read against the listing the user was shown, never re-derived from live sessions.
     *
     * That is the whole point of the numbering: sessions run while the user reads the list, so a
     * number resolved against "whatever is newest now" can land somewhere else entirely. The caller
     * passes the rows a quote pinned, or the newest listing this conversation received; only when it
     * knows of neither does this fall back to the live list.
     */
    const bindings = await this.#load()
    const all = await this.#gateway.listSessions()
    const own = await this.#ownSessions(all)
    const pinned =
      params.numbered !== undefined && params.numbered.sessions.length > 0
        ? params.numbered
        : options.fallback
    /*
     * Ordered here rather than trusted from the gateway: the number the user typed refers to a
     * position in a listing, and a listing is ordered by this file. A gateway that happens to hand its
     * rows over in directory order would otherwise make the same number mean two different things
     * depending on whether a list was shown first.
     */
    const pool: NumberedRows =
      pinned !== undefined && pinned.sessions.length > 0
        ? pinned
        : { sessions: [...own].sort(compareSessionsNewestFirst), first: 1 }
    // Ids and titles stay searchable across everything the machine knows, so a session named rather
    // than numbered is still reachable — including one that only a pinned listing knows.
    const known = new Map<string, NumberedSession>(all.map((session) => [session.sessionId, session]))
    for (const session of pool.sessions) {
      if (!known.has(session.sessionId)) known.set(session.sessionId, session)
    }
    const searchable = [...known.values()]
    const resolution = resolveTarget(args, searchable, pool)
    if (resolution.kind === 'ambiguous') {
      if (options.mode === 'reply') return undefined
      return { kind: 'reply', text: ambiguousTargetMessage(args.trim(), resolution.candidates) }
    }
    if (resolution.kind === 'none') {
      if (options.mode === 'reply') return undefined
      return { kind: 'reply', text: UNKNOWN_TARGET }
    }
    const target = resolution.session
    await this.#gateway.ensureSession(target.sessionId, target.title)
    const binding: SessionBinding = {
      conversationId: params.conversationId,
      accountId: params.accountId,
      peerId: params.peerId,
      sessionId: target.sessionId,
      title: target.title || this.#titlePrefix,
      createdAt: bindings[params.conversationId]?.createdAt ?? Date.now(),
      lastUsedAt: Date.now(),
    }
    bindings[params.conversationId] = binding
    await this.#store.save(bindings)
    // No `browse`: the reply names a conversation that is now in use, so the listing it came from is
    // finished with and the next 「查看其余」 must not continue it.
    return { kind: 'reply', text: `已切换到「${binding.title}」。\n${shortId(binding.sessionId)}` }
  }
}

/** Commands that may be written with or without an argument. */
const COMMANDS_WITH_ARG = ['/new', '/switch', '/model'] as const

/** Commands that never take an argument. */
const COMMANDS_BARE = ['/help', '/list', '/current', '/cancel'] as const

/**
 * Split `/cmd args` into its parts.
 *
 * The separator space is optional, and `:` is accepted in its place, because these
 * commands are typed on a phone keyboard where a dropped space is the common case.
 * `/switch1`, `/switch 1`, and `/switch:1` all mean the same thing. A leading token
 * that only *starts* with a command name is left alone, so `/news` is not `/new`.
 */
export function splitCommand(text: string): { command: string; args: string } {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()

  const space = trimmed.search(/\s/)
  if (space >= 0) {
    return { command: lower.slice(0, space), args: trimmed.slice(space + 1).trim() }
  }

  const colon = lower.indexOf(':')
  if (colon > 0) {
    return { command: lower.slice(0, colon), args: trimmed.slice(colon + 1).trim() }
  }

  if ((COMMANDS_BARE as readonly string[]).includes(lower)) {
    return { command: lower, args: '' }
  }

  for (const command of COMMANDS_WITH_ARG) {
    if (!lower.startsWith(command)) continue
    const rest = trimmed.slice(command.length)
    // A following ASCII letter means this was a different word, not this command
    // with a glued argument: `/news` must not parse as `/new` plus `s`. Digits and
    // non-ASCII text are legitimate glued arguments (`/switch1`, `/new我的任务`).
    if (/^[a-z]/.test(rest)) continue
    return { command, args: rest.replace(/^[:\s]+/, '').trim() }
  }

  return { command: lower, args: '' }
}

/** What a `/switch` and a reply inside a folder both say when nothing matched. */
const UNKNOWN_TARGET = '找不到这个对话。回复 /list 看清单，再回复数字或 id。'

/**
 * What the user is told when their conversation had to be moved to a new session.
 *
 * Said out loud because the alternative is a conversation that silently changed identity: the
 * messages keep going out, the answers come back from a session with no history, and the only
 * explanation available is a log line the user cannot see. The old title is named so they recognise
 * which conversation was left behind, and the new one so they can find it in `/list`.
 *
 * @param previousTitle - Title of the session that can no longer take messages.
 * @param state - Why it was replaced.
 * @param nextTitle - Title of the session that is now bound.
 * @returns The sentence to send into the chat.
 */
function replacedBindingNotice(
  previousTitle: string,
  state: SessionState,
  nextTitle: string,
): string {
  const why = state === 'archived' ? '已经被归档' : '在电脑上已经不存在了'
  return (
    `原对话「${previousTitle}」${why}，我已新建「${nextTitle}」并接到这里。\n` +
    '你刚发的这条会发到新对话里，之前那个的上下文不在新对话里。'
  )
}

/**
 * What a `/switch` argument resolved to.
 *
 * Ambiguity is a distinct outcome rather than a missing one. The two need different answers: nothing
 * matched means "look at the list again", while several matched means "your id is too short" — and
 * the second is the one the user can fix, so it has to name the candidates instead of guessing.
 */
export type TargetResolution =
  | { kind: 'found'; session: NumberedSession }
  | { kind: 'ambiguous'; candidates: NumberedSession[] }
  | { kind: 'none' }

/**
 * Resolve a `/switch` argument against the session list.
 *
 * Accepts a 1-based list position, a full session id, the short id printed by `/list` (or any longer
 * prefix of it), or a title — a phone keyboard makes copying a full uuid painful.
 *
 * Matching is deliberately strict. Session ids share a common shape (`session-<short>-<uuid>`), so a
 * loose `includes` test can match several rows; an ambiguous argument must fail rather than switch to
 * a surprise session. Since the printed id is only the first few hex digits of it, two conversations
 * *can* share one, and the caller is told to ask for a longer one rather than being handed whichever
 * happened to be found first.
 *
 * Order matters: the exact readings are tried before the prefix reading, so a conversation whose
 * title looks like a hex fragment is still reachable by that title.
 *
 * @param args - What the user typed after `/switch`.
 * @param sessions - Every session that may be named, usually the whole machine.
 * @param numbered - The rows a number refers to, and the number printed beside the first of them.
 *
 *   This matters because the two are not the same list. A number is answered from the listing the
 *   user was actually shown, while a title or id may name a session from any workspace — and a
 *   conversation the user picked out of a listing has to be switchable, or the listing is a lie.
 *   The offset is part of it because numbering runs on across screens: the second screen of ten
 *   prints 11..20, and a "13" read as row 3 would move the chat to a conversation that screen never
 *   showed.
 */
export function resolveTarget(
  args: string,
  sessions: readonly NumberedSession[],
  numbered: NumberedRows = { sessions: [...sessions], first: 1 },
): TargetResolution {
  const value = args.trim()
  if (!value) return { kind: 'none' }

  if (/^\d+$/.test(value)) {
    // A number refers to a row of the listing the user was shown, which is not necessarily the whole
    // machine — hence `numbered` rather than `sessions`.
    const index = Number(value) - numbered.first
    const byIndex = index < 0 ? undefined : numbered.sessions[index]
    if (byIndex !== undefined) return { kind: 'found', session: byIndex }
    /*
     * Fall through: a numeric string can still be a title or an id.
     *
     * A number *below* the screen's first one is not silently folded onto row 1 — numbering runs on,
     * so "3" on a screen that starts at 11 is a number from a screen the user has scrolled past, and
     * guessing which row they meant is exactly the drift the pin exists to prevent.
     */
  }

  const exactId = sessions.find((session) => session.sessionId === value)
  if (exactId !== undefined) return { kind: 'found', session: exactId }

  const byTitle = sessions.find((session) => session.title === value)
  if (byTitle !== undefined) return { kind: 'found', session: byTitle }

  // The short id lives in the middle: `session-<short>-<uuid>`. Any prefix of it does too, which is
  // what makes "use a longer id" an answer the user can act on.
  if (/^[0-9a-f]+$/i.test(value)) {
    const lower = value.toLowerCase()
    const byPrefix = sessions.filter((session) => idKeyOf(session.sessionId).startsWith(lower))
    if (byPrefix.length === 1) return { kind: 'found', session: byPrefix[0] }
    if (byPrefix.length > 1) return { kind: 'ambiguous', candidates: byPrefix }
  }

  const bySuffix = sessions.filter((session) => session.sessionId.endsWith(value))
  if (bySuffix.length === 1) return { kind: 'found', session: bySuffix[0] }
  if (bySuffix.length > 1) return { kind: 'ambiguous', candidates: bySuffix }

  /*
   * Last, a *core* title match in either direction — and only when exactly one session matches.
   *
   * People name a conversation the way they talk about it, in both directions of slop: they type a
   * fragment («北京»), or they add words of their own («北京今天天气如何**会话**»). Both are the same
   * request as the exact title, and exact matching alone failed on each — a hard failure for a
   * request the user can see is answerable.
   *
   * Uniqueness is the safeguard, and it is why this is the last resort. Several matches, or none,
   * return nothing: an ambiguous argument must fail rather than move the conversation somewhere the
   * user did not ask for. A word as short as a single character will usually match nothing here for
   * the same reason — good, because it would be a guess.
   */
  const core = (session: { title: string }): boolean =>
    session.title.includes(value) || value.includes(session.title)
  const byCore = sessions.filter((session) => session.title !== '' && core(session))
  if (byCore.length === 1) return { kind: 'found', session: byCore[0] }

  return { kind: 'none' }
}

/**
 * The identifier a short id is a prefix of.
 *
 * The id is `session-<hex>-<uuid>`, and the hex group repeats the first characters of the uuid, so
 * the middle group is what the user sees and types. Ids without that shape fall back to their bare
 * form, so the same prefix rule still applies to a session from another implementation.
 *
 * @param sessionId - Session id.
 * @returns The string a typed short id is a prefix of, lower-cased.
 */
function idKeyOf(sessionId: string): string {
  const match = /^session-([0-9a-f]+)-/i.exec(sessionId)
  return (match?.[1] ?? sessionId.replace(/^session-/, '')).toLowerCase()
}

/**
 * The message for a `/switch` whose id was too short to identify one conversation.
 *
 * The candidates are printed with the *longest* prefix of their hex group, which is exactly the
 * longer id the user should reply with — and with their titles, because a phone user recognises the
 * conversation, not the id.
 *
 * @param value - What the user typed.
 * @param candidates - Every session it matched.
 * @returns The message body.
 */
export function ambiguousTargetMessage(
  value: string,
  candidates: readonly NumberedSession[],
): string {
  const lines = candidates.map((session) => {
    const match = /^session-([0-9a-f]+)-/i.exec(session.sessionId)
    const longer = (match?.[1] ?? session.sessionId).toLowerCase()
    return `${longer} · ${(session.title || '(无标题)').trim()}`
  })
  return [
    `有多个会话匹配「${value}」，请用更长的 id（下面每一行开头的就是）：`,
    '',
    ...lines,
    '',
    '完整 id 也可以，回复 /list 能再看一次清单。',
  ].join('\n')
}

/**
 * Mint a session id in DSH's own format.
 *
 * The id is `session-<uuid>` because the host treats that shape as its native
 * session identity. The trailing hex group is random; the leading group is
 * derived from it so that the compact form shown by `/list` is also the form
 * `/switch` accepts. Keeping the two identical is what makes switching possible
 * from a phone keyboard.
 */
export function mintSessionId(random: () => string = randomUUID): string {
  const uuid = random()
  const tail = uuid.replace(/-/g, '').slice(0, 8)
  return `session-${tail}-${uuid}`
}

/**
 * How many characters of a session id the list prints.
 *
 * Six hex digits is still short enough to read and retype on a phone, while the space it draws from
 * is 16 777 216 values instead of the 65 536 four digits gave: a machine with a few hundred sessions
 * collided often enough to be noticed, and the extra two characters are free to type. The printed
 * form is a prefix of the id, so a collision is answered by asking for more characters rather than by
 * failing. The bound is the requirement, not a preference: an identifier the user has to copy is not
 * an identifier they will use.
 */
export const SHORT_ID_LENGTH = 6

/** Compact identifier shown to the user, and accepted back by `/switch`. */
export function shortId(sessionId: string): string {
  const match = /^session-([0-9a-f]+)-/i.exec(sessionId)
  if (match) return match[1].slice(0, SHORT_ID_LENGTH)
  return sessionId.replace(/^session-/, '').slice(0, SHORT_ID_LENGTH)
}

/**
 * The name a user knows a workspace by.
 *
 * The store records absolute directories, and a full path in a chat message is noise. The last
 * component is what the desktop sidebar shows, so it is what the user will recognise.
 *
 * @param path - Working directory recorded for a session.
 * @returns Its final path component, or the path itself when there is nothing to trim.
 */
export function workspaceLabel(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '')
  return parts.at(-1) ?? path
}

/**
 * Resolve a `/model` argument against the catalog.
 *
 * Accepts a 1-based list position, a model id, or a model name — the same three shapes `/switch`
 * accepts for a conversation, for the same reason: the number is what the listing prints, and the
 * name is what a person remembers.
 *
 * Matching is deliberately strict, and every match must be unique. Two providers can expose the same
 * model id (`deepseek-chat` from two accounts), so a loose match would silently pick one of them, and
 * which one silently picked is not something the user could even see. Several matches return
 * undefined: a model the user did not ask for is worse than a question.
 *
 * @param args - What the user typed after `/model`.
 * @param models - Every model the host offers, in the order the listing numbered them.
 */
export function resolveModelOption(
  args: string,
  models: readonly ModelOption[],
): ModelOption | undefined {
  const value = args.trim()
  if (value === '') return undefined

  if (/^\d+$/.test(value)) {
    const byIndex = models[Number(value) - 1]
    if (byIndex !== undefined) return byIndex
    // Fall through: a numeric string can still be part of a name or an id.
  }

  // Case-insensitive, unlike session titles: model ids are machine-written identifiers, and a user
  // retyping `deepseek-chat` from a phone should not have to match its capitalisation.
  const lower = value.toLowerCase()
  const byId = models.filter((option) => option.model.toLowerCase() === lower)
  if (byId.length === 1) return byId[0]

  const byName = models.filter((option) => option.name.toLowerCase() === lower)
  if (byName.length === 1) return byName[0]

  // Last, a *core* name match in either direction — a fragment, or the name with words of its own,
  // which is how people refer to a model in a sentence. Uniqueness is the safeguard; see above.
  const core = (option: ModelOption): boolean => {
    const name = option.name.toLowerCase()
    return name !== '' && (name.includes(lower) || lower.includes(name))
  }
  const byCore = models.filter(core)
  if (byCore.length === 1) return byCore[0]

  return undefined
}

/**
 * How many rows one screen of the browser shows, at both levels.
 *
 * Ten, because that is what a phone screen holds and what the listing already showed. The point of
 * two levels is not to fit more on one screen but to make every conversation reachable without ever
 * printing more than a readable amount at once — which is what the old fixed cut could not do.
 */
export const BROWSE_PAGE_SIZE = 10

/** The phrase that walks one screen further down whichever level the user is on. */
export const SHOW_REST = '查看其余'

/**
 * Whether a message is the phrase that walks to the next screen.
 *
 * Trailing sentence punctuation is stripped because a phone keyboard adds it and the user is writing
 * a sentence, not typing a token. Nothing else is accepted: this phrase has no target, so a near miss
 * that was guessed at would move the user somewhere they did not ask to go.
 *
 * @param text - The inbound message.
 */
export function isShowRest(text: string): boolean {
  return text.trim().replace(/[。．.!！?？]+$/, '') === SHOW_REST
}

/**
 * Group rows into the folders the first level lists.
 *
 * The channel's own workspace leads, because those are the conversations this chat created; the rest
 * follow, most recently active first, with the directory as the tie-break so the same machine always
 * produces the same list. A row that does not say where it lives counts as the channel's own, which
 * is the only workspace a conversation can vouch for.
 *
 * Counts, not rows: the first level answers "which project", and its rows have to be small enough
 * that ten of them name ten projects. A folder holding nothing is left out — a row that opens onto
 * an empty list is a dead end dressed as a choice.
 *
 * @param rows - Every conversation the machine knows.
 * @param options.ownWorkspace - Directory the channel's own conversations live in.
 * @param options.ownLabel - Name printed for that directory.
 * @returns Non-empty folders, in display order.
 */
export function sessionFolders(
  rows: readonly ListedSession[],
  options: { ownWorkspace?: string; ownLabel: string },
): SessionFolder[] {
  let own = 0
  const byPath = new Map<string, { count: number; newest: number }>()
  for (const row of rows) {
    const path = row.workspace
    const isOwn =
      path === undefined ||
      (options.ownWorkspace !== undefined && isSameWorkspace(path, options.ownWorkspace))
    if (isOwn) {
      own += 1
      continue
    }
    const seen = byPath.get(path)
    if (seen === undefined) byPath.set(path, { count: 1, newest: row.updatedAt })
    else {
      seen.count += 1
      if (row.updatedAt > seen.newest) seen.newest = row.updatedAt
    }
  }

  const others = [...byPath.entries()]
    .map(([path, stats]) => ({ path, ...stats }))
    .sort((a, b) => {
      if (a.newest !== b.newest) return b.newest - a.newest
      if (a.path === b.path) return 0
      return a.path < b.path ? -1 : 1
    })

  const folders: SessionFolder[] = []
  if (own > 0) folders.push({ path: options.ownWorkspace ?? '', label: options.ownLabel, count: own })
  for (const group of others) {
    folders.push({
      path: group.path,
      label: workspaceLabel(group.path) || group.path,
      count: group.count,
    })
  }
  return folders
}

/**
 * Cut one screen of ten out of an ordered sequence.
 *
 * @param rows - The whole sequence, already ordered.
 * @param page - 1-based screen to cut; clamped into range, so a stored page that no longer exists
 *   still renders something rather than an empty message.
 * @returns The rows on that screen, where the screen sits, and how many there are.
 */
export function browsePage<T>(
  rows: readonly T[],
  page: number,
): { items: T[]; page: number; pages: number; start: number } {
  const pages = Math.max(1, Math.ceil(rows.length / BROWSE_PAGE_SIZE))
  const wanted = Number.isFinite(page) ? Math.trunc(page) : 1
  const current = Math.min(Math.max(wanted, 1), pages)
  const start = (current - 1) * BROWSE_PAGE_SIZE
  return { items: rows.slice(start, start + BROWSE_PAGE_SIZE), page: current, pages, start }
}

/**
 * The numbering one screen of a folder prints, for a caller that has no frozen listing.
 *
 * Only a fallback: the numbering the user is looking at is the one frozen under the message that
 * printed it, and the caller passes that whenever it has one.
 *
 * @param rows - Every row of the folder, ordered.
 * @param page - Screen the reply is answering.
 * @returns That screen's rows and the number printed beside the first of them.
 */
export function screenRows(rows: readonly ListedSession[], page: number): NumberedRows {
  const { items, start } = browsePage(rows, page)
  return {
    sessions: items.map((session) => ({ sessionId: session.sessionId, title: session.title })),
    first: start + 1,
  }
}

/**
 * Render one screen of the workspace list.
 *
 * @param folders - Every folder, in display order.
 * @param page - 1-based screen to print.
 * @returns The message body.
 */
export function renderFolderScreen(folders: readonly SessionFolder[], page: number): string {
  const { items, page: current, pages, start } = browsePage(folders, page)
  const sections = [`会话夹（${String(current)}/${String(pages)}）`]
  if (items.length === 0) sections.push('（还没有其它工作区）')
  items.forEach((folder, index) => {
    sections.push(`${String(start + index + 1)}. ${folder.label}  ${String(folder.count)} 个会话`)
  })
  sections.push(
    '',
    current < pages ? '回复编号或名字进入；回复「查看其余」看下十个。' : '回复编号或名字进入。',
  )
  return sections.join('\n')
}

/**
 * Render one screen of a folder's conversations.
 *
 * The numbering runs on across screens, so the second screen of ten prints 11..20 — the number is
 * what the user replies with, and starting over at 1 would give one number two meanings within a
 * single browse.
 *
 * @param rows - Every conversation in the folder, ordered.
 * @param options.label - Folder name, printed in the heading.
 * @param options.page - 1-based screen to print.
 * @param options.currentId - Session this conversation is bound to, marked in the list.
 * @param options.held - Conversations in other folders, counted and named rather than left invisible.
 * @param options.heldHint - How to reach them, which differs between typed and spoken requests.
 * @param options.now - Current time, so every row of one message agrees on what "3 分钟前" means.
 * @returns The message body, and the numbering it printed.
 */
export function renderSessionScreen(
  rows: readonly ListedSession[],
  options: {
    label: string
    page: number
    currentId?: string
    held?: { count: number; names?: readonly string[] }
    heldHint?: string
    now?: number
  },
): { text: string; numbered: NumberedRows } {
  const now = options.now ?? Date.now()
  const { items, page, pages, start } = browsePage(rows, options.page)
  const sections = [`【${options.label}】会话（${String(page)}/${String(pages)}）`]
  if (items.length === 0) sections.push('（这个会话夹还没有对话）')
  items.forEach((session, index) => {
    sections.push(renderSessionRow(session, start + index, options.currentId, now))
  })

  const held = options.held
  if (held !== undefined && held.count > 0) {
    const names = held.names ?? []
    sections.push(
      '',
      `另有 ${String(held.count)} 个对话在其它会话夹${
        names.length === 0 ? '' : `（${names.join('、')}）`
      }，${options.heldHint ?? '发 /list all 看会话夹。'}`,
    )
  }

  /*
   * The phrase is offered only when there is somewhere for it to go. A listing that ends by inviting
   * the user to ask for more, on a screen where there is no more, teaches them the command does
   * nothing.
   *
   * The row's trailing id is named, not just printed: reading the number and replying with it is what
   * users did, and nothing said the id was also a way in — the one form that cannot expire.
   */
  sections.push(
    '',
    page < pages
      ? '回复编号或行尾 6 位 id 切换；回复「查看其余」看下十个。'
      : '回复编号或行尾 6 位 id 切换。',
  )
  sections.push('引用这条消息再回编号，可以避免编号过期。')

  return {
    text: sections.join('\n'),
    numbered: {
      sessions: items.map((session) => ({ sessionId: session.sessionId, title: session.title })),
      first: start + 1,
    },
  }
}

/** What entering a folder resolved to. Ambiguous and none are separate, as for `resolveTarget`. */
export type FolderResolution =
  | { kind: 'found'; folder: SessionFolder }
  | { kind: 'ambiguous'; candidates: SessionFolder[] }
  | { kind: 'none' }

/**
 * Resolve what the user typed against the workspace list.
 *
 * Accepts the printed number, the printed name, or a fragment of it — the same three shapes
 * `resolveTarget` accepts for a conversation, for the same reason: the number is what the listing
 * prints, and the name is what a person remembers.
 *
 * Two directories routinely share a last component (`…/workplace` under two parents), and the printed
 * name is that last component — so a name matching several folders returns the candidates instead of
 * picking one. Entering the wrong project's folder is worse than a question.
 *
 * @param args - What the user replied with.
 * @param folders - Every folder, in the order the listing numbered them.
 * @returns What it named.
 */
export function resolveFolder(args: string, folders: readonly SessionFolder[]): FolderResolution {
  const value = args.trim()
  if (value === '') return { kind: 'none' }

  if (/^\d+$/.test(value)) {
    const byIndex = folders[Number(value) - 1]
    if (byIndex !== undefined) return { kind: 'found', folder: byIndex }
    // Fall through: a numeric string can still be a folder name.
  }

  const byLabel = folders.filter((folder) => folder.label === value)
  if (byLabel.length === 1) return { kind: 'found', folder: byLabel[0] }
  if (byLabel.length > 1) return { kind: 'ambiguous', candidates: byLabel }

  // Last, a *core* match in either direction, exactly as a conversation title is matched: people
  // name a project the way they talk about it, so a fragment or the name with words of its own has
  // to work. Uniqueness is the safeguard.
  const byCore = folders.filter(
    (folder) => folder.label !== '' && (folder.label.includes(value) || value.includes(folder.label)),
  )
  if (byCore.length === 1) return { kind: 'found', folder: byCore[0] }
  if (byCore.length > 1) return { kind: 'ambiguous', candidates: byCore }

  return { kind: 'none' }
}

/**
 * The message for a workspace name that named several folders.
 *
 * The candidates are printed with their numbers, because the number is the one form that is never
 * ambiguous, and it is what the user replies with next.
 *
 * @param value - What the user typed.
 * @param candidates - Every folder it matched.
 * @param folders - The whole list, so each candidate can be shown with its own number.
 * @returns The message body.
 */
export function ambiguousFolderMessage(
  value: string,
  candidates: readonly SessionFolder[],
  folders: readonly SessionFolder[],
): string {
  const lines = candidates.map((folder) => {
    const number = folders.findIndex((candidate) => candidate.path === folder.path) + 1
    return `${String(number)}. ${folder.path}  ${String(folder.count)} 个会话`
  })
  return [
    `有多个会话夹匹配「${value.trim()}」，请回复编号：`,
    '',
    ...lines,
    '',
    '回复 /list all 能再看一次会话夹清单。',
  ].join('\n')
}

/** How much of a conversation title a row prints before it is cut. */
const TITLE_LIMIT = 24

/**
 * Render one row of a session list.
 *
 * The title leads because it is what a person recognises, the time follows because the list is
 * ordered by it, and the **short id closes the row** because it is what `/switch` accepts when a
 * number is not enough — and a workspace heading is shared by every row under it, so two
 * conversations in one workspace are otherwise indistinguishable.
 *
 * One row per line rather than two: a listing of ten conversations has to fit in one WeChat message,
 * and a second line per row doubles the height of a phone screen full of them.
 *
 * @param session - Session to render.
 * @param index - 0-based position, rendered as the 1-based number to reply with.
 * @param currentId - Session this conversation is bound to, marked in the list.
 * @param now - Current time, so every row of one message agrees on what "3 分钟前" means.
 * @returns The row.
 */
export function renderSessionRow(
  session: { sessionId: string; title?: string; updatedAt?: number },
  index: number,
  currentId: string | undefined,
  now: number = Date.now(),
): string {
  const mark = session.sessionId === currentId ? ' ← 当前' : ''
  const title = truncateTitle(session.title ?? '')
  // A record with no usable timestamp is left undated rather than shown as 1970: a session the store
  // knows nothing about is better described by its title than by an epoch it never had.
  const at = session.updatedAt
  const when = at === undefined || !Number.isFinite(at) || at <= 0 ? '' : ` · ${relativeTime(at, now)}`
  return `${String(index + 1)}. ${title}${when}${mark}  ${shortId(session.sessionId)}`
}

/**
 * Trim a conversation title for one row.
 *
 * A session is named from the user's first sentence, which is routinely a whole paragraph. Printing it
 * whole pushes the time and the id off the screen, and those are the parts the row exists to deliver.
 *
 * @param title - Title as recorded.
 * @returns A title that fits, or `(无标题)`.
 */
function truncateTitle(title: string): string {
  const trimmed = title.trim().replace(/\s+/g, ' ')
  if (trimmed === '') return '(无标题)'
  return trimmed.length <= TITLE_LIMIT ? trimmed : `${trimmed.slice(0, TITLE_LIMIT)}…`
}

/**
 * The message for a `/list` whose own workspace has no conversations yet.
 *
 * @param held - Conversations in other workspaces.
 * @param ownLabel - Heading for the channel's own workspace.
 * @returns The message body.
 */
export function heldOnlyList(held: readonly ListedSession[], ownLabel: string): string {
  return [
    `【${ownLabel}】还没有对话，直接发消息就会新建一个。`,
    '',
    `另有 ${String(held.length)} 个对话在其它会话夹${heldHintSuffix(held)}，发 /list all 看会话夹。`,
  ].join('\n')
}

/**
 * The workspace names behind a set of held rows, for the sentence that counts them.
 *
 * @param held - Rows left out of a listing.
 * @returns Distinct workspace labels, sorted, without duplicates.
 */
export function heldNames(held: readonly ListedSession[]): string[] {
  const names = new Set<string>()
  for (const session of held) {
    if (session.workspace !== undefined) names.add(workspaceLabel(session.workspace))
  }
  return [...names].sort()
}

/** `（a、b）` for the held-workspace names, or an empty string when there are none. */
function heldHintSuffix(held: readonly ListedSession[]): string {
  const names = heldNames(held)
  return names.length === 0 ? '' : `（${names.join('、')}）`
}

/**
 * Render the model list.
 *
 * Unlike sessions this is not capped. A session list grows without bound as a machine is used, so it
 * needs a cut-off; a model catalog is a closed set the host itself offers in full, and every model
 * has to be reachable by the number printed next to it.
 *
 * @param listing - Models on offer, and the selection the host reports.
 * @returns The message body.
 */
export function renderModelList(listing: ModelListing): string {
  const models = listing.models
  if (models.length === 0) return '当前没有可用的模型。'

  const current = listing.current
  const currentName = current === undefined ? undefined : labelOfModel(current, models)
  const header = `可用模型（共 ${String(models.length)} 个${currentName === undefined ? '' : `，当前：${currentName}`}）：`
  const rows = models.map((option, index) => renderModelRow(option, index, current))
  // Providers that failed are named rather than silently missing: a model that is simply absent
  // reads as a model the deployment does not have, which is a different thing to act on.
  const failures = listing.failures ?? []
  const unavailable =
    failures.length === 0
      ? ''
      : `\n\n另有 ${String(failures.length)} 个提供方的模型这次没取到：${failures
          .map((failure) => `${failure.name}（${failure.message}）`)
          .join('、')}`

  return [
    header,
    '',
    rows.join('\n\n'),
    unavailable,
    '',
    '回复 /model 编号即可切换，也可以直接发模型名字。',
  ].join('\n')
}

/**
 * Render one row of the model list.
 *
 * The label leads because it is what a person recognises; the provider and the id follow, because
 * two providers can offer the same id and the id is what the user may end up typing.
 *
 * @param option - Model to render.
 * @param index - 0-based position, rendered as the 1-based number to reply with.
 * @param current - Selection the host reports, marked in the list.
 * @returns The row.
 */
function renderModelRow(
  option: ModelOption,
  index: number,
  current: ModelSelection | undefined,
): string {
  const mark =
    current !== undefined && current.provider === option.provider && current.model === option.model
      ? '  ← 当前'
      : ''
  const provider = option.providerName.trim() === '' ? option.provider : option.providerName
  return `${String(index + 1)}. ${option.name}${mark}\n   ${provider} · ${option.model}`
}

/** What to call a selection in a heading: its label when it is on offer, else its id. */
function labelOfModel(selection: ModelSelection, models: readonly ModelOption[]): string {
  const found = models.find(
    (option) => option.provider === selection.provider && option.model === selection.model,
  )
  return found?.name ?? selection.model
}

/**
 * How long ago something happened, in the words a person would use.
 *
 * Relative rather than absolute because the question the list answers is "which one was I just
 * working on", and a 24-hour clock makes that harder, not easier. `昨天` appears because that is the
 * word people actually use for it, and it is the boundary a reader cares about most.
 *
 * @param at - Timestamp in milliseconds.
 * @param now - Current time, injectable so the wording is testable and one message stays consistent.
 * @returns A short phrase such as `3 分钟前`.
 */
export function relativeTime(at: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  // Whole days elapsed, not calendar days: a conversation 25 hours old was "昨天" by any reading the
  // user would give it, and matching their clock exactly is not worth a timezone.
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  return new Date(at).toLocaleDateString('zh-CN')
}

export const HELP_TEXT = [
  '可用指令：',
  '/new [标题]      新建对话',
  '/list            列出微信会话（本工作区）',
  '/list all        列出全部会话夹，回复编号或名字进入',
  '/switch <编号>   切换（引用列表消息再回编号，编号不会过期）',
  '/switch <id>     按列表行尾那个 6 位 id 切换，例如 /switch e716f0',
  '/model <编号>    查看或切换模型',
  '/current         显示当前对话',
  '/cancel          中断当前任务',
  '/help            显示本帮助',
  '',
  `每屏最多 ${String(BROWSE_PAGE_SIZE)} 条，编号跨屏连续；回复「${SHOW_REST}」看下十个。`,
  '列表就在眼前时，直接回编号、名字或行尾 id 即可，不必打 /switch。',
  '',
  '直接发消息即与当前对话对话。',
  '',
  '也可以直接用大白话说，例如「查看对话列表」「换个对话」「换个模型」「停下」，',
  '我会先问你一次确认，确认后才执行。',
].join('\n')
