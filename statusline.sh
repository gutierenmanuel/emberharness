#!/bin/bash
# Status Line para Claude Code - Optimizado para Vibecoding
# Muestra: modelo, contexto, git, costos, rate limits y más

# Directorio de estado propio de fnharness (separado de ~/.claude)
FNH_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.fnharness}"

# Leer JSON desde stdin
INPUT=$(cat)

# Colores ANSI
RESET='\033[0m'
BOLD='\033[1m'
DIM='\033[2m'
CYAN='\033[36m'
GREEN='\033[32m'
YELLOW='\033[33m'
RED='\033[31m'
BLUE='\033[34m'
MAGENTA='\033[35m'
WHITE='\033[37m'
GRAY='\033[90m'

# Extraer datos del JSON
MODEL=$(echo "$INPUT" | jq -r '.model.display_name // "Unknown"')
CONTEXT_PCT=$(echo "$INPUT" | jq -r '.context_window.used_percentage // 0' | xargs printf "%.0f")
# Sin ventana conocida no se supone 200k: 0 = desconocida (se pinta "?").
CONTEXT_TOTAL=$(echo "$INPUT" | jq -r '.context_window.context_window_size // 0')
CURRENT_DIR=$(echo "$INPUT" | jq -r '.workspace.current_dir // "~"' | sed "s|$HOME|~|")
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')

# Bloque .fnharness del arnés: cuenta activa, ventana REAL del backend, servidor y velocidad.
# Un solo jq; los valores salen ya entrecomillados para el shell (@sh).
ACC_ID=""; ACC_LABEL=""; ACC_PROVIDER=""; ACC_URL=""; ACC_LOCAL=false; ACC_MODEL=""; ACC_SRV_MODEL=""
WIN_SRC=""; COMPACT_AT=""; MAX_OUT=""; SRV_ONLINE=""; SRV_NCTX=""
SPD_TTFT=""; SPD_GEN=""; SPD_PROMPT=""; SPD_DRAFT_N=""; SPD_DRAFT_OK=""; COST_KIND=""
eval "$(echo "$INPUT" | jq -r '.fnharness // empty | @sh "ACC_ID=\(.account.id // "") ACC_LABEL=\(.account.label // "") ACC_PROVIDER=\(.account.provider // "") ACC_URL=\(.account.base_url // "") ACC_LOCAL=\(.account.local // false) ACC_MODEL=\(.account.model // "") ACC_SRV_MODEL=\(.account.server_model // "") WIN_SRC=\(.context.source // "") COMPACT_AT=\(.context.autocompact_at // "") MAX_OUT=\(.context.max_output_tokens // "") SRV_ONLINE=\(if .server then .server.online else "" end) SRV_NCTX=\(.server.n_ctx // "") SPD_TTFT=\(.speed.ttft_s // "") SPD_GEN=\(.speed.generation_tokens_per_second // "") SPD_PROMPT=\(.speed.prompt_tokens_per_second // "") SPD_DRAFT_N=\(.speed.draft_tokens // "") SPD_DRAFT_OK=\(.speed.draft_accepted_tokens // "") COST_KIND=\(.cost.kind // "")"' 2>/dev/null)"
NOT_CLAUDE=0
[ -n "$ACC_ID" ] && [ "$ACC_ID" != "claude" ] && NOT_CLAUDE=1
# En cuentas que no son Claude el modelo real es el del servidor o el id, nunca un alias de Claude.
if [ "$NOT_CLAUDE" = "1" ]; then MODEL="${ACC_SRV_MODEL:-${ACC_MODEL:-$MODEL}}"; fi

# Proveedor GLM (z.ai): el modelo real llega en .model.id (con GLM el
# display_name puede ser un alias Anthropic como "Opus"; se muestra el id).
# Precedencia: si el id/display contiene glm es GLM; si el id es un claude-*
# resuelto no lo es aunque el env de GLM llegue heredado (una sesión claude.ai
# puede vivir en una shell con ANTHROPIC_BASE_URL de z.ai); el env sólo decide
# cuando el modelo no dice nada (id vacío/desconocido).
# Consumo estimado de sesión en créditos del Coding Plan (acumulado abajo en
# el sidecar, ver bloque de runtime).
MODEL_ID=$(echo "$INPUT" | jq -r '.model.id // ""')
IS_GLM=0
if printf '%s %s' "$MODEL_ID" "$MODEL" | grep -qi glm; then
    IS_GLM=1
elif ! printf '%s' "$MODEL_ID" | grep -qiE '^claude-'; then
    printf '%s' "${ANTHROPIC_BASE_URL:-}" | grep -qi 'z\.ai' && IS_GLM=1
fi
[ "$IS_GLM" = "1" ] && [ -n "$MODEL_ID" ] && MODEL="$MODEL_ID"
EST_IN=0; EST_CACHE_R=0; EST_OUT=0; EST_CR=0

# Estado de uso por cuenta (issue 0305): ventanas 5h/7d para las cabeceras de
# Element via agentsadmin. No imprime nada ni puede romper el statusline.
SL_DIR=$(dirname "$(readlink -f "${BASH_SOURCE[0]}" 2>/dev/null)")
if [ "$IS_GLM" = "1" ]; then SL_PROFILE=zai
elif printf '%s' "${CLAUDE_CONFIG_DIR:-}" | grep -q 'claude-work'; then SL_PROFILE=work
else SL_PROFILE=personal; fi
# fnharness: sin usage_sidecar (alimenta agentsadmin con cuentas Claude, no con esta).

# Multiplicadores de crédito del GLM Coding Plan (docs.z.ai/devpack/overview):
# credits = (input*Mi + cache_read*Mc + output*Mo) / 10000. Por modelo:
# glm-5.3 (6.9/1.7/24) y glm-5.3-flash (2.3/0.56/8).
glm_credit_mult() {
    case "$1" in
        *flash*) echo "2.3 0.56 8" ;;
        *)       echo "6.9 1.7 24" ;;
    esac
}

