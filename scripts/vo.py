"""Narration: a TTS model on OpenRouter reads every caption at its caption time -> public/vo.wav
usage: .venv/bin/python vo.py      (needs OPENROUTER_API_KEY in the environment or in .env)
timeline.json: captions[].say = spoken form when it differs from the on-screen text ("120 kW" -> "a hundred and twenty kilowatts");
voice = {model, narrator, duckDb, extra: [{at, text, voice?}]} for lines with no caption (title, a second speaker, the ending).
"""
import hashlib, json, os, subprocess, urllib.request
from pathlib import Path
import numpy as np
from scipy.io import wavfile

HERE = Path.cwd()
SR = 24000
T = json.loads((HERE / "src" / "timeline.json").read_text())
V = T.get("voice", {})
MODEL = V.get("model", "x-ai/grok-voice-tts-1.0")
NARRATOR = V.get("narrator", "eve")
CACHE = HERE / "out" / "vo-cache"


def key():
    if os.environ.get("OPENROUTER_API_KEY"):
        return os.environ["OPENROUTER_API_KEY"]
    for line in (HERE / ".env").read_text().splitlines():
        if line.startswith("OPENROUTER_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("OPENROUTER_API_KEY missing (env or .env)")


def lines():
    out = [{"at": c["at"] + 0.1, "text": c.get("say", c["text"])} for c in T["captions"]]
    out += [dict(e) for e in V.get("extra", [])]
    out.sort(key=lambda l: l["at"])
    for i, l in enumerate(out):  # room = time until the next line starts
        nxt = out[i + 1]["at"] if i + 1 < len(out) else T["duration"]
        l["room"] = nxt - l["at"] - 0.2
    return out


def tts(text, voice, speed=1.0):
    """OpenRouter /audio/speech -> float32 mono 24 kHz, cached per (model, voice, text); speed via atempo."""
    CACHE.mkdir(parents=True, exist_ok=True)
    f = CACHE / (hashlib.sha1(f"{MODEL}|{voice}|{text}".encode()).hexdigest()[:16] + ".mp3")
    if not f.exists():
        body = json.dumps({"model": MODEL, "input": text, "voice": voice, "response_format": "mp3"}).encode()
        req = urllib.request.Request("https://openrouter.ai/api/v1/audio/speech", body,
                                     {"Authorization": f"Bearer {key()}", "Content-Type": "application/json"})
        f.write_bytes(urllib.request.urlopen(req, timeout=120).read())
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(f), "-af", f"atempo={speed}", "-f", "f32le",
                          "-ac", "1", "-ar", str(SR), "-"], capture_output=True, check=True).stdout
    a = np.frombuffer(raw, np.float32).copy()
    nz = np.nonzero(np.abs(a) > 0.01)[0]  # trim silence at both ends
    return a[max(0, nz[0] - 240): nz[-1] + 2400] if len(nz) else a


def main():
    vo = np.zeros(int(T["duration"] * SR), np.float32)
    for l in lines():
        v, speed = l.get("voice", NARRATOR), 1.0
        a = tts(l["text"], v)
        if len(a) / SR > l["room"]:  # squeeze up to 18%, beyond that it runs over: shorten the line instead
            speed = round(min(1.18, len(a) / SR / l["room"]), 3)
            a = tts(l["text"], v, speed)
        i = int(l["at"] * SR)
        a = a[: len(vo) - i]
        vo[i: i + len(a)] += a
        flag = "  OVER, shorten it" if len(a) / SR > l["room"] + 0.1 else ""
        print(f"{l['at']:6.1f}s  {len(a) / SR:4.1f}/{l['room']:4.1f}s  x{speed:.2f}  {v:6s} {l['text']}{flag}")
    vo *= 0.89 / max(1e-6, np.abs(vo).max())
    wavfile.write(HERE / "public" / "vo.wav", SR, vo)


if __name__ == "__main__":
    main()
