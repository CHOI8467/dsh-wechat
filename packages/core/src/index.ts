/**
 * `@dsh-wechat/core` — a client for the Tencent iLink Bot API, which is the
 * backend behind the official WeChat ClawBot plugin.
 *
 * The API is plain HTTP/JSON with an outbound long poll, so a machine running DSH
 * can receive WeChat messages from anywhere without a tunnel, a public address, or
 * any inbound port. This package contains only that client: no DSH imports, so it
 * can be unit-tested and reused on its own.
 *
 * Phase 1 covers text. Media transfer (AES-128-ECB plus Tencent CDN) is phase 2.
 *
 * @module @dsh-wechat/core
 */

export * from './constants.ts'
export * from './types.ts'
export * from './http.ts'
export * from './crypto.ts'
export * from './state.ts'
export * from './quota.ts'
export * from './login.ts'
export * from './channel.ts'
export * from './media.ts'
export * from './thumbnail.ts'
export * from './silk.ts'
export * from './session-index.ts'
export * from './render.ts'
export {
  SessionRouter,
  SHORT_ID_LENGTH,
  LIST_ALL_GROUP_LIMIT,
  LIST_ALL_LIMIT,
  ambiguousTargetMessage,
  flattenSessionGroups,
  groupSessionRows,
  heldNames,
  heldOnlyList,
  mintSessionId,
  relativeTime,
  renderModelList,
  renderSessionList,
  renderSessionRow,
  resolveModelOption,
  resolveTarget,
  shortId,
  splitCommand,
  workspaceLabel,
  HELP_TEXT,
  type BindingStore,
  type ListedSession,
  type ModelListing,
  type ModelOption,
  type ModelSelection,
  type NumberedSession,
  type RouteDecision,
  type RouteResult,
  type SessionBinding,
  type SessionGateway,
  type SessionGroup,
  type SessionRouterOptions,
  type TargetResolution,
} from './router.ts'
