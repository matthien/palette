// ── CONFIG ───────────────────────────────────────────────────────────────────

const CLIENT_ID    = '2da20958709345ad9ef4317bd3cdb83c';
const REDIRECT_URI = window.location.origin + window.location.pathname;
const SCOPES       = 'playlist-read-private playlist-read-collaborative';

// ── PKCE ─────────────────────────────────────────────────────────────────────

function genRandStr(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, v => chars[v % chars.length]).join('');
}

async function sha256(str) {
  return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
}

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function startAuth() {
  const verifier  = genRandStr(64);
  const challenge = b64url(await sha256(verifier));
  const state     = genRandStr(16);
  localStorage.setItem('pkce_verifier', verifier);
  localStorage.setItem('pkce_state', state);
  const p = new URLSearchParams({
    client_id: CLIENT_ID, response_type: 'code',
    redirect_uri: REDIRECT_URI, scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: challenge, state,
  });
  window.location.href = `https://accounts.spotify.com/authorize?${p}`;
}

async function exchangeToken(code) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code,
      redirect_uri: REDIRECT_URI, client_id: CLIENT_ID,
      code_verifier: localStorage.getItem('pkce_verifier'),
    }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error_description || d.error);
  saveTokens(d);
  localStorage.removeItem('pkce_verifier');
  localStorage.removeItem('pkce_state');
  return d.access_token;
}

function saveTokens(d) {
  localStorage.setItem('access_token', d.access_token);
  localStorage.setItem('token_expiry', Date.now() + d.expires_in * 1000);
  if (d.refresh_token) localStorage.setItem('refresh_token', d.refresh_token);
}

async function doRefresh() {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: localStorage.getItem('refresh_token'),
      client_id: CLIENT_ID,
    }),
  });
  const d = await res.json();
  if (d.error) throw new Error(d.error_description || d.error);
  saveTokens(d);
  return d.access_token;
}

async function getToken() {
  const exp = parseInt(localStorage.getItem('token_expiry') || '0');
  if (Date.now() < exp - 60_000) return localStorage.getItem('access_token');
  return doRefresh();
}

function isLoggedIn() {
  return !!localStorage.getItem('access_token') && !!localStorage.getItem('refresh_token');
}

function clearTokens() {
  ['access_token', 'refresh_token', 'token_expiry'].forEach(k => localStorage.removeItem(k));
}

// ── SPOTIFY API ───────────────────────────────────────────────────────────────

async function spFetch(path) {
  const token = await getToken();
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) { clearTokens(); showScreen('landing'); return null; }
  if (!res.ok) throw new Error(`Spotify ${res.status}`);
  return res.json();
}

async function fetchPlaylists() {
  const me = await spFetch('/me');
  if (!me) return [];
  const userId = me.id;

  const all = [];
  let url = '/me/playlists?limit=50';
  while (url) {
    const d = await spFetch(url);
    if (!d) return all;
    all.push(...d.items.filter(pl => pl && pl.owner?.id === userId));
    url = d.next ? d.next.replace('https://api.spotify.com/v1', '') : null;
  }

  return all;
}

async function fetchTracks(playlistId) {
  const all = [];
  let url = `/playlists/${playlistId}/items?limit=50`;
  while (url && all.length < 100) {
    const d = await spFetch(url);
    if (!d) break;
    for (const entry of d.items) {
      if (entry?.item?.album?.images?.length) all.push(entry.item);
    }
    url = d.next ? d.next.replace('https://api.spotify.com/v1', '') : null;
  }
  return all;
}

// ── COLOR PIPELINE ────────────────────────────────────────────────────────────

function hexToLab(hex) {
  let r = parseInt(hex.slice(1,3),16)/255;
  let g = parseInt(hex.slice(3,5),16)/255;
  let b = parseInt(hex.slice(5,7),16)/255;
  const lin = v => v <= 0.04045 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4);
  [r,g,b] = [lin(r),lin(g),lin(b)];
  const x = r*0.4124564+g*0.3575761+b*0.1804375;
  const y = r*0.2126729+g*0.7151522+b*0.0721750;
  const z = r*0.0193339+g*0.1191920+b*0.9503041;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787037*t+16/116;
  const [fx,fy,fz] = [f(x/0.95047),f(y/1.00000),f(z/1.08883)];
  return [116*fy-16, 500*(fx-fy), 200*(fy-fz)];
}

