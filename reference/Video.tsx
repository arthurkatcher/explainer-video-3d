import React, {useEffect, useLayoutEffect, useMemo, useRef} from 'react';
import {AbsoluteFill, Easing, continueRender, delayRender, interpolate, useCurrentFrame} from 'remotion';
import {ThreeCanvas} from '@remotion/three';
import {useThree} from '@react-three/fiber';
import * as THREE from 'three';
import {RoomEnvironment} from 'three/examples/jsm/environments/RoomEnvironment.js';
import {EffectComposer, Bloom, Vignette} from '@react-three/postprocessing';
import {loadFont as loadInter} from '@remotion/google-fonts/Inter';
import {loadFont as loadMono} from '@remotion/google-fonts/JetBrainsMono';
import T from './timeline.json';

const {fontFamily: SANS} = loadInter('normal', {weights: ['400', '500', '600', '700', '800'], subsets: ['latin']});
const {fontFamily: MONO} = loadMono('normal', {weights: ['400', '500', '700'], subsets: ['latin']});

// ---------- palette ----------
const BG = '#04060A';
const FG = '#F4F6F8';
const MUTED = '#8A93A0';
const ACC = '#3DF5C8';
const HOT = '#FFB547';

// ---------- time helpers ----------
const EO = Easing.bezier(0.16, 1, 0.3, 1);
const EIO = Easing.bezier(0.65, 0, 0.35, 1);
const EIN = Easing.bezier(0.55, 0, 1, 0.45);
const prog = (t: number, at: number, dur: number, ease = EO) =>
  interpolate(t, [at, at + dur], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease});
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const blurIf = (px: number) => (px > 0.05 ? `blur(${px}px)` : undefined);
const frac = (x: number) => x - Math.floor(x);
const rnd = (i: number) => frac(Math.sin(i * 127.1 + 311.7) * 43758.5453);
const PI = Math.PI;

// ---------- camera keys: Catmull-Rom through [time, values] ----------
type Key = [number, number[]];
const cr = (p0: number, p1: number, p2: number, p3: number, u: number) =>
  0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (-p0 + 3 * p1 - 3 * p2 + p3) * u * u * u);
const keys = (t: number, K: Key[]): number[] => {
  const n = K.length;
  if (t <= K[0][0]) return K[0][1];
  if (t >= K[n - 1][0]) return K[n - 1][1];
  let i = 0;
  while (t >= K[i + 1][0]) i++;
  const u = (t - K[i][0]) / (K[i + 1][0] - K[i][0]);
  const a = K[Math.max(0, i - 1)][1], b = K[i][1], c = K[i + 1][1], d = K[Math.min(n - 1, i + 2)][1];
  return b.map((_, j) => cr(a[j], b[j], c[j], d[j], u));
};
// orbit keys: [a, r, y, lookX, lookY, lookZ] -> camera
const orbit = (v: number[]) => ({p: [Math.sin(v[0]) * v[1] + v[3], v[2], Math.cos(v[0]) * v[1] + v[5]], l: [v[3], v[4], v[5]]});

// ---------- scene routing ----------
const SC = T.scenes;
const MON = T.montage;
const MON_END = MON.at + MON.step * MON.shots.length;
type View = {scene: string; st: number; cutStart: number; cutEnd: number; montage?: boolean};
const viewAt = (t: number): View => {
  if (t >= MON.at && t < MON_END) {
    const i = Math.floor((t - MON.at) / MON.step);
    const s0 = MON.at + i * MON.step;
    return {scene: MON.shots[i].scene, st: MON.shots[i].t + (t - s0) * 0.9, cutStart: s0, cutEnd: s0 + MON.step, montage: true};
  }
  if (t >= MON_END) return {scene: 'end', st: t, cutStart: MON_END, cutEnd: 999};
  const s = SC.find((x) => t < x.end) ?? SC[SC.length - 1];
  return {scene: s.id, st: t, cutStart: s.start, cutEnd: s.end};
};
const METERS: Record<string, number> = {'100 m': 100, '2 m': 2, '50 cm': 0.5, '10 cm': 0.1, '1 cm': 0.01, '1 mm': 0.001, '10 µm': 1e-5, '50 nm': 5e-8};
const scalePos = (s: string) => Math.log10(100 / METERS[s]);
const SCALE_STEPS: [number, number][] = (() => {
  const out: [number, number][] = [];
  for (const s of SC) if (s.scale) out.push([s.start, scalePos(s.scale)]);
  MON.shots.forEach((sh, i) => out.push([MON.at + i * MON.step, scalePos(SC.find((x) => x.id === sh.scene)!.scale)]));
  return out;
})();
const scaleAt = (t: number) => {
  let v = SCALE_STEPS[0][1];
  for (let i = 1; i < SCALE_STEPS.length; i++) {
    const [at, to] = SCALE_STEPS[i];
    if (t < at) break;
    const d = i >= SC.filter((s) => s.scale).length ? 0.3 : 1.1;
    v = lerp(v, to, prog(t, at, d, EIO));
  }
  return v;
};

// ---------- procedural textures ----------
const canvasTex = (w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]) => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const tx = new THREE.CanvasTexture(c);
  tx.colorSpace = THREE.SRGBColorSpace;
  tx.anisotropy = 8;
  if (repeat) {
    tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
    tx.repeat.set(repeat[0], repeat[1]);
  }
  return tx;
};
const dieTexture = () =>
  canvasTex(512, 680, (g) => {
    g.fillStyle = '#0a0e14';
    g.fillRect(0, 0, 512, 680);
    const m = 26, band = 64, cw = (512 - 2 * m) / 8, ch = (680 - 2 * m - band) / 10;
    for (let r = 0; r < 10; r++)
      for (let c = 0; c < 8; c++) {
        const x = m + c * cw, y = m + r * ch + (r >= 5 ? band : 0);
        g.fillStyle = '#131a23';
        g.fillRect(x + 3, y + 3, cw - 6, ch - 6);
        g.strokeStyle = '#1f2b38';
        g.lineWidth = 1;
        g.strokeRect(x + cw / 2, y + 3, 0.5, ch - 6);
        g.strokeRect(x + 3, y + ch / 2, cw - 6, 0.5);
        g.fillStyle = 'rgba(61,245,200,0.75)';
        for (const [qx, qy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) g.fillRect(x + 8 + qx * (cw / 2 - 3), y + 8 + qy * (ch / 2 - 3), 9, 9);
      }
    g.fillStyle = '#0e1822';
    g.fillRect(m, m + 5 * ch + 6, 512 - 2 * m, band - 12);
    for (let x = m; x < 512 - m; x += 4) {
      g.fillStyle = x % 16 === 0 ? 'rgba(77,163,255,0.5)' : 'rgba(40,70,100,0.6)';
      g.fillRect(x, m + 5 * ch + 10, 2, band - 20);
    }
    g.fillStyle = 'rgba(255,181,71,0.55)';
    for (let y = m; y < 680 - m; y += 10) {
      g.fillRect(6, y, 12, 4);
      g.fillRect(494, y, 12, 4);
    }
  });
const smTexture = () =>
  canvasTex(256, 256, (g) => {
    g.fillStyle = '#0d131b';
    g.fillRect(0, 0, 256, 256);
    for (const [qx, qy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const x = 10 + qx * 122, y = 10 + qy * 122;
      g.fillStyle = '#16202c';
      g.fillRect(x, y, 114, 114);
      g.fillStyle = '#233447';
      g.fillRect(x + 6, y + 6, 102, 22);
      g.fillStyle = 'rgba(120,150,180,0.55)';
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) g.fillRect(x + 8 + i * 13, y + 36 + j * 13, 9, 9);
      g.fillStyle = 'rgba(255,181,71,0.95)';
      g.fillRect(x + 64, y + 38, 40, 40);
      g.fillStyle = 'rgba(61,245,200,0.8)';
      g.fillRect(x + 8, y + 92, 96, 10);
    }
  });
const floorTexture = (rep: number) =>
  canvasTex(256, 256, (g) => {
    g.fillStyle = '#080b10';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = '#141a22';
    g.lineWidth = 3;
    g.strokeRect(0, 0, 256, 256);
    g.fillStyle = '#0b0f15';
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) if ((i + j) % 2) g.fillRect(8 + i * 30, 8 + j * 30, 4, 4);
  }, [rep, rep]);
const rackFaceTexture = () =>
  canvasTex(128, 512, (g) => {
    g.fillStyle = '#07090c';
    g.fillRect(0, 0, 128, 512);
    for (let k = 0; k < 30; k++) {
      const y = 14 + k * 16.3;
      g.fillStyle = k % 7 === 3 ? '#1a2029' : '#11161d';
      g.fillRect(6, y, 116, 12);
      g.fillStyle = '#05070a';
      for (let x = 30; x < 118; x += 6) g.fillRect(x, y + 3, 3, 6);
    }
  });
const trayFace = (kind: 'compute' | 'switch' | 'power') =>
  canvasTex(512, 64, (g) => {
    g.fillStyle = kind === 'power' ? '#15191f' : '#0c0f14';
    g.fillRect(0, 0, 512, 64);
    if (kind === 'compute') {
      g.fillStyle = '#030406';
      for (let x = 70; x < 440; x += 9) for (let y = 12; y < 54; y += 9) g.fillRect(x + ((y / 9) % 2) * 4, y, 5, 5);
      g.fillStyle = '#3df5c8';
      g.fillRect(16, 26, 30, 8);
      g.fillStyle = '#2a313b';
      g.fillRect(460, 14, 34, 36);
    } else if (kind === 'switch') {
      for (let i = 0; i < 18; i++) {
        g.fillStyle = '#20262f';
        g.fillRect(40 + i * 25, 16, 20, 32);
        g.fillStyle = '#050608';
        g.fillRect(43 + i * 25, 20, 14, 24);
      }
      g.fillStyle = '#4da3ff';
      g.fillRect(12, 28, 16, 8);
    } else {
      g.fillStyle = '#0a0c10';
      for (let x = 20; x < 490; x += 7) g.fillRect(x, 10, 3, 44);
      g.fillStyle = '#39d353';
      g.fillRect(494, 28, 8, 8);
    }
  });
