#!/usr/bin/env bash
# Render an email through REAL classic desktop Outlook (Word engine) and save
# page-by-page screenshots -- the view an "older Outlook" recipient gets.
# Browser previews cannot reproduce Word-engine bugs (doubled borders,
# inflated 1px rows, etc.); this can.
#
# Usage:
#   ./scripts/outlook-preview.sh <template-uuid>            # pull from DB
#   ./scripts/outlook-preview.sh path/to/email.html         # local file
#   ./scripts/outlook-preview.sh <arg> /custom/out/dir
#
# Requirements: WSL on a Windows host with classic Outlook installed and an
# unlocked interactive desktop (an Outlook compose window opens briefly).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARG="${1:?usage: outlook-preview.sh <template-uuid|html-file> [outdir]}"
OUTDIR="${2:-$ROOT/outlook-preview-out}"
mkdir -p "$OUTDIR"

if [[ -f "$ARG" ]]; then
  HTML="$(realpath "$ARG")"
else
  HTML="$OUTDIR/template.html"
  node "$ROOT/scripts/fetch-template-html.cjs" "$ARG" > "$HTML"
fi

PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
"$PS" -NoProfile -ExecutionPolicy Bypass \
  -File "$(wslpath -w "$ROOT/scripts/outlook-preview.ps1")" \
  -HtmlPath "$(wslpath -w "$HTML")" \
  -OutDir "$(wslpath -w "$OUTDIR")" | tr -d '\r'
