/**
 * Trivial MCP server over stdio (newline-delimited JSON-RPC), no dependencies.
 * Used by the e2e tests to exercise hot reload, auto-reconnect and tool-list
 * notices.
 *
 *   FIX_TOOLS       comma separated tool names (default "echo")
 *   FIX_TOOLS_FILE  if set, the tool names are re-read from this file (same
 *                   format) and a tools/list_changed notification is sent
 *                   whenever its content changes
 *   FIX_PID_FILE    if set, the pid of this process is written there
 *   FIX_LOG_FILE    if set, a line "start" is appended there on startup
 *   FIX_CALL_LOG    if set, every tools/call appends a JSON line {name, arguments} there
 *   FIX_CALL_REPLY  if set, text returned by tools/call instead of "called <name>"
 *   FIX_DIE_AFTER_MS if set, the process exits this many ms after initialize (crash loop)
 *   FIX_INIT_DELAY_MS if set, the answer to initialize is delayed this many ms (slow server)
 */
import { appendFileSync, existsSync, readFileSync, watchFile, writeFileSync } from 'fs'

const readTools = (): string[] => {
  const file = process.env.FIX_TOOLS_FILE
  const raw = file && existsSync(file) ? readFileSync(file, 'utf8') : (process.env.FIX_TOOLS ?? 'echo')
  return raw.split(',').map(s => s.trim()).filter(Boolean)
}

if (process.env.FIX_PID_FILE) writeFileSync(process.env.FIX_PID_FILE, String(process.pid))
if (process.env.FIX_LOG_FILE) appendFileSync(process.env.FIX_LOG_FILE, 'start\n')

const send = (msg: object) => process.stdout.write(JSON.stringify(msg) + '\n')

let last = readTools().join(',')
if (process.env.FIX_TOOLS_FILE) {
  watchFile(process.env.FIX_TOOLS_FILE, { interval: 100 }, () => {
    const now = readTools().join(',')
    if (now !== last) {
      last = now
      send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    }
  })
}

function handle(msg: { id?: number | string; method?: string; params?: any }) {
  const { id, method } = msg
  if (method === 'initialize') {
    if (process.env.FIX_DIE_AFTER_MS) setTimeout(() => process.exit(1), Number(process.env.FIX_DIE_AFTER_MS))
    if (process.env.FIX_INIT_DELAY_MS) {
      const reply = {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'fixture', version: '1.0.0' },
        },
      }
      return void setTimeout(() => send(reply), Number(process.env.FIX_INIT_DELAY_MS))
    }
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fixture', version: '1.0.0' },
      },
    })
  }
  if (method === 'tools/list') {
    return send({
      jsonrpc: '2.0',
      id,
      result: {
        tools: readTools().map(name => ({
          name,
          description: `fixture tool ${name}`,
          inputSchema: { type: 'object', properties: {} },
        })),
      },
    })
  }
  if (method === 'tools/call') {
    if (process.env.FIX_CALL_LOG) {
      appendFileSync(process.env.FIX_CALL_LOG, JSON.stringify({ name: msg.params?.name, arguments: msg.params?.arguments }) + '\n')
    }
    const text = process.env.FIX_CALL_REPLY ?? `called ${msg.params?.name}`
    return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } })
  }
  if (id !== undefined && method) {
    return send({ jsonrpc: '2.0', id, result: {} })
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  buf += chunk
  let i: number
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim()
    buf = buf.slice(i + 1)
    if (!line) continue
    try {
      handle(JSON.parse(line))
    } catch {
      /* ignore garbage */
    }
  }
})
process.stdin.on('end', () => process.exit(0))
