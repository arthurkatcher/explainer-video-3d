# .venv/bin/python gen_music.py  -> public/music.wav
# Score + sound design, all synthesized from code, locked to the same timeline.json the video reads.
import json, numpy as np
from scipy.signal import butter, sosfilt, sosfilt_zi, fftconvolve

T = json.load(open('src/timeline.json'))
SR = 48000
DUR = T['duration']
N = int(SR * DUR)
BEAT = 60 / T['bpm']
rng = np.random.default_rng(7)

def mtof(m): return 440.0 * 2 ** ((m - 69) / 12)
def tt(n): return np.arange(n) / SR
def bus(): return np.zeros((2, N))

def add(b, at, sig, gain=1.0, pan=0.0):
    """mix mono or stereo sig into bus b at time `at` (seconds), equal-power pan"""
    i = int(at * SR)
    if i >= N: return
    if sig.ndim == 1:
        l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
        sig = np.vstack([sig * l * 1.414, sig * r * 1.414])
    n = min(sig.shape[1], N - i)
    b[:, i:i + n] += gain * sig[:, :n]

def filt(x, kind, f, order=2):
    sos = butter(order, f, kind, fs=SR, output='sos')
    return sosfilt(sos, x, axis=-1)

def sweep_filter(x, kind, f_curve, order=2, block=512):
    """time-varying butterworth: f_curve(t_seconds_array) -> cutoff per block"""
    x = np.atleast_2d(x)
    out = np.zeros_like(x)
    zi = None
    for s in range(0, x.shape[1], block):
        f = float(np.clip(f_curve(s / SR), 30, SR / 2 - 500))
        sos = butter(order, f, kind, fs=SR, output='sos')
        if zi is None: zi = np.stack([sosfilt_zi(sos) * 0 for _ in range(x.shape[0])], axis=1)
        out[:, s:s + block], zi = sosfilt(sos, x[:, s:s + block], axis=-1, zi=zi)
    return out

def saw(f, n, phase=0.0):
    ph = (phase + np.cumsum(np.full(n, f) if np.isscalar(f) else f) / SR) % 1.0
    return 2 * ph - 1

def env_adsr(n, a=0.01, d=0.1, s=0.7, r=0.2):
    e = np.ones(n) * s
    na, nd, nr = int(a * SR), int(d * SR), int(r * SR)
    na = min(na, n); e[:na] = np.linspace(0, 1, na)
    nd = min(nd, n - na); e[na:na + nd] = np.linspace(1, s, nd)
    nr = min(nr, n); e[n - nr:] *= np.linspace(1, 0, nr)
    return e

def expdec(n, tau): return np.exp(-tt(n) / tau)

# ---------------- instruments ----------------
def kick(amp=1.0):
    n = int(0.5 * SR); t = tt(n)
    f = 45 + 110 * np.exp(-t / 0.035)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.28)
    click = filt(rng.standard_normal(n), 'highpass', 2000) * np.exp(-t / 0.004) * 0.35
    return np.tanh((body + click) * 1.6) * amp

def clap():
    n = int(0.4 * SR); t = tt(n)
    nz = filt(rng.standard_normal(n), 'bandpass', [900, 3200])
    e = np.zeros(n)
    for k, o in enumerate([0, 0.011, 0.022]):
        i = int(o * SR); e[i:] += np.exp(-(t[:n - i]) / (0.012 if k < 2 else 0.14))
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t / 0.05) * 0.4
    return (nz * e + tone) * 0.6

def hat(open_=False):
    n = int((0.35 if open_ else 0.08) * SR); t = tt(n)
    nz = filt(rng.standard_normal(n), 'highpass', 7500, 4)
    return nz * np.exp(-t / (0.11 if open_ else 0.022)) * 0.5

def bass_note(m, dur, bright=500):
    n = int(dur * SR); f = mtof(m)
    x = 0.8 * np.sin(2 * np.pi * f * tt(n)) + 0.45 * filt(saw(f, n) + saw(f * 1.005, n), 'lowpass', bright)
    return np.tanh(x * 1.3) * env_adsr(n, 0.004, 0.08, 0.75, 0.05)