function labToHex(lab) {
  const [L,a,b] = lab;
  const fy=(L+16)/116, fx=a/500+fy, fz=fy-b/200;
  const finv=t=>t>0.206897?t**3:(t-16/116)/7.787037;
  const x=finv(fx)*0.95047, y=finv(fy)*1.00000, z=finv(fz)*1.08883;
  const lr= 3.2404542*x-1.5371385*y-0.4985314*z;
  const lg=-0.9692660*x+1.8760108*y+0.0415560*z;
  const lb= 0.0556434*x-0.2040259*y+1.0572252*z;
  const delin=v=>v<=0.0031308?12.92*v:1.055*Math.pow(Math.max(0,v),1/2.4)-0.055;
  const toU8=v=>Math.round(Math.max(0,Math.min(1,delin(v)))*255);
  return '#'+[toU8(lr),toU8(lg),toU8(lb)].map(v=>v.toString(16).padStart(2,'0')).join('');
}

function labDist(a, b) {
  return Math.sqrt(a.reduce((s,v,i) => s+(v-b[i])**2, 0));
}

function makeRng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed>>>15, 1|seed);
    t = t + Math.imul(t ^ t>>>7, 61|t) ^ t;
    return ((t ^ t>>>14) >>> 0) / 4294967296;
  };
}

function seedFromColors(colors) {
  return colors.join('').split('').reduce((h,c) => (Math.imul(31,h)+c.charCodeAt(0))|0, 0);
}

function kMeans(points, k, hexColors, iterations=60) {
  const rng = makeRng(seedFromColors(hexColors));
  const centroids = [points[Math.floor(rng()*points.length)]];
  while (centroids.length < k) {
    const dists = points.map(p => Math.min(...centroids.map(c => labDist(p,c))));
    const total = dists.reduce((s,d) => s+d, 0);
    let r = rng()*total;
    for (let i=0; i<points.length; i++) { r-=dists[i]; if(r<=0){centroids.push(points[i]);break;} }
  }
  let assignments = new Array(points.length).fill(0);
  for (let iter=0; iter<iterations; iter++) {
    assignments = points.map(p => {
      let min=Infinity, idx=0;
      centroids.forEach((c,i) => { const d=labDist(p,c); if(d<min){min=d;idx=i;} });
      return idx;
    });
    for (let i=0; i<k; i++) {
      const m = points.filter((_,j) => assignments[j]===i);
      if (m.length===0) continue;
      centroids[i] = centroids[i].map((_,d) => m.reduce((s,p) => s+p[d], 0)/m.length);
    }
  }
  const counts = new Array(k).fill(0);
  assignments.forEach(a => counts[a]++);
  return {
    clusters: centroids.map((c,i) => ({ lab:c, hex:labToHex(c), count:counts[i] })),
    assignments,
  };
}

function extractColor(imgUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const thief = new ColorThief();
        const palette = thief.getPalette(img, 6);
        const best = palette
          .map(([r,g,b], i) => {
            const hex = '#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join('');
            const [L,a,bv] = hexToLab(hex);
            const chroma = Math.sqrt(a*a + bv*bv);
            const dominance = Math.pow(0.85, i);
            const score = dominance * (1 + chroma / 40);
            return { hex, score, L };
          })
          .filter(c => c.L > 10)
          .sort((a,b) => b.score - a.score)[0];
        resolve(best?.hex || null);
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = imgUrl;
  });
}

