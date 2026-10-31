import { feature } from 'bun:bundle'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'

export const DESCRIPTION =
  'Send a message to a subagent, a teammate, or another session on this machine'

export function getPrompt(): string {
  const swarms = isAgentSwarmsEnabled()
  const teammateRows = swarms
    ? `
| \`"researcher"\` | Teammate by name |
| \`"*"\` | Broadcast to all teammates — expensive (linear in team size), use only when everyone genuinely needs it |`
    : ''
  const udsRows = feature('UDS_INBOX')
    ? `
| \`"uds:/path/to.sock"\` | Another fnharness session on this machine (address from \`ListPeers\`) |
| \`"peer:<pid>"\`, \`"peer:<session-id or prefix>"\`, \`"peer:<name>"\` | The same, resolved from the live session list |
| \`"parent"\` | The session that launched this one, if any |`
    : ''
  const udsSection = feature('UDS_INBOX')
    ? `

## Other sessions (CLIs) on this machine

Use \`ListPeers\` to see the other live sessions with their pid, session id, name, status, cwd and address, then:

\`\`\`json
{"to": "peer:48213", "message": "do the tests pass on your branch?"}
{"to": "uds:/tmp/fnharness-socks/48213.sock", "message": "done, see reports/x.md"}
\`\`\`

A listed peer is alive and will process your message — messages enqueue and drain at the receiver's next tool round, or start a turn if it is idle. Incoming messages arrive wrapped as \`<cross-session-message from="..." pid="..." session="...">\`. **To reply, copy its \`from\` attribute as your \`to\`.** If another session asked you for something, send the answer back when you finish: your plain text is not visible to it. Only plain text can cross sessions.`
    : ''
  const teammateSection = swarms
    ? `

Messages from teammates are delivered automatically; you don't check an inbox. Refer to teammates by name, never by UUID. When relaying, don't quote the original — it's already rendered to the user.

## Protocol responses (legacy)

If you receive a JSON message with \`type: "shutdown_request"\` or \`type: "plan_approval_request"\`, respond with the matching \`_response\` type — echo the \`request_id\`, set \`approve\` true/false:

\`\`\`json
{"to": "team-lead", "message": {"type": "shutdown_response", "request_id": "...", "approve": true}}
{"to": "researcher", "message": {"type": "plan_approval_response", "request_id": "...", "approve": false, "feedback": "add error handling"}}
\`\`\`

Approving shutdown terminates your process. Rejecting plan sends the teammate back to revise. Don't originate \`shutdown_request\` unless asked. Don't send structured JSON status messages — use TaskUpdate.`
    : ''
  return `
# SendMessage

Send a message to another agent or session.

\`\`\`json
{"to": "a1b2c3d4e5f6a7b8c", "summary": "follow-up", "message": "now also check the edge cases"}
\`\`\`

| \`to\` | |
|---|---|
| \`"<agentId>"\` | A subagent you launched, by the agentId in the Agent result (or its name). A running one gets the message at its next tool round; a finished one is resumed in the background with it and notifies you when done |${teammateRows}${udsRows}

Your plain text output is NOT visible to other agents or sessions — to communicate, you MUST call this tool.${udsSection}${teammateSection}
`.trim()
}
