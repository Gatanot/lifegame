// ============================================================
// Perlin Noise — exact match to perlin_noise.cpp
// ============================================================
class PerlinNoise {
  constructor(seed = 0) {
    this.SIZE = 256;
    this.perm = new Uint8Array(this.SIZE * 2);
    this._init(seed);
  }

  setSeed(seed) { this._init(seed); }

  _init(seed) {
    for (let i = 0; i < this.SIZE; i++) this.perm[i] = i;
    let state = seed || 1;
    for (let i = this.SIZE - 1; i > 0; i--) {
      state = (state * 1103515245 + 12345) >>> 0;
      let j = (state >>> 16) % (i + 1);
      let t = this.perm[i];
      this.perm[i] = this.perm[j];
      this.perm[j] = t;
    }
    for (let i = 0; i < this.SIZE; i++) this.perm[this.SIZE + i] = this.perm[i];
  }

  fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  lerp(a, b, t) { return a + t * (b - a); }

  grad2D(hash, x, y) {
    let h = hash & 3;
    let u = h < 2 ? x : y;
    let v = h < 2 ? y : x;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }

  noise2D(x, y) {
    let X = Math.floor(x) & (this.SIZE - 1);
    let Y = Math.floor(y) & (this.SIZE - 1);
    let xf = x - Math.floor(x);
    let yf = y - Math.floor(y);
    let u = this.fade(xf);
    let v = this.fade(yf);
    let aa = this.perm[this.perm[X] + Y];
    let ab = this.perm[this.perm[X] + Y + 1];
    let ba = this.perm[this.perm[X + 1] + Y];
    let bb = this.perm[this.perm[X + 1] + Y + 1];
    let x1 = this.lerp(this.grad2D(aa, xf, yf), this.grad2D(ba, xf - 1, yf), u);
    let x2 = this.lerp(this.grad2D(ab, xf, yf - 1), this.grad2D(bb, xf - 1, yf - 1), u);
    return this.lerp(x1, x2, v);
  }

  fbm2D(x, y, octaves = 4, lacunarity = 2, gain = 0.5) {
    let value = 0, amplitude = 1, frequency = 1, maxVal = 0;
    for (let i = 0; i < octaves; i++) {
      value += amplitude * this.noise2D(x * frequency, y * frequency);
      maxVal += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return value / maxVal;
  }
}

// ============================================================
// Game of Life — exact match to lifegame.ino
// ============================================================
const COLS = 200;
const ROWS = 150;

let grid = new Uint8Array(COLS * ROWS);
let generation = 0;
let running = false;
let timerId = null;
let speedMs = 200;

const TERRAIN_COUNT = 6;
const TERRAIN_HABITABILITY = [0.02, 0.05, 0.15, 0.50, 0.70, 0.25];
const TERRAIN_NAMES = ['深海', '浅海', '沙滩', '草原', '森林', '山地'];
const TERRAIN_COLORS = ['#1a3a5c', '#2a6a9c', '#c4a86a', '#5a8a3a', '#2a5a1a', '#8a8a8a'];
const SURVIVE_MIN = [3, 2, 2, 2, 2, 2];
const SURVIVE_MAX = [3, 3, 4, 3, 4, 3];
const BIRTH_MIN   = [1, 3, 3, 3, 3, 3];
const BIRTH_MAX   = [0, 3, 3, 3, 4, 4];

// Elevation → terrain: 0-50 deep water, 51-80 shallow, 81-110 beach,
// 111-160 grassland, 161-200 forest, 201-255 mountain
const ELEV_BOUNDS = [51, 81, 111, 161, 201];
const EROSION_RATE = 0.008;       // per-neighbor erosion fraction (was 0.04 — much gentler)
const DIFFUSION_RATE = 0.06;      // smoothing blend fraction (was 0.005 — 12x stronger)
const BASE_LEVEL = 60;
const UPLIFT_AMOUNT = 0.12;       // coherent Perlin noise uplift amplitude (was 0.3)
const MIN_SLOPE = 1.5;            // minimum elevation drop to trigger erosion
const FLOW_EROSION_BONUS = 0.04;  // extra erosion per unit sqrt(flow)

// Catastrophic events — rare geological disruptions
const CATASTROPHE_INTERVAL = 7;   // terrain-evo cycles between events (7×20=140 gens ≈ 28s)
const CAT_RADIUS_MIN = 12;
const CAT_RADIUS_MAX = 40;
const CAT_UPLIFT_MIN = 35;
const CAT_UPLIFT_MAX = 100;
const CAT_DROP_MIN = 25;
const CAT_DROP_MAX = 80;

let elevationMap = new Float32Array(COLS * ROWS);
let showTerrain = false;
let terrainEvoInterval = 20;
let terrainNoise = new PerlinNoise(42);
let upliftNoise = new PerlinNoise(42 ^ 0xABCD);
let terrainEvoCount = 0;  // counts elevationUpdate() calls

function getTerrainFromElevation(e) {
  for (let i = 0; i < ELEV_BOUNDS.length; i++) {
    if (e < ELEV_BOUNDS[i]) return i;
  }
  return 5;
}

function golRandomize(seed, scale, threshold, octaves) {
  terrainNoise.setSeed(seed);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      let val = terrainNoise.fbm2D(x * scale, y * scale, octaves);
      let elev = (val + 1) * 127.5;
      elevationMap[y * COLS + x] = elev;
      let t = getTerrainFromElevation(elev);
      let p = TERRAIN_HABITABILITY[t];
      grid[y * COLS + x] = Math.random() < p ? 1 : 0;
    }
  }
  generation = 0;
}