# Purga: borra goal files de sesiones muertas (no tocados en >7 dias). El worker
# refresca el mtime en cada respuesta, asi que las sesiones vivas nunca caen.
find "${FNH_DIR}/goals" -maxdepth 1 -name '*.json' -mtime +7 -delete 2>/dev/null

# Tokens de entrada y salida (current_usage puede ser null antes del primer API call)
INPUT_TOKENS=$(echo "$INPUT" | jq -r '.context_window.current_usage.input_tokens // 0')
OUTPUT_TOKENS=$(echo "$INPUT" | jq -r '.context_window.current_usage.output_tokens // 0')
CACHE_READ=$(echo "$INPUT" | jq -r '.context_window.current_usage.cache_read_input_tokens // 0')
CACHE_CREATION=$(echo "$INPUT" | jq -r '.context_window.current_usage.cache_creation_input_tokens // 0')
TOTAL_INPUT=$(echo "$INPUT" | jq -r '.context_window.total_input_tokens // 0')
TOTAL_OUTPUT=$(echo "$INPUT" | jq -r '.context_window.total_output_tokens // 0')

# Calcular contexto usado (suma de todos los tokens de entrada)
CONTEXT_USED=$((INPUT_TOKENS + CACHE_READ + CACHE_CREATION))

# GLM-5.3 / GLM-5.3-Flash: la ventana real es 1M tokens (model card de
# zai-org/GLM-5.3 en Hugging Face y docs de z.ai; verificado 05/10/2026).
# Claude Code no conoce estos modelos y manda context_window_size=200000 como
# fallback, lo que encoge el total pintado e infla el porcentaje. Decisión
# expresa del usuario (05/10/2026): pintar el total real y recalcular el
# porcentaje sobre él, sin sonda empírica del gateway. La compactación interna
# de Claude Code sigue guiándose por su propio límite; esta corrección afecta
# solo a la visualización (statusline y sidecars de ~/.claude/runtime).
if [ "$NOT_CLAUDE" = "0" ] && echo "$MODEL" | grep -qi 'glm-5.3' && [ "$CONTEXT_TOTAL" -le 200000 ]; then
    CONTEXT_TOTAL=1000000
    if [ "$CONTEXT_USED" -gt 0 ]; then
        CONTEXT_PCT=$(echo "scale=0; $CONTEXT_USED * 100 / $CONTEXT_TOTAL" | bc)
    fi
fi

# Calcular porcentaje manualmente si el del JSON es 0
if [ "$CONTEXT_PCT" -eq 0 ] && [ "$CONTEXT_USED" -gt 0 ] && [ "$CONTEXT_TOTAL" -gt 0 ]; then
    CONTEXT_PCT=$(echo "scale=0; $CONTEXT_USED * 100 / $CONTEXT_TOTAL" | bc)
fi