def pluck(m, dur=0.22, cutoff=3500):
    n = int(dur * SR); f = mtof(m); t = tt(n)
    x = 0.6 * saw(f, n) + 0.4 * np.sign(np.sin(2 * np.pi * f * t)) * 0.5
    x = sweep_filter(x, 'lowpass', lambda s: 300 + cutoff * np.exp(-s / 0.06), block=256)[0]
    return x * np.exp(-t / 0.09)

def bell(m, dur=1.4, idx=2.5):
    n = int(dur * SR); t = tt(n); f = mtof(m)
    mod = np.sin(2 * np.pi * f * 3.5 * t) * idx * np.exp(-t / 0.25)
    return np.sin(2 * np.pi * f * t + mod) * np.exp(-t / (dur / 3.5)) * env_adsr(n, 0.002, 0.01, 1, 0.05)

def pad_chord(notes, dur, detune_c=9):
    n = int(dur * SR)
    out = np.zeros((2, n))
    for m in notes:
        for k, d in enumerate([-detune_c, 0, detune_c]):
            f = mtof(m) * 2 ** (d / 1200)
            v = saw(f, n, phase=rng.random())
            pan = [-0.7, 0, 0.7][k]
            out[0] += v * np.cos((pan + 1) * np.pi / 4); out[1] += v * np.sin((pan + 1) * np.pi / 4)
    return out / (len(notes) * 2.2) * env_adsr(n, 0.35, 0.3, 0.85, 0.6)

def noise_sweep(dur, f0, f1, shape='rise'):
    n = int(dur * SR); t = tt(n)
    x = rng.standard_normal((2, n))
    x = sweep_filter(x, 'bandpass', lambda s: 0, block=512) if False else x
    y = np.zeros_like(x)
    zi = None
    for s in range(0, n, 512):
        p = s / n
        fc = f0 * (f1 / f0) ** p
        sos = butter(2, [fc * 0.7, min(fc * 1.4, SR / 2 - 1000)], 'bandpass', fs=SR, output='sos')
        if zi is None: zi = np.zeros((sos.shape[0], 2, 2))
        y[:, s:s + 512], zi = sosfilt(sos, x[:, s:s + 512], axis=-1, zi=zi)
    e = (t / dur) ** 2.2 if shape == 'rise' else np.sin(np.pi * t / dur) ** 2
    return y * e

def impact(size=1.0):
    n = int(2.5 * SR); t = tt(n)
    f = 32 + 40 * np.exp(-t / 0.08)
    boom = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / (0.9 * size))
    crash = filt(rng.standard_normal(n), 'lowpass', 5000) * np.exp(-t / 0.35) * 0.35
    return np.tanh((boom * 1.2 + crash) * 1.4) * 0.8

def click(amp=1.0):
    n = int(0.03 * SR); t = tt(n)
    return (filt(rng.standard_normal(n), 'bandpass', [1800, 6000]) * np.exp(-t / 0.004) + np.sin(2 * np.pi * 2400 * t) * np.exp(-t / 0.003) * 0.3) * amp

def blip(m, dur=0.12):
    n = int(dur * SR); t = tt(n); f = mtof(m)
    return (np.sin(2 * np.pi * f * t) + 0.3 * np.sin(2 * np.pi * f * 2 * t)) * np.exp(-t / (dur / 4))

def thud(m):
    n = int(0.45 * SR); t = tt(n); f = mtof(m) * (1 + 0.6 * np.exp(-t / 0.02))
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t / 0.12)
    nz = filt(rng.standard_normal(n), 'lowpass', 1800) * np.exp(-t / 0.03) * 0.4
    return np.tanh((body + nz) * 1.5)

def buzz():
    n = int(0.4 * SR); t = tt(n)
    f = 98 * (1 - 0.15 * t / 0.4)
    x = np.sign(np.sin(2 * np.pi * np.cumsum(f) / SR)) + np.sign(np.sin(2 * np.pi * np.cumsum(f * 1.02) / SR))
    return filt(x, 'lowpass', 1400) * env_adsr(n, 0.005, 0.05, 0.8, 0.12) * 0.35