async function buildPalette(tracks) {

  const selected = tracks.slice(0, 50);
  const results = await Promise.all(
    selected.map(async t => {
      const imgUrl = t.album.images[0]?.url;
      if (!imgUrl) return null;
      const hex = await extractColor(imgUrl);
      return hex ? { hex, track: t } : null;
    })
  );

  const valid = results.filter(Boolean);

  if (valid.length < 5) throw new Error('Not enough colors extracted');

  const hexArr = valid.map(v => v.hex);
  const { clusters, assignments } = kMeans(hexArr.map(hexToLab), 8, hexArr);

  const indexed = clusters.map((c,i) => ({ ...c, origIdx: i }));
  indexed.sort((a,b) => b.count - a.count);
  const top5 = indexed.slice(0, 5);

  const origToSorted = {};
  top5.forEach((c,si) => { origToSorted[c.origIdx] = si; });

  const palette   = top5.map(c => ({ hex: c.hex, count: c.count }));
  const top5Labs  = top5.map(c => c.lab);

  const songs = valid.map((v, i) => {
    let clusterIdx = origToSorted[assignments[i]];
    if (clusterIdx === undefined) {
      const songLab = hexToLab(v.hex);
      let minDist = Infinity;
      top5Labs.forEach((lab, j) => {
        const d = labDist(songLab, lab);
        if (d < minDist) { minDist = d; clusterIdx = j; }
      });
    }
    return {
      title:     v.track.name,
      albumId:   v.track.album.id,
      albumName: v.track.album.name,
      albumUrl:  v.track.album.external_urls?.spotify || null,
      artist:    v.track.artists[0]?.name || '',
      color:     v.hex,
      coverUrl:  (v.track.album.images[1] ?? v.track.album.images[0])?.url || null,
      clusterIdx,
    };
  });

  return { palette, songs };
}

// ── AURORA ────────────────────────────────────────────────────────────────────

const AURORA_VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const AURORA_FRAG = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uAmplitude;
uniform vec3 uColorStops[3];
uniform vec2 uResolution;
uniform float uBlend;

out vec4 fragColor;

