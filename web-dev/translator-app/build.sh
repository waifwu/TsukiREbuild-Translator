#!/usr/bin/env bash
# build.sh [win] [mac]: the translator tool as an app, Tsukihime Translator (web-dev/translator-app/README.md). With no argument, Windows only:
#   out/TsukihimeTranslator-win-x64.zip   Windows 10 or newer: unzip anywhere, run "Tsukihime Translator.exe" (the game must be installed: its PC build)
#   out/mac-arm64/                        for trying it on this Mac (it uses this Mac's python3)
# The Windows app carries Python: python.org's embeddable package (PY below), downloaded once into the cache and checked against its SHA-256
# (the one python.org's release page gives). Needs Node.js with npm, and python3 (bundled.json); electron and electron-builder are the desktop
# app's versions.
# bundled.json describes the tool files the app packs (web-dev/tools/translator_manifest.py), so that the app knows which release's files it
# already has; its time is TOOL_TIME (seconds) when set (the release workflow sets the commit's), else now.
set -euo pipefail
cd "$(dirname "$0")"
PY=3.15.2
PY_SHA256=d012f3aa29cf07436dae8aea1fec0fd195c2612a0b059b1f915ae0afb9ad1f62
args=()
for a in "$@"; do
    case "$a" in
        win|mac) args+=("--$a") ;;
        *) echo "unknown argument: $a (win, mac)" >&2; exit 2 ;;
    esac
done
[ ${#args[@]} -gt 0 ] || args=(--win)
if [[ " ${args[*]} " == *" --win "* ]]; then
    if [ "$(uname)" = Darwin ]; then CACHE="$HOME/Library/Caches/tsukihime-translator"; else CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/tsukihime-translator"; fi
    zip="$CACHE/python-$PY-embed-amd64.zip"
    if [ ! -f "$zip" ]; then
        mkdir -p "$CACHE"
        curl -fL -o "$zip.part" "https://www.python.org/ftp/python/$PY/python-$PY-embed-amd64.zip"
        mv "$zip.part" "$zip"
    fi
    echo "$PY_SHA256  $zip" | shasum -a 256 -c - >/dev/null || { echo "$zip is not python.org's $PY (SHA-256): not built" >&2; exit 1; }
    rm -rf out/python-win
    mkdir -p out/python-win
    unzip -q "$zip" -d out/python-win
fi
[ -d node_modules/electron-builder ] || npm install --prefer-offline --no-audit --no-fund
mkdir -p out
python3 ../tools/translator_manifest.py --bundle out/bundled.json ${TOOL_TIME:+--time "$TOOL_TIME"}
npx electron-builder "${args[@]}"
rm -rf out/python-win out/bundled.json
ls -lh out/TsukihimeTranslator-* 2>/dev/null | awk '{print $5, $9}' || true
