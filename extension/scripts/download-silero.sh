#!/usr/bin/env bash
# Downloads the three binary files needed for Silero VAD into the extension bundle.
# Run once from the repo root or from inside extension/scripts/:
#   bash extension/scripts/download-silero.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(dirname "$SCRIPT_DIR")"
ORT_VERSION="1.19.2"

mkdir -p "$EXT_DIR/lib/ort"

echo "▸ onnxruntime-web JS (v${ORT_VERSION})..."
curl -fsSL --location \
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.min.js" \
  -o "$EXT_DIR/lib/ort/ort.min.js"

echo "▸ onnxruntime WASM — SIMD (v${ORT_VERSION})..."
curl -fsSL --location \
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd.wasm" \
  -o "$EXT_DIR/lib/ort/ort-wasm-simd.wasm"

echo "▸ silero_vad.onnx (official snakers4/silero-vad repo)..."
# The ONNX file is tracked in Git LFS on GitHub. Use the HuggingFace mirror which
# serves the binary directly without LFS pointer redirects.
ONNX_URL="https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/silero_vad.onnx"
FALLBACK_URL="https://github.com/snakers4/silero-vad/raw/master/files/silero_vad.onnx"

if ! curl -fsSL --location "$ONNX_URL" -o "$EXT_DIR/lib/silero_vad.onnx"; then
  echo "  HuggingFace failed, trying GitHub fallback..."
  curl -fsSL --location "$FALLBACK_URL" -o "$EXT_DIR/lib/silero_vad.onnx"
fi

# Sanity check — ONNX files begin with 0x08 (protobuf field 1, varint)
MAGIC=$(xxd -l 1 "$EXT_DIR/lib/silero_vad.onnx" | awk '{print $2}')
if [ "$MAGIC" != "08" ]; then
  echo "❌ silero_vad.onnx looks wrong (first byte=$MAGIC, expected 08)."
  echo "   The file may be a Git LFS pointer. Download manually from:"
  echo "   https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/silero_vad.onnx"
  exit 1
fi

echo ""
echo "✓ All files ready:"
ls -lh "$EXT_DIR/lib/ort/ort.min.js" \
        "$EXT_DIR/lib/ort/ort-wasm-simd.wasm" \
        "$EXT_DIR/lib/silero_vad.onnx"
echo ""
echo "Next: reload the extension at chrome://extensions (Ctrl+R on the card)."
