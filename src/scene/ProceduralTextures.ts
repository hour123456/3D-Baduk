import * as THREE from 'three';
import { BoardSize } from '../rules/types';
import { getStarPoints } from '../rules/GoEngine';

const GO_COL_LABELS = 'ABCDEFGHJKLMNOPQRST';

// Fast deterministic 2D value noise + FBM for realistic organic wood & shell grain
function hash2D(ix: number, iy: number, seed: number): number {
  let n = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function smoothNoise2D(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const a = hash2D(ix, iy, seed);
  const b = hash2D(ix + 1, iy, seed);
  const c = hash2D(ix, iy + 1, seed);
  const d = hash2D(ix + 1, iy + 1, seed);

  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm2D(x: number, y: number, seed: number, octaves = 4): number {
  let val = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    val += amp * smoothNoise2D(x * freq, y * freq, seed + i * 31);
    freq *= 2.03;
    amp *= 0.5;
  }
  return val;
}

export interface GobanSurfaceTextures {
  map: THREE.CanvasTexture;
  bumpMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

export interface BoardGridMetrics {
  size: BoardSize;
  boardWidth: number;
  boardDepth: number;
  slabThickness: number;
  gridSpanX: number;
  gridSpanZ: number;
  cellX: number;
  cellZ: number;
  stoneRadius: number;
  stoneHeight: number;
}

export function getBoardMetrics(size: BoardSize): BoardGridMetrics {
  const boardWidth = 4.36;
  const boardDepth = 4.64;
  const slabThickness = 1.32;

  let gridSpanX = 3.78;
  let gridSpanZ = 4.02;
  let stoneRadius = 0.1015;

  if (size === 15) {
    gridSpanX = 3.66;
    gridSpanZ = 3.88;
    stoneRadius = 0.123;
  } else if (size === 13) {
    gridSpanX = 3.54;
    gridSpanZ = 3.76;
    stoneRadius = 0.138;
  } else if (size === 9) {
    gridSpanX = 3.28;
    gridSpanZ = 3.48;
    stoneRadius = 0.184;
  }

  const intervals = size - 1;
  const cellX = gridSpanX / intervals;
  const cellZ = gridSpanZ / intervals;
  const stoneHeight = stoneRadius * 0.92; // Authentic thick 36-go slate/clamshell proportion

  return {
    size,
    boardWidth,
    boardDepth,
    slabThickness,
    gridSpanX,
    gridSpanZ,
    cellX,
    cellZ,
    stoneRadius,
    stoneHeight,
  };
}

/**
 * Generates high-resolution (2048x2048) Kaya Wood (비자나무) top texture with raised black lacquer grid lines,
 * star points (화점), coordinate markings, bump map, and roughness map.
 */
export function createGobanTopTextures(
  metrics: BoardGridMetrics,
  showCoordinates = true
): GobanSurfaceTextures {
  const res = 2048;

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = res;
  colorCanvas.height = res;
  const cCtx = colorCanvas.getContext('2d')!;

  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = res;
  bumpCanvas.height = res;
  const bCtx = bumpCanvas.getContext('2d')!;

  const roughCanvas = document.createElement('canvas');
  roughCanvas.width = res;
  roughCanvas.height = res;
  const rCtx = roughCanvas.getContext('2d')!;

  const colorImg = cCtx.createImageData(res, res);
  const bumpImg = bCtx.createImageData(res, res);
  const roughImg = rCtx.createImageData(res, res);

  const cData = colorImg.data;
  const bData = bumpImg.data;
  const rData = roughImg.data;

  // Golden Honey Kaya Wood (비자나무 특유의 따뜻하고 기품 있는 황금 호박빛 결)
  for (let py = 0; py < res; py++) {
    const ny = py / res;
    for (let px = 0; px < res; px++) {
      const nx = px / res;
      const idx = (py * res + px) * 4;

      // Subtle straight-cut Masa-me (정목/곧은결) Kaya rings running vertically along Z
      const warp = fbm2D(nx * 5.5, ny * 2.2, 101, 4) * 0.35;
      const ringCoord = (nx + 0.12) * 38.0 + warp * 5.2 + Math.sin(ny * Math.PI * 1.4) * 0.65;
      const ringWave = 0.5 + 0.5 * Math.sin(ringCoord * Math.PI * 2);
      const sharpRing = Math.pow(ringWave, 2.6);

      // Fine vertical wood fiber pores
      const fineFiber = smoothNoise2D(nx * 240, ny * 28, 777);
      const microTone = fbm2D(nx * 12, ny * 12, 303, 3);

      // Rich Kaya palette: base #d9a055 -> ring #b77932 -> highlight #e5b46c
      const r = Math.min(255, Math.max(0, 224 - sharpRing * 36 + (fineFiber - 0.5) * 12 + (microTone - 0.5) * 14));
      const g = Math.min(255, Math.max(0, 166 - sharpRing * 34 + (fineFiber - 0.5) * 10 + (microTone - 0.5) * 11));
      const b = Math.min(255, Math.max(0, 88 - sharpRing * 25 + (fineFiber - 0.5) * 8 + (microTone - 0.5) * 8));

      cData[idx] = r;
      cData[idx + 1] = g;
      cData[idx + 2] = b;
      cData[idx + 3] = 255;

      const bumpVal = Math.floor(124 + (fineFiber - 0.5) * 18 - sharpRing * 10);
      bData[idx] = bumpVal;
      bData[idx + 1] = bumpVal;
      bData[idx + 2] = bumpVal;
      bData[idx + 3] = 255;

      // Satin hand-waxed Kaya wood roughness (~0.34..0.46)
      const roughVal = Math.floor(92 + sharpRing * 22 + (1 - fineFiber) * 14);
      rData[idx] = roughVal;
      rData[idx + 1] = roughVal;
      rData[idx + 2] = roughVal;
      rData[idx + 3] = 255;
    }
  }

  cCtx.putImageData(colorImg, 0, 0);
  bCtx.putImageData(bumpImg, 0, 0);
  rCtx.putImageData(roughImg, 0, 0);

  // Subtle warm edge vignette on wood top
  const vig = cCtx.createRadialGradient(res / 2, res / 2, res * 0.34, res / 2, res / 2, res * 0.74);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(52,26,6,0.13)');
  cCtx.fillStyle = vig;
  cCtx.fillRect(0, 0, res, res);

  // Map board world coordinates to UV pixel coordinates on [0..res]
  const marginX = ((metrics.boardWidth - metrics.gridSpanX) / 2 / metrics.boardWidth) * res;
  const marginZ = ((metrics.boardDepth - metrics.gridSpanZ) / 2 / metrics.boardDepth) * res;
  const spanPxX = (metrics.gridSpanX / metrics.boardWidth) * res;
  const spanPxZ = (metrics.gridSpanZ / metrics.boardDepth) * res;
  const stepPxX = spanPxX / (metrics.size - 1);
  const stepPxZ = spanPxZ / (metrics.size - 1);

  const drawGridLines = (ctx: CanvasRenderingContext2D, strokeStyle: string, lineWidth: number, borderWidth: number) => {
    ctx.save();
    ctx.strokeStyle = strokeStyle;
    ctx.lineCap = 'square';

    // Inner lines
    ctx.lineWidth = lineWidth;
    ctx.beginPath();
    for (let i = 1; i < metrics.size - 1; i++) {
      const x = marginX + i * stepPxX;
      ctx.moveTo(x, marginZ);
      ctx.lineTo(x, marginZ + spanPxZ);

      const y = marginZ + i * stepPxZ;
      ctx.moveTo(marginX, y);
      ctx.lineTo(marginX + spanPxX, y);
    }
    ctx.stroke();

    // Slightly bolder outer frame (전통 태치기 바깥 테두리선)
    ctx.lineWidth = borderWidth;
    ctx.strokeRect(marginX, marginZ, spanPxX, spanPxZ);
    ctx.restore();
  };

  // Lacquer ink lines (검은 옻칠 눈금: 살짝 도톰하게 올라오고 매끄러운 광택을 띔)
  drawGridLines(cCtx, '#16120f', 3.4, 5.0);
  drawGridLines(bCtx, '#dcdcdc', 4.0, 5.6); // Raised lacquer ridge in bump map!
  drawGridLines(rCtx, '#343434', 4.0, 5.6); // Glossy lacquer ink in roughness map!

  // Star points (화점 Hoshi)
  const stars = getStarPoints(metrics.size);
  const starRadius = metrics.size === 19 ? 8.2 : 9.6;

  for (const st of stars) {
    const sx = marginX + st.x * stepPxX;
    const sy = marginZ + st.y * stepPxZ;

    cCtx.beginPath();
    cCtx.arc(sx, sy, starRadius, 0, Math.PI * 2);
    cCtx.fillStyle = '#14100d';
    cCtx.fill();

    bCtx.beginPath();
    bCtx.arc(sx, sy, starRadius + 0.8, 0, Math.PI * 2);
    bCtx.fillStyle = '#e8e8e8';
    bCtx.fill();

    rCtx.beginPath();
    rCtx.arc(sx, sy, starRadius + 0.8, 0, Math.PI * 2);
    rCtx.fillStyle = '#2b2b2b';
    rCtx.fill();
  }

  // Optional subtle laser-engraved / calligraphed coordinate indices along margins
  if (showCoordinates) {
    cCtx.save();
    cCtx.fillStyle = 'rgba(42, 24, 10, 0.58)';
    cCtx.font = '600 24px "Pretendard", "Malgun Gothic", sans-serif';
    cCtx.textAlign = 'center';
    cCtx.textBaseline = 'middle';

    for (let i = 0; i < metrics.size; i++) {
      const colTxt = GO_COL_LABELS[i];
      const x = marginX + i * stepPxX;
      cCtx.fillText(colTxt, x, marginZ * 0.46);
      cCtx.fillText(colTxt, x, res - marginZ * 0.46);

      const rowTxt = String(metrics.size - i);
      const y = marginZ + i * stepPxZ;
      cCtx.fillText(rowTxt, marginX * 0.46, y);
      cCtx.fillText(rowTxt, res - marginX * 0.46, y);
    }
    cCtx.restore();
  }

  const map = new THREE.CanvasTexture(colorCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 16;

  const bumpMap = new THREE.CanvasTexture(bumpCanvas);
  bumpMap.anisotropy = 8;

  const roughnessMap = new THREE.CanvasTexture(roughCanvas);
  roughnessMap.anisotropy = 8;

  return { map, bumpMap, roughnessMap };
}

/**
 * Generates Kaya Side & End-Grain (마구리 나이테 단면) wood texture for the thick Goban sides!
 */
export function createGobanSideTexture(isEndGrain: boolean): THREE.CanvasTexture {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const data = img.data;

  for (let py = 0; py < h; py++) {
    const ny = py / h;
    for (let px = 0; px < w; px++) {
      const nx = px / w;
      const idx = (py * w + px) * 4;

      let ring: number;
      if (isEndGrain) {
        // Concentric off-center tree heartwood growth rings (비자나무 통판 밑둥 나이테 단면!)
        const dx = (nx - 0.5) * 2.2;
        const dy = (ny - 1.55) * 1.15;
        const dist = Math.hypot(dx, dy) + fbm2D(nx * 6, ny * 6, 404, 3) * 0.06;
        ring = Math.pow(0.5 + 0.5 * Math.sin(dist * 95), 2.3);
      } else {
        // Horizontal longitudinal grain along left/right sides
        const warp = fbm2D(nx * 4, ny * 5, 505, 3) * 0.18;
        ring = Math.pow(0.5 + 0.5 * Math.sin((ny * 18 + warp * 5) * Math.PI * 2), 2.4);
      }

      const grain = smoothNoise2D(nx * 140, ny * 90, 606);
      const shade = isEndGrain ? 0.91 : 0.96; // End-grain naturally absorbs slightly more oil, appearing warmer/deeper
      const r = Math.min(255, (214 - ring * 38 + (grain - 0.5) * 12) * shade);
      const g = Math.min(255, (154 - ring * 34 + (grain - 0.5) * 10) * shade);
      const b = Math.min(255, (78 - ring * 24 + (grain - 0.5) * 8) * shade);

      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Jujube / Chestnut Hardwood (대추나무 바둑통) rich dark reddish-amber lathe-turned texture
 */
export function createJujubeWoodTexture(): THREE.CanvasTexture {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const data = img.data;

  for (let py = 0; py < h; py++) {
    const ny = py / h;
    for (let px = 0; px < w; px++) {
      const nx = px / w;
      const idx = (py * w + px) * 4;

      const wave = fbm2D(nx * 3.5, ny * 7.5, 818, 4) * 0.3;
      const band = Math.pow(0.5 + 0.5 * Math.sin((ny * 22 + wave * 6 + Math.sin(nx * Math.PI * 2) * 0.5) * Math.PI), 2.2);
      const fine = smoothNoise2D(nx * 180, ny * 60, 919);

      const r = Math.max(0, Math.min(255, 108 - band * 44 + (fine - 0.5) * 10));
      const g = Math.max(0, Math.min(255, 44 - band * 21 + (fine - 0.5) * 6));
      const b = Math.max(0, Math.min(255, 24 - band * 13 + (fine - 0.5) * 5));

      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/**
 * Hyuga Clamshell White Stone (일향백석/해남석 조개돌) texture with delicate pearlescent growth striations
 */
export function createClamshellStoneTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  for (let py = 0; py < size; py++) {
    const ny = py / size;
    for (let px = 0; px < size; px++) {
      const nx = px / size;
      const idx = (py * size + px) * 4;

      // Gently curved parallel aragonite shell striations (조개결 줄무늬)
      const curve = ny + 0.14 * (nx - 0.5) * (nx - 0.5) + fbm2D(nx * 4, ny * 4, 212, 3) * 0.015;
      const stripe1 = 0.5 + 0.5 * Math.sin(curve * 165);
      const stripe2 = 0.5 + 0.5 * Math.sin(curve * 72 + 1.1);
      const subtleBand = stripe1 * 0.6 + stripe2 * 0.4;

      // Warm milky ivory-white (#f7f4ed -> #ebe5d8)
      const r = Math.min(255, 248 - subtleBand * 8);
      const g = Math.min(255, 244 - subtleBand * 9);
      const b = Math.min(255, 236 - subtleBand * 12);

      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Nachi Black Slate Stone (나치흑석 오석) micro-crystalline satin texture
 */
export function createSlateStoneTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  for (let py = 0; py < size; py++) {
    const ny = py / size;
    for (let px = 0; px < size; px++) {
      const nx = px / size;
      const idx = (py * size + px) * 4;

      const micro = fbm2D(nx * 28, ny * 28, 313, 3);
      const sheen = smoothNoise2D(nx * 95, ny * 95, 414);
      const base = 21 + (micro - 0.5) * 6 + (sheen - 0.5) * 4;

      data[idx] = base;
      data[idx + 1] = base + 1;
      data[idx + 2] = base + 3; // Faint cool blue-charcoal slate undertone
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Woven Tatami Mat (전통 왕골/다다미 매트) & Dark Maru Hardwood Floor textures
 */
export function createTatamiTexture(): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  for (let py = 0; py < size; py++) {
    const ny = py / size;
    for (let px = 0; px < size; px++) {
      const nx = px / size;
      const idx = (py * size + px) * 4;

      // Woven reed ribs
      const reedRib = 0.5 + 0.5 * Math.sin(py * 1.45);
      const crossStitch = 0.5 + 0.5 * Math.sin(px * 0.22);
      const tone = fbm2D(nx * 14, ny * 6, 515, 3);

      // Warm muted sage-straw tatami (#8b8362)
      let r = 136 - reedRib * 16 + (tone - 0.5) * 16 - crossStitch * 5;
      let g = 128 - reedRib * 15 + (tone - 0.5) * 15 - crossStitch * 5;
      let b = 92 - reedRib * 12 + (tone - 0.5) * 11 - crossStitch * 4;

      // Brocade silk border (다다미 비단 가선) along left & right edges
      if (nx < 0.045 || nx > 0.955) {
        const pattern = ((px >> 3) ^ (py >> 3)) & 1;
        r = pattern ? 44 : 28;
        g = pattern ? 38 : 25;
        b = pattern ? 32 : 22;
      }

      data[idx] = Math.max(0, Math.min(255, r));
      data[idx + 1] = Math.max(0, Math.min(255, g));
      data[idx + 2] = Math.max(0, Math.min(255, b));
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export function createMaruFloorTexture(): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const data = img.data;

  for (let py = 0; py < size; py++) {
    const ny = py / size;
    const plankIdx = Math.floor(ny * 8);
    const plankEdge = Math.abs((ny * 8) - Math.round(ny * 8));
    for (let px = 0; px < size; px++) {
      const nx = px / size;
      const idx = (py * size + px) * 4;

      const grain = fbm2D(nx * 6 + plankIdx * 3.7, ny * 34, 717, 4);
      const plankTint = (hash2D(plankIdx, 1, 99) - 0.5) * 10;
      const seam = plankEdge < 0.012 ? 0.55 : 1.0;

      const r = (54 + grain * 22 + plankTint) * seam;
      const g = (36 + grain * 15 + plankTint * 0.7) * seam;
      const b = (24 + grain * 10 + plankTint * 0.5) * seam;

      data[idx] = Math.max(0, Math.min(255, r));
      data[idx + 1] = Math.max(0, Math.min(255, g));
      data[idx + 2] = Math.max(0, Math.min(255, b));
      data[idx + 3] = 255;
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}