const boardTexture = () =>
  canvasTex(512, 840, (g) => {
    g.fillStyle = '#07120e';
    g.fillRect(0, 0, 512, 840);
    for (let i = 0; i < 260; i++) {
      g.strokeStyle = i % 9 === 0 ? 'rgba(201,162,74,0.35)' : 'rgba(40,110,80,0.35)';
      g.lineWidth = i % 9 === 0 ? 2 : 1;
      let x = rnd(i) * 512, y = rnd(i + 500) * 840;
      g.beginPath();
      g.moveTo(x, y);
      for (let s = 0; s < 4; s++) {
        if (s % 2) x += (rnd(i * 7 + s) - 0.5) * 220;
        else y += (rnd(i * 5 + s) - 0.5) * 220;
        g.lineTo(x, y);
      }
      g.stroke();
    }
  });
const labelTexture = (text: string, color: string) =>
  canvasTex(512, 128, (g) => {
    g.font = `700 64px ${SANS}, sans-serif`;
    g.fillStyle = color;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.letterSpacing = '8px';
    g.fillText(text, 256, 64);
  });

// ---------- 3D infrastructure ----------
const envCache = new WeakMap<THREE.WebGLRenderer, THREE.Texture>();
const Env: React.FC<{intensity?: number; bg?: string; fog?: number}> = ({intensity = 0.6, bg = BG, fog = 0}) => {
  const {gl, scene} = useThree();
  useLayoutEffect(() => {
    let tx = envCache.get(gl);
    if (!tx) {
      const p = new THREE.PMREMGenerator(gl);
      tx = p.fromScene(new RoomEnvironment(), 0.04).texture;
      envCache.set(gl, tx);
    }
    scene.environment = tx;
    scene.environmentIntensity = intensity;
    scene.background = new THREE.Color(bg);
    scene.fog = fog > 0 ? new THREE.FogExp2(bg, fog) : null;
  });
  return null;
};
const Cam: React.FC<{p: number[]; l: number[]; fov?: number}> = ({p, l, fov = 40}) => {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  useLayoutEffect(() => {
    camera.position.set(p[0], p[1], p[2]);
    camera.fov = fov;
    camera.near = 0.02;
    camera.far = 900;
    camera.updateProjectionMatrix();
    camera.lookAt(l[0], l[1], l[2]);
  });
  return null;
};
type InstFn = (i: number, o: THREE.Object3D, c: THREE.Color) => void;
const Inst: React.FC<{n: number; fn: InstFn; color?: boolean; children: React.ReactNode}> = ({n, fn, color, children}) => {
  const ref = useRef<THREE.InstancedMesh>(null!);
  const o = useMemo(() => new THREE.Object3D(), []);
  const c = useMemo(() => new THREE.Color(), []);
  useLayoutEffect(() => {
    const m = ref.current;
    for (let i = 0; i < n; i++) {
      o.position.set(0, 0, 0);
      o.rotation.set(0, 0, 0);
      o.scale.set(1, 1, 1);
      c.setRGB(1, 1, 1);
      fn(i, o, c);
      o.updateMatrix();
      m.setMatrixAt(i, o.matrix);
      if (color) m.setColorAt(i, c);
    }
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, n]} frustumCulled={false}>
      {children}
    </instancedMesh>
  );
};
const Glow: React.FC = () => <meshBasicMaterial toneMapped={false} />;
const Lights: React.FC<{key1?: number; rim?: string}> = ({key1 = 2.2, rim = '#6fb7ff'}) => (
  <>
    <ambientLight intensity={0.22} />
    <directionalLight position={[6, 10, 5]} intensity={key1} />
    <directionalLight position={[-7, 4, -6]} intensity={0.9} color={rim} />
  </>
);
const Floor: React.FC<{y?: number; size?: number; rep?: number}> = ({y = 0, size = 80, rep = 40}) => {
  const tex = useMemo(() => floorTexture(rep), [rep]);
  return (
    <mesh rotation-x={-PI / 2} position-y={y}>
      <planeGeometry args={[size, size]} />
      <meshStandardMaterial map={tex} color="#39414b" metalness={0.5} roughness={0.5} />
    </mesh>
  );
};

// ---------- the GPU package (units: cm) ----------
const HX = [-1.6, -0.53, 0.53, 1.6];
const HZ = [-2.0, 2.0];
const LAYERS = 9;
const Package: React.FC<{t: number; dieGlow?: number; flow?: number; explode?: number; seam?: number}> = ({t, dieGlow = 0.5, flow = 0.2, explode = 0, seam = 0.4}) => {
  const tex = useMemo(dieTexture, []);
  const ex = (s: number) => Math.max(0, Math.min(1, explode * 1.5 - s * 0.06));
  const layerY = (s: number, i: number) => 0.34 + i * (0.05 + ex(s) * 0.2);
  return (
    <group>
      {/* substrate + stiffener + caps */}
      <mesh position={[0, 0.11, 0]}>
        <boxGeometry args={[6.6, 0.22, 7.2]} />
        <meshStandardMaterial color="#10201a" metalness={0.25} roughness={0.55} />
      </mesh>
      {[[0, 3.35, 6.4, 0.3], [0, -3.35, 6.4, 0.3], [3.05, 0, 0.3, 6.4], [-3.05, 0, 0.3, 6.4]].map(([x, z, w, d], i) => (
        <mesh key={i} position={[x, 0.28, z]}>
          <boxGeometry args={[w, 0.12, d]} />
          <meshStandardMaterial color="#b9c0c8" metalness={1} roughness={0.25} />
        </mesh>
      ))}
      <Inst n={64} color fn={(i, o, c) => {
        const side = i % 4, k = Math.floor(i / 4);
        const along = -2.2 + (k / 15) * 4.4;
        o.position.set(side < 2 ? along : (side === 2 ? 2.62 : -2.62), 0.25, side < 2 ? (side === 0 ? 2.95 : -2.95) : along * 1.1);
        o.rotation.y = side < 2 ? 0 : PI / 2;
        c.set(k % 3 ? '#8a6d3b' : '#9ca3ab');
      }}>
        <boxGeometry args={[0.14, 0.07, 0.24]} />
        <meshStandardMaterial metalness={0.7} roughness={0.4} />
      </Inst>
      {/* interposer */}
      <mesh position={[0, 0.27, 0]}>
        <boxGeometry args={[4.6, 0.1, 5.4]} />
        <meshStandardMaterial color="#3a4048" metalness={0.9} roughness={0.32} />
      </mesh>
      {/* two dies */}
      {[-1.07, 1.07].map((x) => (
        <mesh key={x} position={[x, 0.38, 0]}>
          <boxGeometry args={[2.05, 0.12, 2.7]} />
          <meshStandardMaterial color="#1b2029" metalness={0.85} roughness={0.2} map={tex} emissiveMap={tex} emissive={ACC} emissiveIntensity={dieGlow} />
        </mesh>
      ))}
      <mesh position={[0, 0.45, 0]}>
        <boxGeometry args={[0.05, 0.02, 2.5]} />
        <meshBasicMaterial color={new THREE.Color(ACC).multiplyScalar(0.5 + seam * 2)} toneMapped={false} />
      </mesh>
      {/* 8 HBM stacks, 9 layers each */}
      <Inst n={8 * LAYERS} fn={(i, o) => {
        const s = Math.floor(i / LAYERS), l = i % LAYERS;
        o.position.set(HX[s % 4], layerY(s, l), HZ[s >> 2]);
      }}>
        <boxGeometry args={[0.95, 0.044, 1.1]} />
        <meshStandardMaterial color="#262d37" metalness={0.9} roughness={0.28} />
      </Inst>
      {/* through-silicon vias, visible when exploded */}
      <Inst n={8 * 9} color fn={(i, o, c) => {
        const s = Math.floor(i / 9), v = i % 9;
        const h = layerY(s, LAYERS - 1) - layerY(s, 0);
        o.position.set(HX[s % 4] + ((v % 3) - 1) * 0.28, layerY(s, 0) + h / 2, HZ[s >> 2] + (Math.floor(v / 3) - 1) * 0.32);
        const e = ex(s);
        o.scale.set(e > 0.02 ? 1 : 0, Math.max(0.001, h), e > 0.02 ? 1 : 0);
        c.setRGB(2.4 * e, 1.5 * e, 0.4 * e);
      }}>
        <cylinderGeometry args={[0.018, 0.018, 1, 6]} />
        <Glow />
      </Inst>
      {/* data flowing from memory into the dies */}
      <Inst n={420} color fn={(i, o, c) => {
        const s = i % 8;
        const sp = 0.35 + 0.35 * rnd(i + 99);
        const f = frac(rnd(i) + t * sp * (0.3 + flow * 1.5));
        const sx = HX[s % 4], sz = HZ[s >> 2];
        const ex_ = (sx < 0 ? -1.07 : 1.07) + (rnd(i + 7) - 0.5) * 1.5, ez = sz * 0.15 + (rnd(i + 13) - 0.5) * 1.8;
        const y0 = layerY(s, LAYERS - 1) + 0.05;
        const q = 1 - f;
        const mx = (sx + ex_) / 2, mz = (sz + ez) / 2, my = 1.1 + rnd(i + 3) * 0.5;
        o.position.set(q * q * sx + 2 * q * f * mx + f * f * ex_, q * q * y0 + 2 * q * f * my + f * f * 0.46, q * q * sz + 2 * q * f * mz + f * f * ez);
        const sc = flow * Math.pow(Math.sin(PI * f), 0.5);
        o.scale.setScalar(Math.max(0.0001, sc));
        const w = rnd(i + 21);
        c.setRGB(0.15 + w * 1.1, 1.9, 1.5 - w * 0.8);
      }}>
        <sphereGeometry args={[0.024, 8, 6]} />
        <Glow />
      </Inst>
    </group>
  );
};

