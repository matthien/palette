// ── DATA ──────────────────────────────────────────────────────────────────

const PLAYLIST_NAME = 'late august drives';

const SONGS = [
  { title: 'Night Drive',  artist: 'Mk.gee',           color: '#9B2FCA', x: 0.10, y: 0.24 },
  { title: 'Blood Orange', artist: 'Frank Ocean',       color: '#FF4500', x: 0.76, y: 0.28 },
  { title: 'Slow Burn',    artist: 'Kacey Musgraves',   color: '#E8826A', x: 0.43, y: 0.41 },
  { title: 'Ultraviolet',  artist: 'Starcrawler',       color: '#6A0DAD', x: 0.26, y: 0.58 },
  { title: 'Crash',        artist: 'Usher',             color: '#C0392B', x: 0.60, y: 0.64 },
  { title: 'Desert Rain',  artist: 'FKA Twigs',         color: '#D4A017', x: 0.18, y: 0.74 },
  { title: 'Something',    artist: 'The Beatles',       color: '#2E86AB', x: 0.83, y: 0.50 },
  { title: 'Afterimage',   artist: 'Rush',              color: '#7B68EE', x: 0.53, y: 0.79 },
  { title: 'Neon Haze',    artist: 'FKA Twigs',         color: '#FF6EC7', x: 0.86, y: 0.71 },
  { title: 'Half Light',   artist: 'Sufjan Stevens',    color: '#B0C4DE', x: 0.36, y: 0.26 },
  { title: 'Retrograde',   artist: 'James Blake',       color: '#4169E1', x: 0.05, y: 0.49 },
  { title: 'Superstar',    artist: 'Sheryl Crow',       color: '#FF8C00', x: 0.66, y: 0.21 },
];

const LOAD_MSGS = [
  'reading your playlist…',
  'extracting album art…',
  'picking dominant colors…',
  'feeling the vibe…',
  'mixing the palette…',
];

// ── SHADERS ───────────────────────────────────────────────────────────────

const VERT_SRC = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision highp float;

const int N = 12;

uniform vec2  iResolution;
uniform float iTime;
uniform vec3  uColors[N];
uniform vec2  uPositions[N];

out vec4 fragColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 uv = gl_FragCoord.xy / iResolution;
  uv.y = 1.0 - uv.y; // flip Y to match CSS coordinate system
  float aspect = iResolution.x / iResolution.y;

  // Subtle domain warp so the background breathes
  float t = iTime * 0.04;
  uv.x += sin(uv.y * 3.1 + t) * 0.005;
  uv.y += cos(uv.x * 2.7 + t * 1.1) * 0.004;

  // Inverse-distance-weighted blend — each pixel is colored by nearby songs
  // The closer a song is to this pixel, the more its color dominates
  vec3  col         = vec3(0.0);
  float totalWeight = 0.001; // near-zero anchor so corners fill with color

  for (int i = 0; i < N; i++) {
    vec2 d = uv - uPositions[i];
    d.x *= aspect; // correct for non-square viewport so blobs are circular
    float w = exp(-dot(d, d) / 0.05); // larger sigma fills corners
    col         += uColors[i] * w;
    totalWeight += w;
  }

  col /= totalWeight;

  // Contrast
  col = (col - 0.5) * 1.35 + 0.5;

  // Film grain
  col += (hash(uv * 750.0 + fract(iTime)) - 0.5) * 0.055;

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ── WEBGL SETUP ───────────────────────────────────────────────────────────

let gl, program, rafId, resizeObserver;
const startTime = performance.now();

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return [r, g, b];
}

function compileShader(type, src) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  return shader;
}

function initGL() {
  const canvas = document.getElementById('resultBg');
  gl = canvas.getContext('webgl2');
  if (!gl) return false;

  // Full-screen triangle (covers clip space with 3 vertices)
  const verts = new Float32Array([-1, -1, 3, -1, -1, 3]);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

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

  // Upload song colors and positions as uniforms (set once, never change)
  const flatColors    = new Float32Array(SONGS.flatMap(s => hexToRgb(s.color)));
  const flatPositions = new Float32Array(SONGS.flatMap(s => [s.x, s.y]));
  gl.uniform3fv(gl.getUniformLocation(program, 'uColors'),    flatColors);
  gl.uniform2fv(gl.getUniformLocation(program, 'uPositions'), flatPositions);

  // Watch for canvas size changes
  resizeObserver = new ResizeObserver(() => resizeCanvas(canvas));
  resizeObserver.observe(canvas);
  resizeCanvas(canvas);

  return true;
}

function resizeCanvas(canvas) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w   = Math.round(canvas.clientWidth  * dpr);
  const h   = Math.round(canvas.clientHeight * dpr);
  if (canvas.width === w && canvas.height === h) return;
  canvas.width  = w;
  canvas.height = h;
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
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
}

// ── SCREEN NAVIGATION ─────────────────────────────────────────────────────

let loadTimer, loadInterval;
let glReady = false;

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function generate() {
  showScreen('loading');
  let i = 0;
  const el = document.getElementById('loadText');
  el.textContent = LOAD_MSGS[0];
  el.style.opacity = '1';

  loadInterval = setInterval(() => {
    el.style.opacity = '0';
    setTimeout(() => {
      i = (i + 1) % LOAD_MSGS.length;
      el.textContent = LOAD_MSGS[i];
      el.style.opacity = '1';
    }, 280);
  }, 750);

  loadTimer = setTimeout(() => {
    clearInterval(loadInterval);
    buildResults();
    showScreen('results');
  }, 3500);
}

function buildResults() {
  document.getElementById('plistName').textContent = PLAYLIST_NAME;

  if (!glReady) {
    glReady = initGL();
  }
  if (glReady) {
    startRender();
  }

  buildDots();
}

function buildDots() {
  const layer = document.getElementById('dotsLayer');
  layer.innerHTML = '';

  SONGS.forEach((song, i) => {
    const dot = document.createElement('div');
    dot.className = 'sdot';
    dot.style.left            = (song.x * 100) + '%';
    dot.style.top             = (song.y * 100) + '%';
    dot.style.backgroundColor = song.color + '22';
    dot.style.borderColor     = song.color + '99';
    dot.style.animationDelay  = (550 + i * 60) + 'ms';

    const center = document.createElement('div');
    center.className = 'sdot-center';
    center.style.background = song.color;

    const tipLeft = song.x > 0.60;
    const tip = document.createElement('div');
    tip.className = tipLeft ? 'tip tip-left' : 'tip';
    tip.innerHTML =
      `<div class="tip-title">${song.title}</div>` +
      `<div class="tip-artist">${song.artist}</div>` +
      `<div class="tip-hex">` +
        `<div class="hex-dot" style="background:${song.color}"></div>` +
        `<span class="hex-val">${song.color}</span>` +
      `</div>`;

    dot.appendChild(center);
    dot.appendChild(tip);
    layer.appendChild(dot);
  });
}

function goBack() {
  clearTimeout(loadTimer);
  clearInterval(loadInterval);
  stopRender();
  glReady = false;
  gl = null;
  program = null;
  document.getElementById('urlInput').value = '';
  showScreen('landing');
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────

document.getElementById('genBtn').addEventListener('click', generate);
document.getElementById('backBtn').addEventListener('click', goBack);
document.getElementById('urlInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') generate();
});