function golClear() {
  grid.fill(0);
  generation = 0;
}

function golUpdate() {
  let newGrid = new Uint8Array(COLS * ROWS);
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        let ny = (y + dy + ROWS) % ROWS;
        for (let dx = -1; dx <= 1; dx++) {
          if (dy === 0 && dx === 0) continue;
          let nx = (x + dx + COLS) % COLS;
          n += grid[ny * COLS + nx];
        }
      }
      let cell = grid[y * COLS + x];
      let t = getTerrainFromElevation(elevationMap[y * COLS + x]);
      if (cell) {
        newGrid[y * COLS + x] = (n >= SURVIVE_MIN[t] && n <= SURVIVE_MAX[t]) ? 1 : 0;
      } else {
        newGrid[y * COLS + x] = (n >= BIRTH_MIN[t] && n <= BIRTH_MAX[t]) ? 1 : 0;
      }
    }
  }
  grid = newGrid;
  generation++;
}

// Terrain evolution — hydraulic erosion + coherent uplift + stronger diffusion
function elevationUpdate() {
  let N = COLS * ROWS;
  let newElev = new Float32Array(elevationMap);

  // ==========================================================
  // Phase 1: Hydraulic flow accumulation
  // Sort cells by elevation descending; route water downhill.
  // ==========================================================
  let waterFlow = new Float32Array(N);
  let indices = new Uint32Array(N);
  for (let i = 0; i < N; i++) indices[i] = i;
  indices.sort((a, b) => elevationMap[b] - elevationMap[a]);

  for (let i = 0; i < N; i++) {
    let idx = indices[i];
    let y = (idx / COLS) | 0;
    let x = idx % COLS;
    let e = elevationMap[idx];
    let lowestNi = -1, lowestE = e;

    for (let dy = -1; dy <= 1; dy++) {
      let ny = (y + dy + ROWS) % ROWS;
      for (let dx = -1; dx <= 1; dx++) {
        if (dy === 0 && dx === 0) continue;
        let ni = ny * COLS + ((x + dx + COLS) % COLS);
        if (elevationMap[ni] < lowestE) {
          lowestE = elevationMap[ni];
          lowestNi = ni;
        }
      }
    }
    if (lowestNi >= 0) {
      waterFlow[lowestNi] += 1 + waterFlow[idx];
    }
  }

  // ==========================================================
  // Phase 2: Slope-thresholded hydraulic erosion
  // Bio-feedback: living cells protect terrain, barren cells erode faster.
  // ==========================================================
  for (let i = 0; i < N; i++) {
    let idx = indices[i];
    let y = (idx / COLS) | 0;
    let x = idx % COLS;
    let e = newElev[idx];
    if (e <= BASE_LEVEL) continue;

    let maxDrop = 0, steepestNi = -1;
    let density = grid[idx];  // 3×3 local population density (include self)
    for (let dy = -1; dy <= 1; dy++) {
      let ny = (y + dy + ROWS) % ROWS;
      for (let dx = -1; dx <= 1; dx++) {
        if (dy === 0 && dx === 0) continue;
        let ni = ny * COLS + ((x + dx + COLS) % COLS);
        let drop = e - newElev[ni];
        if (drop > maxDrop) { maxDrop = drop; steepestNi = ni; }
        density += grid[ni];
      }
    }
    density /= 9;
    if (maxDrop < MIN_SLOPE) continue;

    let bioFactor = density > 0.5 ? 0.3 : (density < 0.2 ? 1.5 : 0.7);
    let flowFactor = Math.sqrt(waterFlow[idx] + 1) * FLOW_EROSION_BONUS;
    let erosion = (EROSION_RATE + flowFactor) * maxDrop * bioFactor;
    let realErosion = Math.min(erosion, e - BASE_LEVEL);

    if (realErosion > 0 && steepestNi >= 0) {
      newElev[idx] -= realErosion;
      newElev[steepestNi] += realErosion * 0.85;  // 85% deposited, 15% dissolved
    }
  }

  // Phase 2b: Organic deposition — dead cells amid life gather sediment
  for (let i = 0; i < N; i++) {
    if (grid[i]) continue;
    let y = (i / COLS) | 0;
    let x = i % COLS;
    let density = 0;
    for (let dy = -1; dy <= 1; dy++) {
      let ny = (y + dy + ROWS) % ROWS;
      for (let dx = -1; dx <= 1; dx++) {
        density += grid[ny * COLS + ((x + dx + COLS) % COLS)];
      }
    }
    density /= 9;
    if (density > 0.3) {
      newElev[i] += density * 0.08;
    }
  }

  for (let i = 0; i < N; i++)
    elevationMap[i] = newElev[i];

  // ==========================================================
  // Phase 3: Coherent Perlin-noise uplift (replaces white noise)
  // Two-octave noise at landscape scale creates mountain ranges.
  // ==========================================================
  let uScale = 0.03;  // large scale → continent-level features
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      let idx = y * COLS + x;
      let u = upliftNoise.noise2D(x * uScale, y * uScale);
      let v = upliftNoise.noise2D(x * uScale * 2.7 + 3.1, y * uScale * 2.7 + 3.1);
      elevationMap[idx] += (u * 0.7 + v * 0.3) * UPLIFT_AMOUNT * 2.5;
    }
  }

  // ==========================================================
  // Phase 4: Stronger diffusion — smooths uplift into round hills
  // ==========================================================
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) {
      let idx = y * COLS + x;
      let avg = 0;
      for (let dy = -1; dy <= 1; dy++) {
        let ny = (y + dy + ROWS) % ROWS;
        for (let dx = -1; dx <= 1; dx++) {
          if (dy === 0 && dx === 0) continue;
          avg += elevationMap[ny * COLS + ((x + dx + COLS) % COLS)];
        }
      }
      avg /= 8;
      newElev[idx] = elevationMap[idx] * (1 - DIFFUSION_RATE) + avg * DIFFUSION_RATE;
    }
  }

  // ==========================================================
  // Phase 5: Catastrophic events — rare uplift / collapse / flood
  // ==========================================================
  terrainEvoCount++;
  if (terrainEvoCount >= CATASTROPHE_INTERVAL) {
    terrainEvoCount = 0;
    let cx = (Math.random() * COLS) | 0;
    let cy = (Math.random() * ROWS) | 0;
    let radius = CAT_RADIUS_MIN + Math.random() * (CAT_RADIUS_MAX - CAT_RADIUS_MIN);
    let r2 = radius * radius;
    let type = Math.random();

    // Bounding box for efficiency
    let x0 = Math.max(0, cx - radius | 0);
    let x1 = Math.min(COLS - 1, cx + radius | 0);
    let y0 = Math.max(0, cy - radius | 0);
    let y1 = Math.min(ROWS - 1, cy + radius | 0);

    if (type < 0.30) {
      // Uplift: volcanic mountain  (30%)
      let amount = CAT_UPLIFT_MIN + Math.random() * (CAT_UPLIFT_MAX - CAT_UPLIFT_MIN);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          let dx = x - cx, dy = y - cy;
          let d2 = dx * dx + dy * dy;
          if (d2 < r2) {
            let t = 1 - d2 / r2;
            let factor = t * t * (3 - 2 * t);  // smoothstep
            newElev[y * COLS + x] += amount * factor;
            if (grid[y * COLS + x]) grid[y * COLS + x] = 0;  // kill life
          }
        }
      }
    } else if (type < 0.60) {
      // Collapse: sinkhole / caldera  (30%)
      let amount = CAT_DROP_MIN + Math.random() * (CAT_DROP_MAX - CAT_DROP_MIN);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          let dx = x - cx, dy = y - cy;
          let d2 = dx * dx + dy * dy;
          if (d2 < r2) {
            let t = 1 - d2 / r2;
            let factor = t * t * (3 - 2 * t);
            newElev[y * COLS + x] -= amount * factor;
            if (grid[y * COLS + x]) grid[y * COLS + x] = 0;
          }
        }
      }
    } else if (type < 0.80) {
      // Flood: sudden sea-level incursion  (20%)
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          let dx = x - cx, dy = y - cy;
          let d2 = dx * dx + dy * dy;
          if (d2 < r2) {
            let t = 1 - d2 / r2;
            let factor = t * t * (3 - 2 * t);
            let current = newElev[y * COLS + x];
            let target = BASE_LEVEL - 5 - Math.random() * 20;
            newElev[y * COLS + x] += (target - current) * factor;
            if (grid[y * COLS + x]) grid[y * COLS + x] = 0;
          }
        }
      }
    }
  }

  // Finalize: clamp [0, 255]
  for (let i = 0; i < N; i++) {
    let v = newElev[i];
    if (v < 0) v = 0;
    if (v > 255) v = 255;
    elevationMap[i] = v;
  }
}

