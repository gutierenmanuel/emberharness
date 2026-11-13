import { afterEach, describe, expect, test } from 'bun:test'
import {
  decideTrustWorkdir,
  isTrustWorkdirActive,
  setTrustWorkdirActiveForTesting,
  markProjectTrusted,
} from './trustWorkdir.js'
import type { ProjectConfig } from './config.js'

const same = (p: string) => p
const base = { cwd: '/w/sala', nonInteractive: false, alreadyTrusted: false, realpath: same }

describe('decideTrustWorkdir', () => {
  test('without the flag nothing changes: the dialog keeps its normal behaviour', () => {
    expect(decideTrustWorkdir({ ...base, flagValue: undefined })).toEqual({ action: 'none', reason: 'flag_absent' })
    expect(decideTrustWorkdir({ ...base, flagValue: '' })).toEqual({ action: 'none', reason: 'flag_absent' })
  })

  test('flag equal to the cwd trusts exactly that folder', () => {
    expect(decideTrustWorkdir({ ...base, flagValue: '/w/sala' })).toEqual({ action: 'trust', key: '/w/sala' })
  })

  test('already trusted: no write, but the flag is still honoured', () => {
    expect(decideTrustWorkdir({ ...base, flagValue: '/w/sala', alreadyTrusted: true })).toEqual({
      action: 'none',
      reason: 'already_trusted',
    })
  })

  test('a different directory is rejected (flag only trusts the cwd it names)', () => {
    expect(decideTrustWorkdir({ ...base, flagValue: '/w/otra' })).toEqual({
      action: 'reject',
      reason: 'dir_mismatch',
      dir: '/w/otra',
    })
    // A parent is not the cwd either: no widening of trust.
    expect(decideTrustWorkdir({ ...base, flagValue: '/w' }).action).toBe('reject')
  })

  test('symlinks resolve to the real cwd', () => {
    const real = (p: string) => (p === '/enlace' ? '/w/sala' : p)
    expect(decideTrustWorkdir({ ...base, flagValue: '/enlace', realpath: real })).toEqual({
      action: 'trust',
      key: '/w/sala',
    })
  })

  test('a directory that cannot be resolved is rejected', () => {
    const boom = () => {
      throw new Error('ENOENT')
    }
    expect(decideTrustWorkdir({ ...base, flagValue: '/no/existe', realpath: boom })).toEqual({
      action: 'reject',
      reason: 'dir_unreadable',
      dir: '/no/existe',
    })
  })

  test('non-interactive runs never touch the config (they skip the dialog already)', () => {
    expect(decideTrustWorkdir({ ...base, flagValue: '/w/sala', nonInteractive: true })).toEqual({
      action: 'none',
      reason: 'non_interactive',
    })
  })

  test('the environment never enables it', () => {
    const saved = process.env.FNHARNESS_TRUST_WORKDIR
    process.env.FNHARNESS_TRUST_WORKDIR = '/w/sala'
    try {
      expect(decideTrustWorkdir({ ...base, flagValue: undefined }).action).toBe('none')
    } finally {
      if (saved === undefined) delete process.env.FNHARNESS_TRUST_WORKDIR
      else process.env.FNHARNESS_TRUST_WORKDIR = saved
    }
  })
})

describe('markProjectTrusted', () => {
  const project = (trusted: boolean) => ({ allowedTools: ['Bash'], hasTrustDialogAccepted: trusted }) as ProjectConfig

  test('marks the project trusted and keeps its other fields', () => {
    const after = markProjectTrusted(project(false))
    expect(after.hasTrustDialogAccepted).toBe(true)
    expect(after.allowedTools).toEqual(['Bash'])
  })

  test('returns the same reference when already trusted (no write)', () => {
    const before = project(true)
    expect(markProjectTrusted(before)).toBe(before)
  })
})

describe('active flag', () => {
  afterEach(() => setTrustWorkdirActiveForTesting(false))
  test('starts inactive', () => {
    expect(isTrustWorkdirActive()).toBe(false)
  })
})