// ---------- worlds ----------
const Warp: React.FC<{t: number}> = ({t}) => {
  const u = t - T.enter;
  let dist = 0;
  const speed = (x: number) => 6 + 140 * prog(x, 0.1, 1.4, EIN) * (1 - prog(x, 3.2, 1.2, EIO) * 0.8);
  for (let k = 0; k < 60; k++) dist += (speed((u * k) / 60) * u) / 60;
  const v = speed(u);
  const orbZ = -3 - u * 16 - Math.max(0, u - 0.6) * 35;
  return (
    <>
      <Env intensity={0.2} />
      <Cam p={[0, 0, 0]} l={[0, 0, -10]} fov={50} />
      <Inst n={900} color fn={(i, o, c) => {
        const th = rnd(i) * 2 * PI, rad = 1.2 + rnd(i + 1) * 26;
        const z = -(((rnd(i + 2) * 500 - dist) % 500) + 500) % 500 - 2;
        o.position.set(Math.cos(th) * rad, Math.sin(th) * rad, z);
        o.scale.set(1, 1, 0.3 + v * 0.09);
        const a = rnd(i + 3);
        const k = 0.5 + 2.4 * Math.min(1, v / 60);
        c.setRGB((a < 0.2 ? 1.6 : 0.4) * k, (a < 0.2 ? 1.6 : 1.9) * k, (a < 0.2 ? 1.6 : 1.6) * k);
      }}>
        <boxGeometry args={[0.035, 0.035, 1]} />
        <Glow />
      </Inst>
      <mesh position={[0, -0.05, orbZ]}>
        <sphereGeometry args={[0.16, 24, 16]} />
        <meshBasicMaterial color={new THREE.Color(ACC).multiplyScalar(6)} toneMapped={false} />
      </mesh>
    </>
  );
};

const IntroWorld: React.FC<{t: number; end?: boolean}> = ({t, end}) => {
  if (!end && t >= T.enter) return <Warp t={t} />;
  const out = end ? 0 : prog(t, T.titleOut, 2.4, EIO);
  const a = 0.75 + t * 0.14;
  const r = end ? 10.5 : lerp(9.4, 16, out);
  const glow = end ? 0.5 + 0.9 * prog(t, T.final, 1.2) : 0.35 + 0.8 * prog(t, 0.3, 1.5);
  return (
    <>
      <Env intensity={0.55} fog={0.035} />
      <Lights />
      <Cam p={[Math.sin(a) * r, end ? 5.2 : lerp(4.4, 8, out), Math.cos(a) * r]} l={[0, end ? 0 : lerp(-1.7, -0.5, out), 0]} fov={34} />
      <pointLight position={[0, 3, 0]} intensity={4} color={ACC} distance={10} />
      <Package t={t} dieGlow={glow} flow={0.35} seam={0.8} />
      <Floor y={0} size={120} rep={40} />
    </>
  );
};

// data center (units: m)
const DC_ROWS = 5, DC_N = 50, DC_PITCH = 0.62;
const rackX = (side: number, r: number) => side * (1.25 + r * 2.9);
const rackZ = (n: number) => 2 - n * DC_PITCH;
const TARGET = {x: rackX(-1, 0) + 0.556, y: 1.25, z: rackZ(27)};
const DCWorld: React.FC<{t: number}> = ({t}) => {
  const faceTex = useMemo(rackFaceTexture, []);
  const {p, l} = (() => {
    const v = keys(t, [
      [12, [0, 5.4, 7, 0, 1.0, -12]],
      [16, [0.2, 3.2, 3, 0, 1.4, -14]],
      [20, [-0.3, 1.8, -1, 0, 1.5, -16]],
      [24, [0.25, 1.65, -5.5, 0, 1.5, -20]],
      [27, [0.1, 1.6, -9, -0.3, 1.4, -15]],
      [29.2, [0.35, 1.35, -14.1, TARGET.x, 1.3, TARGET.z]],
      [30, [0.05, 1.28, TARGET.z, TARGET.x, 1.28, TARGET.z]],
    ]);
    return {p: v.slice(0, 3), l: v.slice(3)};
  })();
  const push = prog(t, T.dcPush, 2.6, EIO);
  const orb = [lerp(p[0] - 0.1, TARGET.x, push), lerp(1.45, TARGET.y + 0.05, push), lerp(p[2] - 3.4, TARGET.z, push)];
  const N = 2 * DC_ROWS * DC_N;
  const led = 24;
  return (
    <>
      <Env intensity={0.45} fog={0.052} />
      <Lights key1={1.2} />
      <Cam p={p} l={l} fov={46} />
      {/* rack bodies */}
      <Inst n={N} fn={(i, o) => {
        const side = i % 2 ? 1 : -1, r = Math.floor(i / 2) % DC_ROWS, n = Math.floor(i / (2 * DC_ROWS));
        o.position.set(rackX(side, r), 1.1, rackZ(n));
      }}>
        <boxGeometry args={[1.1, 2.2, 0.6]} />
        <meshStandardMaterial color="#0d1117" metalness={0.8} roughness={0.35} />
      </Inst>
      {/* rack faces */}
      <Inst n={N} color fn={(i, o, c) => {
        const side = i % 2 ? 1 : -1, r = Math.floor(i / 2) % DC_ROWS, n = Math.floor(i / (2 * DC_ROWS));
        o.position.set(rackX(side, r) - side * 0.556, 1.1, rackZ(n));
        o.rotation.y = -side * PI / 2;
        const k = 0.8 + 0.4 * rnd(i);
        c.setRGB(k, k, k);
      }}>
        <planeGeometry args={[0.56, 2.12]} />
        <meshBasicMaterial map={faceTex} toneMapped={false} />
      </Inst>
      {/* blinking LEDs on the two inner rows */}
      <Inst n={2 * 2 * DC_N * led} color fn={(i, o, c) => {
        const k = i % led, rk = Math.floor(i / led);
        const side = rk % 2 ? 1 : -1, r = Math.floor(rk / 2) % 2, n = Math.floor(rk / 4);
        o.position.set(rackX(side, r) - side * 0.562, 0.2 + k * 0.078, rackZ(n) - 0.22 * side * (k % 2 ? 1 : 0.85));
        const rate = 1.5 + rnd(i) * 5;
        const on = rnd(i * 3 + Math.floor(t * rate)) > 0.3;
        const amber = rnd(i + 5) < 0.06;
        const b = on ? 2.8 : 0.15;
        if (amber) c.setRGB(b * 1.4, b * 0.8, b * 0.15);
        else c.setRGB(b * 0.25, b * 1.3, b * 1.05);
      }}>
        <boxGeometry args={[0.012, 0.012, 0.03]} />
        <Glow />
      </Inst>
      {/* ceiling: light strips, cable ladders, coolant pipes */}
      {[-5.8, -2.9, 0, 2.9, 5.8].map((x) => (
        <mesh key={x} position={[x, 3.4, -12]}>
          <boxGeometry args={[0.09, 0.03, 70]} />
          <meshBasicMaterial color={new THREE.Color(1.0, 1.25, 1.3)} toneMapped={false} />
        </mesh>
      ))}
      {[-1.25, 1.25, -4.15, 4.15].map((x) => (
        <mesh key={x} position={[x, 2.55, -12]}>
          <boxGeometry args={[0.42, 0.05, 70]} />
          <meshStandardMaterial color="#9a7a2a" metalness={0.7} roughness={0.45} />
        </mesh>
      ))}
      {[-1.7, 1.7].map((x) => (
        <mesh key={x} position={[x, 2.85, -12]} rotation-x={PI / 2}>
          <cylinderGeometry args={[0.07, 0.07, 70, 16]} />
          <meshStandardMaterial color="#1f4fbf" metalness={0.6} roughness={0.3} emissive="#0b2a70" emissiveIntensity={0.6} />
        </mesh>
      ))}
      <Floor y={0} size={90} rep={150} />
      {/* the question, travelling */}
      <mesh position={orb as [number, number, number]}>
        <sphereGeometry args={[0.07, 20, 14]} />
        <meshBasicMaterial color={new THREE.Color(ACC).multiplyScalar(7)} toneMapped={false} />
      </mesh>
      <pointLight position={orb as [number, number, number]} intensity={5} distance={5} color={ACC} />
    </>
  );
};