# Persistir el contexto por sesión en un sidecar para que fleetview (y otras
# herramientas) puedan mostrarlo sin tener este stdin. El statusline se re-ejecuta
# cada pocos segundos, así que el dato se mantiene fresco mientras la sesión vive.
if [ -n "$SESSION_ID" ]; then
    RTDIR="${FNH_DIR}/runtime"
    mkdir -p "$RTDIR" 2>/dev/null
    RTF="$RTDIR/${SESSION_ID}.json"
    RTMP="${RTF}.tmp.$$"
    SL_R5=$(echo "$INPUT" | jq -r '.rate_limits.five_hour.used_percentage // 0' | xargs printf "%.0f")
    SL_R7=$(echo "$INPUT" | jq -r '.rate_limits.seven_day.used_percentage // 0' | xargs printf "%.0f")
    SL_R5_RESET=$(echo "$INPUT" | jq -r '.rate_limits.five_hour.resets_at // 0')
    SL_R7_RESET=$(echo "$INPUT" | jq -r '.rate_limits.seven_day.resets_at // 0')
    # Detectar actividad real de API: total_output_tokens crece con cada
    # respuesta del modelo. Si cambió respecto al tick anterior, esta sesión
    # acaba de trabajar y su snapshot de rate_limits es el más fresco (una
    # sesión idle conserva el rate del momento de su última llamada, aunque el
    # statusline siga refrescando su mtime cada 2 s).
    PREV_ACT=$(jq -r '.act_seq // -1' "$RTF" 2>/dev/null)
    PREV_ACT_TS=$(jq -r '.act_ts // 0' "$RTF" 2>/dev/null)
    CUR_ACT=${TOTAL_OUTPUT:-0}
    # Timestamp de la última actividad real de API de esta sesión: avanza sólo
    # cuando el total de output tokens crece (respuesta nueva del modelo) y se
    # conserva mientras la sesión está idle. Las herramientas externas (widget
    # conky) eligen el sidecar con act_ts más reciente como "rate fresco de la
    # cuenta", sin depender de designar una terminal fuente que puede quedarse
    # idle y congelar el dato.
    if [ "${CUR_ACT:-0}" != "${PREV_ACT:--1}" ] && [ "${CUR_ACT:-0}" -gt 0 ] 2>/dev/null; then
        ACT_TS=$(date +%s)
    else
        ACT_TS=${PREV_ACT_TS:-0}
    fi
    # Consumo estimado GLM en créditos del Coding Plan: se acumulan por
    # respuesta (cuando total_output_tokens cambia, misma señal que act_seq)
    # los tokens del current_usage de esa llamada. Estimación: si dos
    # respuestas caen entre dos ticks del statusline, la primera no se suma.
    if [ "$IS_GLM" = "1" ]; then
        PREV_EIN=$(jq -r '.est_in // 0' "$RTF" 2>/dev/null); PREV_EIN=${PREV_EIN:-0}
        PREV_ECRD=$(jq -r '.est_cache_r // 0' "$RTF" 2>/dev/null); PREV_ECRD=${PREV_ECRD:-0}
        PREV_EOUT=$(jq -r '.est_out // 0' "$RTF" 2>/dev/null); PREV_EOUT=${PREV_EOUT:-0}
        if [ "${CUR_ACT:-0}" != "${PREV_ACT:--1}" ] && [ "${CUR_ACT:-0}" -gt 0 ] 2>/dev/null; then
            EST_IN=$((PREV_EIN + INPUT_TOKENS + CACHE_CREATION))
            EST_CACHE_R=$((PREV_ECRD + CACHE_READ))
            EST_OUT=$((PREV_EOUT + OUTPUT_TOKENS))
        else
            EST_IN=$PREV_EIN; EST_CACHE_R=$PREV_ECRD; EST_OUT=$PREV_EOUT
        fi
        read -r GLM_MI GLM_MC GLM_MO <<< "$(glm_credit_mult "${MODEL_ID:-$MODEL}")"
        EST_CR=$(echo "scale=2; ($EST_IN * $GLM_MI + $EST_CACHE_R * $GLM_MC + $EST_OUT * $GLM_MO) / 10000" | bc)
        case "$EST_CR" in .*) EST_CR="0${EST_CR}" ;; esac
    fi
    if jq -n \
        --argjson pct "${CONTEXT_PCT:-0}" \
        --argjson used "${CONTEXT_USED:-0}" \
        --argjson total "${CONTEXT_TOTAL:-0}" \
        --argjson r5 "${SL_R5:-0}" \
        --argjson r7 "${SL_R7:-0}" \
        --argjson r5r "${SL_R5_RESET:-0}" \
        --argjson r7r "${SL_R7_RESET:-0}" \
        --argjson act "${CUR_ACT:-0}" \
        --argjson act_ts "${ACT_TS:-0}" \
        --arg provider "$([ "$IS_GLM" = "1" ] && echo glm || echo anthropic)" \
        --argjson ein "${EST_IN:-0}" \
        --argjson ecrd "${EST_CACHE_R:-0}" \
        --argjson eout "${EST_OUT:-0}" \
        --arg est_cr "${EST_CR:-0}" \
        '{ctx_pct:$pct, ctx_used:$used, ctx_total:$total, rate_5h_pct:$r5, rate_7d_pct:$r7, rate_5h_reset:$r5r, rate_7d_reset:$r7r, act_seq:$act, act_ts:$act_ts, provider:$provider, est_in:$ein, est_cache_r:$ecrd, est_out:$eout, est_cr:$est_cr}' > "$RTMP" 2>/dev/null; then
        mv "$RTMP" "$RTF" 2>/dev/null
    else
        rm -f "$RTMP" 2>/dev/null
    fi
    # Global "último rate fresco" para herramientas externas (widget conky).
    # Cada sesión Claude puede reportar un rate distinto: el usuario tiene varias
    # cuentas/tokens en distintas terminales, y el rate limit es por-cuenta. Por
    # eso NO se puede deducir "el valor de la cuenta" globalmente; hay que designar
    # UNA terminal como fuente. Es fuente si:
    #   - env CONKY_CLAUDE_RATE=1 (se pone en el lanzador de la terminal principal:
    #     el atajo que corre fnclaude y el launcher de fleetclaude), o
    #   - la sesión actual está anclada a mano: su session_id está en
    #     ~/.claude/runtime/_rate_source.
    # Además solo escribe la que acaba de tener actividad real (output tokens
    # crecieron), para que el valor sea el más fresco. Si la fuente no está activa,
    # nadie reescribe y el widget conserva el último valor con su rate_ts (que le
    # permite marcarlo como viejo — nunca un dato falso).
    # Las sesiones GLM no tienen rate de claude.ai (rate_limits ausente): no
    # deben pisar el rate fresco del widget con ceros.
    IS_RATE_SRC=0
    [ "${CONKY_CLAUDE_RATE:-0}" = "1" ] && IS_RATE_SRC=1
    [ -f "$RTDIR/_rate_source" ] && [ "$(cat "$RTDIR/_rate_source" 2>/dev/null)" = "$SESSION_ID" ] && IS_RATE_SRC=1
    [ "$IS_GLM" = "1" ] && IS_RATE_SRC=0
    if [ "$IS_RATE_SRC" = "1" ] && [ "${CUR_ACT:-0}" != "${PREV_ACT:--1}" ] && [ "${CUR_ACT:-0}" -gt 0 ] 2>/dev/null; then
        GLF="$RTDIR/_rate_latest.json"
        GTMP="${GLF}.tmp.$$"
        if jq -n \
            --argjson r5 "${SL_R5:-0}" \
            --argjson r7 "${SL_R7:-0}" \
            --argjson r5r "${SL_R5_RESET:-0}" \
            --argjson r7r "${SL_R7_RESET:-0}" \
            --argjson ts "$(date +%s)" \
            '{rate_5h_pct:$r5, rate_7d_pct:$r7, rate_5h_reset:$r5r, rate_7d_reset:$r7r, rate_ts:$ts}' > "$GTMP" 2>/dev/null; then
            mv "$GTMP" "$GLF" 2>/dev/null
        else
            rm -f "$GTMP" 2>/dev/null
        fi
    fi
