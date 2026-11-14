import * as THREE from 'three';
import { BoardSize } from '../rules/types';
import { getStarPoints } from '../rules/GoEngine';
import type { BoardGrainIntensity, GridLineContrast } from '../settings/SettingsManager';

export interface GobanVisualOptions {
  grainIntensity?: BoardGrainIntensity;
  lineContrast?: GridLineContrast;
}

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
  showCoordinates = true,
  visualOpts: GobanVisualOptions = {}
): GobanSurfaceTextures {
  const grainIntensity: BoardGrainIntensity = visualOpts.grainIntensity ?? 'classic';
  const lineContrast: GridLineContrast = visualOpts.lineContrast ?? 'normal';
  const grainScale =
    grainIntensity === 'plain' ? 0.05 : grainIntensity === 'soft' ? 0.30 : 0.82;

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

  // Golden Honey Kaya Wood (차분하고 눈부심이 적은 황금 비자나무 반상 결)
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

      // Calibrated Kaya palette scaled by grainScale so wood rings never drown grid lines on mobile
      const r = Math.min(
        255,
        Math.max(
          0,
          210 -
            sharpRing * (32 * grainScale) +
            (fineFiber - 0.5) * (11 * grainScale) +
            (microTone - 0.5) * (13 * grainScale)
        )
      );
      const g = Math.min(
        255,
        Math.max(
          0,
          156 -
            sharpRing * (30 * grainScale) +
            (fineFiber - 0.5) * (9 * grainScale) +
            (microTone - 0.5) * (10 * grainScale)
        )
      );
      const b = Math.min(
        255,
        Math.max(
          0,
          82 -
            sharpRing * (22 * grainScale) +
            (fineFiber - 0.5) * (7 * grainScale) +
            (microTone - 0.5) * (7 * grainScale)
        )
      );

      cData[idx] = r;
      cData[idx + 1] = g;
      cData[idx + 2] = b;
      cData[idx + 3] = 255;

      const bumpVal = Math.floor(
        124 + ((fineFiber - 0.5) * 16 - sharpRing * 9) * grainScale
      );
      bData[idx] = bumpVal;
      bData[idx + 1] = bumpVal;
      bData[idx + 2] = bumpVal;
      bData[idx + 3] = 255;

      // Satin matte Kaya wood roughness (~0.40..0.52) to prevent harsh overhead hotspot glare
      const roughVal = Math.floor(
        108 + sharpRing * (18 * grainScale) + (1 - fineFiber) * (12 * grainScale)
      );
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
  vig.addColorStop(1, 'rgba(52,26,6,0.11)');
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

  const innerLineWidth =
    lineContrast === 'high' ? 6.4 : lineContrast === 'bold' ? 5.0 : 3.6;
  const outerBorderWidth =
    lineContrast === 'high' ? 10.0 : lineContrast === 'bold' ? 8.2 : 6.2;
  const lineHex =
    lineContrast === 'high' ? '#050403' : lineContrast === 'bold' ? '#0b0806' : '#15110d';

  if (lineContrast === 'high') {
    // Subtle warm separation halo under black lines for effortless row/col tracking on mobile screens
    drawGridLines(cCtx, 'rgba(246, 224, 178, 0.44)', innerLineWidth + 2.8, outerBorderWidth + 2.8);
  }

  // Lacquer ink lines (검은 옻칠 눈금)
  drawGridLines(cCtx, lineHex, innerLineWidth, outerBorderWidth);
  drawGridLines(bCtx, '#dcdcdc', innerLineWidth + 0.6, outerBorderWidth + 0.6);
  drawGridLines(rCtx, '#484848', innerLineWidth + 0.6, outerBorderWidth + 0.6);

  // Star points (화점 Hoshi)
  const stars = getStarPoints(metrics.size);
  const baseStarR = metrics.size === 19 ? 8.4 : 9.8;
  const starRadius =
    lineContrast === 'high' ? baseStarR * 1.24 : lineContrast === 'bold' ? baseStarR * 1.12 : baseStarR;

  for (const st of stars) {
    const sx = marginX + st.x * stepPxX;
    const sy = marginZ + st.y * stepPxZ;

    cCtx.beginPath();
    cCtx.arc(sx, sy, starRadius, 0, Math.PI * 2);
    cCtx.fillStyle = lineHex;
    cCtx.fill();

    bCtx.beginPath();
    bCtx.arc(sx, sy, starRadius + 0.8, 0, Math.PI * 2);
    bCtx.fillStyle = '#e8e8e8';
    bCtx.fill();

    rCtx.beginPath();
    rCtx.arc(sx, sy, starRadius + 0.8, 0, Math.PI * 2);
    rCtx.fillStyle = '#383838';
    rCtx.fill();
  }

  // Optional subtle laser-engraved / calligraphed coordinate indices along margins
  if (showCoordinates) {
    cCtx.save();
    cCtx.fillStyle =
      lineContrast === 'high' ? 'rgba(16, 10, 4, 0.84)' : 'rgba(38, 22, 10, 0.64)';
    const coordPx = lineContrast === 'high' ? 27 : 24;
    cCtx.font = `700 ${coordPx}px "Pretendard", "Malgun Gothic", sans-serif`;
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
export function createClamshellStoneTexture(highRes = true): THREE.CanvasTexture {
  const size = highRes ? 768 : 512;
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
      const curve = ny + 0.14 * (nx - 0.5) * (nx - 0.5) + fbm2D(nx * 4.5, ny * 4.5, 212, 3) * 0.016;
      const stripe1 = 0.5 + 0.5 * Math.sin(curve * 175);
      const stripe2 = 0.5 + 0.5 * Math.sin(curve * 78 + 1.1);
      const fineRipple = 0.5 + 0.5 * Math.sin(curve * 310 + nx * 6.0);
      const subtleBand = stripe1 * 0.5 + stripe2 * 0.35 + fineRipple * 0.15;

      // Warm milky ivory-white with delicate aragonite shimmer
      const r = Math.min(255, 249 - subtleBand * 9);
      const g = Math.min(255, 245 - subtleBand * 10 + (1 - stripe1) * 1.5);
      const b = Math.min(255, 237 - subtleBand * 12 + stripe2 * 2);

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
export function createSlateStoneTexture(highRes = true): THREE.CanvasTexture {
  const size = highRes ? 768 : 512;
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
      const sheen = smoothNoise2D(nx * 110, ny * 110, 414);
      const base = 19 + (micro - 0.5) * 7 + (sheen - 0.5) * 4.5;

      data[idx] = Math.max(0, base);
      data[idx + 1] = Math.max(0, base + 1.5);
      data[idx + 2] = Math.max(0, base + 4); // Faint cool blue-charcoal slate undertone
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

/**
 * Korean Mother-of-Pearl Lacquerware Inlay (나전칠기 매화·운문 자개 상감) texture
 */
export function createMotherOfPearlTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  // Deep glossy ottchil black lacquer base
  const bg = ctx.createRadialGradient(256, 256, 30, 256, 256, 360);
  bg.addColorStop(0, '#18100d');
  bg.addColorStop(1, '#090605');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  // Subtle gold hairline border (금사 경계선)
  ctx.strokeStyle = 'rgba(224, 182, 102, 0.78)';
  ctx.lineWidth = 4;
  ctx.strokeRect(18, 18, size - 36, size - 36);
  ctx.strokeStyle = 'rgba(224, 182, 102, 0.35)';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(28, 28, size - 56, size - 56);

  // Stylized flowering branch & pearl blossoms (매화 가지 & 오색 자개 꽃잎)
  ctx.strokeStyle = '#c89b52';
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(64, 420);
  ctx.quadraticCurveTo(180, 310, 290, 230);
  ctx.quadraticCurveTo(370, 170, 442, 118);
  ctx.moveTo(215, 290);
  ctx.quadraticCurveTo(175, 200, 145, 132);
  ctx.moveTo(318, 208);
  ctx.quadraticCurveTo(375, 225, 424, 260);
  ctx.stroke();

  const drawNacreBlossom = (cx: number, cy: number, radius: number, hueOffset: number) => {
    const grad = ctx.createLinearGradient(cx - radius, cy - radius, cx + radius, cy + radius);
    grad.addColorStop(0, `hsla(${175 + hueOffset}, 72%, 80%, 0.92)`);
    grad.addColorStop(0.45, `hsla(${285 + hueOffset}, 62%, 82%, 0.88)`);
    grad.addColorStop(1, `hsla(${48 + hueOffset}, 80%, 84%, 0.94)`);
    ctx.fillStyle = grad;

    for (let i = 0; i < 5; i++) {
      const a = (i * Math.PI * 2) / 5 - Math.PI / 2;
      const px = cx + Math.cos(a) * radius * 0.62;
      const py = cy + Math.sin(a) * radius * 0.62;
      ctx.beginPath();
      ctx.ellipse(px, py, radius * 0.48, radius * 0.32, a, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#f5d27a';
    ctx.beginPath();
    ctx.arc(cx, cy, radius * 0.18, 0, Math.PI * 2);
    ctx.fill();
  };

  drawNacreBlossom(152, 138, 24, 0);
  drawNacreBlossom(272, 240, 28, 25);
  drawNacreBlossom(346, 174, 22, -18);
  drawNacreBlossom(422, 122, 18, 40);
  drawNacreBlossom(416, 254, 20, 12);
  drawNacreBlossom(118, 355, 19, -30);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/**
 * Woven Korean Silk Cushion Brocade (비단 대국 방석 직조 텍스처)
 */
export function createSilkBrocadeTexture(isBlackSide: boolean): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = isBlackSide ? '#2b2024' : '#263230';
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = isBlackSide ? 'rgba(218, 174, 98, 0.16)' : 'rgba(196, 214, 178, 0.16)';
  ctx.lineWidth = 1.2;
  const step = 32;
  for (let y = 0; y <= size; y += step) {
    for (let x = 0; x <= size; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - 16, y);
      ctx.lineTo(x + 16, y);
      ctx.moveTo(x, y - 16);
      ctx.lineTo(x, y + 16);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}
