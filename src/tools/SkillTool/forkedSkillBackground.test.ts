import { describe, expect, test } from 'bun:test'
import {
  buildBackgroundedSkillResultText,
  continueForkedSkillInBackground,
  driveForkedSkillIterator,
} from './forkedSkillBackground.js'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function* slowMessages(n: number, ms: number) {
  for (let i = 0; i < n; i++) {
    await sleep(ms)
    yield `m${i}`
  }
}

describe('driveForkedSkillIterator', () => {
  test('without a signal it drains the iterator', async () => {
    const seen: string[] = []
    const r = await driveForkedSkillIterator({
      iterator: slowMessages(3, 1)[Symbol.asyncIterator](),
      onMessage: m => seen.push(m),
    })
    expect(r.kind).toBe('done')
    expect(seen).toEqual(['m0', 'm1', 'm2'])
  })

  test('finishes in the foreground when the signal never fires', async () => {
    const seen: string[] = []
    const r = await driveForkedSkillIterator({
      iterator: slowMessages(2, 1)[Symbol.asyncIterator](),
      onMessage: m => seen.push(m),
      backgroundSignal: new Promise<void>(() => {}),
    })
    expect(r.kind).toBe('done')
    expect(seen).toEqual(['m0', 'm1'])
  })

  test('the background signal detaches it and the same iterator finishes without losing messages', async () => {
    const seen: string[] = []
    let fire!: () => void
    const signal = new Promise<void>(r => {
      fire = r
    })
    const iterator = slowMessages(5, 20)[Symbol.asyncIterator]()
    setTimeout(() => fire(), 50)
    const r = await driveForkedSkillIterator({
      iterator,
      onMessage: m => seen.push(m),
      backgroundSignal: signal,
    })
    expect(r.kind).toBe('backgrounded')
    if (r.kind !== 'backgrounded') return
    const before = seen.length
    expect(before).toBeGreaterThan(0)
    expect(before).toBeLessThan(5)
    await continueForkedSkillInBackground({
      iterator,
      pending: r.pending,
      onMessage: m => seen.push(m),
    })
    expect(seen).toEqual(['m0', 'm1', 'm2', 'm3', 'm4'])
  })

  test('errors from the iterator propagate', async () => {
    async function* broken() {
      yield 'a'
      throw new Error('skill failed')
    }
    await expect(
      driveForkedSkillIterator({
        iterator: broken()[Symbol.asyncIterator](),
        onMessage: () => {},
        backgroundSignal: new Promise<void>(() => {}),
      }),
    ).rejects.toThrow('skill failed')
  })

  test('backgrounded result text names the task and file', () => {
    const t = buildBackgroundedSkillResultText({
      commandName: 'review',
      taskId: 'a123',
      outputFile: '/tmp/a123.output',
    })
    expect(t).toContain('a123')
    expect(t).toContain('/tmp/a123.output')
    expect(t).toContain('task-notification')
  })
})
