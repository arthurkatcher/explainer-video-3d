"""Duck public/music.wav under public/vo.wav -> public/mix_raw.wav (render.sh loudnorms it and muxes)."""
import json
import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly

DUCK_DB = json.load(open("src/timeline.json")).get("voice", {}).get("duckDb", -9)
sr, m = wavfile.read("public/music.wav")
m = m.astype(np.float32) / (32768 if m.dtype == np.int16 else 1)
if m.ndim == 1:
    m = m[:, None]
vsr, v = wavfile.read("public/vo.wav")
v = resample_poly(v.astype(np.float32), sr, vsr)
v = np.pad(v, (0, max(0, len(m) - len(v))))[: len(m)]

# envelope follower on the voice: fast attack, slow release, lookahead so the duck lands before the first syllable
hop = sr // 100
blk = np.array([np.abs(v[i:i + hop]).max() for i in range(0, len(v), hop)])
blk = np.convolve((blk > 0.02).astype(np.float32), np.ones(8), "same").clip(0, 1)  # 80 ms lookahead/hold
g = np.zeros_like(blk)
for i in range(1, len(blk)):
    a = 0.35 if blk[i] > g[i - 1] else 0.04  # ~30 ms attack, ~250 ms release
    g[i] = g[i - 1] + a * (blk[i] - g[i - 1])
duck = 10 ** (DUCK_DB * np.repeat(g, hop)[: len(m)] / 20)
mix = m * duck[:, None] + (v * 1.25)[:, None]
mix /= max(1.0, np.abs(mix).max() / 0.97)
wavfile.write("public/mix_raw.wav", sr, mix.astype(np.float32))
print(f"voice mixed, music ducked {DUCK_DB} dB under speech")
