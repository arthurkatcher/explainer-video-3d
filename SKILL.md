---
name: explainer-video-3d
description: Make a 2-3 minute narrated 3D explainer ("how X works", zooming from the whole system down to its smallest part) entirely in code - Remotion + three.js for the picture, a numpy synth for the score, a TTS voice for the narration - rendered to mp4 on a laptop. Use when asked for a 3D explainer, a documentary-style "how X works" video, a zoom from big to small, or a narrated deep dive.
---

# explainer-video-3d

Every frame and every note is code. One `timeline.json` drives the picture, the score and the narration, so cuts, hits and spoken lines always land together. `reference/` is a finished 2:40 video, "How an AI chip works" (data center -> rack -> tray -> GPU -> memory -> die -> tensor core -> transistor). Read it before writing anything, copy its patterns, replace its content.

## The story shape that works
- **A question goes in, the camera follows it down.** Open with something everyone does (typing a question), then fly into the machine behind it. The viewer is travelling, not reading.
- **One level per scene, 12-20 s each, each ~10x smaller than the last.** A log scale ruler on the side (100 m ... 50 nm) and a chapter label make the depth feel real.
- **Each level gets one physical action and one number**: a tray slides out, a cold plate lifts, memory stacks explode apart, a counter runs to 208 billion. Numbers are real public specs, never invented.
- **At the bottom, the one idea that explains everything** in plain words ("Multiply two grids of numbers. Add up the results. That's what AI is, underneath.").
- **Reverse montage back up** (0.75 s per level), the answer to the opening question types out, one-line thesis ("All of that. For every single word.").
- Captions: plain words, one accent phrase each. The narrator reads the captions, so write them to be spoken.

## Workflow
1. `scripts/new.sh <dir>`: Remotion + three.js project + venv, seeded with the reference.
2. Storyboard in `src/timeline.json`: scenes with `scale`, captions with `at`/`until`, a time for every event. Put cuts on the beat grid (120 BPM = 0.5 s).
3. `src/Video.tsx`: each world is a pure function of `t`. Camera = Catmull-Rom through keyframes (`keys(t, [[time, [x,y,z, lx,ly,lz, fov]], ...])`). Only procedural geometry and `CanvasTexture`s, no model files.
4. `gen_music.py`: score locked to the timeline (build, drop when the hero object appears, near-silence for the quiet level, second drop, half-time at the bottom). Every event gets a sound: impacts on cuts, ticks on counters, blips per layer, clicks on switches, whooshes in the montage.
5. Narration (optional): put `OPENROUTER_API_KEY` in `.env`, set `voice` in the timeline (model, narrator voice, extra lines such as a second speaker asking the question). `vo.py` reads each caption at its time, checks it fits before the next one and squeezes up to 18% if not; `mix_vo.py` ducks the music ~9 dB under speech. Lines are cached, so re-runs are free. Check the words with any Whisper before shipping.
6. QA before the full render: `node stills.mjs <frames...>` and look at `out/contact.png` (blown-out bloom, black frames, unreadable text). Fix, repeat. After rendering, scan per-frame brightness (ffmpeg `signalstats`) for black frames.
7. `scripts/render.sh`: music -> narration -> loudnorm -14 LUFS -> 1080p30 render -> `out/video.mp4` + `out/spectrum.png`. About 7 min for 2:40 on a laptop iGPU (concurrency 3). `SKIP_VIDEO=1` re-mixes audio onto the last render.

## three.js inside Remotion: the traps (all hit and fixed)
- **Render with a real GPU**: `Config.setChromiumOpenGlRenderer('angle')` in `remotion.config.ts` (and `chromiumOptions: {gl: 'angle'}` for stills). The default swiftshader fails to create a WebGL context. `npx remotion` then also wants a `tsconfig.json`.
- **During rendering ThreeCanvas uses `frameloop="never"` and calls `advance()` in a passive effect.** Put camera moves and instance matrix updates in `useLayoutEffect`, or the frame renders one step stale. `useFrame` never runs.
- **EffectComposer (bloom) draws black on its first pass after mount**, so the first frame of every render chunk comes out black. Fix: the `WarmUp` component in the reference (`delayRender`, two delayed `advance()` calls, then `continueRender`).
- **Glow = `meshBasicMaterial toneMapped={false}` with colors above 1** (`color.multiplyScalar(4)`), bloom threshold ~0.8. Keep everything else below 1, or bloom washes the frame white. Dim the glows 3-5x from your first guess.
- Thousands of repeated things (racks, LEDs, cores, particles, transistors) = one `instancedMesh` with per-instance colors, updated in `useLayoutEffect`.
- Reflections: `RoomEnvironment` through `PMREMGenerator`, cached once per renderer. `FogExp2` per world hides the edge of the world and gives depth.
- Cuts: a short zoom-blur plus a radial flash hides the world swap. Mount only the current world.

## Rules
- No stock footage, no AI video or music generators, no model files, no external assets except Google Fonts. The voice is the one thing that comes from a model.
- Facts on screen must be true public specs. Keep brand names and logos off screen.
- Receipts for the post: wall-clock time, lines of code, render time. Say only what is true.
