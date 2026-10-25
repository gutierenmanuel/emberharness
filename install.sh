#!/usr/bin/env bash
# Instala fnharness desde su repo de Gitea: clona (o actualiza), instala dependencias con bun,
# compila ./cli y enlaza el lanzador en ~/.local/bin/fnharness.
#
# Uso:
#   ./install.sh                       # desde una copia ya clonada: instala ahí
#   FNHARNESS_DIR=~/fnharness ./install.sh   # clona o actualiza en otra ruta
#
# El repo es privado: la clonación necesita credenciales de Gitea ya configuradas (token en git
# credential helper o en el remoto). Este script nunca las lee ni las imprime.
set -euo pipefail

REPO="${FNHARNESS_REPO:-https://github.com/gutierenmanuel/fnharness$1}"
BUN_MIN_VERSION="1.3.11"
LINK_DIR="${FNHARNESS_LINK_DIR:-$HOME/.local/bin}"

info() { printf '[*] %s\n' "$*"; }
ok()   { printf '[+] %s\n' "$*"; }
fail() { printf '[x] %s\n' "$*" >&2; exit 1; }

# Raíz de instalación: la copia donde está este script, salvo que se pida otra.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${FNHARNESS_DIR:-}" ]]; then
  install_dir="$FNHARNESS_DIR"
elif [[ -f "$script_dir/package.json" ]]; then
  install_dir="$script_dir"
else
  install_dir="$HOME/fnharness"
fi

# bun >= BUN_MIN_VERSION (el global del dueño vive en ~/.local/bun-npm).
export PATH="$HOME/.local/bun-npm/node_modules/.bin:$PATH"
command -v bun >/dev/null 2>&1 || fail "bun no está instalado (se necesita >= $BUN_MIN_VERSION)"
bun_version="$(bun --version)"
if [[ "$(printf '%s\n%s\n' "$BUN_MIN_VERSION" "$bun_version" | sort -V | head -1)" != "$BUN_MIN_VERSION" ]]; then
  fail "bun $bun_version es demasiado viejo (se necesita >= $BUN_MIN_VERSION)"
fi
ok "bun $bun_version"

if [[ ! -f "$install_dir/package.json" ]]; then
  info "Clonando $REPO en $install_dir"
  git clone "$REPO" "$install_dir"
elif [[ -d "$install_dir/.git" && -z "$(git -C "$install_dir" status --porcelain)" ]]; then
  info "Actualizando $install_dir"
  git -C "$install_dir" pull --ff-only || info "sin actualizar (rama sin remoto o con cambios locales); se instala lo que hay"
fi
ok "Código en $install_dir"

info "Instalando dependencias"
(cd "$install_dir" && bun install --frozen-lockfile)

info "Compilando ./cli"
(cd "$install_dir" && bun run build)
[[ -x "$install_dir/cli" ]] || fail "la compilación no dejó $install_dir/cli"
ok "Binario: $install_dir/cli"

info "ripgrep para Grep y Glob (sin sudo, junto al binario)"
if command -v rg >/dev/null 2>&1 && [[ "$(type -t rg)" == file ]]; then
  ok "rg del sistema: $(command -v rg)"
else
  "$install_dir/scripts/install-ripgrep.sh" || info "sin ripgrep: Grep y Glob fallarán hasta instalar rg o ejecutar scripts/install-ripgrep.sh"
fi

mkdir -p "$LINK_DIR"
ln -sf "$install_dir/bin/fnharness" "$LINK_DIR/fnharness"
ok "Enlace: $LINK_DIR/fnharness"

case ":$PATH:" in
  *":$LINK_DIR:"*) ;;
  *) info "Añade $LINK_DIR al PATH para usar el comando fnharness" ;;
esac

cat <<EOF

Listo. Prueba:
  fnharness --accounts     # cuentas disponibles
  fnharness                # sesión interactiva con la última cuenta usada

La primera vez con la cuenta claude, escribe /login dentro de la sesión. Con modelos locales o de
otros proveedores usa /account (selector de cuentas).
EOF
