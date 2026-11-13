/**
 * statusline.sh against the `fnharness` block the fork adds to the status bar
 * input. Needs jq and bc (the script itself does).
 */
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'

const SCRIPT = resolve(import.meta.dir, '..', 'statusline.sh')
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

function render(input: object, env: Record<string, string> = {}): string[] {
  const proc = Bun.spawnSync(['bash', SCRIPT], {
    stdin: new TextEncoder().encode(JSON.stringify(input)),
    env: { ...process.env, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'fnh-sl-')), ...env },
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

  describe('correo de la cuenta', () => {
    const withEmail = (email: string | null) => ({ ...claude, fnharness: { ...claude.fnharness, account: { ...claude.fnharness.account, email, org: null } } })
    // Un config falso con .claude.json y TMPDIR propio para que la cache no cruce tests.
    function fakeConfig(email: string): { CLAUDE_CONFIG_DIR: string; TMPDIR: string } {
      const dir = mkdtempSync(join(tmpdir(), 'fnh-cfg-'))
      writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: email, accessToken: 'SECRETO' } }))
      return { CLAUDE_CONFIG_DIR: dir, TMPDIR: mkdtempSync(join(tmpdir(), 'fnh-tmp-')) }
    }

    test('el correo del JSON se pinta junto a la etiqueta de la cuenta', () => {
      const l3 = render(withEmail('persona@example.com'))[2]!
      expect(l3).toContain('claude Anthropic persona@example.com')
      expect(l3).toContain('ventana 200k')
    })

    test('sin correo la linea queda como siempre', () => {
      expect(render(withEmail(null))[2]).toContain('claude Anthropic │ ventana 200k')
      expect(render(claude)[2]).toContain('claude Anthropic │ ventana 200k')
    })

    test('cuenta OpenAI-compatible con correo: va tras la etiqueta y antes de la URL', () => {
      const l3 = render({ ...qwen, fnharness: { ...qwen.fnharness, account: { ...qwen.fnharness.account, email: 'dueno@ejemplo.com' } } })[2]!
      expect(l3).toContain('Qwen3.6 35B heretic (local) dueno@ejemplo.com @ localhost:8090')
    })

    test('respaldo: sin correo en el JSON lo lee de <config>/.claude.json y nunca imprime el token', () => {
      const env = fakeConfig('respaldo@example.com')
      const out = render(claude, env).join('\n')
      expect(out).toContain('claude Anthropic respaldo@example.com')
      expect(out).not.toContain('SECRETO')
      // segunda pasada: misma salida, ahora desde la cache
      expect(render(claude, env).join('\n')).toContain('respaldo@example.com')
    })

    test('respaldo solo para la cuenta claude: una OpenAI-compatible no hereda el correo de Anthropic', () => {
      const out = render(qwen, fakeConfig('ajeno@example.com')).join('\n')
      expect(out).not.toContain('ajeno@example.com')
    })

    test('sin bloque .fnharness (binario oficial) y con correo en el config aparece la linea de cuenta', () => {
      const lines = render({ ...common, model: { display_name: 'X' } }, fakeConfig('oficial@example.com'))
      expect(lines.some(l => l.includes('claude Anthropic oficial@example.com'))).toBe(true)
    })
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

  describe('alias hablable de la sesion', () => {
    // Registro falso: un get_session_alias.py que imprime lo que le pasa el test.
    function fakeRegistry(body: string): string {
      const root = mkdtempSync(join(tmpdir(), 'fnh-reg-'))
      const dir = join(root, 'python', 'functions', 'infra')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'get_session_alias.py'), body)
      chmodSync(join(dir, 'get_session_alias.py'), 0o755)
      return root
    }
    const withSession = { ...claude, session_id: 'abc-123' }

    test('shows the alias after the resume command, separated', () => {
      const root = fakeRegistry('print("🐶 perro grande")\n')
      const lines = render(withSession, { FN_REGISTRY_ROOT: root })
      const resume = lines.find(l => l.includes('fnharness --resume'))
      expect(resume).toBe('  🔗 fnharness --resume abc-123 │ 🐶 perro grande')
    })

    test('passes its own pid so the registry can find the session', () => {
      const root = fakeRegistry('import sys\nprint("args=" + " ".join(sys.argv[1:2]))\n')
      const lines = render(withSession, { FN_REGISTRY_ROOT: root })
      expect(lines.find(l => l.includes('fnharness --resume'))).toContain('│ args=--from-pid')
    })

    test('a failing or missing alias script leaves the resume line untouched', () => {
      for (const root of [fakeRegistry('import sys\nsys.exit(1)\n'), mkdtempSync(join(tmpdir(), 'fnh-empty-'))]) {
        const lines = render(withSession, { FN_REGISTRY_ROOT: root })
        expect(lines.find(l => l.includes('fnharness --resume'))).toBe('  🔗 fnharness --resume abc-123')
        // lo demas de la barra sigue igual
        expect(lines.join('\n')).toContain('Sonnet 5.5')
      }
    })

    test('no session id: no resume line and no alias lookup', () => {
      const root = fakeRegistry('print("no debe verse")\n')
      const lines = render(claude, { FN_REGISTRY_ROOT: root })
      expect(lines.join('\n')).not.toContain('no debe verse')
      expect(lines.join('\n')).not.toContain('--resume')
    })
  })
})