fi

# Costos
TOTAL_COST=$(echo "$INPUT" | jq -r '.cost.total_cost_usd // 0' | xargs printf "%.3f")
SESSION_DURATION=$(echo "$INPUT" | jq -r '.cost.total_duration_ms // 0')
LINES_ADDED=$(echo "$INPUT" | jq -r '.cost.total_lines_added // 0')
LINES_REMOVED=$(echo "$INPUT" | jq -r '.cost.total_lines_removed // 0')

# Rate Limits
RATE_5H=$(echo "$INPUT" | jq -r '.rate_limits.five_hour.used_percentage // 0' | xargs printf "%.0f")
RATE_7D=$(echo "$INPUT" | jq -r '.rate_limits.seven_day.used_percentage // 0' | xargs printf "%.0f")
RESET_5H_EPOCH=$(echo "$INPUT" | jq -r '.rate_limits.five_hour.resets_at // 0')
RESET_7D_EPOCH=$(echo "$INPUT" | jq -r '.rate_limits.seven_day.resets_at // 0')

# Formatear resets (vacio si epoch=0)
RESET_5H=""
RESET_7D=""
[ "$RESET_5H_EPOCH" -gt 0 ] && RESET_5H=$(date -d "@$RESET_5H_EPOCH" +"%H:%M" 2>/dev/null)
[ "$RESET_7D_EPOCH" -gt 0 ] && RESET_7D=$(date -d "@$RESET_7D_EPOCH" +"%a %H:%M" 2>/dev/null)

# Git info (si estamos en un repo). Con cache de TTL corto: como el statusline
# se re-ejecuta cada pocos segundos (refreshInterval), recomputar git en cada
# tick es caro en repos grandes y el estado git no cambia estando idle. Se cachea
# por directorio y se recomputa solo si el cache tiene mas de 6s.
GIT_BRANCH=""
GIT_STATUS=""
GIT_CACHE="/tmp/fn_sl_git_$(printf '%s' "$CURRENT_DIR" | cksum | cut -d' ' -f1).cache"
GIT_CACHE_AGE=999
[ -f "$GIT_CACHE" ] && GIT_CACHE_AGE=$(( $(date +%s) - $(stat -c %Y "$GIT_CACHE" 2>/dev/null || echo 0) ))
if [ "$GIT_CACHE_AGE" -lt 6 ]; then
    . "$GIT_CACHE"
