/**
 * Pure helper for the PostToolBatch hook: pairs every tool_use of a batch with
 * the serialized tool_result content the model will see.
 */

type ToolUseLike = { id: string; name: string; input: unknown }
type MessageLike = { type: string; message?: { content?: unknown } }

export type ToolBatchCall = {
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  tool_response: unknown
}

export function buildToolBatchCalls(
  toolUseBlocks: readonly ToolUseLike[],
  toolResults: readonly MessageLike[],
): ToolBatchCall[] {
  const responses = new Map<string, unknown>()
  for (const m of toolResults) {
    const content = m.type === 'user' ? m.message?.content : undefined
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        responses.set(block.tool_use_id, block.content)
      }
    }
  }
  return toolUseBlocks.map(b => ({
    tool_name: b.name,
    tool_input: b.input,
    tool_use_id: b.id,
    tool_response: responses.get(b.id) ?? '',
  }))
}