// one NVL72-style rack (units: m)
type Slot = {kind: 'compute' | 'switch' | 'power'; y: number; h: number};
const SLOTS: Slot[] = (() => {
  const order: Slot['kind'][] = [
    'power', 'power', ...Array(8).fill('compute'), ...Array(9).fill('switch'), ...Array(10).fill('compute'), 'power', 'power',
  ];
  const H = {power: 0.09, compute: 0.058, switch: 0.045};
  let y = 0.1;
  return order.map((k) => {
    const s = {kind: k, y: y + H[k] / 2, h: H[k] - 0.005};
    y += H[k] + 0.001;
    return s;
  });
})();
const TRAY_I = SLOTS.length - 2 - 4; // 4th compute tray from the top
const TY = SLOTS[TRAY_I].y;
const RackWorld: React.FC<{t: number}> = ({t}) => {
  const faces = useMemo(() => ({compute: trayFace('compute'), switch: trayFace('switch'), power: trayFace('power')}), []);
  const v = keys(t, [
    [30, [0.8, 3.5, 1.9, 0, 1.15, 0]],
    [34, [0.45, 2.9, 1.55, 0, 1.1, 0]],
    [38, [1.8, 2.6, 1.45, 0, 1.2, -0.2]],
    [41, [2.75, 2.0, 1.5, 0, 1.2, -0.4]],
    [44, [2.3, 1.45, 0.95, 0, 0.9, -0.4]],
    [46.2, [0.5, 1.8, TY + 0.25, 0, TY, 0.3]],
    [48, [0.12, 0.75, TY + 0.12, 0, TY, 0.8]],
  ]);
  const {p, l} = orbit(v);
  const slide = prog(t, T.traySlide, 2.4, EIO) * 0.75;
  const cool = 0.35 + 0.65 * prog(t, T.rackCool, 1.0);
  const nv = 0.5 + 0.5 * prog(t, T.rackOrbitBack, 1.5);
  const computes = SLOTS.map((s, i) => ({...s, i})).filter((s) => s.kind === 'compute');
  return (
    <>
      <Env intensity={0.6} fog={0.06} />
      <Lights key1={1.8} />
      <Cam p={p} l={l} fov={38} />
      <pointLight position={[0, 1.2, -2.2]} intensity={8} distance={6} color={ACC} />
      {/* frame */}
      {[[-0.31, -0.61], [0.31, -0.61], [-0.31, 0.61], [0.31, 0.61]].map(([x, z], i) => (
        <mesh key={i} position={[x, 1.1, z]}>
          <boxGeometry args={[0.04, 2.24, 0.04]} />
          <meshStandardMaterial color="#20252d" metalness={0.9} roughness={0.3} />
        </mesh>
      ))}
      {[0.05, 2.2].map((y) => (
        <mesh key={y} position={[0, y, 0]}>
          <boxGeometry args={[0.66, 0.06, 1.26]} />
          <meshStandardMaterial color="#161a20" metalness={0.8} roughness={0.35} />
        </mesh>
      ))}
      {/* trays */}
      {SLOTS.map((s, i) => {
        const z = i === TRAY_I ? slide : 0;
        return (
          <group key={i} position={[0, s.y, z]}>
            <mesh>
              <boxGeometry args={[0.56, s.h, 1.14]} />
              <meshStandardMaterial color="#12161c" metalness={0.85} roughness={0.35} />
            </mesh>
            <mesh position={[0, 0, 0.571]}>
              <planeGeometry args={[0.56, s.h]} />
              <meshStandardMaterial map={faces[s.kind]} emissiveMap={faces[s.kind]} emissive="#ffffff" emissiveIntensity={1.5} metalness={0.3} roughness={0.5} />
            </mesh>
          </group>
        );
      })}
      {/* NVLink spine: cable bundles on the back */}
      <Inst n={48} fn={(i, o) => {
        const b = Math.floor(i / 12), k = i % 12;
        o.position.set(-0.21 + b * 0.14 + ((k % 4) - 1.5) * 0.013, 1.05, -0.63 - Math.floor(k / 4) * 0.013);
        o.scale.set(1, 1.75, 1);
      }}>
        <cylinderGeometry args={[0.006, 0.006, 1, 6]} />
        <meshStandardMaterial color="#1a1d22" metalness={0.4} roughness={0.5} />
      </Inst>
      <Inst n={240} color fn={(i, o, c) => {
        const b = i % 4, dir = i % 2 ? 1 : -1;
        const f = frac(rnd(i) + t * (0.25 + rnd(i + 3) * 0.35) * dir);
        o.position.set(-0.21 + b * 0.14 + (rnd(i + 9) - 0.5) * 0.04, 0.2 + f * 1.7, -0.655);
        o.scale.setScalar(nv);
        c.setRGB(0.5 * nv, 3 * nv, 2.4 * nv);
      }}>
        <sphereGeometry args={[0.009, 8, 6]} />
        <Glow />
      </Inst>
      {/* coolant manifolds + hoses */}
      {[-0.25, 0.25].map((x) => (
        <mesh key={x} position={[x, 1.08, -0.68]}>
          <cylinderGeometry args={[0.028, 0.028, 1.9, 16]} />
          <meshStandardMaterial color={x < 0 ? '#1e4fd0' : '#3b82f6'} metalness={0.5} roughness={0.3} emissive="#0b3aa0" emissiveIntensity={cool * 0.9} />
        </mesh>
      ))}
      <Inst n={computes.length * 2} fn={(i, o) => {
        const s = computes[Math.floor(i / 2)];
        o.position.set(i % 2 ? 0.25 : -0.25, s.y, -0.62);
        o.rotation.x = PI / 2;
        o.scale.set(1, 0.12, 1);
      }}>
        <cylinderGeometry args={[0.009, 0.009, 1, 8]} />
        <meshStandardMaterial color="#2c5fe0" metalness={0.3} roughness={0.4} />
      </Inst>
      <Inst n={160} color fn={(i, o, c) => {
        const side = i % 2, dir = side ? 1 : -1;
        const f = frac(rnd(i) + t * 0.4 * dir);
        o.position.set(side ? 0.25 : -0.25, 0.15 + f * 1.86, -0.68 + (rnd(i + 4) > 0.5 ? 0.024 : -0.024));
        o.scale.set(1, 2.4, 1);
        c.setRGB(0.3 * cool, 1.2 * cool, 3.6 * cool);
      }}>
        <sphereGeometry args={[0.008, 8, 6]} />
        <Glow />
      </Inst>
      <Floor y={0} size={40} rep={60} />
    </>
  );
};

// one compute tray (units: 10 cm)
const GPUS = [[-1.3, -1.6], [1.3, -1.6], [-1.3, 1.2], [1.3, 1.2]];
const CPUS = [[0, -1.6], [0, 1.2]];
const TrayWorld: React.FC<{t: number}> = ({t}) => {
  const board = useMemo(boardTexture, []);
  const {p, l} = (() => {
    const v = keys(t, [
      [48, [6.5, 7.8, 8.5, 0, 0, 0.3]],
      [52.5, [4.6, 6.2, 6.8, 0, 0, 0]],
      [56, [3.8, 3.4, 5.0, 0.4, 0.2, 0.2]],
      [58.8, [3.0, 2.9, 3.9, 1.3, 0.3, 1.2]],
      [60.4, [1.9, 1.6, 2.3, 1.3, 0.15, 1.2]],
      [62, [1.42, 0.55, 1.5, 1.3, 0.1, 1.2]],
    ]);
    return {p: v.slice(0, 3), l: v.slice(3)};
  })();
  const lift = prog(t, T.lift, 2.0, EIO);
  const curves = useMemo(() => {
    const cs: THREE.CatmullRomCurve3[] = [];
    for (const z of [-1.6, 1.2]) {
      const pts = [[-0.5, -3.6], [-1.3, z], [0, z], [1.3, z], [0.5, -3.6]];
      for (let k = 0; k < pts.length - 1; k++) {
        const [x0, z0] = pts[k], [x1, z1] = pts[k + 1];
        const a = new THREE.Vector3(x0 + (k === 0 ? 0 : 0.35), k === 0 ? 0.3 : 0.5, z0 + (k === 0 ? 0 : -0.3));
        const b = new THREE.Vector3(x1 - (k === pts.length - 2 ? 0 : 0.35), k === pts.length - 2 ? 0.3 : 0.5, z1 + (k === pts.length - 2 ? 0 : -0.3));
        const m = a.clone().lerp(b, 0.5);
        m.y = 1.0;
        cs.push(new THREE.CatmullRomCurve3([a, m, b]));
      }
    }
    return cs;
  }, []);
  const tubes = useMemo(() => curves.map((c) => new THREE.TubeGeometry(c, 40, 0.07, 10, false)), [curves]);
  return (
    <>
      <Env intensity={0.5} />
      <Lights key1={1.9} />
      <Cam p={p} l={l} fov={38} />
      <pointLight position={[0, 3, 0]} intensity={3} distance={10} color="#8fd8ff" />
      {/* pan + board */}
      <mesh position={[0, -0.06, 0]}>
        <boxGeometry args={[4.8, 0.06, 8.2]} />
        <meshStandardMaterial color="#8d949c" metalness={0.95} roughness={0.35} />
      </mesh>
      {[-2.4, 2.4].map((x) => (
        <mesh key={x} position={[x, 0.15, 0]}>
          <boxGeometry args={[0.05, 0.45, 8.2]} />
          <meshStandardMaterial color="#8d949c" metalness={0.95} roughness={0.35} />
        </mesh>
      ))}
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[4.5, 0.08, 7.6]} />
        <meshStandardMaterial map={board} emissiveMap={board} emissive="#ffffff" emissiveIntensity={0.35} metalness={0.3} roughness={0.6} />
      </mesh>
      {/* front panel + rear connectors */}
      <mesh position={[0, 0.2, 4.08]}>
        <boxGeometry args={[4.8, 0.5, 0.08]} />
        <meshStandardMaterial color="#0e1116" metalness={0.8} roughness={0.35} />
      </mesh>
      <Inst n={10} fn={(i, o) => o.position.set(-2 + i * 0.44, 0.14, -3.95)}>
        <boxGeometry args={[0.34, 0.2, 0.3]} />
        <meshStandardMaterial color="#c9a24a" metalness={1} roughness={0.3} />
      </Inst>
      {[-0.5, 0.5].map((x) => (
        <mesh key={x} position={[x, 0.2, -3.6]}>
          <boxGeometry args={[0.5, 0.35, 0.4]} />
          <meshStandardMaterial color="#26468f" metalness={0.8} roughness={0.3} />
        </mesh>
      ))}
      {/* small parts: VRMs and caps */}
      <Inst n={160} color fn={(i, o, c) => {
        const g = GPUS[i % 4];
        const k = Math.floor(i / 4);
        const side = k % 4;
        const along = ((Math.floor(k / 4) % 10) - 4.5) * 0.15;
        const off = 0.95 + (k % 2) * 0.12;
        o.position.set(g[0] + (side < 2 ? along : (side === 2 ? off : -off)), 0.07, g[1] + (side < 2 ? (side === 0 ? off : -off) : along));
        c.set(k % 3 ? '#2a2f36' : '#6b5a3a');
      }}>
        <boxGeometry args={[0.1, 0.07, 0.1]} />
        <meshStandardMaterial metalness={0.6} roughness={0.5} />
      </Inst>
      {/* the GPU under the lifted plate */}
      <group position={[1.3, 0.04, 1.2]} scale={0.2}>
        <Package t={t} dieGlow={0.4 + lift * 1.2} flow={lift * 0.6} seam={lift} />
      </group>
      {/* cold plates */}
      {GPUS.map(([x, z], i) => {
        const isT = i === 3;
        return (
          <group key={i} position={[x, 0.3 + (isT ? lift * 2.4 : 0), z]} rotation={[isT ? -lift * 0.25 : 0, 0, isT ? lift * 0.2 : 0]}>
            <mesh>
              <boxGeometry args={[1.55, 0.3, 1.55]} />
              <meshStandardMaterial color="#aeb6bf" metalness={1} roughness={0.22} />
            </mesh>
            {[-0.35, 0.35].map((dx) => (
              <mesh key={dx} position={[dx, 0.22, -0.3]}>
                <cylinderGeometry args={[0.1, 0.1, 0.18, 14]} />
                <meshStandardMaterial color="#c9a24a" metalness={1} roughness={0.25} />
              </mesh>
            ))}
          </group>
        );
      })}
      {CPUS.map(([x, z], i) => (
        <mesh key={i} position={[x, 0.24, z]}>
          <boxGeometry args={[0.9, 0.22, 1.1]} />
          <meshStandardMaterial color="#9aa2ab" metalness={1} roughness={0.26} />
        </mesh>
      ))}
      {/* coolant hoses + flow */}
      {tubes.map((g, i) => {
        const hide = i >= 6 && (i === 6 || i === 7) ? lift : 0;
        return (
          <mesh key={i} geometry={g}>
            <meshStandardMaterial color="#2a6cf0" metalness={0.2} roughness={0.35} emissive="#0b2a7a" emissiveIntensity={0.7} transparent opacity={1 - hide} />
          </mesh>
        );
      })}
      <Inst n={curves.length * 16} color fn={(i, o, c) => {
        const ci = Math.floor(i / 16);
        const hide = ci === 6 || ci === 7 ? lift : 0;
        const f = frac(rnd(i) + t * 0.45);
        o.position.copy(curves[ci].getPointAt(f));
        o.scale.setScalar(1 - hide);
        c.setRGB(0.5, 1.8, 4.2);
      }}>
        <sphereGeometry args={[0.055, 8, 6]} />
        <Glow />
      </Inst>
    </>
  );
};