function countPopulation() {
  let c = 0;
  for (let i = 0; i < grid.length; i++) c += grid[i];
  return c;
}

// ============================================================
// Rendering
// ============================================================
const canvas = document.getElementById('gridCanvas');
const ctx = canvas.getContext('2d');

const CELL_MAX = 6;
let cellSize = 4;

function computeCellSize() {
  let wrap = document.getElementById('canvasWrap');
  let maxW = Math.min(window.innerWidth - 320, 1200);
  let maxH = window.innerHeight - 40;
  let cs = Math.min(Math.floor(maxW / COLS), Math.floor(maxH / ROWS), CELL_MAX);
  cellSize = Math.max(2, cs);
}

function resizeCanvas() {
  computeCellSize();
  canvas.width = COLS * cellSize;
  canvas.height = ROWS * cellSize;
  draw();
}

function hexToRgb(hex) {
  let r = parseInt(hex.slice(1, 3), 16);
  let g = parseInt(hex.slice(3, 5), 16);
  let b = parseInt(hex.slice(5, 7), 16);
  return [r, g, b, 255];
}

function draw() {
  let w = canvas.width;
  let h = canvas.height;
  let imgData = ctx.createImageData(w, h);
  let data = imgData.data;

  for (let gy = 0; gy < ROWS; gy++) {
    for (let gx = 0; gx < COLS; gx++) {
      let px = gx * cellSize;
      let py = gy * cellSize;
      let alive = grid[gy * COLS + gx];

      let r, g, b;
      if (showTerrain) {
        let t = getTerrainFromElevation(elevationMap[gy * COLS + gx]);
        let tc = hexToRgb(TERRAIN_COLORS[t]);
        if (alive) {
          let a = 0.4;
          r = (tc[0] * (1 - a) + 255 * a) | 0;
          g = (tc[1] * (1 - a) + 255 * a) | 0;
          b = (tc[2] * (1 - a) + 255 * a) | 0;
        } else {
          r = tc[0]; g = tc[1]; b = tc[2];
        }
      } else {
        if (alive) {
          r = 30; g = 41; b = 59;
        } else {
          r = 255; g = 255; b = 255;
        }
      }

      for (let dy = 0; dy < cellSize; dy++) {
        for (let dx = 0; dx < cellSize; dx++) {
          let off = ((py + dy) * w + (px + dx)) * 4;
          data[off] = r;
          data[off + 1] = g;
          data[off + 2] = b;
          data[off + 3] = 255;
        }
      }
    }
  }

  if (cellSize >= 4) {
    for (let gy = 1; gy < ROWS; gy++) {
      let py = gy * cellSize;
      for (let dx = 0; dx < w; dx++) {
        let off = (py * w + dx) * 4;
        data[off] = (data[off] * 0.92) | 0;
        data[off + 1] = (data[off + 1] * 0.92) | 0;
        data[off + 2] = (data[off + 2] * 0.92) | 0;
      }
    }
    for (let gx = 1; gx < COLS; gx++) {
      let px = gx * cellSize;
      for (let dy = 0; dy < h; dy++) {
        let off = (dy * w + px) * 4;
        data[off] = (data[off] * 0.92) | 0;
        data[off + 1] = (data[off + 1] * 0.92) | 0;
        data[off + 2] = (data[off + 2] * 0.92) | 0;
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  updateStats();
}

function updateStats() {
  document.getElementById('genDisplay').textContent = generation;
  document.getElementById('popDisplay').textContent = countPopulation();
}

// ============================================================
// Simulation controls
// ============================================================
function step() {
  golUpdate();
  if (generation % terrainEvoInterval === 0) {
    elevationUpdate();
    renderTerrainLegend();
  }
  draw();
}

function play() {
  if (timerId) return;
  running = true;
  document.getElementById('btnPlay').textContent = '⏸';
  tick();
}

function pause() {
  if (timerId) {
    clearTimeout(timerId);
    timerId = null;
  }
  running = false;
  document.getElementById('btnPlay').textContent = '▶';
}

function tick() {
  if (!running) return;
  step();
  timerId = setTimeout(tick, speedMs);
}

document.getElementById('btnPlay').addEventListener('click', () => {
  running ? pause() : play();
});

document.getElementById('btnStep').addEventListener('click', step);

document.getElementById('btnClear').addEventListener('click', () => {
  pause();
  golClear();
  draw();
});

document.getElementById('btnToggleView').addEventListener('click', () => {
  showTerrain = !showTerrain;
  document.getElementById('btnToggleView').textContent = showTerrain ? '🌿 细胞' : '🗺 地形';
  draw();
});

document.getElementById('speedSlider').addEventListener('input', (e) => {
  speedMs = parseInt(e.target.value);
  if (running) { pause(); play(); }
});

// ============================================================
// Perlin noise generation
// ============================================================
document.getElementById('evoInterval').addEventListener('input', (e) => {
  terrainEvoInterval = parseInt(e.target.value);
});

document.getElementById('btnGenPerlin').addEventListener('click', () => {
  pause();
  let seed = parseInt(document.getElementById('perlinSeed').value) || 42;
  let scale = parseFloat(document.getElementById('perlinScale').value) || 0.06;
  let thresh = parseFloat(document.getElementById('perlinThresh').value) || 0.05;
  let oct = parseInt(document.getElementById('perlinOct').value) || 3;
  golRandomize(seed, scale, thresh, oct);
  draw();
});

document.getElementById('btnRandSeed').addEventListener('click', () => {
  pause();
  let seed = (Math.random() * 0xFFFFFFFF) >>> 0;
  document.getElementById('perlinSeed').value = seed;
  let scale = parseFloat(document.getElementById('perlinScale').value) || 0.06;
  let thresh = parseFloat(document.getElementById('perlinThresh').value) || 0.05;
  let oct = parseInt(document.getElementById('perlinOct').value) || 3;
  golRandomize(seed, scale, thresh, oct);
  draw();
});

// ============================================================
// Mouse interaction — click/drag to paint
// ============================================================
let mouseDown = false;
let paintValue = 1;

canvas.addEventListener('mousedown', (e) => {
  mouseDown = true;
  let rect = canvas.getBoundingClientRect();
  let gx = Math.floor((e.clientX - rect.left) / (rect.width / COLS));
  let gy = Math.floor((e.clientY - rect.top) / (rect.height / ROWS));
  if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return;
  paintValue = grid[gy * COLS + gx] ? 0 : 1;
  setCell(gx, gy);
});

canvas.addEventListener('mousemove', (e) => {
  if (!mouseDown) return;
  let rect = canvas.getBoundingClientRect();
  let gx = Math.floor((e.clientX - rect.left) / (rect.width / COLS));
  let gy = Math.floor((e.clientY - rect.top) / (rect.height / ROWS));
  if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return;
  setCell(gx, gy);
});

window.addEventListener('mouseup', () => { mouseDown = false; });

function setCell(gx, gy) {
  grid[gy * COLS + gx] = paintValue;
  drawCell(gx, gy);
  updateStats();
}

function drawCell(gx, gy) {
  if (showTerrain) return;
  let px = gx * cellSize;
  let py = gy * cellSize;
  let alive = grid[gy * COLS + gx];
  ctx.fillStyle = alive ? '#1e293b' : '#fff';
  ctx.fillRect(px, py, cellSize, cellSize);
  if (cellSize >= 4) {
    ctx.fillStyle = '#e5e7eb';
    if (px > 0) ctx.fillRect(px, py, 1, cellSize);
    if (py > 0) ctx.fillRect(px, py, cellSize, 1);
  }
}

// Touch support
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  let touch = e.touches[0];
  let rect = canvas.getBoundingClientRect();
  let gx = Math.floor((touch.clientX - rect.left) / (rect.width / COLS));
  let gy = Math.floor((touch.clientY - rect.top) / (rect.height / ROWS));
  if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return;
  paintValue = grid[gy * COLS + gx] ? 0 : 1;
  setCell(gx, gy);
});

canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  let touch = e.touches[0];
  let rect = canvas.getBoundingClientRect();
  let gx = Math.floor((touch.clientX - rect.left) / (rect.width / COLS));
  let gy = Math.floor((touch.clientY - rect.top) / (rect.height / ROWS));
  if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return;
  let idx = gy * COLS + gx;
  if (grid[idx] !== paintValue) { grid[idx] = paintValue; drawCell(gx, gy); updateStats(); }
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  let rect = canvas.getBoundingClientRect();
  let gx = Math.floor((e.clientX - rect.left) / (rect.width / COLS));
  let gy = Math.floor((e.clientY - rect.top) / (rect.height / ROWS));
  if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return;
  grid[gy * COLS + gx] = 0;
  draw();
});