elif git rev-parse --git-dir > /dev/null 2>&1; then
    GIT_BRANCH=$(git branch --show-current 2>/dev/null || echo "detached")

    # Obtener archivos staged, modified, untracked
    STAGED=$(git diff --cached --numstat 2>/dev/null | wc -l)
    MODIFIED=$(git diff --numstat 2>/dev/null | wc -l)
    UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null | wc -l)

    # Commits ahead/behind
    UPSTREAM=$(git rev-parse --abbrev-ref --symbolic-full-name @{u} 2>/dev/null)
    if [ -n "$UPSTREAM" ]; then
        AHEAD=$(git rev-list --count @{u}..HEAD 2>/dev/null || echo "0")
        BEHIND=$(git rev-list --count HEAD..@{u} 2>/dev/null || echo "0")
    else
        AHEAD="0"
        BEHIND="0"
    fi

    # Construir status compacto
    GIT_STATUS=""
    [ "$STAGED" -gt 0 ] && GIT_STATUS="${GIT_STATUS}+${STAGED} "
    [ "$MODIFIED" -gt 0 ] && GIT_STATUS="${GIT_STATUS}~${MODIFIED} "
    [ "$UNTRACKED" -gt 0 ] && GIT_STATUS="${GIT_STATUS}?${UNTRACKED} "
    [ "$AHEAD" -gt 0 ] && GIT_STATUS="${GIT_STATUS}↑${AHEAD} "
    [ "$BEHIND" -gt 0 ] && GIT_STATUS="${GIT_STATUS}↓${BEHIND} "

    # Trim trailing space
    GIT_STATUS=$(echo "$GIT_STATUS" | sed 's/ $//')

    # Guardar en cache (quoting seguro para re-source).
    printf 'GIT_BRANCH=%q\nGIT_STATUS=%q\n' "$GIT_BRANCH" "$GIT_STATUS" > "$GIT_CACHE" 2>/dev/null
fi

# Color estable por sesión (hash del session_id → paleta ANSI 256 legible).
# Cada terminal mantiene su color toda su vida; distinto entre terminales.
goal_color() {
    local sid="$1"
    local palette=(39 45 51 75 81 114 120 156 183 210 215 222 213 159 228)
    local h
    h=$(printf '%s' "$sid" | cksum | cut -d' ' -f1)
    local idx=$(( h % ${#palette[@]} ))
    printf '\033[1;38;5;%dm' "${palette[$idx]}"
}

# Fase de trabajo → icono | color ANSI | etiqueta visible.
# El slug (clave) lo escribe el agente del Stop hook; aqui se mapea a su estilo.
phase_style() {
    case "$1" in
        investigando)       printf '🔎|36|investigando' ;;
        planificando)       printf '📋|34|planificando' ;;
        haciendo)           printf '🔨|33|haciendo' ;;
        testeando)          printf '🧪|35|testeando' ;;
        puliendo)           printf '✨|95|puliendo detalles' ;;
        pendiente_revision) printf '👀|93|pendiente de revisión' ;;
        preguntando)        printf '❓|96|esperando respuesta' ;;
        bloqueado)          printf '⛔|31|bloqueado' ;;
        en_pausa)           printf '⏸️|90|en pausa' ;;
        hecho)              printf '✅|32|hecho' ;;
        iterando)           printf '🔁|94|iterando' ;;
        *)                  printf "•|90|$1" ;;
    esac
}

# Función para crear barra de progreso
progress_bar() {
    local pct=$1
    local width=10
    local filled=$(( pct * width / 100 ))
    local empty=$(( width - filled ))

    # Color según porcentaje
    local color=$GREEN
    if [ "$pct" -ge 80 ]; then
        color=$RED
    elif [ "$pct" -ge 60 ]; then
        color=$YELLOW
    fi

    printf "${color}"
    for ((i=0; i<filled; i++)); do printf "█"; done
    printf "${GRAY}"
    for ((i=0; i<empty; i++)); do printf "░"; done
    printf "${RESET}"
}

# Función para formatear duración
format_duration() {
    local ms=$1
    local seconds=$((ms / 1000))
    local minutes=$((seconds / 60))
    local hours=$((minutes / 60))

    if [ "$hours" -gt 0 ]; then
        printf "%dh%dm" $hours $((minutes % 60))
    elif [ "$minutes" -gt 0 ]; then
        printf "%dm%ds" $minutes $((seconds % 60))
    else
        printf "%ds" $seconds
    fi
}

# Función para formatear tokens (k para miles, M para millones)
format_tokens() {
    local tokens=$1
    if [ "$tokens" -ge 1000000 ]; then
        printf "%.1fM" $(echo "scale=1; $tokens / 1000000" | bc)
    elif [ "$tokens" -ge 1000 ]; then
        printf "%.0fk" $(echo "scale=0; $tokens / 1000" | bc)
    else
        printf "%d" $tokens
    fi
}

# Tokens con un decimal si no son redondos (32768 -> 32k, 29500 -> 29.5k, 200000 -> 200k, 1000000 -> 1M)
fmt_k() {
    local n=$1
    if [ "$n" -ge 1000000 ]; then
        printf '%s' "$(echo "scale=1; $n / 1000000" | bc | sed 's/\.0$//')M"
    elif [ "$n" -ge 1024 ] && [ $((n % 1024)) -eq 0 ]; then
        printf '%dk' $((n / 1024))
    elif [ "$n" -ge 1000 ]; then
        printf '%s' "$(echo "scale=1; $n / 1000" | bc | sed 's/\.0$//')k"
    else
        printf '%d' "$n"
    fi
}

# Hora actual
CURRENT_TIME=$(date +"%H:%M")

# ===== CONSTRUIR STATUS LINE (2 LÍNEAS) =====

# ===== LÍNEA 1: Información Principal =====
LINE1=""

