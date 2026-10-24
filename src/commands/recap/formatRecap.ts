/**
 * Pure: collapses the model's recap into a single trimmed line (the model may
 * return newlines, bullets or markdown emphasis).
 */
export function formatRecap(text: string | null | undefined): string | null {
  if (!text) return null
  const line = text
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return line === '' ? null : line
}