const PkgWorld: React.FC<{t: number}> = ({t}) => {
  const {p, l} = orbit(keys(t, [
    [62, [0.95, 12.5, 7.0, 0, 0, 0]],
    [67, [0.55, 10, 5.6, 0, 0.2, 0]],
    [72.6, [0.1, 8.6, 4.3, 0, 0.4, 0.3]],
    [77, [-0.35, 7.2, 3.3, 0, 0.8, 0.6]],
    [82, [-0.7, 7.8, 3.6, 0, 0.6, 0.4]],
  ]));
  const explode = prog(t, T.explode, 1.8, EIO) * (1 - prog(t, 80.2, 1.4, EIO));
  const cnt = prog(t, T.counter[0], 0.3) * (1 - prog(t, T.counter[1], 1.4, EIO));
  return (
    <>
      <Env intensity={0.6} fog={0.03} />
      <Lights />
      <Cam p={p} l={l} fov={36} />
      <pointLight position={[0, 3, 0]} intensity={4} color={ACC} distance={10} />
      <Package t={t} dieGlow={0.55 + cnt * 1.6} flow={0.3} explode={explode} seam={0.5 + 2 * prog(t, 62.6, 0.8) * (1 - prog(t, 67.2, 0.8))} />
      <Floor y={0} size={120} rep={40} />
    </>
  );
};

const MemWorld: React.FC<{t: number}> = ({t}) => {
  const v = keys(t, [
    [82, [2.4, 2.2, 6.4, 0.5, 0.4, 1.2]],
    [88, [1.3, 1.45, 4.9, 0.5, 0.45, 1.0]],
    [93.6, [0.2, 2.8, 6.4, 0, 0.4, 0.6]],
    [100, [-0.8, 5.2, 5.2, 0, 0.4, 0.2]],
  ]);
  const flow = 0.18 + 0.82 * prog(t, T.flowOn, 1.4);
  return (
    <>
      <Env intensity={0.6} fog={0.04} />
      <Lights key1={1.8} />
      <Cam p={v.slice(0, 3)} l={v.slice(3)} fov={40} />
      <pointLight position={[0, 2, 1]} intensity={3} color={ACC} distance={8} />
      <Package t={t} dieGlow={0.5 + flow * (0.8 + 0.3 * Math.sin(t * 9))} flow={flow} seam={0.8} />
      <Floor y={0} size={120} rep={40} />
    </>
  );
};

// one die (units: 1 mm, die ~ 20 x 27)
const smX = (c: number) => (c - 3.5) * 2.35;
const smZ = (r: number) => (r - 4.5) * 2.3 + (r >= 5 ? 1.25 : -1.25);
const TSM = {c: 5, r: 2};
const TX = smX(TSM.c), TZ = smZ(TSM.r);
const DieWorld: React.FC<{t: number}> = ({t}) => {
  const sm = useMemo(smTexture, []);
  const v = keys(t, [
    [100, [0, 31, 25, 0, 0, 1]],
    [104, [3, 26, 19.5, 0, 0, 0]],
    [108, [5, 20, 14, 1, 0, -1]],
    [110.4, [6.5, 14, 8.5, TX, 0, TZ]],
    [113, [TX + 1.8, 4.4, TZ + 3.7, TX, 0.4, TZ]],
    [116, [TX + 0.5, 1.7, TZ + 1.15, TX, 0.5, TZ]],
  ]);
  const tc = prog(t, T.smZoom + 0.6, 1.2);
  return (
    <>
      <Env intensity={0.6} fog={0.012} />
      <Lights key1={1.6} />
      <Cam p={v.slice(0, 3)} l={v.slice(3)} fov={42} />
      <mesh position={[0, 0, 0]}>
        <boxGeometry args={[20.6, 0.4, 27.4]} />
        <meshStandardMaterial color="#12171e" metalness={0.9} roughness={0.25} />
      </mesh>
      <Inst n={80} fn={(i, o) => o.position.set(smX(i % 8), 0.34, smZ(Math.floor(i / 8)))}>
        <boxGeometry args={[2.1, 0.28, 2.05]} />
        <meshStandardMaterial color="#19212b" metalness={0.8} roughness={0.3} />
      </Inst>
      <Inst n={80} color fn={(i, o, c) => {
        const cx = i % 8, r = Math.floor(i / 8);
        o.position.set(smX(cx), 0.485, smZ(r));
        o.rotation.x = -PI / 2;
        const d = Math.hypot(cx + 1, r + 1) * 2.35;
        const tw = 0.25 * rnd(i * 13 + Math.floor(t * 3));
        const wave = t > T.smWave ? 1.7 * Math.exp(-Math.pow(((d - (t - T.smWave) * 14) % 34 + 34) % 34 - 17, 2) / 10) : 0;
        const tgt = cx === TSM.c && r === TSM.r ? prog(t, T.smZoom, 0.8) * 0.8 : 0;
        const k = 0.45 + tw + wave + tgt;
        c.setRGB(k, k, k);
      }}>
        <planeGeometry args={[2.0, 1.95]} />
        <meshBasicMaterial map={sm} toneMapped={false} />
      </Inst>
      {/* L2 cache band */}
      <mesh position={[0, 0.3, 0]}>
        <boxGeometry args={[19.2, 0.2, 2.1]} />
        <meshStandardMaterial color="#0f1b27" metalness={0.8} roughness={0.3} emissive="#1d4f8a" emissiveIntensity={0.5 + 0.4 * Math.sin(t * 4)} />
      </mesh>
      {/* memory PHYs on the long edges */}
      <Inst n={16} color fn={(i, o, c) => {
        o.position.set(-8.2 + (i % 8) * 2.35, 0.3, i < 8 ? -13.1 : 13.1);
        const k = 0.6 + 0.6 * rnd(i + Math.floor(t * 6));
        c.setRGB(1.6 * k, 1.0 * k, 0.25 * k);
      }}>
        <boxGeometry args={[2.0, 0.18, 0.7]} />
        <Glow />
      </Inst>
      {/* tensor cores rising in the target SM */}
      <Inst n={4} color fn={(i, o, c) => {
        const qx = i % 2 ? 1 : -1, qz = i < 2 ? -1 : 1;
        o.position.set(TX + qx * 0.52 + 0.08, 0.5 + tc * 0.22, TZ + qz * 0.5 - 0.02);
        o.scale.set(1, Math.max(0.01, tc), 1);
        const pulse = 1 + 0.6 * Math.max(0, Math.sin((t - T.smZoom) * 7 + i));
        c.setRGB(1.5 * pulse, 0.85 * pulse, 0.15 * pulse);
      }}>
        <boxGeometry args={[0.36, 0.44, 0.36]} />
        <meshStandardMaterial metalness={0.2} roughness={0.35} toneMapped={false} />
      </Inst>
    </>
  );
};

