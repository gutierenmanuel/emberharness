#!/usr/bin/env bash
# Deja un ripgrep junto al binario compilado: <app>/vendor/ripgrep/<arch>-<os>/rg (gitignored).
# Grep y Glob lo necesitan; dentro de ./cli no hay rg embebido. fnharness usa primero un rg real
# del PATH (no una función de shell) y, si no existe, este. No requiere sudo ni paquetes del sistema.
#
#   scripts/install-ripgrep.sh            # descarga si falta
#   FNHARNESS_RG_VERSION=15.2.0 FORCE=1 scripts/install-ripgrep.sh
set -euo pipefail

app="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="${FNHARNESS_RG_VERSION:-15.2.0}"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)         sub="x64-linux";   triple="x86_64-unknown-linux-musl" ;;
  Linux-aarch64|Linux-arm64) sub="arm64-linux"; triple="aarch64-unknown-linux-gnu" ;;
  Darwin-arm64)         sub="arm64-darwin"; triple="aarch64-apple-darwin" ;;
  Darwin-x86_64)        sub="x64-darwin";  triple="x86_64-apple-darwin" ;;
  *) echo "[x] plataforma sin ripgrep empaquetado: $(uname -s)-$(uname -m); instala rg en el PATH" >&2; exit 1 ;;
esac

dest="$app/vendor/ripgrep/$sub/rg"
if [[ -x "$dest" && "${FORCE:-0}" != 1 ]]; then
  echo "[+] ripgrep ya en $dest"; exit 0
fi

name="ripgrep-$version-$triple"
url="https://github.com/BurntSushi/ripgrep/releases/download/$version/$name.tar.gz"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

echo "[*] Descargando $url"
curl -fsSL "$url" -o "$tmp/rg.tgz"
# Comprobación de integridad cuando la release publica el .sha256 (las de Linux musl y macOS lo traen).
if curl -fsSL "$url.sha256" -o "$tmp/rg.sha256" 2>/dev/null; then
  want="$(awk '{print $1}' "$tmp/rg.sha256")"
  got="$(sha256sum "$tmp/rg.tgz" 2>/dev/null || shasum -a 256 "$tmp/rg.tgz")"
  [[ "${got%% *}" == "$want" ]] || { echo "[x] sha256 distinto en $url" >&2; exit 1; }
  echo "[+] sha256 verificado"
fi
tar -xzf "$tmp/rg.tgz" -C "$tmp"
mkdir -p "$(dirname "$dest")"
install -m 0755 "$tmp/$name/rg" "$dest"
echo "[+] ripgrep $("$dest" --version | head -1) en $dest"
