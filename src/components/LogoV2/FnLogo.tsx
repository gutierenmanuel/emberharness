import * as React from 'react';
import { Box, Text } from '../../ink.js';

// FnHarness logo: a terminal window with an ƒ prompt. Same footprint as
// Clawd (9 cols × 3 rows) so it drops into the condensed logo unchanged.
const ROWS = ['▛▀▀▀▀▀▀▀▜', '▌ > ƒ_  ▐', '▙▄▄▄▄▄▄▄▟'];

export function FnLogo(): React.ReactNode {
  return <Box flexDirection="column">
      {ROWS.map((row, i) => <Text key={i} color="startupAccent">{row}</Text>)}
    </Box>;
}