# 1. Modelo
LINE1="${LINE1}${BOLD}${CYAN}${MODEL}${RESET}"
if [ -n "$ACC_ID" ]; then
    LINE1="${LINE1} ${DIM}[${ACC_ID}]${RESET}"
elif [ -n "${FNHARNESS_ACCOUNT_LABEL:-}" ]; then
    LINE1="${LINE1} ${DIM}[${FNHARNESS_ACCOUNT_LABEL}]${RESET}"
fi

# 2. Contexto con barra y usado/total
CONTEXT_USED_FMT=$(format_tokens $CONTEXT_USED)
if [ "$CONTEXT_TOTAL" -gt 0 ]; then CONTEXT_TOTAL_FMT=$(fmt_k $CONTEXT_TOTAL); else CONTEXT_TOTAL_FMT="?"; fi
COMPACT_STR=""
[ -n "$COMPACT_AT" ] && COMPACT_STR=" ${DIM}⟳$(fmt_k "$COMPACT_AT")${RESET}"
LINE1="${LINE1} ${GRAY}│${RESET} ${BOLD}CTX:${RESET} $(progress_bar $CONTEXT_PCT) ${YELLOW}${CONTEXT_PCT}%${RESET} ${DIM}(${CONTEXT_USED_FMT}/${CONTEXT_TOTAL_FMT})${RESET}${COMPACT_STR}"

# 3. Tokens entrada/salida (formateados)
INPUT_FMT=$(format_tokens $INPUT_TOKENS)
OUTPUT_FMT=$(format_tokens $OUTPUT_TOKENS)
LINE1="${LINE1} ${GRAY}│${RESET} ${CYAN}IN:${RESET}${INPUT_FMT} ${MAGENTA}OUT:${RESET}${OUTPUT_FMT}"
if [ "$CACHE_READ" -gt 0 ]; then
    CACHE_FMT=$(format_tokens $CACHE_READ)
    LINE1="${LINE1} ${DIM}(cache:${CACHE_FMT})${RESET}"
fi

# 4. Git (si existe)
if [ -n "$GIT_BRANCH" ]; then
    LINE1="${LINE1} ${GRAY}│${RESET} ${BOLD}${MAGENTA}⎇ ${GIT_BRANCH}${RESET}"
    if [ -n "$GIT_STATUS" ]; then
        LINE1="${LINE1} ${DIM}[${GIT_STATUS}]${RESET}"
    fi
fi

# 5. Hora actual
LINE1="${LINE1} ${GRAY}│${RESET} ${WHITE}${CURRENT_TIME}${RESET}"

# ===== LÍNEA 2: Detalles =====
LINE2=""

# 1. Costos. Con GLM, .cost.total_cost_usd se calcula con precios Anthropic y
# es un número falso: se muestra el consumo estimado en créditos del Coding
# Plan de z.ai (acumulado por respuesta en el sidecar de sesión). "~" marca
# que es una estimación.
if [ "$IS_GLM" = "1" ]; then
    EST_CR_FMT=$(printf '%.1f' "${EST_CR:-0}" 2>/dev/null || echo 0)
    LINE2="${LINE2}${BOLD}${GREEN}~ⓒ${EST_CR_FMT}${RESET}"
elif [ "$COST_KIND" = "free" ]; then
    LINE2="${LINE2}${DIM}local · sin coste${RESET}"
elif [ "$COST_KIND" = "unpriced" ]; then
    LINE2="${LINE2}${DIM}sin tarifa${RESET}"
elif (( $(echo "$TOTAL_COST > 0" | bc -l) )); then
    LINE2="${LINE2}${BOLD}${GREEN}\$${TOTAL_COST}${RESET}"
else
    LINE2="${LINE2}${DIM}\$0.000${RESET}"
fi

# 2. Ediciones
LINE2="${LINE2} ${GRAY}│${RESET} ${GREEN}+${LINES_ADDED}${RESET}${GRAY}/${RED}-${LINES_REMOVED}${RESET}"

# 3. Tokens totales (formateados). En GLM sin rate_limits se pintan en el
# bloque Usage de abajo en vez de aquí, para no duplicar el dato.
TOTAL_IN_FMT=$(format_tokens $TOTAL_INPUT)
TOTAL_OUT_FMT=$(format_tokens $TOTAL_OUTPUT)
GLM_NO_LIMITS=0
[ "$IS_GLM" = "1" ] && [ "$RATE_5H" -eq 0 ] && [ "$RATE_7D" -eq 0 ] && GLM_NO_LIMITS=1
if [ "$GLM_NO_LIMITS" = "0" ]; then
    LINE2="${LINE2} ${GRAY}│${RESET} ${DIM}Total:${RESET} ${CYAN}↓${TOTAL_IN_FMT}${RESET}${GRAY}/${MAGENTA}↑${TOTAL_OUT_FMT}${RESET}"
fi

