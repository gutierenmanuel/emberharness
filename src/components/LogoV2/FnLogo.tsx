import * as React from 'react';
import { Box, Text } from '../../ink.js';

// FnHarness mascot: a head wearing a crossed harness strap. Same footprint as
// Clawd (9 cols × 3 rows) so it drops into the condensed logo unchanged.
const ROWS = [' ▐▛▀▀▀▜▌ ', ' ▝▜███▛▘ ', '   ▚▞    '];

export function FnLogo(): React.ReactNode {
  return <Box flexDirection="column">
      {ROWS.map((row, i) => <Text key={i} color="startupAccent">{row}</Text>)}
    </Box>;
}
