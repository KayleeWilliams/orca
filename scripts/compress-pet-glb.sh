#!/usr/bin/env bash
# Compress a GLB for use as a bundled pet model.
#
# Why two passes: the first `optimize` run with `--compress draco` must decode
# any existing Draco compression before it can downscale textures; textures
# dominate file size for most source models, so the real win comes from the
# second pass after textures are shrunk + re-encoded as WebP at 512px.
#
# Typical result: 20–30 MB source → <1 MB bundled. Output lands at
# resources/pets/<slug>.glb unless --out is given.
#
# Usage:
#   scripts/compress-pet-glb.sh <input.glb> [--out <path>] [--size 512]
#
# Example:
#   scripts/compress-pet-glb.sh ~/Downloads/some_model.glb --out resources/pets/cat.glb

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <input.glb> [--out <path>] [--size <px>]" >&2
  exit 1
fi

INPUT="$1"
shift

SIZE=512
OUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      OUT="$2"
      shift 2
      ;;
    --size)
      SIZE="$2"
      shift 2
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$INPUT" ]]; then
  echo "input not found: $INPUT" >&2
  exit 1
fi

if [[ -z "$OUT" ]]; then
  BASENAME="$(basename "$INPUT" .glb)"
  # Why: produce a kebab-case slug so the filename matches the PetModelId
  # convention (lowercase, hyphen-separated) without manual renaming.
  SLUG="$(echo "$BASENAME" | tr '[:upper:] _' '[:lower:]--' | tr -cd 'a-z0-9-' | sed 's/--*/-/g;s/^-//;s/-$//')"
  OUT="resources/pets/${SLUG}.glb"
fi

echo "==> compressing: $INPUT"
echo "    -> $OUT (textures: ${SIZE}px, webp + draco)"

# Why: write to a temp file first so a failed second pass doesn't leave a
# half-optimized GLB at the destination.
TMP="$(mktemp -t pet-glb.XXXXXX).glb"
trap 'rm -f "$TMP"' EXIT

npx --yes @gltf-transform/cli optimize "$INPUT" "$TMP" \
  --compress draco \
  --texture-compress webp \
  --texture-size "$SIZE"

# Why: second optimize pass. After the first pass decoded Draco and shrank
# textures, re-running draco + webp compresses the now-smaller assets far
# more aggressively (observed: 8.8 MB → 0.8 MB on tiny_planet dinosaur).
npx --yes @gltf-transform/cli optimize "$TMP" "$OUT" \
  --compress draco \
  --texture-compress webp \
  --texture-size "$SIZE"

SIZE_BYTES=$(wc -c <"$OUT" | tr -d ' ')
SIZE_KB=$(( SIZE_BYTES / 1024 ))
echo "==> done: $OUT (${SIZE_KB} KB)"
