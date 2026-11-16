import type { LocalCommandCall } from '../../types/command.js'
import { errorMessage } from '../../utils/errors.js'
import { getOwnSessionAlias } from '../../utils/peerAlias.js'
import {
  formatPeers,
  listPeers,
  resolvePeerSocket,
  sendToUdsSocket,
} from '../../utils/udsClient.js'
import { getUdsMessagingSocketPath } from '../../utils/udsMessaging.js'

const USAGE =
  'Usage: /peers                         list the sessions\n' +
  '       /peers send <alias|animal|pid|session|name|parent> <message>'

export const call: LocalCommandCall = async args => {
  const trimmed = args.trim()
  if (trimmed === '' || trimmed === 'list') {
    const peers = await listPeers()
    const mine = getUdsMessagingSocketPath()
    const own = getOwnSessionAlias()
    const ownAlias = own ? ` · alias "${own.emoji ? `${own.emoji} ` : ''}${own.alias}"` : ''
    const header = mine
      ? `This session: pid ${process.pid}${ownAlias} · uds:${mine}`
      : 'This session has no inbox socket.'
    const others = peers.filter(p => !p.isSelf)
    const body =
      others.length === 0
        ? 'No other fnharness sessions are running on this machine.'
        : formatPeers(others)
    return { type: 'text', value: `${header}\n\n${body}` }
  }
  const m = /^send\s+(\S+)\s+([\s\S]+)$/.exec(trimmed)
  if (!m) return { type: 'text', value: USAGE }
  const [, ref, message] = m
  try {
    const socket = await resolvePeerSocket(ref!)
    await sendToUdsSocket(socket, message!.trim())
    return { type: 'text', value: `Sent to ${ref} (uds:${socket}).` }
  } catch (e) {
    return { type: 'text', value: `Could not send to ${ref}: ${errorMessage(e)}` }
  }
}
