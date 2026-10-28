#!/usr/bin/env bash
# Tests de sync_env.sh sobre un HOME temporal con fixtures. Uso: bash scripts/sync_env.test.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/sync_env.sh"
SECRET="sk-SECRETO-NO-IMPRIMIR-123"
FAILS=0; N=0

ok()   { N=$((N+1)); printf 'ok   %s\n' "$1"; }
fail() { N=$((N+1)); FAILS=$((FAILS+1)); printf 'FAIL %s\n' "$1"; }
assert() { if eval "$2"; then ok "$1"; else fail "$1  [$2]"; fi; }

setup() {
  ROOT="$(mktemp -d)"; H="$ROOT/home"; F="$H/.fnharness"
  mkdir -p "$ROOT/registry/hooks" "$H/.claude/commands" "$H/.claude/skills" "$F"
  ln -s "$ROOT/registry/hooks" "$H/.claude/hooks"
  echo '# x' >"$ROOT/registry/CLAUDE.md"; ln -s "$ROOT/registry/CLAUDE.md" "$H/.claude/CLAUDE.md"
  cat >"$H/.claude/settings.json" <<JSON
{"model":"opus","language":"Español",
 "env":{"ANTHROPIC_MODEL":"x","CLAUDE_CODE_SUBAGENT_MODEL":"sonnet"},
 "enabledPlugins":{"a@b":true},
 "permissions":{"allow":["Bash(ls)"],"defaultMode":"default"},
 "hooks":{"Stop":[{"hooks":[{"type":"command","command":"~/.claude/hooks/a.sh"}]}],
          "PreToolUse":[{"matcher":"Agent","hooks":[{"type":"command","command":"router"}]}]}}
JSON
  cat >"$H/.claude.json" <<JSON
{"mcpServers":{"browser":{"command":"x","env":{"TOKEN":"$SECRET"}},
 "remote":{"type":"http","url":"https://e","headers":{"Authorization":"$SECRET"}},
 "shared":{"command":"origen"}}}
JSON
  cat >"$F/settings.json" <<JSON
{"model":"default","statusLine":{"type":"command","command":"sl.sh"},
 "skipDangerousModePermissionPrompt":true,
 "permissions":{"allow":["Bash(pwd)"],"defaultMode":"plan"},
 "hooks":{"Stop":[{"hooks":[{"type":"command","command":"propio.sh"}]}]}}
JSON
  cat >"$F/.claude.json" <<JSON
{"userID":"u","mcpServers":{"propio":{"command":"p"},"shared":{"command":"fnh","fnharnessOwn":true},"remote":{"command":"viejo"}}}
JSON
}

run() { # imprime salida; código en $RC
  OUT="$(env -i PATH="$PATH" HOME="$H" FNHARNESS_HOME="$F" CLAUDE_SRC="$H/.claude" \
    CLAUDE_JSON_SRC="$H/.claude.json" bash "$SCRIPT" "$@" 2>&1)"; RC=$?
}

setup; trap 'rm -rf "$ROOT"' EXIT
before="$(cat "$F/settings.json")"

run --check; assert "--check devuelve 1 con diferencias" '[ $RC -eq 1 ]'
CHECK_OUT="$OUT"
assert "--check no escribe settings" '[ "$(cat "$F/settings.json")" = "$before" ]'
assert "--check no crea backups" '[ ! -e "$F/backups" ]'
assert "--check lista nombres de servidor" 'grep -q "mcp.browser" <<<"$CHECK_OUT"'
run --dry-run; DRY_OUT="$OUT"; assert "--dry-run devuelve 0 y no escribe" '[ $RC -eq 0 ] && [ "$(cat "$F/settings.json")" = "$before" ]'
run; APPLY_OUT="$OUT"; assert "aplicar devuelve 0" '[ $RC -eq 0 ]'
run --check; assert "--check devuelve 0 tras aplicar" '[ $RC -eq 0 ]'

s1="$(cat "$F/settings.json")"; m1="$(cat "$F/.claude.json")"
run; APPLY2_OUT="$OUT"
assert "idempotencia settings" '[ "$(cat "$F/settings.json")" = "$s1" ]'
assert "idempotencia .claude.json" '[ "$(cat "$F/.claude.json")" = "$m1" ]'
assert "Stop sin duplicados y con ambos hooks" \
  '[ "$(jq -c "[.hooks.Stop[].hooks[].command]" "$F/settings.json")" = "[\"propio.sh\",\"~/.claude/hooks/a.sh\"]" ]'
assert "matcher Agent conservado" '[ "$(jq -r ".hooks.PreToolUse[0].matcher" "$F/settings.json")" = Agent ]'
assert "no toca model/statusLine/skip" \
  '[ "$(jq -r ".model" "$F/settings.json")" = default ] && [ "$(jq -r ".statusLine.command" "$F/settings.json")" = sl.sh ] && [ "$(jq -r .skipDangerousModePermissionPrompt "$F/settings.json")" = true ]'
assert "permissions: defaultMode propio y allow unido" \
  '[ "$(jq -r .permissions.defaultMode "$F/settings.json")" = plan ] && [ "$(jq -c .permissions.allow "$F/settings.json")" = "[\"Bash(pwd)\",\"Bash(ls)\"]" ]'
assert "env: sin ANTHROPIC_MODEL, con SUBAGENT_MODEL" \
  '[ "$(jq -r ".env.ANTHROPIC_MODEL // \"none\"" "$F/settings.json")" = none ] && [ "$(jq -r .env.CLAUDE_CODE_SUBAGENT_MODEL "$F/settings.json")" = sonnet ]'
assert "mcp: conserva propio y fnharnessOwn, origen gana en remote" \
  '[ "$(jq -r .mcpServers.propio.command "$F/.claude.json")" = p ] && [ "$(jq -r .mcpServers.shared.command "$F/.claude.json")" = fnh ] && [ "$(jq -r .mcpServers.remote.url "$F/.claude.json")" = "https://e" ] && [ "$(jq -r .userID "$F/.claude.json")" = u ]'
assert ".claude.json con permisos 0600" '[ "$(stat -c %a "$F/.claude.json")" = 600 ]'
assert "backup settings creado" 'ls "$F"/backups/settings.json.bak-* >/dev/null 2>&1'
assert "backups con 0600" '[ -z "$(find "$F/backups" -type f ! -perm 600)" ]'
assert "sin secretos en stdout" '! grep -q "$SECRET" <<<"$CHECK_OUT$DRY_OUT$APPLY_OUT$APPLY2_OUT"'
assert "enlace hooks a la ruta real" '[ "$(readlink "$F/hooks")" = "$ROOT/registry/hooks" ]'
assert "enlace CLAUDE.md a la ruta real" '[ "$(readlink "$F/CLAUDE.md")" = "$ROOT/registry/CLAUDE.md" ]'
assert "enlace skills a la ruta real" '[ "$(readlink "$F/skills")" = "$H/.claude/skills" ]'

# enlace existente no se pisa
rm "$F/commands" 2>/dev/null; ln -s /tmp "$F/commands"; run
assert "enlace existente intacto" '[ "$(readlink "$F/commands")" = /tmp ]'

printf '\n%d pruebas, %d fallos\n' "$N" "$FAILS"
[ "$FAILS" -eq 0 ]
