#!/usr/bin/env bash
# scripts/render.sh [composition-id] [out-name]  (run inside the project)
# -> out/<name>.mp4: music (+ narration when OPENROUTER_API_KEY is set or .env exists) at -14 LUFS, 1080p30, GPU (angle) render
set -euo pipefail
ID="${1:-$(node -e "console.log(require('fs').readFileSync('src/Root.tsx','utf8').match(/id=\"([^\"]+)\"/)[1])")}"
NAME="${2:-video}"
.venv/bin/python gen_music.py
ffmpeg -v error -y -i public/music_raw.wav -af loudnorm=I=-14:TP=-1.0:LRA=11 -ar 48000 public/music.wav
AUDIO=public/music.wav
if [ "${NO_VOICE:-}" != 1 ] && { [ -n "${OPENROUTER_API_KEY:-}" ] || [ -f .env ]; }; then
  .venv/bin/python vo.py && .venv/bin/python mix_vo.py
  ffmpeg -v error -y -i public/mix_raw.wav -af loudnorm=I=-14:TP=-1.0:LRA=11 -ar 48000 public/mix.wav
  AUDIO=public/mix.wav
fi
# the picture only changes when src/ changes; SKIP_VIDEO=1 re-mixes audio onto the last render
[ "${SKIP_VIDEO:-}" = 1 ] && [ -f out/silent.mp4 ] || \
  npx remotion render src/index.ts "$ID" out/silent.mp4 --concurrency="${CONCURRENCY:-3}" --crf=18 --muted --log=error
ffmpeg -v error -y -i out/silent.mp4 -i "$AUDIO" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 256k -shortest -movflags +faststart "out/$NAME.mp4"
ffmpeg -v error -y -i "$AUDIO" -lavfi showspectrumpic=s=1600x500:legend=1:scale=log out/spectrum.png
echo "out/$NAME.mp4"