vec3 permute(vec3 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

struct ColorStop { vec3 color; float position; };

#define COLOR_RAMP(colors, factor, finalColor) {                                    \
  int index = 0;                                                                   \
  for (int i = 0; i < 2; i++) {                                                    \
    ColorStop c = colors[i];                                                       \
    index = int(mix(float(index), float(i), float(c.position <= factor)));         \
  }                                                                                \
  ColorStop cur = colors[index]; ColorStop nxt = colors[index + 1];               \
  float lf = (factor - cur.position) / (nxt.position - cur.position);             \
  finalColor = mix(cur.color, nxt.color, lf);                                     \
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;

  ColorStop colors[3];
  colors[0] = ColorStop(uColorStops[0], 0.0);
  colors[1] = ColorStop(uColorStops[1], 0.5);
  colors[2] = ColorStop(uColorStops[2], 1.0);

  vec3 rampColor;
  COLOR_RAMP(colors, uv.x, rampColor);

  float height = snoise(vec2(uv.x * 2.0 + uTime * 0.1, uTime * 0.25)) * 0.5 * uAmplitude;
  height = exp(height);
  height = (uv.y * 2.0 - height + 0.2);
  float intensity = 0.6 * height;

  float midPoint = 0.20;
  float auroraAlpha = smoothstep(midPoint - uBlend * 0.5, midPoint + uBlend * 0.5, intensity);

  vec3 auroraColor = intensity * rampColor;
  fragColor = vec4(auroraColor * auroraAlpha, auroraAlpha);
}
`;

let auroraGl = null, auroraProgram = null, auroraRafId = null, auroraResizeObs = null;
let auroraReady = false;
const auroraStartTime = performance.now();

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return '#' + [f(0), f(8), f(4)].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

function randomAuroraColors() {
  const h = Math.random() * 360;
  const spread = 90 + Math.random() * 60;
  return [
    hslToHex(h % 360, 85, 58),
    hslToHex((h + spread) % 360, 75, 68),
    hslToHex((h + spread * 2) % 360, 90, 52),
  ];
}

function initAurora() {
  const canvas = document.getElementById('auroraCanvas');
  if (!canvas) return false;

  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: true });
  if (!gl) return false;
  auroraGl = gl;

  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);

  function compileAuroraShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }

  auroraProgram = gl.createProgram();
  gl.attachShader(auroraProgram, compileAuroraShader(gl.VERTEX_SHADER, AURORA_VERT));
  gl.attachShader(auroraProgram, compileAuroraShader(gl.FRAGMENT_SHADER, AURORA_FRAG));
  gl.linkProgram(auroraProgram);
  gl.useProgram(auroraProgram);

  const posLoc = gl.getAttribLocation(auroraProgram, 'position');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  gl.uniform3fv(
    gl.getUniformLocation(auroraProgram, 'uColorStops'),
    new Float32Array(randomAuroraColors().flatMap(hexToRgb))
  );
  gl.uniform1f(gl.getUniformLocation(auroraProgram, 'uAmplitude'), 2.0);
  gl.uniform1f(gl.getUniformLocation(auroraProgram, 'uBlend'), 0.9);

  function resizeAurora() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.round(canvas.clientWidth  * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w; canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.uniform2f(gl.getUniformLocation(auroraProgram, 'uResolution'), w, h);
  }

  auroraResizeObs = new ResizeObserver(resizeAurora);
  auroraResizeObs.observe(canvas);
  resizeAurora();

  return true;
}

function startAurora() {
  if (!auroraReady) auroraReady = initAurora();
  if (!auroraReady || auroraRafId) return;
  const gl = auroraGl;
  gl.useProgram(auroraProgram);
  gl.uniform3fv(
    gl.getUniformLocation(auroraProgram, 'uColorStops'),
    new Float32Array(randomAuroraColors().flatMap(hexToRgb))
  );
  const timeLoc = gl.getUniformLocation(auroraProgram, 'uTime');
  function loop() {
    const t = (performance.now() - auroraStartTime) * 0.001;
    gl.uniform1f(timeLoc, t * 0.5);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    auroraRafId = requestAnimationFrame(loop);
  }
  auroraRafId = requestAnimationFrame(loop);
}

function stopAurora() {
  if (auroraRafId) { cancelAnimationFrame(auroraRafId); auroraRafId = null; }
}

// ── SHADERS ───────────────────────────────────────────────────────────────────

const VERT_SRC = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;

const int N = 5;

uniform vec2  iResolution;
uniform float iTime;
uniform vec3  uColors[N];
uniform vec2  uPositions[N];
uniform float uWeights[N];

out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = gl_FragCoord.xy / iResolution;
  uv.y = 1.0 - uv.y;
  float aspect = iResolution.x / iResolution.y;

  float t = iTime * 0.04;
  uv.x += sin(uv.y * 3.1 + t) * 0.005;
  uv.y += cos(uv.x * 2.7 + t * 1.1) * 0.004;

  vec3  col         = vec3(0.0);
  float totalWeight = 0.001;

  for (int i = 0; i < N; i++) {
    vec2 d = uv - uPositions[i];
    d.x *= aspect;
    float sigma = 0.025 + uWeights[i] * 0.16;
    float w = exp(-dot(d, d) / sigma);
    col         += uColors[i] * w;
    totalWeight += w;
  }

  col /= totalWeight;
  col = (col - 0.5) * 1.35 + 0.5;
  col = max(col, vec3(0.07));
  col += (hash(uv * 750.0 + fract(iTime)) - 0.5) * 0.055;

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ── WEBGL ─────────────────────────────────────────────────────────────────────

let gl, program, rafId, resizeObserver;
const startTime = performance.now();
let glReady = false;

let coverSongs      = [];
let coversResizeObs = null;
let canvasDpr       = 1;
let activeHoverIdx  = -1;
let coversAnimRaf   = null;

function easeOutElastic(t) {
  if (t === 0 || t === 1) return t;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
}

function startCoversAnim(canvas) {
  if (coversAnimRaf) cancelAnimationFrame(coversAnimRaf);
  const DURATION = 1020;
  const start = performance.now();
  function tick(now) {
    const elapsed = now - start;
    let stillGoing = false;
    coverSongs.forEach(s => {
      const t = Math.max(0, Math.min(1, (elapsed - s.animDelay) / DURATION));
      s.animScale = easeOutElastic(t);
      if (t < 1) stillGoing = true;
    });
    drawCovers(canvas, activeHoverIdx);
    coversAnimRaf = stillGoing ? requestAnimationFrame(tick) : null;
  }
  coversAnimRaf = requestAnimationFrame(tick);
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3), 16);
  const g = parseInt(hex.slice(3,5), 16);
  const b = parseInt(hex.slice(5,7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function hexToRgb(hex) {
  return [
    parseInt(hex.slice(1,3),16)/255,
    parseInt(hex.slice(3,5),16)/255,
    parseInt(hex.slice(5,7),16)/255,
  ];
}

function compileShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  return s;
}

function initGL() {
  const canvas = document.getElementById('resultBg');
  gl = canvas.getContext('webgl2');
  if (!gl) return false;

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);

  const vs = compileShader(gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
  program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.useProgram(program);

  const posLoc = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

  resizeObserver = new ResizeObserver(() => resizeCanvas(canvas));
  resizeObserver.observe(canvas);
  resizeCanvas(canvas);

  return true;
}

function updateGLUniforms(palette, blobPositions) {
  if (!gl || !program) return;
  const maxCount = Math.max(...palette.map(c => c.count));
  const weights  = palette.map(c => Math.pow(c.count / maxCount, 1.8));
  gl.uniform3fv(gl.getUniformLocation(program, 'uColors'),    new Float32Array(palette.flatMap(c => hexToRgb(c.hex))));
  gl.uniform2fv(gl.getUniformLocation(program, 'uPositions'), new Float32Array(blobPositions.flat()));
  gl.uniform1fv(gl.getUniformLocation(program, 'uWeights'),   new Float32Array(weights));
}

function resizeCanvas(canvas) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w   = Math.round(canvas.clientWidth  * dpr);
  const h   = Math.round(canvas.clientHeight * dpr);
  if (canvas.width === w && canvas.height === h) return;
  canvas.width = w; canvas.height = h;
  if (gl) {
    gl.viewport(0, 0, w, h);
    gl.uniform2f(gl.getUniformLocation(program, 'iResolution'), w, h);
  }
}

function startRender() {
  if (rafId) return;
  const timeLoc = gl.getUniformLocation(program, 'iTime');
  function loop() {
    gl.uniform1f(timeLoc, (performance.now() - startTime) * 0.001);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    rafId = requestAnimationFrame(loop);
  }
  rafId = requestAnimationFrame(loop);
}

function stopRender() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

// ── PICKER ───────────────────────────────────────────────────────────────────

const PAGE_SIZE  = 6;
let visibleCount = PAGE_SIZE;
let errorTimer   = null;
let allPlaylists = [];

function buildGrid() {
  const grid = document.getElementById('playlistGrid');
  const wrap = document.getElementById('loadMoreWrap');
  grid.innerHTML = '';

  allPlaylists.slice(0, visibleCount).forEach(pl => {
    const card   = document.createElement('div');
    card.className = 'grid-card';
    const imgSrc = pl.images?.[0]?.url;
    const count  = pl.items?.total || 0;
    card.innerHTML = `
      <div class="grid-card-img-wrap">
        <div class="grid-card-img-inner">
          ${imgSrc
            ? `<img src="${imgSrc}" alt="" style="width:100%;height:100%;object-fit:cover;display:block;">`
            : `<div style="width:100%;height:100%;background:#2a2a2a;"></div>`
          }
        </div>
      </div>
      <div class="grid-card-info">
        <span class="grid-card-name">${pl.name}</span>
        <span class="grid-card-count">${count} SONGS</span>
      </div>
    `;
    card.addEventListener('click', () => onPickPlaylist(pl));
    grid.appendChild(card);
  });

  wrap.style.display = visibleCount >= allPlaylists.length ? 'none' : 'flex';
}

function onPickPlaylist(pl) {
  if ((pl.items?.total || 0) < 25) { showError(); return; }
  startGenerate(pl);
}

function showError() {
  const toast = document.getElementById('errorToast');
  toast.classList.add('visible');
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => toast.classList.remove('visible'), 3000);
}

// ── BLOOM ─────────────────────────────────────────────────────────────────────

function triggerBloom() {
  const bloom = document.getElementById('bloom');
  bloom.classList.remove('flash');
  void bloom.offsetWidth;
  bloom.classList.add('flash');
}

// ── SCREEN NAVIGATION ─────────────────────────────────────────────────────────

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  if (id === 'landing' || id === 'picker') startAurora(); else stopAurora();
}

const LOAD_MSGS = [
  'fetching your tracks…',
  'extracting album colors…',
  'clustering your palette…',
  'mixing the gradient…',
];

let loadInterval    = null;
let currentGenerate = null;

async function startGenerate(pl) {
  const token = {};
  currentGenerate = token;
  showScreen('loading');

  let msgIdx = 0;
  const el = document.getElementById('loadText');
  el.textContent = LOAD_MSGS[0];
  el.style.opacity = '1';

  loadInterval = setInterval(() => {
    el.style.opacity = '0';
    setTimeout(() => {
      msgIdx = (msgIdx + 1) % LOAD_MSGS.length;
      el.textContent = LOAD_MSGS[msgIdx];
      el.style.opacity = '1';
    }, 280);
  }, 1800);

  try {
    const tracks = await fetchTracks(pl.id);
    if (currentGenerate !== token) return;

    const { palette, songs } = await buildPalette(tracks);
    if (currentGenerate !== token) return;

    clearInterval(loadInterval);
    buildResults(pl, palette, songs);
    showScreen('results');
    triggerBloom();
  } catch (err) {
    if (currentGenerate !== token) return;
    clearInterval(loadInterval);
    console.error('Pipeline error:', err);
    showScreen('picker');
  }
}

function placeBlobsSeparated(n) {
  const positions = [];
  const MIN_DIST = 0.25;
  const MAX_TRIES = 60;
  for (let i = 0; i < n; i++) {
    let best = null, bestMinDist = -1;
    for (let t = 0; t < MAX_TRIES; t++) {
      const angle = Math.random() * Math.PI * 2;
      const r = 0.30 + Math.random() * 0.32;
      const pos = [0.5 + Math.cos(angle) * r, 0.5 + Math.sin(angle) * r * 0.75];
      let minDist = Infinity;
      for (const p of positions) {
        const dx = pos[0] - p[0], dy = pos[1] - p[1];
        minDist = Math.min(minDist, Math.sqrt(dx*dx + dy*dy));
      }
      if (minDist === Infinity || minDist >= MIN_DIST) { best = pos; break; }
      if (minDist > bestMinDist) { bestMinDist = minDist; best = pos; }
    }
    positions.push(best);
  }
  return positions;
}

function buildResults(pl, palette, songs) {
  document.getElementById('plistName').textContent = pl.name;

  const blobPositions = placeBlobsSeparated(palette.length);

  if (!glReady) glReady = initGL();
  if (glReady) {
    updateGLUniforms(palette, blobPositions);
    startRender();
  }

  buildCovers(songs, blobPositions, palette);
}

function buildCovers(songs, blobPositions, palette) {
  if (coversAnimRaf) { cancelAnimationFrame(coversAnimRaf); coversAnimRaf = null; }
  activeHoverIdx = -1;

  const layer = document.getElementById('dotsLayer');
  layer.innerHTML = '';

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
  layer.appendChild(canvas);

  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.style.position = 'absolute';
  layer.appendChild(tip);

  // Deduplicate by album — one cover per album, collecting all track titles
  const albumMap = new Map();
  songs.forEach(song => {
    if (!albumMap.has(song.albumId)) {
      albumMap.set(song.albumId, { ...song, titles: [song.title] });
    } else {
      albumMap.get(song.albumId).titles.push(song.title);
    }
  });
  const uniqueSongs = Array.from(albumMap.values());

  const MIN_COVER_DIST = 0.065;
  const MAX_COVER_TRIES = 80;
  const placed = [];

  const clusterCounts = new Array(blobPositions.length).fill(0);
  uniqueSongs.forEach(s => { if (s.clusterIdx >= 0) clusterCounts[s.clusterIdx]++; });

  const blobSafeRadius = blobPositions.map((bp, i) => {
    let minD = Infinity;
    blobPositions.forEach((bp2, j) => {
      if (i === j) return;
      const dx = bp[0] - bp2[0], dy = bp[1] - bp2[1];
      minD = Math.min(minD, Math.sqrt(dx*dx + dy*dy));
    });
    return Math.min(minD * 0.42, 0.28);
  });

  coverSongs = uniqueSongs.map(song => {
    let x, y, best = null, bestMinDist = -1;

    const safeR = song.clusterIdx >= 0 ? blobSafeRadius[song.clusterIdx] : 0.20;
    const count = song.clusterIdx >= 0 ? clusterCounts[song.clusterIdx] : 1;
    const spread = Math.min(Math.sqrt(count) * 0.09, safeR);

    for (let t = 0; t < MAX_COVER_TRIES; t++) {
      let cx, cy;
      if (song.clusterIdx >= 0 && blobPositions[song.clusterIdx]) {
        const [bx, by] = blobPositions[song.clusterIdx];
        cx = Math.max(0.09, Math.min(0.91, bx + (Math.random() - 0.5) * spread * 2.0));
        cy = Math.max(0.09, Math.min(0.91, by + (Math.random() - 0.5) * spread * 1.5));
      } else {
        cx = 0.09 + Math.random() * 0.82;
        cy = 0.09 + Math.random() * 0.82;
      }
      let minDist = Infinity;
      for (const p of placed) {
        const dx = cx - p[0], dy = cy - p[1];
        minDist = Math.min(minDist, Math.sqrt(dx*dx + dy*dy));
      }
      if (minDist === Infinity || minDist >= MIN_COVER_DIST) { best = [cx, cy]; break; }
      if (minDist > bestMinDist) { bestMinDist = minDist; best = [cx, cy]; }
    }

    [x, y] = best;
    placed.push([x, y]);

    const rotation   = (Math.random() - 0.5) * 20;
    const clusterHex = (song.clusterIdx >= 0 && palette[song.clusterIdx])
      ? palette[song.clusterIdx].hex : song.color;
    return { ...song, x, y, rotation, clusterHex, img: null, animScale: 0, animDelay: 0 };
  });

  function sizeCanvas() {
    canvasDpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width  = Math.round(canvas.clientWidth  * canvasDpr);
    canvas.height = Math.round(canvas.clientHeight * canvasDpr);
  }

  let loaded = 0;
  function onLoad() {
    if (++loaded >= coverSongs.length) {
      sizeCanvas();
      coverSongs.forEach(s => { s.animDelay = Math.random() * 700; s.animScale = 0; });
      startCoversAnim(canvas);
    }
  }
  if (!coverSongs.length) { sizeCanvas(); drawCovers(canvas, -1); }
  coverSongs.forEach((s, i) => {
    if (!s.coverUrl) { onLoad(); return; }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload  = () => { coverSongs[i].img = img; onLoad(); };
    img.onerror = onLoad;
    img.src = s.coverUrl;
  });

  if (coversResizeObs) coversResizeObs.disconnect();
  coversResizeObs = new ResizeObserver(() => { sizeCanvas(); drawCovers(canvas, activeHoverIdx); });
  coversResizeObs.observe(layer);

  function getHovered(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    let nearest = -1, nearestDist = 40;
    coverSongs.forEach((s, i) => {
      const d = Math.hypot(mx - s.x * rect.width, my - s.y * rect.height);
      if (d < nearestDist) { nearestDist = d; nearest = i; }
    });
    return nearest;
  }

  canvas.addEventListener('mousemove', e => {
    const idx = getHovered(e.clientX, e.clientY);
    if (idx !== activeHoverIdx) {
      activeHoverIdx = idx;
      drawCovers(canvas, activeHoverIdx);
    }
    if (activeHoverIdx >= 0) {
      canvas.style.cursor = 'pointer';
      const rect = canvas.getBoundingClientRect();
      showCoverTip(tip, coverSongs[activeHoverIdx], rect.width, rect.height);
    } else {
      canvas.style.cursor = '';
      tip.style.opacity = '0';
    }
  });

  canvas.addEventListener('click', e => {
    const idx = getHovered(e.clientX, e.clientY);
    if (idx >= 0 && coverSongs[idx].albumUrl) {
      window.open(coverSongs[idx].albumUrl, '_blank', 'noopener');
    }
  });

  canvas.addEventListener('mouseleave', () => {
    activeHoverIdx = -1;
    drawCovers(canvas, -1);
    tip.style.opacity = '0';
    canvas.style.cursor = '';
  });
}

function drawCovers(canvas, hoveredIdx) {
  const ctx = canvas.getContext('2d');
  if (!ctx || !canvas.width || !canvas.height) return;

  const dpr  = canvasDpr;
  const w    = canvas.width;
  const h    = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const SIZE      = 80 * dpr;
  const HOVERSIZE = 94 * dpr;
  const RADIUS    = 8  * dpr;

  const order = coverSongs.map((_, i) => i)
    .sort((a, b) => (a === hoveredIdx ? 1 : 0) - (b === hoveredIdx ? 1 : 0));

  for (const i of order) {
    const s    = coverSongs[i];
    if (!s.img) continue;
    const isHov = i === hoveredIdx;
    const size  = isHov ? HOVERSIZE : SIZE;
    const half  = size / 2;
    const px    = s.x * w;
    const py    = s.y * h;
    const ang   = s.rotation * Math.PI / 180;

    const scale = s.animScale ?? 1;
    if (scale <= 0) continue;

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.scale(scale, scale);

    ctx.fillStyle = '#000';
    if (isHov) {
      // Pass 1: drop shadow
      ctx.shadowColor   = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur    = 12 * dpr;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 4 * dpr;
      ctx.beginPath(); ctx.roundRect(-half, -half, size, size, RADIUS); ctx.fill();
      // Pass 2: cluster color glow
      ctx.shadowColor   = hexToRgba(s.color, 0.55);
      ctx.shadowBlur    = 20 * dpr;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
      ctx.beginPath(); ctx.roundRect(-half, -half, size, size, RADIUS); ctx.fill();
    } else {
      ctx.shadowColor   = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur    = 12 * dpr;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 4 * dpr;
      ctx.beginPath(); ctx.roundRect(-half, -half, size, size, RADIUS); ctx.fill();
    }

    // Clip and overlay image (shadow off)
    ctx.shadowColor   = 'rgba(0,0,0,0)';
    ctx.shadowBlur    = 0;
    ctx.shadowOffsetY = 0;
    ctx.beginPath();
    ctx.roundRect(-half, -half, size, size, RADIUS);
    ctx.clip();
    ctx.drawImage(s.img, -half, -half, size, size);

    ctx.restore();

    // Border pass (outside clip)
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.scale(scale, scale);
    ctx.strokeStyle = isHov ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.25)';
    ctx.lineWidth   = isHov ? 2 * dpr : Math.max(1, dpr);
    ctx.beginPath();
    ctx.roundRect(-half, -half, size, size, RADIUS);
    ctx.stroke();
    ctx.restore();
  }
}

function showCoverTip(tip, song, w, h) {
  const isLeft = song.x > 0.60;
  tip.className = isLeft ? 'tip tip-left' : 'tip';

  const trackList = song.titles?.length
    ? `<ul class="tip-others">${song.titles.map(t => `<li>${t}</li>`).join('')}</ul>`
    : '';

  tip.innerHTML =
    `<div class="tip-top">` +
      `<div class="tip-title">${song.albumName}</div>` +
      `<div class="tip-artist">${song.artist}</div>` +
      trackList +
    `</div>` +
    `<div class="tip-hex">` +
      `<div class="hex-dot" style="background:${song.color}"></div>` +
      `<span class="hex-val">${song.color}</span>` +
    `</div>`;
  const cx = song.x * w;
  const cy = song.y * h;
  tip.style.top       = cy + 'px';
  tip.style.transform = 'translateY(-50%)';
  if (isLeft) {
    tip.style.left  = '';
    tip.style.right = (w - cx + 16) + 'px';
  } else {
    tip.style.left  = (cx + 16) + 'px';
    tip.style.right = '';
  }
  tip.style.opacity = '1';
}

function goBack() {
  currentGenerate = null;
  clearInterval(loadInterval);
  stopRender();
  document.getElementById('errorToast').classList.remove('visible');
  showScreen('picker');
}

// ── INIT ─────────────────────────────────────────────────────────────────────

async function handleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get('code');
  const error  = params.get('error');
  history.replaceState({}, '', window.location.pathname);
  if (error || !code) { showScreen('landing'); return; }
  try {
    await exchangeToken(code);
    await loadPicker();
  } catch (err) {
    console.error('Auth failed:', err);
    showScreen('landing');
  }
}

async function loadPicker() {
  showScreen('picker');
  try {
    allPlaylists = await fetchPlaylists();
    visibleCount = PAGE_SIZE;
    buildGrid();
  } catch (err) {
    console.error('Failed to load playlists:', err);
    clearTokens();
    showScreen('landing');
  }
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('code') || params.has('error')) { await handleCallback(); return; }
  if (isLoggedIn()) { await loadPicker(); return; }
  showScreen('landing');
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────────

document.getElementById('spotifyBtn').addEventListener('click', startAuth);
document.getElementById('loadMoreBtn').addEventListener('click', () => { visibleCount += PAGE_SIZE; buildGrid(); });
document.getElementById('backBtn').addEventListener('click', goBack);
document.getElementById('logoutBtn').addEventListener('click', () => { clearTokens(); showScreen('landing'); });

init();
