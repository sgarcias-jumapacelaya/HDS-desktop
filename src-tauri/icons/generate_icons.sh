#!/usr/bin/env bash
# Genera los iconos requeridos por Tauri 2 a partir de logo.png
# Uso: coloca tu logo cuadrado en este mismo folder como `logo.png` y ejecuta:
#   bash generate_icons.sh
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f logo.png ]]; then
  echo "ERROR: falta logo.png en $(pwd)"
  exit 1
fi

# Cuadrar y rellenar con transparencia para evitar deformación
convert logo.png -resize 1024x1024 -background none -gravity center -extent 1024x1024 _square.png

convert _square.png -resize 32x32      32x32.png
convert _square.png -resize 128x128    128x128.png
convert _square.png -resize 256x256    "128x128@2x.png"
convert _square.png -resize 512x512    icon.png
convert _square.png -resize 256x256 -define icon:auto-resize=256,128,64,48,32,16 icon.ico

# Para macOS (opcional)
convert _square.png -resize 1024x1024 icon-1024.png

rm -f _square.png
echo "OK iconos generados en $(pwd)"
ls -1 *.png *.ico 2>/dev/null