def downsweep(dur=0.8):
    n = int(dur * SR); t = tt(n)
    f = 900 * (60 / 900) ** (t / dur)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * t / dur) ** 0.5 * 0.6

def reverb_ir(sec=2.4, damp=5500):
    n = int(sec * SR); t = tt(n)
    ir = rng.standard_normal((2, n)) * np.exp(-t / (sec / 6.5))
    ir = filt(ir, 'lowpass', damp)
    ir[:, :int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))
    return ir / np.sqrt((ir ** 2).sum(axis=1, keepdims=True)) * 0.9

def verb(b, sec=2.4):
    ir = reverb_ir(sec)
    return np.vstack([fftconvolve(b[0], ir[0])[:N], fftconvolve(b[1], ir[1])[:N]])

def pingpong(b, delay=3 * BEAT / 4, fb=0.38, taps=5):
    out = np.zeros_like(b); d = int(delay * SR)
    for k in range(1, taps + 1):
        src = b[(k + 1) % 2] if k % 2 else b[k % 2]
        ch = k % 2
        if k * d < N: out[ch, k * d:] += src[:N - k * d] * fb ** k
    return filt(out, 'lowpass', 4000)

# ---------------- score: "How an AI chip works" (160s, 120 BPM, D minor) ----------------
CH = {'Dm': ([57, 62, 65], 38), 'Bb': ([58, 62, 65], 34), 'F': ([57, 60, 65], 41), 'C': ([55, 60, 64], 36)}
PROG = ['Dm', 'Bb', 'F', 'C']
def chord_at(t): return CH[PROG[int(t // 2) % 4]]
S = {s['id']: (s['start'], s['end']) for s in T['scenes']}
DROP1, DROP2 = S['pkg'][0], S['mm'][0]

def in_any(t, spans): return any(a <= t < b for a, b in spans)
KICK = [(12, 60), (62, 100), (116, 127.9), (128.4, 134)]
FULL = [(62, 100), (116, 134)]          # claps + open hats + rolling bass
drums, bass, pads, arp, sfx, bells = bus(), bus(), bus(), bus(), bus(), bus()

kick_times = [t for t in np.arange(12, 146, BEAT) if in_any(t, KICK)]
kick_times += [t for t in np.arange(134, 146, 2 * BEAT)]          # half-time pulse under the transistor
for k in kick_times: add(drums, k, kick(1.0 if in_any(k, FULL) else 0.85))
side = np.ones(N)
for k in kick_times:
    i = int(k * SR); n = min(int(0.3 * SR), N - i)
    side[i:i + n] = np.minimum(side[i:i + n], 1 - 0.6 * np.exp(-tt(n) / 0.07))
side = filt(side, 'lowpass', 60, 1)

for bar in np.arange(30, 146, 2.0):
    for off in (BEAT, 3 * BEAT):
        at = bar + off
        if in_any(at, [(30, 60), (62, 100), (116, 127.9), (128.4, 134)]): add(drums, at, clap(), 0.5 if in_any(at, FULL) else 0.35, 0.05)
for t in np.arange(12, 146, BEAT / 2):
    off = abs((t / BEAT) % 1 - 0.5) < 1e-6
    if not in_any(t, [(12, 60), (62, 100), (116, 146)]): continue
    if off: add(drums, t, hat(in_any(t, FULL)), 0.42 if in_any(t, FULL) else 0.4, 0.3)
    elif t >= 30: add(drums, t, hat(), 0.18, -0.25)
for t in np.arange(128.4, 134, BEAT / 4): add(drums, t, hat(), 0.16, 0.45 * np.sin(t * 7))
for t in np.arange(142.4, 146, BEAT / 4): add(drums, t, hat(), 0.08 + 0.18 * (t - 142.4) / 3.6, 0.4)
# snare rolls into both drops
for d in (DROP1, DROP2):
    t, step, roll = d - 2.0, 0.25, []
    while t < d - 0.05:
        roll.append(t); t += step
        if t >= d - 1.0: step = 0.0625
        elif t >= d - 1.5: step = 0.125
    for i, r in enumerate(roll): add(drums, r, clap(), 0.15 + 0.45 * i / len(roll), 0.1)

# bass
for t in np.arange(12, 146, BEAT / 2):
    _, root = chord_at(t)
    offbeat = abs((t / BEAT) % 1 - 0.5) < 1e-6
    if in_any(t, FULL):
        add(bass, t, bass_note(root + 12, 0.2, 900), 0.55)
        add(bass, t + BEAT / 4, bass_note(root + 12 + (7 if int(t * 4) % 3 == 0 else 0), 0.1, 900), 0.32)
    elif in_any(t, [(12, 60)]) and offbeat:
        add(bass, t, bass_note(root + 12, 0.22, 420 + 12 * max(0, t - 12)), 0.6)
    elif in_any(t, [(134, 146)]) and abs(t % 1.0) < 1e-6:
        add(bass, t, bass_note(root, 0.9, 260), 0.6)
for bt in np.arange(100, 116, 2.0):
    add(bass, bt, bass_note(chord_at(bt)[1], 1.9, 220), 0.45)
add(bass, T['final'], bass_note(38, 4.0, 300), 0.6)

# pads with story-shaped filter
for bt in np.arange(0, 160, 2.0):
    if bt >= T['final'] - 0.1: break
    notes, _ = chord_at(bt)
    add(pads, bt, pad_chord(notes + [notes[0] + 12] if in_any(bt, FULL) else notes, 2.6), 0.5)
add(pads, T['final'], pad_chord([50, 57, 62, 65, 69, 74], 4.6, 12), 0.75)
def pad_cut(s):
    if s < 12: return 450 + 90 * s
    if s < 60: return 1500 + 35 * (s - 12)
    if s < 62: return 3200 + 1800 * (s - 60)
    if s < 100: return 6500
    if s < 116: return 1400 + 120 * (s - 100)
    if s < 134: return 7000
    if s < 146: return 1600 + 250 * (s - 134)
    if s < MON_END: return 4500 + 800 * (s - 146)
    if s < T['final']: return 1200
    return 3500
MON_END = T['montage']['at'] + T['montage']['step'] * len(T['montage']['shots'])
pads = sweep_filter(pads, 'lowpass', pad_cut)

# arp
ARP = [0, 1, 2, 3, 2, 1, 0, 2]
for i, t in enumerate(np.arange(16, 146, BEAT / 4)):
    if in_any(t, [(60, 62), (127.9, 128.4)]): continue
    sixteenths = in_any(t, [(30, 60)] + FULL + [(100, 116)])
    if not sixteenths and i % 2: continue
    notes, _ = chord_at(t)
    ladder = notes + [notes[0] + 12]
    m = ladder[ARP[i % 8]] + (24 if in_any(t, [(100, 116)]) else 12)
    cut = 5000 if in_any(t, FULL) else 2600 if t < 60 else 3200
    add(arp, t, pluck(m, 0.2, cut), 0.26 if t < 60 else 0.32, pan=0.35 * np.sin(i * 0.9))
arp_wet = pingpong(arp)

# ---------------- sound design, locked to the picture ----------------
add(sfx, 0.0, impact(0.9), 0.55)
for i, w in enumerate(T['titleWords']): add(bells, w, bell([62, 65, 69, 72, 74][i], 1.6, 1.6), 0.2, [-0.4, -0.2, 0, 0.2, 0.4][i])
add(bells, T['subtitle'], bell(81, 1.4, 1.0), 0.12)
add(sfx, T['titleOut'] - 0.4, noise_sweep(0.8, 300, 3000, 'swell'), 0.22)
add(sfx, T['promptIn'], noise_sweep(0.5, 800, 4000, 'swell'), 0.15)
nchar = len(T['prompt'])
for k in range(nchar):
    at = T['typeStart'] + (T['typeEnd'] - T['typeStart']) * k / nchar + rng.uniform(-0.01, 0.01)
    add(sfx, at, click(rng.uniform(0.5, 0.9)), 0.5, rng.uniform(-0.15, 0.15))
add(sfx, T['enter'], thud(62) * 0.6 + np.pad(click(1.0), (0, int(0.45 * SR) - int(0.03 * SR))), 0.6)
# warp: whoosh + riser into the data center
add(sfx, T['enter'], noise_sweep(4.3, 200, 12000, 'rise'), 0.55)
wt = tt(int(4.3 * SR)); add(sfx, T['enter'], np.sin(2 * np.pi * np.cumsum(120 * 6 ** (wt / 4.3)) / SR) * (wt / 4.3) ** 2 * 0.25, 0.45)
cuts = [s['start'] for s in T['scenes'][1:]]
for c in cuts:
    big = c in (DROP1, DROP2, 12)
    add(sfx, c, impact(1.2 if big else 0.7), 0.85 if big else 0.4)
    if not big: add(sfx, c - 0.6, noise_sweep(0.6, 500, 7000, 'rise'), 0.28)
# data center: orb push
add(sfx, T['dcPush'], noise_sweep(2.8, 300, 6000, 'rise'), 0.3)
# rack: orbit whooshes, coolant swell
for w in (T['rackOrbitBack'], 44.0): add(sfx, w, noise_sweep(1.8, 400, 2500, 'swell'), 0.25, 0.3)
add(sfx, T['rackCool'], filt(noise_sweep(3.0, 200, 900, 'swell'), 'lowpass', 1200), 0.4, -0.3)
add(sfx, T['traySlide'], noise_sweep(1.6, 900, 3000, 'swell'), 0.3)
add(sfx, T['traySlide'] + 2.2, thud(45), 0.5)
# tray: plate lift, riser into the drop
up = tt(int(1.6 * SR)); add(sfx, T['lift'], np.sin(2 * np.pi * np.cumsum(80 * 5 ** (up / 1.6)) / SR) * np.sin(np.pi * up / 1.6) * 0.4, 0.5)
add(bells, T['lift'] + 1.4, bell(74, 1.6, 2.0), 0.2)
add(sfx, T['dive'] - 0.2, noise_sweep(2.6, 300, 12000, 'rise'), 0.55)
# package
add(sfx, 62.6, downsweep(0.8) * 0.4, 0.3)
c0, c1 = T['counter']
for k in range(int((c1 - c0) / 0.04)): add(sfx, c0 + k * 0.04, click(0.35), 0.18, 0.2)
add(sfx, c0, impact(1.0), 0.6); add(bells, c1, bell(86, 1.6, 1.4), 0.22)
for i in range(9): add(bells, T['explode'] + i * 0.14, blip(62 + [0, 3, 5, 7, 10, 12, 15, 17, 19][i], 0.12), 0.16, -0.5 + i / 8)
add(sfx, 80.2, downsweep(1.2), 0.4)
# memory wall: the numbers, the flood, the counter
for k in range(24): add(sfx, 82.8 + k * 0.2 + rng.uniform(0, 0.1), blip(84 + int(rng.integers(0, 12)), 0.05), 0.05, rng.uniform(-0.7, 0.7))
add(sfx, T['flowOn'] - 1.2, noise_sweep(1.2, 400, 8000, 'rise'), 0.35)
for k in range(140): add(sfx, T['flowOn'] + k * 0.037, blip(88 + int(rng.integers(0, 10)), 0.035), 0.035 + 0.02 * np.sin(k), rng.uniform(-0.8, 0.8))
t0, t1 = T['tbCounter']
for k in range(int((t1 - t0) / 0.045)): add(sfx, t0 + k * 0.045, click(0.35), 0.16, -0.2)
add(sfx, t0, impact(0.9), 0.5); add(bells, t1, bell(81, 1.6, 1.4), 0.2)
# die: shimmer on the wave, whoosh into the SM, riser into drop 2
for k in range(12): add(bells, T['smWave'] + k * 0.35, bell([74, 77, 81, 84][k % 4], 1.2, 1.0), 0.09, -0.6 + 0.1 * k)
add(sfx, T['smZoom'], noise_sweep(2.0, 300, 5000, 'swell'), 0.3)
for i in range(4): add(bells, T['smZoom'] + 0.6 + i * 0.25, bell(69 + 5 * i, 1.4, 2.5), 0.16)
add(sfx, 113.4, noise_sweep(2.6, 300, 12000, 'rise'), 0.55)
# tensor core: one note per k-layer, then the sum
for k in range(8): add(bells, T['mmStart'] + k * T['mmLayerStep'], bell([62, 65, 69, 72, 74, 77, 81, 84][k], 0.9, 2.2), 0.24, -0.4 + 0.1 * k)
add(sfx, T['mmSum'], noise_sweep(0.9, 6000, 400, 'swell'), 0.3)
add(sfx, T['mmSum'] + 0.9, thud(50), 0.55)
for k, m in enumerate([74, 77, 81, 86]): add(bells, T['mmSum'] + 1.0 + k * 0.06, bell(m, 1.8, 1.2), 0.2, -0.3 + 0.2 * k)
for k in range(int((134 - T['mmFast']) / 0.06)): add(sfx, T['mmFast'] + k * 0.06, blip(86 + int(rng.integers(0, 14)), 0.04), 0.035, rng.uniform(-0.9, 0.9))
# transistor: every gate flip is audible
on = False
for g in T['gateToggles']:
    on = not on
    add(sfx, g, click(1.0), 0.6, 0.1); add(bells, g, blip(81 if on else 69, 0.12), 0.35 if on else 0.2)
k = 0
while T['gateFast'] + k * 0.125 < 146:
    at = T['gateFast'] + k * 0.125
    add(sfx, at, click(0.6), 0.3, 0.3 * np.sin(k)); add(bells, at, blip(81 if k % 2 == 0 else 69, 0.06), 0.1); k += 1
add(sfx, 142.4, noise_sweep(3.6, 300, 12000, 'rise'), 0.45)
# montage: a whoosh per cut, reverse swell into the answer
for i in range(len(T['montage']['shots'])):
    at = T['montage']['at'] + i * T['montage']['step']
    add(sfx, at, noise_sweep(0.5, 2000 + 800 * i, 9000, 'swell'), 0.3, -0.5 + i / 6)
    add(sfx, at, thud(38 + 3 * i), 0.3)
add(sfx, MON_END - 1.2, noise_sweep(1.2, 500, 10000, 'rise'), 0.4)
add(sfx, MON_END, impact(0.7), 0.4)
words = T['answer'].split(' ')
for i in range(len(words)): add(bells, T['answerStart'] + (T['answerEnd'] - T['answerStart']) * i / len(words), blip(79 + (i * 3) % 10, 0.06), 0.08, rng.uniform(-0.3, 0.3))
add(sfx, T['final'] - 1.0, noise_sweep(1.0, 800, 10000, 'rise'), 0.4)
add(sfx, T['final'], impact(1.6), 0.95)
for k, m in enumerate([62, 65, 69, 74, 77, 81]): add(bells, T['final'] + 0.55 + k * 0.11, bell(m, 2.4, 1.0), 0.14, -0.5 + 0.2 * k)
add(bells, T['finalSub'], bell(86, 2.5, 0.8), 0.12)

# ---------------- mix ----------------
music = bass * side * 0.95 + pads * side * 1.1 + arp * side * 2.0 + arp_wet * side
mix = drums * 0.5 + music + sfx * 0.7 + bells * 0.9
wet = verb(pads * 0.35 + arp * 0.4 + bells * 0.9 + sfx * 0.25 + drums * 0.06, 2.8)
mix = filt(mix + wet * 0.5, 'highpass', 28)
mix *= np.clip((DUR - tt(N)) / 1.4, 0, 1)
mix = np.tanh(mix / np.max(np.abs(mix)) * 1.6) / np.tanh(1.6) * 0.89
for name, b in [('drums', drums), ('bass', bass), ('pads', pads), ('arp', arp), ('sfx', sfx), ('bells', bells)]:
    print(f'{name:6s} rms {np.sqrt((b ** 2).mean()):.3f} peak {np.abs(b).max():.2f}')
import wave
pcm = (np.clip(mix.T, -1, 1) * 32767).astype('<i2')
with wave.open('public/music_raw.wav', 'wb') as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print('wrote public/music_raw.wav', mix.shape[1] / SR, 's')
