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
        const [r,g,b] = new ColorThief().getColor(img);
        resolve('#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join(''));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = imgUrl;
  });
}

async function buildPalette(tracks) {

  const selected = tracks.slice(0, 25);
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

  const palette = top5.map(c => ({ hex: c.hex, count: c.count }));
  const songs = valid.map((v,i) => ({
    title:      v.track.name,
    artist:     v.track.artists[0]?.name || '',
    color:      v.hex,
    clusterIdx: origToSorted[assignments[i]] ?? -1,
  }));

  return { palette, songs };
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
    float sigma = 0.04 + uWeights[i] * 0.10;
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
  const weights  = palette.map(c => Math.sqrt(c.count / maxCount));
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

function buildResults(pl, palette, songs) {
  document.getElementById('plistName').textContent = pl.name;

  const blobPositions = palette.map(() => {
    const angle = Math.random() * Math.PI * 2;
    const r = 0.22 + Math.random() * 0.22;
    return [0.5 + Math.cos(angle)*r, 0.5 + Math.sin(angle)*r*0.75];
  });

  if (!glReady) glReady = initGL();
  if (glReady) {
    updateGLUniforms(palette, blobPositions);
    startRender();
  }

  buildDots(songs, blobPositions);
}

function buildDots(songs, blobPositions) {
  const layer = document.getElementById('dotsLayer');
  layer.innerHTML = '';

  songs.forEach((song, i) => {
    let x, y;
    if (song.clusterIdx >= 0 && blobPositions[song.clusterIdx]) {
      const [bx, by] = blobPositions[song.clusterIdx];
      x = Math.max(0.06, Math.min(0.94, bx + (Math.random()-0.5)*0.55));
      y = Math.max(0.06, Math.min(0.94, by + (Math.random()-0.5)*0.45));
    } else {
      x = 0.1 + Math.random()*0.8;
      y = 0.1 + Math.random()*0.8;
    }

    const dot = document.createElement('div');
    dot.className = 'sdot';
    dot.style.left = (x*100)+'%';
    dot.style.top  = (y*100)+'%';
    dot.style.setProperty('--song-color', song.color);
    dot.style.backgroundColor = 'rgba(255,255,255,0.25)';
    dot.style.borderColor     = 'rgba(255,255,255,0.15)';
    dot.style.animationDelay  = (550 + i*60)+'ms';

    const center = document.createElement('div');
    center.className = 'sdot-center';
    center.style.background = song.color;

    const tip = document.createElement('div');
    tip.className = x > 0.60 ? 'tip tip-left' : 'tip';
    tip.innerHTML =
      `<div class="tip-title">${song.title}</div>`+
      `<div class="tip-artist">${song.artist}</div>`+
      `<div class="tip-hex">`+
        `<div class="hex-dot" style="background:${song.color}"></div>`+
        `<span class="hex-val">${song.color}</span>`+
      `</div>`;

    dot.appendChild(center);
    dot.appendChild(tip);
    layer.appendChild(dot);
  });
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
