#!/usr/bin/env bash
# sync_env.sh — alinea el directorio de configuración de fnharness con el de Claude Code del dueño.
#
# Qué sincroniza (nunca copia credenciales):
#   - settings.json: fusiona hooks, permissions, env, enabledPlugins y language desde el de Claude Code.
#     Conserva todo lo propio de fnharness (statusLine, model, skipDangerousModePermissionPrompt...).
#   - .claude.json: solo mcpServers del nivel usuario; gana el origen salvo marca "fnharnessOwn": true.
#   - Enlaces simbólicos hooks/, commands/, agents/, skills/ y CLAUDE.md hacia su ruta real (readlink -f).
#
# Uso: sync_env.sh [--check | --dry-run] [--help]
#   --check    no escribe; imprime diferencias (solo nombres) y sale con 1 si las hay, 0 si no.
#   --dry-run  imprime lo que haría, sin escribir; sale siempre con 0.
#   (sin flag) aplica, con backup previo en $FNHARNESS_HOME/backups/ si hay cambios.
#
# Variables: FNHARNESS_HOME (def. $HOME/.fnharness), CLAUDE_SRC (def. $HOME/.claude),
#            CLAUDE_JSON_SRC (def. $HOME/.claude.json).
# Garantía de salida: nunca imprime valores de env, headers ni tokens; solo nombres.
set -euo pipefail

FNH_HOME="${FNHARNESS_HOME:-$HOME/.fnharness}"
SRC_DIR="${CLAUDE_SRC:-$HOME/.claude}"
SRC_JSON="${CLAUDE_JSON_SRC:-$HOME/.claude.json}"
LINKS=(hooks commands agents skills CLAUDE.md)

# ---------------------------------------------------------------- lógica pura (jq)

# Entrada: [origen, destino] de settings.json. Salida: destino fusionado.
read -r -d '' JQ_MERGE_SETTINGS <<'JQ' || true
def hookkey: .command // tojson;
def dedup: reduce .[] as $x ([]; if any(.[]; . == $x) then . else . + [$x] end);
def merge_hooks_list($e):
  reduce ($e.hooks // [])[] as $x (. // [];
    if any(.[]; hookkey == ($x | hookkey)) then . else . + [$x] end);
