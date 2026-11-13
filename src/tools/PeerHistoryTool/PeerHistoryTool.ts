import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  formatPeerLog,
  isCyberSession,
  readPeerLog,
  visibleChannels,
  type PeerLogEntry,
} from '../../utils/peerLog.js'

export const PEER_HISTORY_TOOL_NAME = 'PeerHistory'

const DESCRIPTION =
  'Read the latest messages exchanged between fnharness sessions on this machine'

const PROMPT = `Read the latest conversations between fnharness sessions (the messages sent with SendMessage to a peer), oldest first. Use it to catch up on what the other sessions have been telling each other, or to see what was already said to a given peer before messaging it.

Optional \`peer\` narrows it to conversations that involve a pid, session id (or a prefix of 4+ characters), session name or \`uds:\` address. \`limit\` is how many messages to return (default 20, max 100).

Privacy: conversations are split in two channels. A conversation where at least one of the two sessions is a cyber session belongs to the cyber channel; every other one belongs to the normal channel. A normal session only reads the normal channel and has no access to the cyber one. A cyber session reads both, or just one with \`scope\` ("normal" | "cyber" | "all", default "all"). Never copy or summarize cyber-channel content into a normal session.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('How many messages to return (default 20)'),
    peer: z
      .string()
      .optional()
      .describe('Only conversations involving this pid, session id/prefix, name or uds: address'),
    scope: z
      .enum(['all', 'normal', 'cyber'])
      .optional()
      .describe('Channel to read; only cyber sessions can read "cyber" (default "all" = every channel you may read)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Output = { entries: PeerLogEntry[]; denied?: string }

export const PeerHistoryTool = buildTool({
  name: PEER_HISTORY_TOOL_NAME,
  searchHint: 'read recent conversations between sessions (peer message history)',
  maxResultSizeChars: 50_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  userFacingName() {
    return 'PeerHistory'
  },
  shouldDefer: true,
  isEnabled() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  renderToolUseMessage() {
    return null
  },
  async call(input) {
    const cyber = isCyberSession()
    if (visibleChannels(cyber, input.scope).length === 0) {
      return {
        data: {
          entries: [],
          denied: 'This is not a cyber session, so the cyber channel is not readable from here.',
        },
      }
    }
    const entries = readPeerLog({
      cyber,
      scope: input.scope,
      peer: input.peer,
      limit: input.limit,
    })
    return { data: { entries } }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { entries, denied } = content as Output
    const body = denied
      ? denied
      : entries.length === 0
        ? 'No messages between sessions match.'
        : formatPeerLog(entries)
    return { tool_use_id: toolUseID, type: 'tool_result', content: body }
  },
} satisfies ToolDef<InputSchema, Output>)