# 4. Rate Limits (o uso real con GLM sin cuota). z.ai no expone cuota: ni
# headers rate-limit en la API ni rate_limits en el stdin (curl verificado
# 2026-10-05). Si un día rate_limits llega no-cero en una sesión GLM, son
# datos reales y se pintan como siempre.
if [ "$GLM_NO_LIMITS" = "1" ]; then
    LINE2="${LINE2} ${GRAY}│${RESET} ${BOLD}Usage:${RESET} ${CYAN}↓${TOTAL_IN_FMT}${RESET}${GRAY}/${MAGENTA}↑${TOTAL_OUT_FMT}${RESET}"
    PC_HIT=$(echo "$INPUT" | jq -r '.prompt_cache.hit_ratio // empty')
    if [ -n "$PC_HIT" ]; then
        PC_HIT_PCT=$(printf '%.0f' "$(echo "$PC_HIT * 100" | bc -l)")
        LINE2="${LINE2} ${DIM}(cache:${PC_HIT_PCT}%)${RESET}"
    fi
elif [ "$NOT_CLAUDE" = "1" ]; then
    : # 5h/7d son límites de la cuenta de Claude: no aplican a otros backends
else
LINE2="${LINE2} ${GRAY}│${RESET} ${BOLD}Limits:${RESET}"

# Color por burndown vs tasa esperada
# Tasa: % consumible permitido por unidad de tiempo (5h: 20%/h, 7d: 14%/dia)
# expected = tasa * unidades_restantes_hasta_reset
# available = 100 - used%
# verde: available >= expected (consumo bajo control)
# amarillo: available >= expected/2 (consumo agresivo)
# rojo: available < expected/2 (riesgo de agotar antes del reset)
NOW_EPOCH=$(date +%s)
burndown_color() {
    local used_pct=$1
    local secs_left=$2
    local rate=$3
    local secs_per_unit=$4
    local available=$((100 - used_pct))
    if [ "$secs_left" -le 0 ]; then
        printf "%s" "$GREEN"; return
    fi
    local expected
    expected=$(echo "scale=2; $rate * $secs_left / $secs_per_unit" | bc)
    if (( $(echo "$available >= $expected" | bc -l) )); then
        printf "%s" "$GREEN"
    elif (( $(echo "$available >= $expected / 2" | bc -l) )); then
        printf "%s" "$YELLOW"
    else
        printf "%s" "$RED"
    fi
}

# 5h limit (tasa 20%/h)
SECS_5H=0
[ "$RESET_5H_EPOCH" -gt "$NOW_EPOCH" ] && SECS_5H=$((RESET_5H_EPOCH - NOW_EPOCH))
C5=$(burndown_color $RATE_5H $SECS_5H 20 3600)
RESET_5H_STR=""
[ -n "$RESET_5H" ] && RESET_5H_STR=" ${C5}→${RESET_5H}${RESET}"
LINE2="${LINE2} ${C5}5h:${RATE_5H}%${RESET}${RESET_5H_STR} ${GRAY}│${RESET}"

# 7d limit (tasa 14%/dia)
SECS_7D=0
[ "$RESET_7D_EPOCH" -gt "$NOW_EPOCH" ] && SECS_7D=$((RESET_7D_EPOCH - NOW_EPOCH))
C7=$(burndown_color $RATE_7D $SECS_7D 14 86400)
RESET_7D_STR=""
[ -n "$RESET_7D" ] && RESET_7D_STR=" ${C7}→${RESET_7D}${RESET}"
LINE2="${LINE2} ${C7}7d:${RATE_7D}%${RESET}${RESET_7D_STR}"
fi

# 5. Duración sesión
if [ "$SESSION_DURATION" -gt 0 ]; then
    DURATION_STR=$(format_duration $SESSION_DURATION)
    LINE2="${LINE2} ${GRAY}│${RESET} ${DIM}⏱ ${DURATION_STR}${RESET}"
fi

# 6. Directorio actual
LINE2="${LINE2} ${GRAY}│${RESET} ${BLUE}${CURRENT_DIR}${RESET}"