def merge_entries($s):
  reduce $s[] as $e (.;
    ([.[] | (.matcher // "")] | index([$e.matcher // ""])) as $i
    | if $i == null then . + [$e]
      else .[$i].hooks |= merge_hooks_list($e) end);
def merge_hooks($s):
  reduce ($s | keys[]) as $ev (.; .[$ev] = ((.[$ev] // []) | merge_entries($s[$ev])));
def merge_perms($q):
  . as $p | ($q + $p)
  | reduce ("allow", "deny", "ask") as $k (.;
      if ($p[$k] // null) == null and ($q[$k] // null) == null then .
      else .[$k] = ((($p[$k] // []) + ($q[$k] // [])) | dedup) end);
.[0] as $s | .[1] as $d
| $d
| if ($s.hooks // null) != null then .hooks = ((.hooks // {}) | merge_hooks($s.hooks)) else . end
| if ($s.permissions // null) != null then .permissions = ((.permissions // {}) | merge_perms($s.permissions)) else . end
| if ($s.env // null) != null then .env = (($s.env | del(.ANTHROPIC_MODEL, .ANTHROPIC_BASE_URL, .ANTHROPIC_AUTH_TOKEN, .ANTHROPIC_API_KEY)) + (.env // {})) else . end
| if ($s.enabledPlugins // null) != null then .enabledPlugins = ($s.enabledPlugins + (.enabledPlugins // {})) else . end
| if ($s.language // null) != null and (.language // null) == null then .language = $s.language else . end
JQ

# Entrada: [origen, destino] de .claude.json. Salida: destino con mcpServers sincronizados.
read -r -d '' JQ_MERGE_MCP <<'JQ' || true
.[0] as $s | .[1] as $d
| ($s.mcpServers // {}) as $src
| if ($src | length) == 0 then $d
  else $d | .mcpServers = ((.mcpServers // {}) as $own
      | reduce ($src | keys[]) as $k ($own;
          if ($own[$k].fnharnessOwn // false) == true then . else .[$k] = $src[$k] end))
  end
JQ

# Entrada: [actual, fusionado]. Salida: una línea por clave cambiada (solo nombres).
read -r -d '' JQ_DIFF_SETTINGS <<'JQ' || true
def chg($a; $b): [($a // {}) + ($b // {}) | keys[] | select(($a // {})[.] != ($b // {})[.])];
.[0] as $a | .[1] as $b
| (chg($a; $b) | map(select(. != "hooks")) | map("settings." + .)[]),
  (chg($a.hooks; $b.hooks)[] | "settings.hooks." + .)
JQ

read -r -d '' JQ_DIFF_MCP <<'JQ' || true
.[0] as $a | .[1] as $b
| (($a.mcpServers // {}) as $x | ($b.mcpServers // {}) as $y
   | [$x + $y | keys[] | select($x[.] != $y[.]) | "mcp." + .] | unique[])
JQ

# ---------------------------------------------------------------- efectos

log() { printf '%s\n' "$*"; }
die() { printf 'sync_env: %s\n' "$*" >&2; exit 2; }

json_or_empty() { # copia un JSON a $2 o escribe {} si no existe
  if [ -f "$1" ]; then jq -e 'type=="object"' "$1" >/dev/null 2>&1 || die "JSON inválido: $(basename "$1")"; cat "$1" >"$2"; else echo '{}' >"$2"; fi
}

merge_to() { # filtro, origen, destino, salida
  jq -s "$1" "$2" "$3" >"$4"
}

same_json() { [ "$(jq -S . "$1")" = "$(jq -S . "$2")" ]; }

changed_names() { # filtro, a, b  -> líneas
  jq -s -r "$1" "$2" "$3"
}

link_target() { # nombre -> ruta real o vacío
  local p="$SRC_DIR/$1"
  [ -e "$p" ] && readlink -f "$p" || true
}

missing_links() { # imprime "nombre<TAB>destino" de enlaces que faltan
  local n t
  for n in "${LINKS[@]}"; do
    t="$(link_target "$n")"
    [ -n "$t" ] || continue
    [ -e "$FNH_HOME/$n" ] || [ -L "$FNH_HOME/$n" ] || printf '%s\t%s\n' "$n" "$t"
  done
}

write_file() { # tmp, destino, modo
  install -m "$3" "$1" "$2"
}

backup_file() { # fichero, etiqueta
  [ -f "$1" ] || return 0
  mkdir -p "$FNH_HOME/backups"
  install -m 600 "$1" "$FNH_HOME/backups/$2.bak-$STAMP"
}

main() {
  local mode=apply
  case "${1:-}" in
    --check) mode=check ;;
    --dry-run) mode=dry ;;
    -h|--help) sed -n '2,17p' "$0"; return 0 ;;
    "") ;;
    *) die "opción desconocida: $1" ;;
  esac
  command -v jq >/dev/null || die "falta jq"
  [ -d "$SRC_DIR" ] || die "no existe CLAUDE_SRC ($SRC_DIR)"

  umask 077
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  STAMP="$(date +%Y%m%d-%H%M%S)"

  local s_src="$SRC_DIR/settings.json" s_dst="$FNH_HOME/settings.json"
  local j_dst="$FNH_HOME/.claude.json"
  json_or_empty "$s_src" "$tmp/s_src"; json_or_empty "$s_dst" "$tmp/s_dst"
  json_or_empty "$SRC_JSON" "$tmp/j_src"; json_or_empty "$j_dst" "$tmp/j_dst"
  merge_to "$JQ_MERGE_SETTINGS" "$tmp/s_src" "$tmp/s_dst" "$tmp/s_new"
  merge_to "$JQ_MERGE_MCP" "$tmp/j_src" "$tmp/j_dst" "$tmp/j_new"

  local diffs=() line
  same_json "$tmp/s_dst" "$tmp/s_new" || while IFS= read -r line; do diffs+=("$line"); done \
    < <(changed_names "$JQ_DIFF_SETTINGS" "$tmp/s_dst" "$tmp/s_new" | sort -u)
  same_json "$tmp/j_dst" "$tmp/j_new" || while IFS= read -r line; do diffs+=("$line"); done \
    < <(changed_names "$JQ_DIFF_MCP" "$tmp/j_dst" "$tmp/j_new")
  local links=() n t
  while IFS=$'\t' read -r n t; do [ -n "$n" ] && { links+=("$n:$t"); diffs+=("link.$n"); }; done < <(missing_links)

  if [ "${#diffs[@]}" -eq 0 ]; then log "sync_env: sin diferencias ($FNH_HOME alineado)"; return 0; fi

  case "$mode" in
    check) log "sync_env: diferencias pendientes:"; printf '  %s\n' "${diffs[@]}"; return 1 ;;
    dry) log "sync_env (dry-run): haría:"; printf '  %s\n' "${diffs[@]}"; return 0 ;;
  esac

  mkdir -p "$FNH_HOME"
  if ! same_json "$tmp/s_dst" "$tmp/s_new"; then
    backup_file "$s_dst" settings.json
    write_file <(jq . "$tmp/s_new") "$s_dst" "$(stat -c %a "$s_dst" 2>/dev/null || echo 600)"
  fi
  if ! same_json "$tmp/j_dst" "$tmp/j_new"; then
    backup_file "$j_dst" claude.json
    write_file <(jq . "$tmp/j_new") "$j_dst" 600
  fi
  for t in "${links[@]:-}"; do [ -n "$t" ] && ln -s "${t#*:}" "$FNH_HOME/${t%%:*}"; done
  log "sync_env: aplicado:"; printf '  %s\n' "${diffs[@]}"
}

# Permite hacer `source` en tests sin ejecutar.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
