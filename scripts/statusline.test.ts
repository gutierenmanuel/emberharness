/**
 * statusline.sh against the `fnharness` block the fork adds to the status bar
 * input. Needs jq and bc (the script itself does).
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const SCRIPT = resolve(import.meta.dir, '..', 'statusline.sh')
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

function render(input: object): string[] {
  const proc = Bun.spawnSync(['bash', SCRIPT], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    env: { ...process.env, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'fnh-sl-')) },
  })
  expect(proc.exitCode).toBe(0)
  return strip(proc.stdout.toString()).split('\n').filter(Boolean)
}

const common = {
  session_id: '',
  workspace: { current_dir: '/tmp' },
  cost: { total_cost_usd: 1.234 },
}

const qwen = {
  ...common,
  model: { id: 'qwen36-35b-heretic-q4km', display_name: 'qwen36-35b-heretic-q4km' },
  context_window: {
    context_window_size: 32768,
    used_percentage: 28,
    current_usage: { input_tokens: 9000, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
  rate_limits: { five_hour: { used_percentage: 50, resets_at: 0 } },
  fnharness: {
    account: { id: 'qwen36', label: 'Qwen3.6 35B heretic (local)', provider: 'qwen36', base_url: 'http://localhost:8090/v1', local: true, model: 'qwen36-35b-heretic-q4km', server_model: null },
    context: { window: 32768, source: 'server', autocompact_at: 29500, max_output_tokens: 4096 },
    server: { online: true, n_ctx: 32768, age_s: 3 },
    speed: { ttft_s: 0.42, generation_tokens_per_second: 42, prompt_tokens_per_second: 1500, draft_tokens: 120, draft_accepted_tokens: 90 },
    cost: { kind: 'free' },
  },
}

const claude = {
  ...common,
  model: { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5' },
  context_window: { context_window_size: 200000, used_percentage: 10, current_usage: { input_tokens: 20000, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
  rate_limits: { five_hour: { used_percentage: 12, resets_at: 0 } },
  fnharness: {
    account: { id: 'claude', label: 'Claude', provider: null, base_url: null, local: false, model: 'claude-sonnet-5-5', server_model: null },
    context: { window: 200000, source: 'claude', autocompact_at: 167000, max_output_tokens: 32000 },
    server: null,
    speed: null,
    cost: { kind: 'subscription' },
  },
}

describe('statusline.sh', () => {
  test('local account: model, real window, compact threshold, output cap, server and speed', () => {
    const [l1, l2, l3] = render(qwen)
    expect(l1).toContain('qwen36-35b-heretic-q4km [qwen36]')
    expect(l1).toContain('28%')
    expect(l1).toContain('(9k/32k)')
    expect(l1).toContain('⟳29.5k')
    expect(l2).toContain('local · sin coste')
    expect(l2).not.toContain('Limits')
    expect(l3).toContain('qwen36 Qwen3.6 35B heretic (local) @ localhost:8090 ● en línea')
    expect(l3).toContain('ventana 32k (servidor)')
    expect(l3).toContain('salida máx 4k')
    expect(l3).toContain('autocompacta a 29.5k')
    expect(l3).toContain('⚡ TTFT 0.42 s · gen 42.0 tok/s · lectura 1500 tok/s · espec. 75%')
    expect(l1 + l2 + l3).not.toMatch(/200k|claude|opus|sonnet/i)
  })

  test('server down and no measurements yet', () => {
    const down = { ...qwen, fnharness: { ...qwen.fnharness, server: { online: false, n_ctx: null, age_s: 1 }, speed: null, context: { ...qwen.fnharness.context, source: 'preset' } } }
    const l3 = render(down)[2]!
    expect(l3).toContain('○ sin respuesta')
    expect(l3).toContain('ventana 32k (preset)')
    expect(l3).toContain('sin medidas aún')
  })

  test('claude account keeps cost and limits, no speed line', () => {
    const [l1, l2, l3] = render(claude)
    expect(l1).toContain('Sonnet 5.5 [claude]')
    expect(l1).toContain('(20k/200k)')
    expect(l2).toContain('$1.234')
    expect(l2).toContain('Limits')
    expect(l3).toContain('claude Anthropic')
    expect(l3).toContain('ventana 200k')
    expect(l3).not.toContain('⚡')
  })

  test('hosted unpriced account says so instead of showing a fake Claude cost', () => {
    const hosted = { ...qwen, fnharness: { ...qwen.fnharness, account: { ...qwen.fnharness.account, id: 'deepseek', local: false, base_url: 'https://api.deepseek.com/v1' }, server: null, speed: null, cost: { kind: 'unpriced' } } }
    const [, l2, l3] = render(hosted)
    expect(l2).toContain('sin tarifa')
    expect(l3).not.toContain('⚡')
  })

  test('without a known window it prints ? instead of assuming 200k', () => {
    const [l1] = render({ ...common, model: { display_name: 'X' } })
    expect(l1).toContain('/?)')
  })
})