// the tensor-core job: C = A x B, drawn as an 8x8x8 iteration cube
const MN = 8, MP = 0.62;
const aVal = (g: number, i: number, k: number) => 0.25 + 0.75 * rnd(g * 1000 + i * 8 + k + 1);
const bVal = (g: number, k: number, j: number) => 0.25 + 0.75 * rnd(g * 1000 + 500 + k * 8 + j);
const MatGroup: React.FC<{L: number; g: number; pos: number[]; step: number}> = ({L, g, pos, step}) => {
  const sumT = MN * step + 0.4;
  const act = (k: number) => Math.exp(-Math.pow((L - k * step - step * 0.5) / (step * 0.7), 2));
  const off = (-MN / 2 + 0.5) * MP;
  const cz = (MN + 1.2) * MP + off;
  const cOn = prog(L, sumT + 0.8, 0.45);
  return (
    <group position={pos as [number, number, number]}>
      {/* A: left face (i, k) */}
      <Inst n={64} color fn={(n, o, c) => {
        const i = Math.floor(n / 8), k = n % 8;
        o.position.set(off - 1.7 * MP, -off - i * MP, off + k * MP);
        const v = aVal(g, i, k) * (0.6 + 2.4 * act(k));
        c.setRGB(0.03 * v, 0.3 * v, 0.24 * v);
      }}>
        <boxGeometry args={[0.2, 0.5, 0.5]} />
        <meshStandardMaterial roughness={0.35} toneMapped={false} />
      </Inst>
      {/* B: top face (k, j) */}
      <Inst n={64} color fn={(n, o, c) => {
        const k = Math.floor(n / 8), j = n % 8;
        o.position.set(off + j * MP, -off + 1.7 * MP, off + k * MP);
        const v = bVal(g, k, j) * (0.6 + 2.4 * act(k));
        c.setRGB(0.06 * v, 0.16 * v, 0.42 * v);
      }}>
        <boxGeometry args={[0.5, 0.2, 0.5]} />
        <meshStandardMaterial roughness={0.35} toneMapped={false} />
      </Inst>
      {/* products a*b in the volume, then summed forward into C */}
      <Inst n={512} color fn={(n, o, c) => {
        const i = Math.floor(n / 64), j = Math.floor(n / 8) % 8, k = n % 8;
        const born = prog(L, k * step, 0.3);
        const go = prog(L, sumT + (MN - 1 - k) * 0.04, 0.9, EIO);
        const z = lerp(off + k * MP, cz, go);
        o.position.set(off + j * MP, -off - i * MP, z);
        const s = born * (1 - go * 0.75) * (go > 0.98 ? 0 : 1);
        o.scale.setScalar(Math.max(0.0001, s * 0.62));
        const v = aVal(g, i, k) * bVal(g, k, j);
        const f = 1 + 3 * act(k);
        c.setRGB((0.04 + v * 0.14) * f, (0.12 + v * 0.16) * f, (0.2 + v * 0.1) * f);
      }}>
        <boxGeometry args={[0.5, 0.5, 0.5]} />
        <meshStandardMaterial roughness={0.35} toneMapped={false} />
      </Inst>
      {/* C: front face (i, j) */}
      <Inst n={64} color fn={(n, o, c) => {
        const i = Math.floor(n / 8), j = n % 8;
        let sum = 0;
        for (let k = 0; k < MN; k++) sum += aVal(g, i, k) * bVal(g, k, j);
        const v = sum / 3;
        o.position.set(off + j * MP, -off - i * MP, cz);
        o.scale.set(Math.max(0.0001, cOn), Math.max(0.0001, cOn), Math.max(0.0001, cOn * (0.5 + v)));
        const f = 1 + 2.5 * Math.exp(-Math.pow(L - sumT - 1.0, 2) / 0.08);
        c.setRGB(0.5 * v * f, 0.26 * v * f, 0.05 * v * f);
      }}>
        <boxGeometry args={[0.5, 0.5, 0.5]} />
        <meshStandardMaterial roughness={0.35} toneMapped={false} />
      </Inst>
    </group>
  );
};
const MmWorld: React.FC<{t: number}> = ({t}) => {
  const v = keys(t, [
    [116, [9.5, 5.5, 15, 0, 1.0, 0]],
    [122, [6.5, 3.6, 13.5, 0, 1.1, 0.5]],
    [128.4, [-5.5, 4.5, 13, 0, 1.0, 0]],
    [131, [-5, 13, 36, 0, 0, 0]],
    [134, [0, 21, 68, 0, 0, 0]],
  ]);
  const fast = t >= T.mmFast;
  const groups: {g: number; pos: number[]; L: number; step: number}[] = [];
  if (!fast) groups.push({g: 0, pos: [0, -1.3, 0], L: t - T.mmStart, step: T.mmLayerStep});
  else {
    const period = 1.7;
    for (let gx = -3; gx <= 3; gx++)
      for (let gy = -2; gy <= 2; gy++) {
        const id = (gx + 3) * 5 + (gy + 2);
        const o = gx === 0 && gy === 0 ? 0 : rnd(id) * period;
        const L = ((t - T.mmFast + o) % period) * 1.55;
        groups.push({g: id + (Math.floor((t - T.mmFast + o) / period) * 37), pos: [gx * 10, gy * 10, 0], L, step: 0.105});
      }
  }
  return (
    <>
      <Env intensity={0.5} fog={fast ? 0.008 : 0} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[6, 10, 8]} intensity={1.4} />
      <directionalLight position={[-8, -4, 6]} intensity={0.5} color="#6fb7ff" />
      <Cam p={v.slice(0, 3)} l={v.slice(3)} fov={38} />
      {groups.map((gr, i) => (
        <MatGroup key={i} L={gr.L} g={gr.g} pos={gr.pos} step={gr.step} />
      ))}
    </>
  );
};

// a FinFET (units: ~10 nm)
const gateOn = (t: number) => {
  if (t >= T.gateFast) return Math.sin((t - T.gateFast) * 2 * PI * 4) > 0;
  let on = false;
  for (const g of T.gateToggles) if (t >= g) on = !on;
  return on;
};
const onInt = (t: number) => {
  let acc = 0, on = false, last = 0;
  for (const g of T.gateToggles) {
    if (g > Math.min(t, T.gateFast)) break;
    if (on) acc += g - last;
    on = !on;
    last = g;
  }
  const end = Math.min(t, T.gateFast);
  if (on && end > last) acc += end - last;
  if (t > T.gateFast) acc += (t - T.gateFast) / 2;
  return acc;
};
const FINS = [-1.5, 0, 1.5];
const TrWorld: React.FC<{t: number}> = ({t}) => {
  const labels = useMemo(() => ({s: labelTexture('SOURCE', '#c9d3df'), g: labelTexture('GATE', HOT), d: labelTexture('DRAIN', '#c9d3df')}), []);
  const v = keys(t, [
    [134, [13, 9.5, 14.5, 0, 1.5, 0]],
    [138, [9.5, 6.5, 11.5, 0, 1.3, 0]],
    [142.4, [-7.5, 6, 10.5, 0, 1.2, 0]],
    [144, [-10, 16, 26, 0, 0.5, 0]],
    [146, [-22, 48, 72, 0, 0, 0]],
  ]);
  const on = gateOn(t);
  const oi = onInt(t);
  const sea = prog(t, T.gateFast + 0.2, 1.2);
  return (
    <>
      <Env intensity={0.6} fog={0.006} />
      <Lights key1={1.8} />
      <Cam p={v.slice(0, 3)} l={v.slice(3)} fov={40} />
      <mesh position={[0, -0.75, 0]}>
        <boxGeometry args={[14, 1.5, 9]} />
        <meshStandardMaterial color="#2a3140" metalness={0.3} roughness={0.6} />
      </mesh>
      <mesh position={[0, 0.25, 0]}>
        <boxGeometry args={[14, 0.5, 9]} />
        <meshStandardMaterial color="#8fb3c9" transparent opacity={0.22} roughness={0.2} />
      </mesh>
      {FINS.map((z) => (
        <mesh key={z} position={[0, 0.8, z]}>
          <boxGeometry args={[12, 1.6, 0.42]} />
          <meshStandardMaterial color="#6d7f99" metalness={0.4} roughness={0.35} transparent opacity={0.55} />
        </mesh>
      ))}
      <mesh position={[0, 1.2, 0]}>
        <boxGeometry args={[1.5, 2.6, 5.6]} />
        <meshStandardMaterial color="#c9a24a" metalness={1} roughness={0.3} emissive={HOT} emissiveIntensity={on ? 1.6 : 0.05} />
      </mesh>
      {[-4.3, 4.3].map((x) => (
        <mesh key={x} position={[x, 1.0, 0]}>
          <boxGeometry args={[2.6, 2.0, 4.8]} />
          <meshStandardMaterial color="#7d8aa0" metalness={0.5} roughness={0.4} />
        </mesh>
      ))}
      {[-4.3, 0, 4.3].map((x) => (
        <group key={x}>
          <mesh position={[x, x === 0 ? 3.6 : 3.4, 0]}>
            <cylinderGeometry args={[0.35, 0.35, x === 0 ? 2.2 : 2.8, 16]} />
            <meshStandardMaterial color="#b87333" metalness={1} roughness={0.3} />
          </mesh>
          <mesh position={[x, 4.9, 0]}>
            <boxGeometry args={[0.9, 0.4, 7]} />
            <meshStandardMaterial color="#b87333" metalness={1} roughness={0.3} emissive={x === 0 ? HOT : '#000000'} emissiveIntensity={x === 0 && on ? 0.5 : 0} />
          </mesh>
          <sprite position={[x, 6.3, 0]} scale={[4, 1, 1]}>
            <spriteMaterial map={x < 0 ? labels.s : x === 0 ? labels.g : labels.d} transparent opacity={1 - prog(t, 137.4, 0.6)} depthWrite={false} />
          </sprite>
        </group>
      ))}
      {/* electrons */}
      <Inst n={FINS.length * 70} color fn={(i, o, c) => {
        const fz = FINS[i % 3];
        const f = frac(rnd(i) + oi * (0.55 + 0.2 * rnd(i + 1)));
        const x = -6 + f * 12;
        const inGate = Math.abs(x) < 1.3;
        const vis = on ? 1 : inGate ? 0 : 0.6;
        o.position.set(x, 0.2 + rnd(i + 2) * 1.4, fz + (rnd(i + 3) - 0.5) * 0.3);
        o.scale.setScalar(Math.max(0.0001, vis));
        const b = on ? 3 : 0.8;
        c.setRGB(0.4 * b, 1.3 * b, 3 * b);
      }}>
        <sphereGeometry args={[0.1, 10, 8]} />
        <Glow />
      </Inst>
      {/* the sea of other transistors */}
      <Inst n={sea > 0 ? 1600 : 1} fn={(i, o) => {
        const gx = (i % 40) - 20, gz = Math.floor(i / 40) - 20;
        const far = Math.abs(gx) + Math.abs(gz) > 0;
        o.position.set(gx * 17, -0.7, gz * 12);
        o.scale.setScalar(far && sea > 0 ? sea : 0.0001);
      }}>
        <boxGeometry args={[14, 1.5, 9]} />
        <meshStandardMaterial color="#232a37" metalness={0.4} roughness={0.5} />
      </Inst>
      <Inst n={sea > 0 ? 1600 : 1} color fn={(i, o, c) => {
        const gx = (i % 40) - 20, gz = Math.floor(i / 40) - 20;
        const far = Math.abs(gx) + Math.abs(gz) > 0;
        o.position.set(gx * 17, 1.2, gz * 12);
        o.scale.setScalar(far && sea > 0 ? sea : 0.0001);
        const b = rnd(i * 7 + Math.floor(t * (6 + rnd(i) * 10))) > 0.5 ? 2.2 : 0.15;
        c.setRGB(b * 1.3, b * 0.75, b * 0.15);
      }}>
        <boxGeometry args={[1.5, 2.6, 5.6]} />
        <Glow />
      </Inst>
    </>
  );
};

