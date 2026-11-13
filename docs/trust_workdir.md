# `--trust-workdir <dir>`: sesiones sin humano que no se quedan en el diálogo de confianza

Estado: implementado en `src/utils/trustWorkdir.ts` (decisión pura, persistencia y estado de sesión),
enganchado en `src/main.tsx` justo antes de `setup()`. Tests: `src/utils/trustWorkdir.test.ts`
(decisión) y `tests/e2e/trustWorkdir.e2e.test.ts` (pseudoterminal).

## Problema

Con `--dangerously-skip-permissions`, fnharness sigue mostrando «Do you trust the files in this
folder?» (`TrustDialog`) en una carpeta nunca confiada: el modo bypass solo afecta a los permisos de
herramientas, no a la confianza del workspace. Una sala del puente de Matrix lanzada dentro de tmux
(`bash/functions/infra/launch_claude_terminal_tmux.sh --harness fnharness`) no tiene a nadie que pulse
Enter, así que `session_start` no llega en `FNHARNESS_EVENTS`, el puente cae al modo transcript y hay
que aceptar a mano y recargar (visto en la fase A con la sala `bench-conv-ui`).

## Contrato

```
fnharness --dangerously-skip-permissions --trust-workdir <dir> [--session-id ...] ...
```

- `<dir>` debe ser el directorio de trabajo real de la sesión (se comparan con `realpath`). Si no lo
  es, o no se puede resolver, el flag se ignora con un aviso en stderr y en el log de depuración, y el
  diálogo normal sigue mandando.
- Con el flag y un `<dir>` válido, antes de pintar nada fnharness guarda
  `projects[<dir>].hasTrustDialogAccepted = true` en el `.claude.json` del config dir, que es lo mismo
  que guarda aceptar el diálogo, y no pregunta. La clave es la carpeta exacta, no la raíz del repo git
  que la contiene (el diálogo guarda la raíz git): una sala solo confía en su propia carpeta.
- Queda una línea `[trust-workdir] trusted <dir> ...` en el log de depuración (`--debug-file`,
  `--debug`). Si la carpeta ya estaba confiada, `... already trusted ...` y no se escribe nada.
- Sin el flag nada cambia: una sesión humana sigue viendo el diálogo. En modo `-p` el flag no hace
  nada (ese modo ya se salta el diálogo).
- Los diálogos que vendrían justo después de la confianza y que también necesitan a una persona se
  contestan «sí» solo durante esa sesión, sin guardar nada en disco, mientras el flag esté activo:
  el aviso del modo bypass (`BypassPermissionsModeDialog`, el lanzador ya pide el bypass de forma
  explícita), la aprobación de los servidores del `.mcp.json` del proyecto y el aviso de includes
  externos de `CLAUDE.md`. Equivale a decir «confío en esta carpeta y en lo que contiene».

## Seguridad

- **Solo flag de CLI, nunca variable de entorno.** Un subproceso hereda el entorno pero no el
  `argv` del padre; una variable `FNHARNESS_TRUST_WORKDIR` se arrastraría a cualquier fnharness
  lanzado desde una sala y confiaría en carpetas que nadie ha revisado. Hay un test que comprueba que
  esas variables no hacen nada.
- Confía solo en el cwd indicado, no en padres ni hijos que no sean ese cwd (la comprobación de
  confianza existente sí da por bueno todo lo que cuelga de una carpeta confiada, como siempre).
- El flag lo pasa el lanzador, que es quien decide el workdir de la sala; no lo lee de settings, de
  `.claude/` del proyecto ni de ningún fichero que un repo pueda escribir.

## Diálogos de arranque y si bloquean a una sala sin humano

| Diálogo | Cuándo sale | Con `--trust-workdir` |
|---|---|---|
| Confianza de la carpeta (`TrustDialog`) | cwd sin confianza guardada | Resuelto |
| Aviso del modo bypass | bypass y sin `skipDangerousModePermissionPrompt` en settings de usuario | Resuelto, solo sesión |
| Servidores `.mcp.json` pendientes | `.mcp.json` en el proyecto con servidores sin aprobar | Resuelto, solo sesión |
| Includes externos de `CLAUDE.md` | `@include` fuera del proyecto sin aprobar | Resuelto, solo sesión |
| Onboarding / tema | config dir sin `hasCompletedOnboarding` | Pendiente: el config dir de una sala ya viene configurado |
| Clave de API nueva (`ApproveApiKey`) | `ANTHROPIC_API_KEY` en el entorno que fnharness no ha visto | Pendiente: un entorno de sala no la define |
| Seguridad de managed settings | settings remotos de organización con cambios peligrosos | Pendiente: solo cuentas de organización |
| Grove, canales de desarrollo, onboarding de Chrome | cuentas Anthropic con política pendiente, `--dangerously-load-development-channels`, `--chrome` | Pendiente: el lanzador no usa esos flags |
