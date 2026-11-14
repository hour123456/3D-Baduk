import * as THREE from 'three';
import { BLACK, WHITE, EMPTY, Coord, PlayerColor, StoneColor } from '../rules/types';
import { AcousticStoneAudioEngine } from '../audio/AcousticStoneAudioEngine';
import type { PhysicsIntensity, StoneMotionStyle, VisualQuality } from '../settings/SettingsManager';
import { BoardGridMetrics, createClamshellStoneTexture, createSlateStoneTexture } from './ProceduralTextures';
import { BowlAnchor } from './GobanBuilder';
import {
  BowlPhysicsParticle,
  StonePhysicsBody,
  StonePhysicsWorld,
} from './StonePhysicsWorld';

/**
 * Builds an authentic 36-go Biconvex Lens Go Stone Geometry (unit radius = 1.0, height = 0.92)
 * so scaling by `stoneRadius` yields exact proportional stones for 9x9, 13x13, 15x15, and 19x19.
 */
export function createBiconvexStoneGeometry(): THREE.BufferGeometry {
  const profile: THREE.Vector2[] = [];
  const halfH = 0.46;
  const steps = 24;

  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    const angle = (u - 0.5) * Math.PI;
    const r = Math.cos(angle);
    const y = Math.sin(angle) * halfH * (0.88 + 0.12 * Math.cos(angle * 0.6));
    profile.push(new THREE.Vector2(Math.max(0, r), y));
  }

  const geo = new THREE.LatheGeometry(profile, 40);
  geo.computeVertexNormals();
  return geo;
}

function createContactAoTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const half = size / 2;
  const grad = ctx.createRadialGradient(half, half, half * 0.22, half, half, half);
  grad.addColorStop(0.0, 'rgba(14, 9, 4, 0.52)');
  grad.addColorStop(0.55, 'rgba(18, 11, 5, 0.28)');
  grad.addColorStop(0.85, 'rgba(20, 12, 6, 0.08)');
  grad.addColorStop(1.0, 'rgba(20, 12, 6, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

interface BowlStoneVisual {
  mesh: THREE.Mesh;
  particle: BowlPhysicsParticle;
  baseRotY: number;
}

interface ActiveBoardStone {
  idx: number;
  mesh: THREE.Mesh;
  aoMesh: THREE.Mesh;
  aoMat: THREE.MeshBasicMaterial;
  rippleMesh: THREE.Mesh;
  rippleMat: THREE.MeshBasicMaterial;
  body: StonePhysicsBody;
  color: PlayerColor;
  gridX: number;
  gridY: number;
  boardSurfaceY: number;
  capturedCount: number;
  adjacentCount: number;
}

interface FlyingPrisoner {
  mesh: THREE.Mesh;
  color: PlayerColor;
  startPos: THREE.Vector3;
  endPos: THREE.Vector3;
  endRot: THREE.Euler;
  delay: number;
  elapsed: number;
  duration: number;
  lidTarget: 'black' | 'white';
}

export class StonePhysicsAnimator {
  private parent: THREE.Group;
  private audio: AcousticStoneAudioEngine;
  private metrics: BoardGridMetrics;
  private blackBowl: BowlAnchor;
  private whiteBowl: BowlAnchor;

  private stoneGeo: THREE.BufferGeometry;
  private aoGeo: THREE.PlaneGeometry;
  private aoTex: THREE.CanvasTexture;
  private rippleGeo: THREE.RingGeometry;
  public readonly blackMat: THREE.MeshPhysicalMaterial;
  public readonly whiteMat: THREE.MeshPhysicalMaterial;
  private deadBlackMat: THREE.MeshPhysicalMaterial;
  private deadWhiteMat: THREE.MeshPhysicalMaterial;

  private physicsWorld: StonePhysicsWorld;

  private bowlStonesBlack: BowlStoneVisual[] = [];
  private bowlStonesWhite: BowlStoneVisual[] = [];
  private bowlAwakeTimerBlack = 0;
  private bowlAwakeTimerWhite = 0;
  private slateTex: THREE.CanvasTexture;
  private shellTex: THREE.CanvasTexture;

  private boardStones = new Map<number, ActiveBoardStone>();
  private flyingPrisoners: FlyingPrisoner[] = [];
  private settledPrisonersBlackLid: THREE.Mesh[] = [];
  private settledPrisonersWhiteLid: THREE.Mesh[] = [];

  private lidShakeBlack = 0;
  private lidShakeWhite = 0;
  private lastBoardNudgeSoundMs = 0;
  private bodiesScratch: StonePhysicsBody[] = [];

  constructor(params: {
    parent: THREE.Group;
    audio: AcousticStoneAudioEngine;
    metrics: BoardGridMetrics;
    blackBowl: BowlAnchor;
    whiteBowl: BowlAnchor;
  }) {
    this.parent = params.parent;
    this.audio = params.audio;
    this.metrics = params.metrics;
    this.blackBowl = params.blackBowl;
    this.whiteBowl = params.whiteBowl;

    this.stoneGeo = createBiconvexStoneGeometry();
    this.aoTex = createContactAoTexture();
    this.aoGeo = new THREE.PlaneGeometry(2.38, 2.38);
    this.aoGeo.rotateX(-Math.PI / 2);

    this.rippleGeo = new THREE.RingGeometry(0.92, 1.14, 32);
    this.rippleGeo.rotateX(-Math.PI / 2);

    this.physicsWorld = new StonePhysicsWorld({
      onBoardImpact: (body, impactEnergy) => {
        const entry = this.boardStones.get(Number(body.key));
        if (!entry) return;
        const half = Math.max(1, (this.metrics.size - 1) / 2);
        const normX = (entry.gridX - half) / half;
        const normY = (entry.gridY - half) / half;
        const force =
          entry.capturedCount > 0
            ? 1.18
            : entry.adjacentCount >= 2
              ? 1.06
              : 0.88 * impactEnergy;
        this.audio.playStonePlace({
          normX,
          normY,
          force,
          isBlack: entry.color === BLACK,
          adjacentStones: entry.adjacentCount,
        });
      },
      onStoneClink: (relSpeed, color, worldX) => {
        const pan = Math.max(-0.75, Math.min(0.75, worldX / 2.2));
        this.audio.playStoneCollisionClink(relSpeed, color === BLACK, pan);
      },
    });

    this.slateTex = createSlateStoneTexture(true);
    this.shellTex = createClamshellStoneTexture(true);

    this.blackMat = new THREE.MeshPhysicalMaterial({
      map: this.slateTex,
      color: 0x1a1c20,
      roughness: 0.25,
      metalness: 0.04,
      clearcoat: 0.44,
      clearcoatRoughness: 0.22,
      sheen: 0.22,
      sheenRoughness: 0.38,
      sheenColor: new THREE.Color(0xd8e0ef),
    });

    this.whiteMat = new THREE.MeshPhysicalMaterial({
      map: this.shellTex,
      color: 0xfbf9f3,
      roughness: 0.13,
      metalness: 0.02,
      clearcoat: 0.82,
      clearcoatRoughness: 0.09,
      iridescence: 0.36,
      iridescenceIOR: 1.38,
      sheen: 0.35,
      sheenRoughness: 0.25,
      sheenColor: new THREE.Color(0xfff6e8),
    });

    this.deadBlackMat = this.blackMat.clone();
    this.deadBlackMat.transparent = true;
    this.deadBlackMat.opacity = 0.38;

    this.deadWhiteMat = this.whiteMat.clone();
    this.deadWhiteMat.transparent = true;
    this.deadWhiteMat.opacity = 0.42;

    this.populateBowlStones();
  }

  public applyVisualQuality(quality: VisualQuality, maxAnisotropy: number): void {
    const safeAniso = Math.max(1, Math.min(16, maxAnisotropy));
    this.slateTex.anisotropy = safeAniso;
    this.shellTex.anisotropy = safeAniso;
    this.slateTex.needsUpdate = true;
    this.shellTex.needsUpdate = true;

    if (quality === 'ultra') {
      this.whiteMat.iridescence = 0.38;
      this.whiteMat.sheen = 0.38;
      this.whiteMat.clearcoat = 0.86;
      this.blackMat.sheen = 0.24;
      this.blackMat.clearcoat = 0.48;
    } else if (quality === 'high') {
      this.whiteMat.iridescence = 0.18;
      this.whiteMat.sheen = 0.2;
      this.whiteMat.clearcoat = 0.72;
      this.blackMat.sheen = 0.12;
      this.blackMat.clearcoat = 0.36;
    } else {
      this.whiteMat.iridescence = 0;
      this.whiteMat.sheen = 0;
      this.whiteMat.clearcoat = 0.45;
      this.blackMat.sheen = 0;
      this.blackMat.clearcoat = 0.25;
    }
    this.whiteMat.needsUpdate = true;
    this.blackMat.needsUpdate = true;
  }

  public setMotionStyle(style: StoneMotionStyle): void {
    this.physicsWorld.setMotionStyle(style);
  }

  public setPhysicsIntensity(intensity: PhysicsIntensity): void {
    this.physicsWorld.setPhysicsIntensity(intensity);
  }

  public setMetrics(metrics: BoardGridMetrics): void {
    this.metrics = metrics;
  }

  public gridToWorld(x: number, y: number): THREE.Vector3 {
    const wx = -this.metrics.gridSpanX / 2 + x * this.metrics.cellX;
    const wz = -this.metrics.gridSpanZ / 2 + y * this.metrics.cellZ;
    const wy = this.metrics.stoneRadius * 0.44;
    return new THREE.Vector3(wx, wy, wz);
  }

  private populateBowlStones(): void {
    const bowlStoneRadius = 0.104;

    const buildPile = (anchor: BowlAnchor, color: PlayerColor): BowlStoneVisual[] => {
      const items: BowlStoneVisual[] = [];
      const mat = color === BLACK ? this.blackMat : this.whiteMat;
      const count = 36;

      for (let i = 0; i < count; i++) {
        const layer = Math.floor(i / 12);
        const idxInLayer = i % 12;
        const ringR = idxInLayer === 0 ? 0.0 : idxInLayer < 5 ? 0.16 : 0.29;
        const angle = idxInLayer * 1.65 + layer * 0.9;

        const rx = Math.cos(angle) * ringR + (Math.random() - 0.5) * 0.025;
        const rz = Math.sin(angle) * ringR + (Math.random() - 0.5) * 0.025;
        const ry = anchor.stonePileOrigin.y - 0.12 + layer * 0.068 + (1 - ringR) * 0.03;

        const mesh = new THREE.Mesh(this.stoneGeo, mat);
        mesh.scale.setScalar(bowlStoneRadius);
        const baseRotY = Math.random() * Math.PI * 2;
        const rotX = (Math.random() - 0.5) * 0.42;
        const rotZ = (Math.random() - 0.5) * 0.42;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.parent.add(mesh);

        items.push({
          mesh,
          baseRotY,
          particle: {
            x: rx,
            y: ry,
            z: rz,
            restX: rx,
            restY: ry,
            restZ: rz,
            vx: 0,
            vy: 0,
            vz: 0,
            rotX,
            rotY: baseRotY,
            rotZ,
            restRotX: rotX,
            restRotZ: rotZ,
            angVx: 0,
            angVz: 0,
          },
        });
      }

      // Deterministic static relaxation at startup so stones begin in settled equilibrium
      const particles = items.map((v) => v.particle);
      for (let iter = 0; iter < 30; iter++) {
        this.physicsWorld.stepContainerStones(particles, 0.02, 0.36, bowlStoneRadius, 0.045);
      }
      for (const it of items) {
        const p = it.particle;
        p.vx = 0;
        p.vy = 0;
        p.vz = 0;
        p.angVx = 0;
        p.angVz = 0;
        p.restX = p.x;
        p.restY = p.y;
        p.restZ = p.z;
        p.restRotX = p.rotX;
        p.restRotZ = p.rotZ;
        it.mesh.position.set(anchor.stonePileOrigin.x + p.x, p.y, anchor.stonePileOrigin.z + p.z);
        it.mesh.rotation.set(p.rotX, it.baseRotY, p.rotZ);
      }

      return items;
    };

    this.bowlStonesBlack = buildPile(this.blackBowl, BLACK);
    this.bowlStonesWhite = buildPile(this.whiteBowl, WHITE);
    this.bowlAwakeTimerBlack = 0;
    this.bowlAwakeTimerWhite = 0;
  }

  public isBowlAwake(which: 'black' | 'white'): boolean {
    return which === 'black' ? this.bowlAwakeTimerBlack > 0 : this.bowlAwakeTimerWhite > 0;
  }

  public getBowlStones(which: 'black' | 'white'): ReadonlyArray<BowlStoneVisual> {
    return which === 'black' ? this.bowlStonesBlack : this.bowlStonesWhite;
  }

  public stirBowl(
    which: 'black' | 'white',
    intensity = 0.8,
    playSound = true,
    dirX?: number,
    dirZ?: number
  ): void {
    const items = which === 'black' ? this.bowlStonesBlack : this.bowlStonesWhite;
    const clamped = Math.max(0.25, Math.min(1.25, intensity));

    if (which === 'black') {
      this.bowlAwakeTimerBlack = 0.92;
    } else {
      this.bowlAwakeTimerWhite = 0.92;
    }

    const dirLen =
      dirX !== undefined && dirZ !== undefined ? Math.hypot(dirX, dirZ) : 0;
    const hasDirection = dirLen > 1e-4;
    const ux = hasDirection ? (dirX as number) / dirLen : 0;
    const uz = hasDirection ? (dirZ as number) / dirLen : 0;

    for (let i = 0; i < items.length; i++) {
      const layerFactor = 0.45 + (i / items.length) * 0.85;
      const amp = 0.095 * clamped * layerFactor;
      const p = items[i].particle;

      if (hasDirection) {
        // 85% pushed along touched/dragged vector + 15% natural pile scatter, with matching directional roll torque
        const speedMag = amp * 12.2;
        const scatterMag = amp * 2.1;
        p.vx += ux * speedMag + (Math.random() - 0.5) * scatterMag;
        p.vz += uz * speedMag + (Math.random() - 0.5) * scatterMag;
        p.vy += (0.35 + Math.random() * 0.65) * amp * 6.5;
        p.angVx += uz * clamped * 7.8;
        p.angVz -= ux * clamped * 7.8;
      } else {
        // Toolbar manual stir button: gentle organic circular swirl inside the bowl
        const angle = Math.atan2(p.z, p.x) + Math.PI * 0.5;
        const swirlSpeed = amp * 9.5;
        p.vx += Math.cos(angle) * swirlSpeed + (Math.random() - 0.5) * amp * 3.5;
        p.vz += Math.sin(angle) * swirlSpeed + (Math.random() - 0.5) * amp * 3.5;
        p.vy += Math.random() * amp * 5.5;
        p.angVx += Math.sin(angle) * clamped * 5.0;
        p.angVz -= Math.cos(angle) * clamped * 5.0;
      }
    }

    if (playSound) {
      const side = which === 'black' ? 'right' : 'left';
      this.audio.playBowlRattle(side, clamped, which === 'black');
    }
  }

  public nudgeBoardStone(
    x: number,
    y: number,
    dirX: number,
    dirZ: number,
    strength = 1.0
  ): boolean {
    const idx = y * this.metrics.size + x;
    const entry = this.boardStones.get(idx);
    if (!entry) return false;

    const nudged = this.physicsWorld.nudgeStone(entry.body, dirX, dirZ, strength);
    if (nudged) {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - this.lastBoardNudgeSoundMs > 95) {
        this.lastBoardNudgeSoundMs = now;
        const pan = Math.max(-0.75, Math.min(0.75, entry.body.x / 2.2));
        this.audio.playStoneCollisionClink(
          Math.min(0.42, 0.18 * strength),
          entry.color === BLACK,
          pan
        );
      }
    }
    return nudged;
  }

  public getBoardStoneBody(x: number, y: number): Readonly<StonePhysicsBody> | null {
    const idx = y * this.metrics.size + x;
    return this.boardStones.get(idx)?.body ?? null;
  }

  private humanJitter(x: number, y: number): THREE.Vector2 {
    const h1 = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    const h2 = Math.sin(x * 39.3468 + y * 11.135) * 24634.6345;
    const jx = ((h1 - Math.floor(h1)) - 0.5) * this.metrics.stoneRadius * 0.065;
    const jz = ((h2 - Math.floor(h2)) - 0.5) * this.metrics.stoneRadius * 0.065;
    return new THREE.Vector2(jx, jz);
  }

  public animateMovePlacement(params: {
    x: number;
    y: number;
    color: PlayerColor;
    captured: Coord[];
    adjacentCount: number;
  }): void {
    const { x, y, color, captured, adjacentCount } = params;
    const idx = y * this.metrics.size + x;

    this.removeBoardStoneImmediate(idx);

    const bowlAnchor = color === BLACK ? this.blackBowl : this.whiteBowl;
    const side = color === BLACK ? 'right' : 'left';

    // Keep bowl stones strictly still during normal board moves; only play subtle pickup sound
    this.audio.playStonePickup(side, color === BLACK);

    const restWorld = this.gridToWorld(x, y);
    const jitter = this.humanJitter(x, y);
    const radius = this.metrics.stoneRadius;
    const halfHeight = radius * 0.44;

    const body = this.physicsWorld.spawnPlacementBody({
      key: String(idx),
      color,
      targetX: restWorld.x,
      targetZ: restWorld.z,
      bowlX: bowlAnchor.stonePileOrigin.x,
      bowlY: bowlAnchor.stonePileOrigin.y + 0.25,
      bowlZ: bowlAnchor.stonePileOrigin.z,
      radius,
      halfHeight,
      jitterX: jitter.x,
      jitterZ: jitter.y,
      boardSurfaceY: restWorld.y,
    });

    const mesh = new THREE.Mesh(this.stoneGeo, color === BLACK ? this.blackMat : this.whiteMat);
    mesh.scale.setScalar(radius);
    mesh.position.set(body.x, restWorld.y + body.y, body.z);
    mesh.rotation.set(body.rotX, body.rotY, body.rotZ);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.parent.add(mesh);

    const aoMat = new THREE.MeshBasicMaterial({
      map: this.aoTex,
      transparent: true,
      opacity: 0.36 * body.aoAlpha,
      depthWrite: false,
    });
    const aoMesh = new THREE.Mesh(this.aoGeo, aoMat);
    aoMesh.scale.setScalar(radius);
    aoMesh.position.set(body.x, 0.0025, body.z);
    this.parent.add(aoMesh);

    const rippleMat = new THREE.MeshBasicMaterial({
      color: color === BLACK ? 0xffe4b8 : 0xfff5de,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const rippleMesh = new THREE.Mesh(this.rippleGeo, rippleMat);
    rippleMesh.scale.setScalar(radius);
    rippleMesh.position.set(body.restX, 0.0035, body.restZ);
    rippleMesh.visible = false;
    this.parent.add(rippleMesh);

    const entry: ActiveBoardStone = {
      idx,
      mesh,
      aoMesh,
      aoMat,
      rippleMesh,
      rippleMat,
      body,
      color,
      gridX: x,
      gridY: y,
      boardSurfaceY: restWorld.y,
      capturedCount: captured.length,
      adjacentCount,
    };

    this.boardStones.set(idx, entry);

    if (body.impactFired) {
      // Instant mode fires placement audio immediately
      const half = Math.max(1, (this.metrics.size - 1) / 2);
      this.audio.playStonePlace({
        normX: (x - half) / half,
        normY: (y - half) / half,
        force: captured.length > 0 ? 1.15 : 0.9,
        isBlack: color === BLACK,
        adjacentStones: adjacentCount,
      });
    }

    if (captured.length > 0) {
      this.launchCapturedStonesToLid(captured, color);
    }
  }

  private launchCapturedStonesToLid(captured: Coord[], capturingColor: PlayerColor): void {
    const targetLidKey: 'black' | 'white' = capturingColor === BLACK ? 'black' : 'white';
    const lidAnchor = capturingColor === BLACK ? this.blackBowl : this.whiteBowl;
    const settledList =
      capturingColor === BLACK ? this.settledPrisonersBlackLid : this.settledPrisonersWhiteLid;

    const existingCount = settledList.length;
    const capturedColor = capturingColor === BLACK ? WHITE : BLACK;

    captured.forEach((pt, i) => {
      const cIdx = pt.y * this.metrics.size + pt.x;
      const existing = this.boardStones.get(cIdx);
      let mesh: THREE.Mesh;
      let startPos: THREE.Vector3;

      if (existing) {
        mesh = existing.mesh;
        startPos = mesh.position.clone();
        this.parent.remove(existing.aoMesh);
        this.parent.remove(existing.rippleMesh);
        existing.aoMat.dispose();
        existing.rippleMat.dispose();
        this.boardStones.delete(cIdx);
      } else {
        mesh = new THREE.Mesh(this.stoneGeo, capturedColor === BLACK ? this.blackMat : this.whiteMat);
        mesh.scale.setScalar(this.metrics.stoneRadius);
        startPos = this.gridToWorld(pt.x, pt.y);
        mesh.position.copy(startPos);
        mesh.castShadow = true;
        this.parent.add(mesh);
      }

      const slotIndex = existingCount + i;
      const layer = Math.floor(slotIndex / 9);
      const inLayer = slotIndex % 9;
      const r = inLayer === 0 ? 0.0 : inLayer < 5 ? 0.145 : 0.255;
      const theta = slotIndex * 2.15;
      const lidStoneScale = Math.min(0.105, this.metrics.stoneRadius);
      mesh.scale.setScalar(lidStoneScale);

      const endPos = new THREE.Vector3(
        lidAnchor.lidCenter.x + Math.cos(theta) * r + (Math.random() - 0.5) * 0.02,
        lidAnchor.lidCenter.y + lidStoneScale * 0.44 + layer * (lidStoneScale * 0.72),
        lidAnchor.lidCenter.z + Math.sin(theta) * r + (Math.random() - 0.5) * 0.02
      );
      const endRot = new THREE.Euler(
        (Math.random() - 0.5) * 0.24,
        Math.random() * Math.PI * 2,
        (Math.random() - 0.5) * 0.24
      );

      this.flyingPrisoners.push({
        mesh,
        color: capturedColor,
        startPos,
        endPos,
        endRot,
        delay: 0.12 + i * 0.055,
        elapsed: 0,
        duration: 0.34,
        lidTarget: targetLidKey,
      });
    });

    const lidSide = capturingColor === BLACK ? 'right' : 'left';
    this.audio.playCaptureToLid(
      captured.length,
      existingCount,
      lidSide,
      capturingColor !== BLACK
    );

    if (capturingColor === BLACK) {
      this.lidShakeBlack = Math.min(1.4, this.lidShakeBlack + 0.65 + captured.length * 0.15);
    } else {
      this.lidShakeWhite = Math.min(1.4, this.lidShakeWhite + 0.65 + captured.length * 0.15);
    }
  }

  public syncBoardSnapshot(
    board: Uint8Array,
    size: number,
    captures: { black: number; white: number },
    deadStoneMask?: Uint8Array | null
  ): void {
    for (const fp of this.flyingPrisoners) {
      this.parent.remove(fp.mesh);
    }
    this.flyingPrisoners = [];

    for (const [idx, st] of Array.from(this.boardStones.entries())) {
      if (idx >= size * size || board[idx] !== st.color) {
        this.removeBoardStoneImmediate(idx);
      }
    }

    const radius = this.metrics.stoneRadius;
    const halfHeight = radius * 0.44;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = y * size + x;
        const c = board[idx] as StoneColor;
        if (c === EMPTY) continue;

        const isDead = deadStoneMask ? deadStoneMask[idx] === 1 : false;
        let entry = this.boardStones.get(idx);

        if (!entry) {
          const restPos = this.gridToWorld(x, y);
          const jitter = this.humanJitter(x, y);
          const rx = restPos.x + jitter.x;
          const rz = restPos.z + jitter.y;
          const baseYaw = ((x * 73 + y * 137) % 360) * (Math.PI / 180);

          const mesh = new THREE.Mesh(this.stoneGeo, c === BLACK ? this.blackMat : this.whiteMat);
          mesh.scale.setScalar(radius);
          mesh.position.set(rx, restPos.y, rz);
          mesh.rotation.set(0, baseYaw, 0);
          mesh.castShadow = !isDead;
          mesh.receiveShadow = true;
          this.parent.add(mesh);

          const aoMat = new THREE.MeshBasicMaterial({
            map: this.aoTex,
            transparent: true,
            opacity: isDead ? 0.12 : 0.36,
            depthWrite: false,
          });
          const aoMesh = new THREE.Mesh(this.aoGeo, aoMat);
          aoMesh.scale.setScalar(radius);
          aoMesh.position.set(rx, 0.0025, rz);
          this.parent.add(aoMesh);

          const rippleMat = new THREE.MeshBasicMaterial({
            color: 0xffe4b8,
            transparent: true,
            opacity: 0,
            depthWrite: false,
          });
          const rippleMesh = new THREE.Mesh(this.rippleGeo, rippleMat);
          rippleMesh.visible = false;
          this.parent.add(rippleMesh);

          entry = {
            idx,
            mesh,
            aoMesh,
            aoMat,
            rippleMesh,
            rippleMat,
            color: c,
            gridX: x,
            gridY: y,
            boardSurfaceY: restPos.y,
            capturedCount: 0,
            adjacentCount: 0,
            body: {
              key: String(idx),
              color: c,
              x: rx,
              y: 0,
              z: rz,
              restX: rx,
              restZ: rz,
              vx: 0,
              vy: 0,
              vz: 0,
              rotX: 0,
              rotY: baseYaw,
              rotZ: 0,
              angVx: 0,
              angVz: 0,
              radius,
              halfHeight,
              motionStyle: 'instant',
              phaseElapsed: 0,
              flightDuration: 0,
              flightActive: false,
              startPosX: rx,
              startPosY: 0,
              startPosZ: rz,
              ctrlPosX: rx,
              ctrlPosY: 0,
              ctrlPosZ: rz,
              impactFired: true,
              aoAlpha: 1,
              rippleAge: -1,
              hasMoved: false,
            },
          };
          this.boardStones.set(idx, entry);
        } else {
          const restPos = this.gridToWorld(x, y);
          const jitter = this.humanJitter(x, y);
          const rx = restPos.x + jitter.x;
          const rz = restPos.z + jitter.y;
          entry.boardSurfaceY = restPos.y;
          entry.body.restX = rx;
          entry.body.restZ = rz;
          entry.body.x = rx;
          entry.body.y = 0;
          entry.body.z = rz;
          entry.body.vx = 0;
          entry.body.vy = 0;
          entry.body.vz = 0;
          entry.body.rotX = 0;
          entry.body.rotZ = 0;
          entry.body.flightActive = false;
          entry.body.impactFired = true;
          entry.body.aoAlpha = 1;
          entry.body.rippleAge = -1;
          entry.body.hasMoved = false;
          entry.mesh.scale.setScalar(radius);
          entry.mesh.position.set(rx, restPos.y, rz);
          entry.mesh.rotation.set(0, entry.body.rotY, 0);
          entry.aoMesh.scale.setScalar(radius);
          entry.aoMesh.position.set(rx, 0.0025, rz);
          entry.rippleMesh.visible = false;
        }

        if (isDead) {
          entry.mesh.material = c === BLACK ? this.deadBlackMat : this.deadWhiteMat;
          entry.mesh.castShadow = false;
          entry.aoMat.opacity = 0.12;
        } else {
          entry.mesh.material = c === BLACK ? this.blackMat : this.whiteMat;
          entry.mesh.castShadow = true;
          entry.aoMat.opacity = 0.36;
        }
      }
    }

    this.syncPrisonerPile(this.settledPrisonersBlackLid, Math.min(40, captures.black), WHITE, this.blackBowl);
    this.syncPrisonerPile(this.settledPrisonersWhiteLid, Math.min(40, captures.white), BLACK, this.whiteBowl);
  }

  public snapAllToRest(): void {
    for (const st of this.boardStones.values()) {
      const b = st.body;
      b.flightActive = false;
      b.x = b.restX;
      b.y = 0;
      b.z = b.restZ;
      b.vx = 0;
      b.vy = 0;
      b.vz = 0;
      b.rotX = 0;
      b.rotZ = 0;
      b.aoAlpha = 1;
      b.rippleAge = -1;
      b.hasMoved = false;
      st.mesh.position.set(b.restX, st.boardSurfaceY, b.restZ);
      st.mesh.rotation.set(0, b.rotY, 0);
      st.aoMesh.position.set(b.restX, 0.0025, b.restZ);
      st.aoMat.opacity = 0.36;
      st.rippleMesh.visible = false;
    }
  }

  public updateDeadMaskVisuals(deadMask: Uint8Array | null): void {
    for (const [idx, st] of this.boardStones.entries()) {
      const isDead = deadMask ? deadMask[idx] === 1 : false;
      if (isDead) {
        st.mesh.material = st.color === BLACK ? this.deadBlackMat : this.deadWhiteMat;
        st.mesh.castShadow = false;
        st.aoMat.opacity = 0.12;
      } else {
        st.mesh.material = st.color === BLACK ? this.blackMat : this.whiteMat;
        st.mesh.castShadow = true;
        st.aoMat.opacity = 0.36 * st.body.aoAlpha;
      }
    }
  }

  private syncPrisonerPile(
    list: THREE.Mesh[],
    targetCount: number,
    stoneColor: PlayerColor,
    anchor: BowlAnchor
  ): void {
    while (list.length > targetCount) {
      const m = list.pop()!;
      this.parent.remove(m);
    }
    const lidScale = Math.min(0.105, this.metrics.stoneRadius);
    while (list.length < targetCount) {
      const slotIndex = list.length;
      const layer = Math.floor(slotIndex / 9);
      const inLayer = slotIndex % 9;
      const r = inLayer === 0 ? 0.0 : inLayer < 5 ? 0.145 : 0.255;
      const theta = slotIndex * 2.15;

      const m = new THREE.Mesh(this.stoneGeo, stoneColor === BLACK ? this.blackMat : this.whiteMat);
      m.scale.setScalar(lidScale);
      m.position.set(
        anchor.lidCenter.x + Math.cos(theta) * r,
        anchor.lidCenter.y + lidScale * 0.44 + layer * (lidScale * 0.72),
        anchor.lidCenter.z + Math.sin(theta) * r
      );
      m.rotation.set((Math.random() - 0.5) * 0.2, slotIndex * 1.1, (Math.random() - 0.5) * 0.2);
      m.castShadow = true;
      this.parent.add(m);
      list.push(m);
    }
  }

  private removeBoardStoneImmediate(idx: number): void {
    const existing = this.boardStones.get(idx);
    if (existing) {
      this.parent.remove(existing.mesh);
      this.parent.remove(existing.aoMesh);
      this.parent.remove(existing.rippleMesh);
      existing.aoMat.dispose();
      existing.rippleMat.dispose();
      this.boardStones.delete(idx);
    }
  }

  public update(dt: number): void {
    const clampedDt = Math.min(0.05, dt);

    // 1. Touch-only bowl stone dynamics inside jujube bowls (zero motion unless stirred)
    const stepBowl = (
      items: BowlStoneVisual[],
      anchor: BowlAnchor,
      timer: number
    ): number => {
      if (timer <= 0) return 0;

      const nextTimer = Math.max(0, timer - clampedDt);
      const particles = items.map((v) => v.particle);
      this.physicsWorld.stepContainerStones(particles, clampedDt, 0.36, 0.104, 0.045);

      const dampingTail = nextTimer < 0.25 ? Math.max(0, nextTimer / 0.25) : 1;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const p = it.particle;
        if (nextTimer <= 0) {
          p.x = p.restX;
          p.y = p.restY;
          p.z = p.restZ;
          p.vx = 0;
          p.vy = 0;
          p.vz = 0;
          p.rotX = p.restRotX;
          p.rotZ = p.restRotZ;
          p.angVx = 0;
          p.angVz = 0;
        } else if (dampingTail < 1) {
          p.vx *= 0.8;
          p.vy *= 0.8;
          p.vz *= 0.8;
          p.angVx *= 0.8;
          p.angVz *= 0.8;
          p.x = p.restX + (p.x - p.restX) * dampingTail;
          p.y = p.restY + (p.y - p.restY) * dampingTail;
          p.z = p.restZ + (p.z - p.restZ) * dampingTail;
          p.rotX = p.restRotX + (p.rotX - p.restRotX) * dampingTail;
          p.rotZ = p.restRotZ + (p.rotZ - p.restRotZ) * dampingTail;
        }

        it.mesh.position.set(
          anchor.stonePileOrigin.x + p.x,
          p.y,
          anchor.stonePileOrigin.z + p.z
        );
        it.mesh.rotation.set(p.rotX, it.baseRotY, p.rotZ);
      }
      return nextTimer;
    };

    if (this.bowlAwakeTimerBlack > 0) {
      this.bowlAwakeTimerBlack = stepBowl(
        this.bowlStonesBlack,
        this.blackBowl,
        this.bowlAwakeTimerBlack
      );
    }
    if (this.bowlAwakeTimerWhite > 0) {
      this.bowlAwakeTimerWhite = stepBowl(
        this.bowlStonesWhite,
        this.whiteBowl,
        this.bowlAwakeTimerWhite
      );
    }

    // 2. Sub-stepped 2.5D rigid-body board stones (motion arc, impact bounce, neighbor clinks)
    this.bodiesScratch.length = 0;
    for (const st of this.boardStones.values()) {
      this.bodiesScratch.push(st.body);
    }
    this.physicsWorld.stepBoardStones(this.bodiesScratch, clampedDt);

    for (const st of this.boardStones.values()) {
      const b = st.body;
      st.mesh.position.set(b.x, st.boardSurfaceY + b.y, b.z);
      st.mesh.rotation.set(b.rotX, b.rotY, b.rotZ);

      st.aoMesh.position.set(b.x, 0.0025, b.z);
      const heightFade = Math.max(0.25, 1 - b.y * 1.4);
      if (st.mesh.castShadow) {
        st.aoMat.opacity = 0.36 * b.aoAlpha * heightFade;
      }

      if (b.rippleAge >= 0) {
        const u = Math.min(1, b.rippleAge / 0.42);
        st.rippleMesh.visible = true;
        st.rippleMesh.position.set(b.restX, 0.0035, b.restZ);
        st.rippleMesh.scale.setScalar(b.radius * (1.05 + u * 1.15));
        st.rippleMat.opacity = (1 - u) * 0.48;
      } else {
        st.rippleMesh.visible = false;
      }
    }

    // 3. Flying captured prisoners into lid
    for (let i = this.flyingPrisoners.length - 1; i >= 0; i--) {
      const fp = this.flyingPrisoners[i];
      fp.elapsed += clampedDt;
      if (fp.elapsed < fp.delay) continue;

      const u = Math.min(1, (fp.elapsed - fp.delay) / fp.duration);
      const ease = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
      fp.mesh.position.lerpVectors(fp.startPos, fp.endPos, ease);
      fp.mesh.position.y += Math.sin(Math.PI * u) * 0.72;
      fp.mesh.rotation.x = fp.endRot.x + (1 - u) * 0.8;
      fp.mesh.rotation.z = fp.endRot.z + (1 - u) * 0.6;

      if (u >= 1) {
        fp.mesh.position.copy(fp.endPos);
        fp.mesh.rotation.copy(fp.endRot);
        const list =
          fp.lidTarget === 'black' ? this.settledPrisonersBlackLid : this.settledPrisonersWhiteLid;
        if (list.length < 45) {
          list.push(fp.mesh);
        } else {
          this.parent.remove(fp.mesh);
        }
        this.flyingPrisoners.splice(i, 1);
      }
    }

    // 4. Wooden lid vibration
    if (this.lidShakeBlack > 0.001) {
      this.lidShakeBlack *= Math.exp(-14 * clampedDt);
      this.blackBowl.lidMesh.rotation.z = Math.sin(performance.now() * 0.065) * 0.035 * this.lidShakeBlack;
    } else {
      this.blackBowl.lidMesh.rotation.z = 0;
    }

    if (this.lidShakeWhite > 0.001) {
      this.lidShakeWhite *= Math.exp(-14 * clampedDt);
      this.whiteBowl.lidMesh.rotation.z = Math.sin(performance.now() * 0.065) * 0.035 * this.lidShakeWhite;
    } else {
      this.whiteBowl.lidMesh.rotation.z = 0;
    }
  }
}