const World: React.FC<{v: View}> = ({v}) => {
  switch (v.scene) {
    case 'intro': return <IntroWorld t={v.st} />;
    case 'dc': return <DCWorld t={v.st} />;
    case 'rack': return <RackWorld t={v.st} />;
    case 'tray': return <TrayWorld t={v.st} />;
    case 'pkg': return <PkgWorld t={v.st} />;
    case 'mem': return <MemWorld t={v.st} />;
    case 'die': return <DieWorld t={v.st} />;
    case 'mm': return <MmWorld t={v.st} />;
    case 'tr': return <TrWorld t={v.st} />;
    default: return <IntroWorld t={v.st} end />;
  }
};

// ---------- 2D overlay ----------
const Words: React.FC<{text: string; t: number; at: number; stagger?: number; hi?: string; style?: React.CSSProperties; hiColor?: string}> = ({text, t, at, stagger = 0.035, hi, style, hiColor = ACC}) => {
  const hs = hi ? text.indexOf(hi) : -1;
  let pos = 0;
  return (
    <div style={{display: 'flex', flexWrap: 'wrap', justifyContent: 'center', columnGap: '0.26em', ...style}}>
      {text.split(' ').map((w, i) => {
        const start = text.indexOf(w, pos);
        pos = start + w.length;
        const isHi = hs >= 0 && start >= hs && start < hs + (hi?.length ?? 0);
        const p = prog(t, at + i * stagger, 0.6);
        return (
          <span key={i} style={{display: 'inline-block', overflow: 'hidden', padding: '0.04em 0 0.14em'}}>
            <span style={{display: 'inline-block', transform: `translateY(${(1 - p) * 110}%)`, color: isHi ? hiColor : undefined}}>{w}</span>
          </span>
        );
      })}
    </div>
  );
};
const Captions: React.FC<{t: number}> = ({t}) => (
  <>
    {T.captions.filter((c) => t >= c.at - 0.05 && t < c.until + 0.35).map((c) => {
      const o = prog(t, c.until, 0.3, EIN);
      return (
        <div key={c.at} style={{position: 'absolute', left: 0, right: 0, bottom: 92, display: 'flex', justifyContent: 'center', opacity: 1 - o, filter: blurIf(o * 8)}}>
          <Words text={c.text} t={t} at={c.at} hi={c.hi} style={{maxWidth: 1500, fontSize: 50, fontWeight: 650, letterSpacing: -1, color: '#E8ECF1', lineHeight: 1.2, textShadow: '0 2px 24px rgba(0,0,0,0.95)'}} />
        </div>
      );
    })}
  </>
);
const RULER = ['100 m', '10 m', '1 m', '10 cm', '1 cm', '1 mm', '100 µm', '10 µm', '1 µm', '100 nm', '10 nm'];
const Hud: React.FC<{t: number; v: View}> = ({t, v}) => {
  const vis = prog(t, 12.2, 0.6) * (1 - prog(t, MON_END - 0.2, 0.3));
  if (vis <= 0) return null;
  const idx = SC.findIndex((s) => s.id === v.scene);
  const s = SC[idx];
  const cp = v.montage ? 1 : prog(t, v.cutStart + 0.15, 0.6);
  const pos = scaleAt(t);
  const top = 150, step = 62;
  const cur = s?.scale ?? '';
  return (
    <div style={{position: 'absolute', inset: 0, opacity: vis}}>
      {!v.montage && t < MON.at && (
        <div style={{position: 'absolute', left: 72, top: 60, display: 'flex', alignItems: 'baseline', gap: 18, opacity: cp, transform: `translateX(${(1 - cp) * -20}px)`}}>
          <span style={{fontFamily: MONO, fontSize: 22, color: ACC, fontWeight: 700}}>{String(idx).padStart(2, '0')}</span>
          <span style={{fontFamily: MONO, fontSize: 22, color: '#C8D0DA', letterSpacing: 5, fontWeight: 500}}>{s.label}</span>
        </div>
      )}
      <div style={{position: 'absolute', right: 70, top, width: 150, height: step * 10 + 20}}>
        <div style={{position: 'absolute', right: 0, top: 0, width: 2, height: step * 10, background: 'rgba(255,255,255,0.14)'}} />
        {RULER.map((r, i) => {
          const near = Math.max(0, 1 - Math.abs(i - pos) / 1.2);
          return (
            <div key={r} style={{position: 'absolute', right: 0, top: i * step - 9, display: 'flex', alignItems: 'center', gap: 10}}>
              <span style={{fontFamily: MONO, fontSize: 17, color: `rgba(200,210,220,${0.28 + near * 0.5})`}}>{r}</span>
              <span style={{width: 12, height: 2, background: 'rgba(255,255,255,0.3)'}} />
            </div>
          );
        })}
        <div style={{position: 'absolute', right: -8, top: pos * step - 8, width: 16, height: 16, borderRadius: 8, background: ACC, boxShadow: `0 0 18px ${ACC}`}} />
        <div style={{position: 'absolute', right: 26, top: pos * step - 44, fontFamily: MONO, fontSize: 18, fontWeight: 700, color: ACC, whiteSpace: 'nowrap'}}>{cur ? `~${cur}` : ''}</div>
      </div>
    </div>
  );
};
const PromptCard: React.FC<{t: number; text: string; top: number; caret?: boolean; pressed?: number; children?: React.ReactNode}> = ({t, text, top, caret, pressed = 0, children}) => (
  <div style={{position: 'absolute', left: 470, width: 980, top, borderRadius: 30, background: 'rgba(14,18,25,0.92)', border: '1px solid rgba(255,255,255,0.12)', boxShadow: '0 30px 80px rgba(0,0,0,0.6)', padding: '34px 40px'}}>
    <div style={{display: 'flex', alignItems: 'center', gap: 24}}>
      <div style={{flex: 1, fontSize: 44, fontWeight: 500, color: FG, letterSpacing: -0.8}}>
        {text}
        {caret && <span style={{display: 'inline-block', width: 3, height: 46, marginLeft: 4, background: ACC, verticalAlign: -6, opacity: Math.floor(t * 2.4) % 2 ? 0.2 : 1}} />}
      </div>
      <div style={{width: 64, height: 64, borderRadius: 32, background: ACC, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${1 - pressed * 0.15})`, boxShadow: `0 0 ${20 + pressed * 40}px ${ACC}`}}>
        <svg width="30" height="30" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" stroke="#04060A" strokeWidth="2.8" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
    </div>
    {children}
  </div>
);
const typed = (text: string, t: number, a: number, b: number) => text.slice(0, Math.floor(text.length * interpolate(t, [a, b], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})));
const Intro: React.FC<{t: number}> = ({t}) => {
  if (t > 12) return null;
  const tOut = prog(t, T.titleOut, 0.6, EIN);
  const cardIn = prog(t, T.promptIn, 0.6);
  const launch = prog(t, T.enter + 0.05, 0.45, EIN);
  const pressed = Math.exp(-Math.pow((t - T.enter) / 0.08, 2));
  return (
    <>
      {tOut < 1 && (
        <div style={{position: 'absolute', left: 0, right: 0, top: 640, opacity: 1 - tOut, filter: blurIf(tOut * 12)}}>
          <Words text="HOW AN AI CHIP WORKS" t={t} at={T.titleWords[0]} stagger={0.25} hi="AI CHIP" style={{fontSize: 128, fontWeight: 800, letterSpacing: -4, color: FG, textShadow: '0 4px 40px rgba(0,0,0,0.9)'}} />
          <div style={{textAlign: 'center', marginTop: 10, fontSize: 36, fontWeight: 500, color: '#AEB7C2', opacity: prog(t, T.subtitle, 0.8), letterSpacing: -0.3}}>
            From a data center down to a single switch.
          </div>
        </div>
      )}
      {cardIn > 0 && launch < 1 && (
        <div style={{position: 'absolute', inset: 0, opacity: cardIn * (1 - launch), transform: `scale(${(0.96 + 0.04 * cardIn) * (1 - launch * 0.7)})`, filter: blurIf(launch * 10)}}>
          <PromptCard t={t} top={440} text={typed(T.prompt, t, T.typeStart, T.typeEnd)} caret={t < T.enter} pressed={pressed} />
        </div>
      )}
    </>
  );
};
const WeightField: React.FC<{t: number}> = ({t}) => {
  const a = prog(t, 82.8, 1.0) * (1 - prog(t, 88.2, 0.8, EIN));
  if (a <= 0) return null;
  return (
    <>
      {Array.from({length: 46}).map((_, i) => {
        const x = 80 + rnd(i + 1) * 1600, y0 = 150 + rnd(i + 2) * 640;
        const at = 82.8 + rnd(i + 3) * 2.5;
        const p = prog(t, at, 0.8);
        const n = (rnd(i + 4) * 2 - 1) * (rnd(i + 5) < 0.3 ? 1.9 : 0.4);
        return (
          <div key={i} style={{position: 'absolute', left: x, top: y0 - (t - 82.8) * 14 * (0.5 + rnd(i)), fontFamily: MONO, fontSize: 20 + rnd(i + 6) * 18, color: ACC, opacity: a * p * (0.25 + 0.5 * rnd(i + 7)), filter: blurIf((1 - p) * 6)}}>
            {n >= 0 ? ' ' : ''}{n.toFixed(4)}
          </div>
        );
      })}
    </>
  );
};
const BigStat: React.FC<{t: number; at: number; until: number; value: string; label: string; color?: string}> = ({t, at, until, value, label, color = FG}) => {
  const p = prog(t, at, 0.5), o = prog(t, until, 0.4, EIN);
  if (p <= 0 || o >= 1) return null;
  return (
    <div style={{position: 'absolute', left: 0, right: 0, top: 120, textAlign: 'center', opacity: p * (1 - o), transform: `translateY(${(1 - p) * 20}px)`, filter: blurIf(o * 10)}}>
      <div style={{fontFamily: MONO, fontSize: 104, fontWeight: 700, color, letterSpacing: -3, textShadow: '0 4px 40px rgba(0,0,0,0.9)'}}>{value}</div>
      <div style={{fontFamily: MONO, fontSize: 22, letterSpacing: 8, color: '#AEB7C2', marginTop: 4}}>{label}</div>
    </div>
  );
};
const Stats: React.FC<{t: number}> = ({t}) => {
  const c = prog(t, T.counter[0], T.counter[1] - T.counter[0], Easing.bezier(0.3, 0, 0.2, 1));
  const tb = prog(t, T.tbCounter[0], T.tbCounter[1] - T.tbCounter[0], Easing.bezier(0.3, 0, 0.2, 1));
  const on = gateOn(t);
  const bitA = prog(t, 135.2, 0.4) * (1 - prog(t, 145.4, 0.4));
  return (
    <>
      <BigStat t={t} at={T.counter[0]} until={72.2} value={fmt(208e9 * c)} label="TRANSISTORS" />
      <BigStat t={t} at={T.tbCounter[0]} until={99.5} value={`${(8 * tb).toFixed(1)} TB/s`} label="READ FROM MEMORY" color={ACC} />
      <BigStat t={t} at={117.2} until={127.6} value="C = A × B" label="MATRIX MULTIPLY" color={HOT} />
      {bitA > 0 && (
        <div style={{position: 'absolute', left: 90, top: 330, width: 200, textAlign: 'center', opacity: bitA}}>
          <div style={{fontFamily: MONO, fontSize: 130, fontWeight: 700, color: on ? HOT : '#3a4250', textShadow: on ? `0 0 50px ${HOT}` : undefined}}>{on ? '1' : '0'}</div>
          <div style={{fontFamily: MONO, fontSize: 22, letterSpacing: 8, color: '#AEB7C2'}}>{on ? 'ON' : 'OFF'}</div>
        </div>
      )}
      <WeightField t={t} />
    </>
  );
};
const Outro: React.FC<{t: number}> = ({t}) => {
  if (t < T.answerIn) return null;
  const inP = prog(t, T.answerIn, 0.6), outP = prog(t, T.final - 0.3, 0.5, EIN);
  const words = T.answer.split(' ');
  const shown = Math.floor(words.length * interpolate(t, [T.answerStart, T.answerEnd], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}));
  return (
    <>
      {outP < 1 && (
        <div style={{position: 'absolute', inset: 0, opacity: inP * (1 - outP), transform: `translateY(${(1 - inP) * 30}px)`, filter: blurIf(outP * 10)}}>
          <PromptCard t={t} top={300} text={T.prompt}>
            <div style={{marginTop: 28, paddingTop: 26, borderTop: '1px solid rgba(255,255,255,0.1)', fontSize: 38, lineHeight: 1.35, color: '#D5DCE4', minHeight: 110}}>
              {words.slice(0, shown).map((w, i) => (
                <span key={i} style={{opacity: Math.min(1, (t - T.answerStart) * 6 - i * 0)}}>{w} </span>
              ))}
              {shown < words.length && <span style={{display: 'inline-block', width: 14, height: 14, borderRadius: 7, background: ACC, boxShadow: `0 0 16px ${ACC}`}} />}
            </div>
          </PromptCard>
        </div>
      )}
      {t >= T.final && (
        <div style={{position: 'absolute', left: 0, right: 0, top: 370, textAlign: 'center'}}>
          <Words text="All of that." t={t} at={T.final} stagger={0.12} style={{fontSize: 104, fontWeight: 800, letterSpacing: -3.5, color: FG, textShadow: '0 4px 40px rgba(0,0,0,0.9)'}} />
          <Words text="For every single word." t={t} at={T.final + 0.55} stagger={0.12} hi="For every single word." style={{fontSize: 104, fontWeight: 800, letterSpacing: -3.5, textShadow: '0 4px 40px rgba(0,0,0,0.9)'}} />
          <div style={{marginTop: 40, fontFamily: MONO, fontSize: 24, letterSpacing: 10, color: '#8E98A5', opacity: prog(t, T.finalSub, 1.0)}}>HOW AN AI CHIP WORKS</div>
        </div>
      )}
    </>
  );
};

// the post-processing composer draws black on its very first pass; burn one pass on mount
const WarmUp: React.FC = () => {
  const advance = useThree((s) => s.advance);
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    const h = delayRender('bloom warm-up');
    setTimeout(() => {
      advance(performance.now());
      setTimeout(() => {
        advance(performance.now());
        continueRender(h);
      }, 50);
    }, 50);
  });
  return null;
};

// ---------- composition ----------
const CUTS = [T.enter, ...SC.slice(1).map((s) => s.start), ...MON.shots.map((_, i) => MON.at + i * MON.step).slice(1), MON_END];
export const ChipExplainer: React.FC = () => {
  const frame = useCurrentFrame();
  const t = frame / T.fps;
  const v = viewAt(t);
  const short = !!v.montage || v.scene === 'end';
  const outP = v.cutEnd < 900 ? prog(t, v.cutEnd - (short ? 0.18 : 0.45), short ? 0.18 : 0.45, EIN) : 0;
  const inP = v.cutStart > 0.1 ? 1 - prog(t, v.cutStart, short ? 0.3 : 0.65) : 0;
  const zoom = 1 + outP * 0.16 + inP * 0.1;
  const blur = outP * 14 + inP * 12;
  const flash = Math.max(...CUTS.map((c) => Math.exp(-Math.pow((t - c) / 0.09, 2)))) * 0.5;
  const fadeIn = 1 - prog(t, 0, 0.8);
  const fadeOut = prog(t, T.duration - 1.1, 1.0, EIO);
  const dim = t >= T.answerIn ? 0.45 * prog(t, T.answerIn, 0.5) * (1 - 0.3 * prog(t, T.final - 0.3, 0.6)) : t >= T.promptIn - 0.2 && t < T.enter + 0.3 ? 0.5 * prog(t, T.promptIn - 0.2, 0.6) : 0;
  return (
    <AbsoluteFill style={{background: BG, fontFamily: SANS}}>
      <AbsoluteFill style={{transform: `scale(${zoom})`, filter: blurIf(blur)}}>
        <ThreeCanvas width={1920} height={1080} camera={{fov: 40, position: [0, 2, 8]}}>
          <World v={v} />
          <EffectComposer multisampling={4}>
            <Bloom intensity={0.95} luminanceThreshold={0.82} luminanceSmoothing={0.25} mipmapBlur radius={0.72} />
            <Vignette darkness={0.55} offset={0.3} />
          </EffectComposer>
          <WarmUp />
        </ThreeCanvas>
      </AbsoluteFill>
      <AbsoluteFill style={{background: `rgba(4,6,10,${dim})`}} />
      <AbsoluteFill style={{background: 'linear-gradient(180deg, rgba(4,6,10,0.55) 0%, rgba(4,6,10,0) 16%, rgba(4,6,10,0) 70%, rgba(4,6,10,0.8) 100%)'}} />
      <Hud t={t} v={v} />
      <Stats t={t} />
      <Captions t={t} />
      <Intro t={t} />
      <Outro t={t} />
      <AbsoluteFill style={{background: `radial-gradient(circle at 50% 50%, rgba(225,255,245,${flash}) 0%, rgba(61,245,200,${flash * 0.45}) 30%, rgba(4,6,10,0) 70%)`}} />
      <AbsoluteFill style={{background: '#000', opacity: Math.max(fadeIn, fadeOut)}} />
    </AbsoluteFill>
  );
};
