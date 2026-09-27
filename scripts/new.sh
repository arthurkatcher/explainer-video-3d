#!/usr/bin/env bash
# scripts/new.sh <dir>  -> Remotion + three.js project + numpy/scipy venv, seeded with the reference video
set -euo pipefail
SKILL="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$1"; mkdir -p "$DIR"/{src,public,out/stills}; cd "$DIR"
[ -f package.json ] || npm init -y >/dev/null
npm i -s remotion @remotion/cli @remotion/bundler @remotion/renderer @remotion/google-fonts @remotion/three \
  three @types/three @react-three/fiber @react-three/postprocessing postprocessing react react-dom typescript @types/react
[ -d .venv ] || { python3 -m venv .venv && .venv/bin/pip -q install numpy scipy; }
for f in Video.tsx timeline.json Root.tsx index.ts; do [ -f src/$f ] || cp "$SKILL/reference/$f" src/; done
for f in gen_music.py remotion.config.ts tsconfig.json; do [ -f $f ] || cp "$SKILL/reference/$f" .; done
cp "$SKILL/scripts/"{stills.mjs,vo.py,mix_vo.py} .
printf 'node_modules/\nout/\n.venv/\n*.wav\n.env\n' > .gitignore
echo "ready: $DIR (reference = 'How an AI chip works'; rewrite src/timeline.json + src/Video.tsx + gen_music.py score)"
