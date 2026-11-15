// Drive a forked skill's runAgent iterator in a race against a background
// signal (Ctrl+B / auto-background), the same pattern AgentTool uses for sync
// agents.
//
// Unlike AgentTool, a backgrounded skill is not restarted as a new async
// agent: the very same iterator keeps running detached, so work the skill
// already did (edits, commands) is never repeated. The in-flight next() at
// the moment of backgrounding is handed over as `pending` so no message is
// lost.

export type ForkedSkillDriveResult<T> =
  | { kind: 'done' }
  | { kind: 'backgrounded'; pending: Promise<IteratorResult<T>> }

/**
 * Consume `iterator`, calling onMessage for each value, until it finishes
 * ('done') or `backgroundSignal` resolves first ('backgrounded'). Errors from
 * the iterator propagate.
 */
export async function driveForkedSkillIterator<T>(opts: {
  iterator: AsyncIterator<T>
  onMessage: (message: T) => void
  backgroundSignal?: Promise<void>
}): Promise<ForkedSkillDriveResult<T>> {
  const { iterator, onMessage } = opts
  // Created once: one .then() per iteration on the same pending promise
  // would pile up reactions for the lifetime of the skill.
  const bg = opts.backgroundSignal?.then(() => ({ type: 'bg' as const }))
  while (true) {
    const next = iterator.next()
    const winner = bg
      ? await Promise.race([
          next.then(r => ({ type: 'msg' as const, r })),
          bg,
        ])
      : { type: 'msg' as const, r: await next }
    if (winner.type === 'bg') {
      return { kind: 'backgrounded', pending: next }
    }
    if (winner.r.done) return { kind: 'done' }
    onMessage(winner.r.value)
  }
}

/** Finish a backgrounded skill: settle `pending`, then drain the iterator. */
export async function continueForkedSkillInBackground<T>(opts: {
  iterator: AsyncIterator<T>
  pending: Promise<IteratorResult<T>>
  onMessage: (message: T) => void
}): Promise<void> {
  let result = await opts.pending
  while (!result.done) {
    opts.onMessage(result.value)
    result = await opts.iterator.next()
  }
}

/** Text of the tool_result the model receives when a forked skill is backgrounded. */
export function buildBackgroundedSkillResultText(input: {
  commandName: string
  taskId: string
  outputFile: string
}): string {
  return `Skill "${input.commandName}" (forked execution) moved to the background. It is still running as task ID: ${input.taskId}. Its transcript is being written to: ${input.outputFile}. You will receive a <task-notification> with the skill's result when it finishes; meanwhile use TaskOutput with this task ID to follow it, or TaskStop to cancel it. Do not invoke the skill again for the same request.`
}
