import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { formatPeers, listPeers, type Peer } from '../../utils/udsClient.js'
import { getUdsMessagingSocketPath } from '../../utils/udsMessaging.js'

export const LIST_PEERS_TOOL_NAME = 'ListPeers'

const DESCRIPTION =
  'List the other fnharness sessions running on this machine, with their ids and messaging address'

const PROMPT = `List the other fnharness CLI sessions alive on this machine that can receive messages.

Each entry shows the pid, session id, optional name, status (busy, idle, waiting), working directory, and the \`to\` address. Entries marked [parent] launched this session; entries marked [child] were launched by it.

To talk to a peer, call SendMessage with \`to\` set to its address (\`uds:/...\`), or to its pid, its session id (or a prefix of at least 4 characters), its name, or \`parent\`. The message lands in that session's prompt queue and it handles it at its next tool round, or right away if idle. Replies arrive here as \`<cross-session-message from="...">\`; answer by sending to that \`from\` value.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    include_self: z
      .boolean()
      .optional()
      .describe('Also list this session (default false)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

type Output = { peers: Peer[]; self?: string }

export const ListPeersTool = buildTool({
  name: LIST_PEERS_TOOL_NAME,
  searchHint: 'list other running sessions (peers) to message',
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
    return 'ListPeers'
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
    const all = await listPeers()
    const peers = input.include_self ? all : all.filter(p => !p.isSelf)
    const mine = getUdsMessagingSocketPath()
    return { data: { peers, self: mine ? `uds:${mine}` : undefined } }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    const { peers, self } = content as Output
    const selfLine = self
      ? `This session (pid ${process.pid}) is reachable at "${self}".`
      : 'This session has no inbox socket, so peers cannot reply to it.'
    const body =
      peers.length === 0
        ? 'No other fnharness sessions are running on this machine.'
        : formatPeers(peers)
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${body}\n\n${selfLine}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
