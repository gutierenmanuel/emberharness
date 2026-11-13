import { describe, expect, test } from 'bun:test'
import { isTelemetryEnvKey, mergeManagedSettings, mergeRestrictions, stripTelemetrySettings, telemetryEnvOf } from './managedPolicy.js'
import { inForceAccounts } from './sessionAccounts.js'
import { rejectionOutcome } from '../remoteManagedSettings/securityCheck.js'
import { claudeIdentity, formatAccountPanel, formatPermissionReport, organisationNotes, panelHeader, parseImportArgs } from '../../commands/account/anthropicActions.js'

describe('telemetry belongs to the account, not to process.env', () => {
  const corp = {
    env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example.eu', OTEL_EXPORTER_OTLP_HEADERS: 'dd-api-key=SECRETO', CLAUDE_CODE_ENABLE_TELEMETRY: '1', HTTPS_PROXY: 'http://p' },
    otelHeadersHelper: '/bin/x',
  }
  test('strip and extract', () => {
    expect(isTelemetryEnvKey('otel_logs_exporter')).toBe(true)
    expect(isTelemetryEnvKey('HTTPS_PROXY')).toBe(false)
    expect(stripTelemetrySettings(corp)).toEqual({ env: { HTTPS_PROXY: 'http://p' } })
    expect(Object.keys(telemetryEnvOf(corp)).sort()).toEqual(['CLAUDE_CODE_ENABLE_TELEMETRY', 'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS'])
    expect(stripTelemetrySettings({ env: { OTEL_X: '1' } })).toEqual({})
    expect(corp.env.OTEL_EXPORTER_OTLP_HEADERS).toBe('dd-api-key=SECRETO') // input untouched
  })
})

describe('D7: most restrictive of the in-force accounts', () => {
  test('settings merge', () => {
    const m = mergeManagedSettings([
      { accountId: 'a', settings: { permissions: { deny: ['Bash(rm:*)'], allow: ['Read', 'Edit'] }, disableAllHooks: false, env: { X: 'a' } } },
      { accountId: 'b', settings: { permissions: { deny: ['WebFetch'], allow: ['Read'] }, disableAllHooks: true, env: { X: 'b', Y: 'b', OTEL_Z: '1' } } },
      { accountId: 'c', settings: null },
    ])
    expect(m.settings).toEqual({
      permissions: { deny: ['Bash(rm:*)', 'WebFetch'], allow: ['Read'] },
      disableAllHooks: true,
      env: { X: 'a', Y: 'b' },
    })
    expect(m.imposedBy.disableAllHooks).toEqual(['a', 'b'])
    expect(mergeManagedSettings([]).settings).toBeNull()
  })
  test('restrictions: allowed only if every account allows', () => {
    expect(mergeRestrictions([{ p: { allowed: true }, q: { allowed: true } }, { p: { allowed: false } }, null])).toEqual({ p: { allowed: false }, q: { allowed: true } })
    expect(mergeRestrictions([null, undefined])).toBeNull()
  })
  test('in-force accounts: session first, no disabled, no duplicates', () => {
    expect(inForceAccounts('a', ['b', 'a', 'c'], new Map([['c', 'x']]))).toEqual(['a', 'b'])
    expect(inForceAccounts(null, [], new Map())).toEqual([])
  })
  test('rejecting the dialog of another account disables it; the session account exits', () => {
    expect(rejectionOutcome('b', 'a')).toBe('disable')
    expect(rejectionOutcome('a', 'a')).toBe('exit')
    expect(rejectionOutcome(undefined, 'a')).toBe('exit')
  })
})

describe('/account panel', () => {
  test('identity, header and lines as in the mockup', () => {
    expect(claudeIdentity({ email: 'e@work.test', org: 'Acme', orgUuid: '3f2a9999', plan: 'team' })).toBe('e@work.test · Acme (org 3f2a…) · plan Team')
    expect(claudeIdentity({ email: 'yo@gmail.test', org: null, orgUuid: null, plan: 'max' })).toBe('yo@gmail.test · personal · plan Max')
    expect(panelHeader({ id: 'claude-work', title: 'Claude (Anthropic)', session: true })).toMatch(/^── claude-work · Claude \(Anthropic\) ● sesión ─+$/)
    const lines = formatAccountPanel([
      { id: 'claude-work', title: 'Claude (Anthropic)', session: true, identity: 'e@work.test · Acme', model: 'claude-opus-5-5', remembered: 'opus', state: '✓ lista', notes: ['n1'] },
      { id: 'qwen36', title: 'llama.cpp local', session: false, identity: 'http://localhost:8090/v1', model: null, remembered: 'q', state: '✓ responde' },
    ])
    expect(lines[0]).toBe('  Cuentas')
    expect(lines[3]).toMatch(/modelo: claude-opus-5-5 \(recordado: opus\)\s+✓ lista/)
    expect(lines[4]).toBe('     n1')
    expect(lines.join('\n')).toContain('modelo: q')
  })
  test('organisation notes show the corporate receiver host, never its headers', () => {
    const notes = organisationNotes({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.datadoghq.eu', OTEL_EXPORTER_OTLP_HEADERS: 'dd-api-key=SECRETO' } }, { a: { allowed: false } }, true)
    expect(notes.join('\n')).toContain('otlp.datadoghq.eu')
    expect(notes.join('\n')).not.toContain('SECRETO')
    expect(notes[1]).toContain('aplican a la sesión')
  })
  test('import args and permission report', () => {
    expect(parseImportArgs(['~/.fnharness-work', '--as', 'claude-work'])).toEqual({ dir: '~/.fnharness-work', id: 'claude-work' })
    expect(() => parseImportArgs(['~/x'])).toThrow(/Uso/)
    const r = formatPermissionReport([{ path: '/c', kind: 'file', mode: 0o644, want: 0o600, ok: false }])
    expect(r[0]).toContain('644 (debe ser 600)')
    expect(r.at(-1)).toContain('--fix')
  })
})
