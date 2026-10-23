import React from 'react';
import { Box, Text } from '../ink.js';
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useTheme } from '../ink.js';
import type { ThemeSetting } from '../utils/theme.js';
import { WelcomeV2 } from './LogoV2/WelcomeV2.js';
import { ThemePicker } from './ThemePicker.js';

export const ONBOARDING_HINT = 'Conecta cuentas con /account · cambia de modelo con /model';

type Props = {
  onDone(): void;
};

/**
 * Bienvenida mínima del primer arranque: WelcomeV2 + selector de tema + una
 * línea con los atajos. El login de Claude ya no es obligatorio: se hace bajo
 * demanda con /login o /account claude.
 */
export function Onboarding({ onDone }: Props): React.ReactNode {
  const [, setTheme] = useTheme();
  const exitState = useExitOnCtrlCDWithKeybindings();
  function handleThemeSelection(newTheme: ThemeSetting) {
    setTheme(newTheme);
    onDone();
  }
  return <Box flexDirection="column">
      <WelcomeV2 />
      <Box flexDirection="column" marginTop={1}>
        <Box marginX={1}>
          <ThemePicker onThemeSelect={handleThemeSelection} showIntroText={true} helpText="To change this later, run /theme" hideEscToCancel={true} skipExitHandling={true} />
        </Box>
        <Box paddingLeft={2}>
          <Text dimColor>{ONBOARDING_HINT}</Text>
        </Box>
        {exitState.pending && <Box padding={1}>
            <Text dimColor>Press {exitState.keyName} again to exit</Text>
          </Box>}
      </Box>
    </Box>;
}