// ============================================================
// Init
// ============================================================
function renderTerrainLegend() {
  let el = document.getElementById('terrainLegend');
  el.innerHTML = '';
  for (let i = 0; i < TERRAIN_COUNT; i++) {
    let d = document.createElement('div');
    d.style.cssText = 'display:flex;align-items:center;gap:4px;';
    let sMin = SURVIVE_MIN[i], sMax = SURVIVE_MAX[i];
    let bMin = BIRTH_MIN[i], bMax = BIRTH_MAX[i];
    let sStr = sMax >= sMin ? `${sMin}–${sMax}` : '—';
    let bStr = bMax >= bMin ? `${bMin}–${bMax}` : '—';
    d.innerHTML = `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${TERRAIN_COLORS[i]};flex-shrink:0;"></span>` +
      `<span style="color:#8a8aaa;">${TERRAIN_NAMES[i]}</span>` +
      `<span style="color:#5a5a7a;margin-left:auto;font-size:9px;">活${sStr} 生${bStr}</span>`;
    el.appendChild(d);
  }
}

resizeCanvas();
golRandomize(42, 0.06, 0.05, 3);
renderTerrainLegend();
draw();

window.addEventListener('resize', resizeCanvas);

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === ' ' || e.key === 'p') { e.preventDefault(); running ? pause() : play(); }
  if (e.key === 'Enter') step();
  if (e.key === 'c') { pause(); golClear(); draw(); }
  if (e.key === 't') { showTerrain = !showTerrain; document.getElementById('btnToggleView').textContent = showTerrain ? '🌿 细胞' : '🗺 地形'; draw(); }
});
