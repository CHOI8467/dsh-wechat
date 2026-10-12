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
   * {@link groupSessionRows}.
   */
  workspace?: string
}

/** One workspace's rows, in the order the listing prints them. */
export interface SessionGroup {
  /** Heading printed above this workspace's rows. */
  label: string
  sessions: ListedSession[]
}

/** Why the router handed work to the agent, for logging. */
export interface RouteDecision {
  /** Session the prompt belongs to. */
  sessionId: string
  /** Text to send to the agent. */
  prompt: string
  /** True when this message started a brand new session. */
  created: boolean
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
      numbered?: NumberedSession[]
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
   * Recent sessions, newest first, for `/list all`.
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
}

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
  #bindings: Record<string, SessionBinding> | undefined

  constructor(options: SessionRouterOptions) {
    this.#gateway = options.gateway
    this.#store = options.store
    this.#titlePrefix = options.titlePrefix ?? '微信'
    this.#ownWorkspace = options.ownWorkspace
    this.#ownWorkspaceLabel = options.ownWorkspaceLabel ?? '微信会话'
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
   * @returns Either text to reply with directly, or a prompt for a session.
   */
  async route(params: {
    conversationId: string
    accountId: string
    peerId: string
    text: string
    numbered?: readonly NumberedSession[]
    heldHint?: string
  }): Promise<RouteResult> {
    const text = params.text.trim()

    if (text.startsWith('/')) {
      return await this.#command(params, text)
    }

    const bindings = await this.#load()
    let binding = bindings[params.conversationId]
    let created = false
    if (binding === undefined) {
      binding = await this.#bind(params, undefined)
      created = true
    } else {
      // DSH may have restarted since this binding was made; make sure the session
      // is live before handing it a prompt.
      await this.#gateway.ensureSession(binding.sessionId, binding.title)
    }

    binding.lastUsedAt = Date.now()
    await this.#store.save(bindings)

    return {
      kind: 'prompt',
      decision: { sessionId: binding.sessionId, prompt: text, created },
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
      numbered?: readonly NumberedSession[]
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
         * The default list is this workspace's own conversations only; `/list all` adds the rest, and
         * both are grouped by the workspace each conversation lives in.
         *
         * Grouping is read rather than inferred: a flat list of eighty conversations from six
         * projects says nothing about which is which, and the number the user replies with has to
         * identify a row they can actually see.
         *
         * "Only", not "first": the rest are held back and counted, with the sentence that says how to
         * see them. A user who is never told cannot ask.
         *
         * `/list all` is cut per workspace, never globally — see {@link LIST_ALL_GROUP_LIMIT}. A single
         * global cut is what made this command useless: this workspace is the busiest one, so the ten
         * rows were all its own, grouping then produced a single heading, and the reply was
         * indistinguishable from plain `/list`.
         */
        const all = await this.#gateway.listSessions()
        const own = await this.#ownSessions(all)
        const wantsAll = args.trim().toLowerCase() === 'all'
        const rows = wantsAll ? all : own
        const ownIds = new Set(own.map((session) => session.sessionId))
        const held = wantsAll ? [] : all.filter((session) => !ownIds.has(session.sessionId))
        if (rows.length === 0 && held.length === 0) {
          return { kind: 'reply', text: '还没有任何对话，直接发消息就会新建一个。' }
        }
        if (rows.length === 0) {
          return { kind: 'reply', text: heldOnlyList(held, this.#ownWorkspaceLabel) }
        }

        const groups = groupSessionRows(rows, {
          ...(this.#ownWorkspace === undefined ? {} : { ownWorkspace: this.#ownWorkspace }),
          ownLabel: this.#ownWorkspaceLabel,
          ...(wantsAll ? { limit: LIST_ALL_LIMIT, groupLimit: LIST_ALL_GROUP_LIMIT } : {}),
        })
        const numbered = flattenSessionGroups(groups)
        const text = renderSessionList(groups, bindings[params.conversationId]?.sessionId, {
          total: rows.length + held.length,
          ...(held.length === 0 ? {} : { held: { count: held.length, names: heldNames(held) } }),
          ...(params.heldHint === undefined ? {} : { heldHint: params.heldHint }),
          ...(wantsAll ? { groupLimit: LIST_ALL_GROUP_LIMIT } : {}),
        })
        return { kind: 'reply', text, numbered }
      }

      case '/switch': {
        /*
         * A number is read against the listing the user was shown, never re-derived from live
         * sessions.
         *
         * That is the whole point of the numbering: sessions run while the user reads the list, so a
         * number resolved against "whatever is newest now" can land somewhere else entirely. The
         * caller passes the rows a quote pinned, or the newest listing this conversation received;
         * only when it knows of neither does this fall back to the live list.
         */
        const all = await this.#gateway.listSessions()
        const own = await this.#ownSessions(all)
        const pinned = params.numbered !== undefined && params.numbered.length > 0 ? [...params.numbered] : []
        /*
         * Ordered here rather than trusted from the gateway: the number the user typed refers to a
         * position in a listing, and a listing is ordered by this file. A gateway that happens to hand
         * its rows over in directory order would otherwise make the same number mean two different
         * things depending on whether a list was shown first.
         */
        const pool = pinned.length > 0 ? pinned : [...own].sort(compareSessionsNewestFirst)
        // Ids and titles stay searchable across everything the machine knows, so a session named
        // rather than numbered is still reachable — including one that only a pinned listing knows.
        const known = new Map<string, NumberedSession>(
          all.map((session) => [session.sessionId, session]),
        )
        for (const session of pinned) if (!known.has(session.sessionId)) known.set(session.sessionId, session)
        const searchable = [...known.values()]
        const resolution = resolveTarget(args, searchable, pool)
        if (resolution.kind === 'ambiguous') {
          return { kind: 'reply', text: ambiguousTargetMessage(args.trim(), resolution.candidates) }
        }
        if (resolution.kind === 'none') {
          return { kind: 'reply', text: '找不到这个对话。回复 /list 看清单，再回复数字或 id。' }
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
        return { kind: 'reply', text: `已切换到「${binding.title}」。\n${shortId(binding.sessionId)}` }
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
 * @param numbered - The rows a number refers to, when they differ from `sessions`.
 *
 *   This matters because the two are not the same list. A number is answered from the listing the
 *   user was actually shown, while a title or id may name a session from any workspace — and a
 *   conversation the user picked out of a listing has to be switchable, or the listing is a lie.
 */
export function resolveTarget(
  args: string,
  sessions: readonly NumberedSession[],
  numbered: readonly NumberedSession[] = sessions,
): TargetResolution {
  const value = args.trim()
  if (!value) return { kind: 'none' }

  if (/^\d+$/.test(value)) {
    // A number refers to a row of the listing the user was shown, which is not necessarily the whole
    // machine — hence `numbered` rather than `sessions`.
    const byIndex = numbered[Number(value) - 1]
    if (byIndex !== undefined) return { kind: 'found', session: byIndex }
    // Fall through: a numeric string can still be a title.
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

/** How many rows the list shows. Beyond this, older sessions are out of reach by number. */
const LIST_LIMIT = 10

/**
 * How many rows one workspace gets when `/list all` lists the whole machine.
 *
 * A share per workspace rather than one cut over everything, because the cut used to be applied
 * *before* the rows were grouped: the channel's own workspace is almost always the most recently
 * active one, so a global top ten went to it in full and every other workspace disappeared. `/list all`
 * then printed exactly what `/list` prints — one heading, the same rows — and the user had no way to
 * tell that other workspaces existed at all. A per-workspace share makes several headings a property
 * of the listing rather than a coincidence of who happened to be busy.
 */
export const LIST_ALL_GROUP_LIMIT = 3

/**
 * Ceiling on `/list all` in total.
 *
 * The share alone is not a bound: ten workspaces at three rows each is thirty rows, and a WeChat
 * message is read on a phone. Four workspaces' worth is about the length of the ten rows it replaces,
 * so listing everything costs the user no more scrolling than before — while still guaranteeing that
 * more than one workspace is visible.
 */
export const LIST_ALL_LIMIT = 12

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
 * Group rows by the workspace they belong to, in the order a listing prints them.
 *
 * A row without a `workspace`, or one whose directory is the channel's own, goes under `ownLabel`;
 * everything else is headed by the last component of its path, which is what the desktop sidebar
 * shows. The channel's own workspace leads, because those are the conversations this chat created;
 * the rest follow, most recently active first.
 *
 * Two cuts apply, in this order. First every workspace is cut to `groupLimit` rows
 * ({@link LIST_ALL_GROUP_LIMIT}), which is what makes a whole-machine listing show more than one
 * workspace instead of handing every row to the busiest one. Then the groups are walked in display
 * order and rows are taken until `limit` is reached, so the total stays readable on a phone and what
 * survives is the most recently active workspaces. The channel's own workspace is walked first and
 * therefore always keeps its share.
 *
 * @param rows - Every row the listing could show.
 * @param options.ownWorkspace - Directory the channel's own sessions live in.
 * @param options.ownLabel - Heading for that directory.
 * @param options.limit - Ceiling on the total number of rows.
 * @param options.groupLimit - Per-workspace ceiling, or undefined for a plain recency cut.
 * @returns Non-empty groups, in display order.
 */
export function groupSessionRows(
  rows: readonly ListedSession[],
  options: { ownWorkspace?: string; ownLabel: string; limit?: number; groupLimit?: number },
): SessionGroup[] {
  const limit = Math.max(options.limit ?? LIST_LIMIT, 0)
  const groupLimit = options.groupLimit === undefined ? undefined : Math.max(options.groupLimit, 0)
  const ordered = [...rows].sort(compareSessionsNewestFirst)

  const own: ListedSession[] = []
  const byPath = new Map<string, ListedSession[]>()
  for (const row of ordered) {
    const path = row.workspace
    // A row that does not say where it lives is this workspace's own — that is the only workspace a
    // conversation can vouch for. A row that does say, and names a different directory, is not.
    const isOwn =
      path === undefined ||
      (options.ownWorkspace !== undefined && isSameWorkspace(path, options.ownWorkspace))
    if (isOwn) own.push(row)
    else {
      const list = byPath.get(path)
      if (list === undefined) byPath.set(path, [row])
      else list.push(row)
    }
  }

  const others = [...byPath.entries()]
    .map(([path, list]) => ({ path, list, newest: list[0]?.updatedAt ?? 0 }))
    .sort((a, b) => {
      if (a.newest !== b.newest) return b.newest - a.newest
      if (a.path === b.path) return 0
      return a.path < b.path ? -1 : 1
    })

  const inDisplayOrder: { label: string; list: ListedSession[] }[] = []
  if (own.length > 0) inDisplayOrder.push({ label: options.ownLabel, list: own })
  for (const group of others) inDisplayOrder.push({ label: workspaceLabel(group.path), list: group.list })

  const groups: SessionGroup[] = []
  let budget = limit
  for (const group of inDisplayOrder) {
    if (budget <= 0) break
    const withinShare = groupLimit === undefined ? group.list : group.list.slice(0, groupLimit)
    const sessions = withinShare.slice(0, budget)
    if (sessions.length === 0) continue
    groups.push({ label: group.label, sessions })
    budget -= sessions.length
  }
  return groups
}

/**
 * The rows of a grouped listing, in the order they were numbered.
 *
 * The number the user replies with is a position in this flat sequence, so the caller that freezes a
 * listing for later reference stores exactly this — and the ordering lives in one place rather than
 * being re-derived by the caller.
 *
 * @param groups - Groups in display order.
 * @returns Every row, numbered 1..n in display order.
 */
export function flattenSessionGroups(groups: readonly SessionGroup[]): ListedSession[] {
  return groups.flatMap((group) => [...group.sessions])
}

/**
 * Render the session list.
 *
 * @param groups - Workspaces and their rows, in display order and already cut to size.
 * @param currentId - Session this conversation is bound to, marked in the list.
 * @param options.total - How many conversations the message is about, including any not shown, so the
 *   heading can say "最近 10 个对话（共 86 个）" rather than pretending ten is all there is.
 * @param options.held - Conversations in other workspaces that this listing left out, with the names
 *   of those workspaces. Naming them is the whole point: a user who is never told cannot ask.
 * @param options.heldHint - How to reach the held conversations. Typed and spoken requests need
 *   different wording, because a spoken request cannot be told to type a command it never mentions.
 * @param options.groupLimit - The per-workspace share the caller cut the rows with, when it used one.
 *   It changes how truncation is described: a plain cut drops the *oldest* rows, while a share drops
 *   rows that can be newer than the ones still on screen, so calling those "更早的" would be false.
 * @param options.now - Current time, so every row of one message agrees on what "3 分钟前" means.
 * @returns The message body.
 */
export function renderSessionList(
  groups: readonly SessionGroup[],
  currentId: string | undefined,
  options: {
    total?: number
    held?: { count: number; names?: readonly string[] }
    heldHint?: string
    groupLimit?: number
    now?: number
  } = {},
): string {
  const now = options.now ?? Date.now()
  const shown = flattenSessionGroups(groups)
  const held = options.held ?? { count: 0 }
  const total = options.total ?? shown.length + held.count
  const missing = total - shown.length
  const share = options.groupLimit
  const heading =
    missing <= 0
      ? `共 ${String(shown.length)} 个对话`
      : share === undefined
        ? `最近 ${String(shown.length)} 个对话（共 ${String(total)} 个）`
        : `共 ${String(total)} 个对话（每个工作区最多显示 ${String(share)} 个）`

  const sections: string[] = []
  let index = 0
  for (const group of groups) {
    if (group.sessions.length === 0) continue
    sections.push('', `【${group.label}】`)
    for (const session of group.sessions) {
      sections.push(renderSessionRow(session, index, currentId, now))
      index += 1
    }
  }

  const more =
    missing <= 0 || held.count > 0
      ? ''
      : share === undefined
        ? `（还有 ${String(missing)} 个更早的对话未显示）`
        : `（还有 ${String(missing)} 个对话未显示）`
  const names = held.names ?? []
  const elsewhere =
    held.count === 0
      ? ''
      : `另有 ${String(held.count)} 个对话在其它工作区${
          names.length === 0 ? '' : `（${names.join('、')}）`
        }，${options.heldHint ?? '一起看就发 /list all。'}`

  /*
   * The row's trailing id is named here, with a real example from this very listing.
   *
   * Printing an id without saying what it is for left it looking like decoration: users read the
   * number, replied with the number, and never knew the id was also a way to switch — which is the
   * one form that cannot expire. The example is taken from row 1 rather than written into the string,
   * so it is always a row the user can see and check against.
   */
  const first = shown[0]
  const switchHint =
    first === undefined
      ? '回复 /switch 编号，或 /switch 行尾那个 6 位 id 切换。'
      : `回复 /switch 编号，或 /switch 行尾那个 6 位 id（如第 1 行的 ${shortId(first.sessionId)}）切换。`

  return [
    `${heading}：`,
    ...sections,
    ...(more === '' ? [] : ['', more]),
    ...(elsewhere === '' ? [] : ['', elsewhere]),
    '',
    switchHint,
    '引用这条消息再回编号，可以避免编号过期。',
  ].join('\n')
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
    `另有 ${String(held.length)} 个对话在其它工作区${heldHintSuffix(held)}，发 /list all 一起看。`,
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
  '/list            列出本工作区的最近对话',
  `/list all        连其它工作区一起列出（每个工作区最多 ${String(LIST_ALL_GROUP_LIMIT)} 个）`,
  '/switch <编号>   切换（引用列表消息再回编号，编号不会过期）',
  '/switch <id>     按列表行尾那个 6 位 id 切换，例如 /switch e716f0',
  '/model <编号>    查看或切换模型',
  '/current         显示当前对话',
  '/cancel          中断当前任务',
  '/help            显示本帮助',
  '',
  '直接发消息即与当前对话对话。',
  '',
  '也可以直接用大白话说，例如「查看对话列表」「换个对话」「换个模型」「停下」，',
  '我会先问你一次确认，确认后才执行。',
].join('\n')