# ===== LÍNEA 0: Objetivo (izq) + Fase (der) =====
# Solo si la sesión tiene archivo de objetivo con goal no vacío.
GOAL_FILE="${FNH_DIR}/goals/${SESSION_ID}.json"
if [ -n "$SESSION_ID" ] && [ -f "$GOAL_FILE" ]; then
    GOAL=$(jq -r '.goal // ""' "$GOAL_FILE" 2>/dev/null)
    PHASE=$(jq -r '.phase // ""' "$GOAL_FILE" 2>/dev/null)
    EMOJIS=$(jq -r '.emojis // ""' "$GOAL_FILE" 2>/dev/null)
    PROVISIONAL=$(jq -r '.provisional // false' "$GOAL_FILE" 2>/dev/null)
    if [ -n "$GOAL" ]; then
        GC=$(goal_color "$SESSION_ID")
        # Prefijo del objetivo:
        #   - provisional (= tu propio texto, mientras haiku genera el real) -> ⏳ atenuado.
        #   - los 3 emojis generados (representan la tarea, igual que FleetView).
        #   - fallback al marcador generico de objetivo.
        if [ "$PROVISIONAL" = "true" ]; then
            LEFT="${GC}⏳ ${DIM}${GOAL}${RESET}"
        elif [ -n "$EMOJIS" ]; then
            LEFT="${GC}${EMOJIS} ${GOAL}${RESET}"
        else
            LEFT="${GC}🎯 ${GOAL}${RESET}"
        fi

        LINE0="${LEFT}"

        # Historial: emojis de los ultimos 7 estados PREVIOS (sin el actual, que
        # se muestra completo a la derecha), atenuados y separados por │.
        PREV=$(jq -r '(.history // []) | .[0:-1] | .[-7:] | .[]' "$GOAL_FILE" 2>/dev/null)
        if [ -n "$PREV" ]; then
            HJOIN=""
            while IFS= read -r slug; do
                [ -z "$slug" ] && continue
                HS=$(phase_style "$slug")
                HIC="${HS%%|*}"
                HJOIN="${HJOIN}${HIC}"
            done <<< "$PREV"
            [ -n "$HJOIN" ] && LINE0="${LINE0} ${GRAY}│${RESET} ${DIM}${HJOIN}${RESET}"
        fi

        # Fase actual (completa, con color e icono).
        if [ -n "$PHASE" ]; then
            PS=$(phase_style "$PHASE")
            PICON="${PS%%|*}"
            REST="${PS#*|}"
            PCOL="${REST%%|*}"
            PLABEL="${REST#*|}"
            LINE0="${LINE0} ${GRAY}│${RESET} \033[1;${PCOL}m${PICON} ${PLABEL}${RESET}"
        fi
        echo -e "$LINE0"
    fi
fi

# Comando para retomar esta sesion desde otra terminal, siempre visible si hay SESSION_ID.
[ -n "$SESSION_ID" ] && echo -e "  ${DIM}🔗 fnharness --resume ${SESSION_ID}${RESET}"

# Imprimir resultado (2 líneas)
# ===== LÍNEA 3: cuenta y backend =====
LINE3=""
if [ -n "$ACC_ID" ]; then
    if [ "$NOT_CLAUDE" = "1" ]; then
        LINE3="${BOLD}${MAGENTA}${ACC_ID}${RESET} ${DIM}${ACC_LABEL}${RESET}"
        [ -n "$ACC_URL" ] && LINE3="${LINE3} ${DIM}@ $(printf '%s' "$ACC_URL" | sed -E 's#^https?://##; s#/v1(beta)?$##')${RESET}"
        if [ "$SRV_ONLINE" = "true" ]; then LINE3="${LINE3} ${GREEN}● en línea${RESET}"
        elif [ "$SRV_ONLINE" = "false" ]; then LINE3="${LINE3} ${RED}○ sin respuesta${RESET}"; fi
    else
        LINE3="${BOLD}${MAGENTA}claude${RESET} ${DIM}Anthropic${RESET}"
    fi
    case "$WIN_SRC" in
        server) SRC_STR="servidor" ;; preset) SRC_STR="preset" ;; catalog) SRC_STR="catálogo" ;;
        claude) SRC_STR="" ;; *) SRC_STR="sin dato" ;;
    esac
    WIN_STR="ventana $CONTEXT_TOTAL_FMT"
    [ -n "$SRC_STR" ] && WIN_STR="$WIN_STR ($SRC_STR)"
    [ "$WIN_SRC" = "server" ] && [ -n "$SRV_NCTX" ] && WIN_STR="ventana $(fmt_k "$SRV_NCTX") (servidor)"
    LINE3="${LINE3} ${GRAY}│${RESET} ${DIM}${WIN_STR}${RESET}"
    [ -n "$MAX_OUT" ] && LINE3="${LINE3} ${DIM}· salida máx $(fmt_k "$MAX_OUT")${RESET}"
    [ -n "$COMPACT_AT" ] && LINE3="${LINE3} ${DIM}· autocompacta a $(fmt_k "$COMPACT_AT")${RESET}"
    if [ "$ACC_LOCAL" = "true" ]; then
        if [ -n "$SPD_TTFT$SPD_GEN" ]; then
            SPD="⚡"
            [ -n "$SPD_TTFT" ] && SPD="$SPD TTFT $(printf '%.2f' "$SPD_TTFT") s"
            [ -n "$SPD_GEN" ] && SPD="$SPD · gen $(printf '%.1f' "$SPD_GEN") tok/s"
            [ -n "$SPD_PROMPT" ] && SPD="$SPD · lectura $(printf '%.0f' "$SPD_PROMPT") tok/s"
            if [ -n "$SPD_DRAFT_N" ] && [ "$SPD_DRAFT_N" != "0" ]; then
                SPD="$SPD · espec. $(( ${SPD_DRAFT_OK:-0} * 100 / SPD_DRAFT_N ))%"
            fi
            LINE3="${LINE3} ${GRAY}│${RESET} ${CYAN}${SPD}${RESET}"
        else
            LINE3="${LINE3} ${GRAY}│${RESET} ${DIM}⚡ sin medidas aún${RESET}"
        fi
    fi
fi

echo -e "$LINE1"
echo -e "$LINE2"
if [ -n "$LINE3" ]; then echo -e "$LINE3"; fi
