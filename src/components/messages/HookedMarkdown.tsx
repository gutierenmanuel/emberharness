import * as React from 'react'
import { useMessageDisplayText } from '../../utils/hooks/messageDisplay.js'
import { Markdown } from '../Markdown.js'

/** Markdown of an assistant text, passed through MessageDisplay hooks. */
export function HookedMarkdown({
  text,
  verbose,
}: {
  text: string
  verbose: boolean
}): React.ReactNode {
  const display = useMessageDisplayText(text, verbose)
  return <Markdown>{display}</Markdown>
}
