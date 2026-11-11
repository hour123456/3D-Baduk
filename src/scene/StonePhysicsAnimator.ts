import * as THREE from 'three';
import { BLACK, WHITE, EMPTY, BoardSize, Coord, PlayerColor, StoneColor } from '../rules/types';
import { AcousticStoneAudioEngine } from '../audio/AcousticStoneAudioEngine';
import { BoardGridMetrics, createClamshellStoneTexture, createSlateStoneTexture } from './ProceduralTextures';
import { BowlAnchor } from './GobanBuilder';

/**
 * Builds an authentic 36-go Biconvex Lens Go Stone Geometry (unit radius = 1.0, height = 0.92)
 * so scaling by `stoneRadius` yields exact proportional stones for 9x9, 13x13, and 19x19.
 */
export function createBiconvexStoneGeometry(): THREE.BufferGeometry {
  const profile: THREE.Vector2[] = [];
  const halfH = 0.46; // total height = 0.92 when radius = 1.0
  const steps = 24;

  for (let i = 0; i <= steps; i++) {
    // theta from -PI/2 (bottom pole) to +PI/2 (top pole)
    const u = i / steps;
    const angle = (u - 0.5) * Math.PI;
    // Biconvex lens profile: flattened spherical dome with soft rounded equatorial shoulder
    const r = Math.cos(angle);
    const y = Math.sin(angle) * halfH * (0.88 + 0.12 * Math.cos(angle * 0.6));
    profile.push(new THREE.Vector2(Math.max(0, r), y));
  }

  const geo = new THREE.LatheGeometry(profile, 40);
  geo.computeVertexNormals();
  return geo;
}

interface BowlStoneItem {
  mesh: THREE.Mesh;
  basePos: THREE.Vector3;
  baseRot: THREE.Euler;
  offset: THREE.Vector3;
  vel: THREE.Vector3;
  rotOffset: THREE.Vector2;
  rotVel: THREE.Vector2;
}

interface ActiveBoardStone {
  mesh: THREE.Mesh;
  color: PlayerColor;
  gridX: number;
  gridY: number;
  restPos: THREE.Vector3;
  baseYaw: number;
  // Spring micro-jostle state (when adjacent stones are placed!)
  jostleOffset: THREE.Vector2;
  jostleVel: THREE.Vector2;
  jostleTilt: THREE.Vector2;
  // Placement flight animation state
  placing?: {
    elapsed: number;
    duration: number;
    startPos: THREE.Vector3;
    soundPlayed: boolean;
    force: number;
    adjacentCount: number;
  };
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
  landed: boolean;
  lidTarget: 'black' | 'white'; // 'black' = Black's lid (holds captured White stones)
}

export class StonePhysicsAnimator {
  private parent: THREE.Group;
  private audio: AcousticStoneAudioEngine;
  private metrics: BoardGridMetrics;
  private blackBowl: BowlAnchor;
  private whiteBowl: BowlAnchor;

  private stoneGeo: THREE.BufferGeometry;
  public readonly blackMat: THREE.MeshPhysicalMaterial;
  public readonly whiteMat: THREE.MeshPhysicalMaterial;
  private deadBlackMat: THREE.MeshPhysicalMaterial;
  private deadWhiteMat: THREE.MeshPhysicalMaterial;

  private bowlStonesBlack: BowlStoneItem[] = [];
  private bowlStonesWhite: BowlStoneItem[] = [];

  private boardStones = new Map<number, ActiveBoardStone>();
  private flyingPrisoners: FlyingPrisoner[] = [];
  private settledPrisonersBlackLid: THREE.Mesh[] = []; // White stones captured by Black
  private settledPrisonersWhiteLid: THREE.Mesh[] = []; // Black stones captured by White

  private lidShakeBlack = 0;
  private lidShakeWhite = 0;

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
    const slateTex = createSlateStoneTexture();
    const shellTex = createClamshellStoneTexture();

    // Nachi Black Slate (오석: 깊은 차콜 무광 사틴 광택)
    this.blackMat = new THREE.MeshPhysicalMaterial({
      map: slateTex,
      color: 0x1a1c20,
      roughness: 0.27,
      metalness: 0.04,
      clearcoat: 0.34,
      clearcoatRoughness: 0.26,
    });

    // Hyuga Clamshell (해남석/일향백석: 은은한 조개결과 매끄러운 유백색 광택)
    this.whiteMat = new THREE.MeshPhysicalMaterial({
      map: shellTex,
      color: 0xfbf9f3,
      roughness: 0.14,
      metalness: 0.02,
      clearcoat: 0.68,
      clearcoatRoughness: 0.12,
    });

    this.deadBlackMat = this.blackMat.clone();
    this.deadBlackMat.transparent = true;
    this.deadBlackMat.opacity = 0.38;

    this.deadWhiteMat = this.whiteMat.clone();
    this.deadWhiteMat.transparent = true;
    this.deadWhiteMat.opacity = 0.42;

    this.populateBowlStones();
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

  /**
   * Populates 36 visible biconvex stones inside both Go bowls so hovering/picking up stones
   * produces tangible 3D stone jostling synchronized with the rattle audio!
   */
  private populateBowlStones(): void {
    const bowlStoneRadius = 0.104;

    const buildPile = (anchor: BowlAnchor, color: PlayerColor): BowlStoneItem[] => {
      const items: BowlStoneItem[] = [];
      const mat = color === BLACK ? this.blackMat : this.whiteMat;
      const count = 36;

      for (let i = 0; i < count; i++) {
        const layer = Math.floor(i / 12); // 0, 1, 2
        const idxInLayer = i % 12;
        const ringR = idxInLayer === 0 ? 0.0 : idxInLayer < 5 ? 0.15 : 0.285;
        const angle = idxInLayer * 1.65 + layer * 0.9;

        const px = anchor.stonePileOrigin.x + Math.cos(angle) * ringR + (Math.random() - 0.5) * 0.03;
        const pz = anchor.stonePileOrigin.z + Math.sin(angle) * ringR + (Math.random() - 0.5) * 0.03;
        const py = anchor.stonePileOrigin.y - 0.12 + layer * 0.068 + (1 - ringR) * 0.03;

        const mesh = new THREE.Mesh(this.stoneGeo, mat);
        mesh.scale.setScalar(bowlStoneRadius);
        mesh.position.set(px, py, pz);
        const baseRot = new THREE.Euler(
          (Math.random() - 0.5) * 0.48,
          Math.random() * Math.PI * 2,
          (Math.random() - 0.5) * 0.48
        );
        mesh.rotation.copy(baseRot);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.parent.add(mesh);

        items.push({
          mesh,
          basePos: new THREE.Vector3(px, py, pz),
          baseRot,
          offset: new THREE.Vector3(),
          vel: new THREE.Vector3(),
          rotOffset: new THREE.Vector2(),
          rotVel: new THREE.Vector2(),
        });
      }
      return items;
    };

    this.bowlStonesBlack = buildPile(this.blackBowl, BLACK);
    this.bowlStonesWhite = buildPile(this.whiteBowl, WHITE);
  }

  /**
   * Impulses the 3D stones inside a Go bowl to jostle & rattle naturally.
   */
  public stirBowl(which: 'black' | 'white', intensity = 0.8, playSound = true): void {
    const items = which === 'black' ? this.bowlStonesBlack : this.bowlStonesWhite;
    const clamped = Math.max(0.25, Math.min(1.25, intensity));

    for (let i = 0; i < items.length; i++) {
      // Top-layer stones move more vividly than deeper stones
      const layerFactor = 0.4 + (i / items.length) * 0.85;
      const amp = 0.09 * clamped * layerFactor;
      const it = items[i];
      it.vel.x += (Math.random() - 0.5) * amp * 12;
      it.vel.y += Math.random() * amp * 8;
      it.vel.z += (Math.random() - 0.5) * amp * 12;
      it.rotVel.x += (Math.random() - 0.5) * clamped * 9;
      it.rotVel.y += (Math.random() - 0.5) * clamped * 9;
    }

    if (playSound) {
      const side = which === 'black' ? 'right' : 'left';
      this.audio.playBowlRattle(side, clamped, which === 'black');
    }
  }

  private humanJitter(x: number, y: number): THREE.Vector2 {
    // Deterministic subtle organic offset (±3.5% of stone radius) so stones feel placed by a master's hand
    const h1 = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    const h2 = Math.sin(x * 39.3468 + y * 11.135) * 24634.6345;
    const jx = ((h1 - Math.floor(h1)) - 0.5) * this.metrics.stoneRadius * 0.065;
    const jz = ((h2 - Math.floor(h2)) - 0.5) * this.metrics.stoneRadius * 0.065;
    return new THREE.Vector2(jx, jz);
  }

  /**
   * Animates a newly played stone lifting from the player's bowl and snapping onto `(x, y)`,
   * nudging adjacent stones on impact and capturing any opponent stones into the bowl lid!
   */
  public animateMovePlacement(params: {
    x: number;
    y: number;
    color: PlayerColor;
    captured: Coord[];
    adjacentCount: number;
  }): void {
    const { x, y, color, captured, adjacentCount } = params;
    const idx = y * this.metrics.size + x;

    // Remove if somehow already occupied
    this.removeBoardStoneImmediate(idx);

    const whichBowl = color === BLACK ? 'black' : 'white';
    const bowlAnchor = color === BLACK ? this.blackBowl : this.whiteBowl;
    const side = color === BLACK ? 'right' : 'left';

    // Subtle stone pickup sound + gentle stir in the active bowl!
    this.stirBowl(whichBowl, 0.42, false);
    this.audio.playStonePickup(side, color === BLACK);

    const restPos = this.gridToWorld(x, y);
    const jitter = this.humanJitter(x, y);
    restPos.x += jitter.x;
    restPos.z += jitter.y;

    const mesh = new THREE.Mesh(this.stoneGeo, color === BLACK ? this.blackMat : this.whiteMat);
    mesh.scale.setScalar(this.metrics.stoneRadius);
    mesh.position.copy(bowlAnchor.stonePileOrigin).add(new THREE.Vector3(0, 0.25, 0));
    const baseYaw = Math.random() * Math.PI * 2;
    mesh.rotation.set(0.22, baseYaw, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.parent.add(mesh);

    const force = captured.length > 0 ? 1.15 : adjacentCount >= 2 ? 1.04 : 0.88 + Math.random() * 0.14;

    this.boardStones.set(idx, {
      mesh,
      color,
      gridX: x,
      gridY: y,
      restPos,
      baseYaw,
      jostleOffset: new THREE.Vector2(),
      jostleVel: new THREE.Vector2(),
      jostleTilt: new THREE.Vector2(),
      placing: {
        elapsed: 0,
        duration: 0.22,
        startPos: mesh.position.clone(),
        soundPlayed: false,
        force,
        adjacentCount,
      },
    });

    // Schedule captured opponent stones to lift and arc into the capturing player's lid right as stone lands!
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
        this.boardStones.delete(cIdx);
      } else {
        mesh = new THREE.Mesh(this.stoneGeo, capturedColor === BLACK ? this.blackMat : this.whiteMat);
        mesh.scale.setScalar(this.metrics.stoneRadius);
        startPos = this.gridToWorld(pt.x, pt.y);
        mesh.position.copy(startPos);
        mesh.castShadow = true;
        this.parent.add(mesh);
      }

      // Compute natural spiral pile slot inside the upside-down bowl lid
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
        delay: 0.21 + i * 0.038, // Starts right after the capturing stone snaps onto the board!
        elapsed: 0,
        duration: 0.36,
        landed: false,
        lidTarget: targetLidKey,
      });
    });

    // Schedule synchronized lid drop audio right when the first prisoner hits the lid (~0.21 + 0.36 = 0.57s)
    const impactDelayMs = Math.round((0.21 + 0.33) * 1000);
    window.setTimeout(() => {
      const side = capturingColor === BLACK ? 'right' : 'left';
      this.audio.playCaptureToLid(captured.length, existingCount, side, capturedColor === BLACK);
      if (targetLidKey === 'black') this.lidShakeBlack = Math.min(1.0, 0.35 + captured.length * 0.12);
      else this.lidShakeWhite = Math.min(1.0, 0.35 + captured.length * 0.12);
    }, impactDelayMs);
  }

  /**
   * Synchronizes the entire 3D board & prisoner lids instantaneously with a given board snapshot
   * (used for New Game, Handicap initialization, Undo, SGF load, and Review scrubbing).
   */
  public syncBoardSnapshot(
    board: Uint8Array,
    size: BoardSize,
    captures: { black: number; white: number },
    deadStoneMask?: Uint8Array
  ): void {
    // Clear any in-flight prisoner animations
    for (const fp of this.flyingPrisoners) {
      this.parent.remove(fp.mesh);
    }
    this.flyingPrisoners = [];

    // Remove stones that no longer exist or changed color
    for (const [idx, st] of Array.from(this.boardStones.entries())) {
      if (idx >= size * size || board[idx] !== st.color) {
        this.parent.remove(st.mesh);
        this.boardStones.delete(idx);
      }
    }

    // Add or update all stones on board
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
          restPos.x += jitter.x;
          restPos.z += jitter.y;

          const mesh = new THREE.Mesh(this.stoneGeo, c === BLACK ? this.blackMat : this.whiteMat);
          mesh.scale.setScalar(this.metrics.stoneRadius);
          mesh.position.copy(restPos);
          const baseYaw = ((x * 73 + y * 137) % 360) * (Math.PI / 180);
          mesh.rotation.set(0, baseYaw, 0);
          mesh.castShadow = !isDead;
          mesh.receiveShadow = true;
          this.parent.add(mesh);

          entry = {
            mesh,
            color: c,
            gridX: x,
            gridY: y,
            restPos,
            baseYaw,
            jostleOffset: new THREE.Vector2(),
            jostleVel: new THREE.Vector2(),
            jostleTilt: new THREE.Vector2(),
          };
          this.boardStones.set(idx, entry);
        } else {
          // Ensure snapped to rest if syncing
          entry.placing = undefined;
          entry.mesh.scale.setScalar(this.metrics.stoneRadius);
          entry.restPos = this.gridToWorld(x, y).add(
            new THREE.Vector3(this.humanJitter(x, y).x, 0, this.humanJitter(x, y).y)
          );
          entry.mesh.position.copy(entry.restPos);
        }

        // Apply dead stone ghost material if in scoring phase
        if (isDead) {
          entry.mesh.material = c === BLACK ? this.deadBlackMat : this.deadWhiteMat;
          entry.mesh.castShadow = false;
        } else {
          entry.mesh.material = c === BLACK ? this.blackMat : this.whiteMat;
          entry.mesh.castShadow = true;
        }
      }
    }

    // Sync visible prisoner counts in lids (cap visual meshes at 40 per lid)
    this.syncPrisonerPile(this.settledPrisonersBlackLid, Math.min(40, captures.black), WHITE, this.blackBowl);
    this.syncPrisonerPile(this.settledPrisonersWhiteLid, Math.min(40, captures.white), BLACK, this.whiteBowl);
  }

  public snapAllToRest(): void {
    for (const st of this.boardStones.values()) {
      if (st.placing) {
        st.placing = undefined;
      }
      st.jostleOffset.set(0, 0);
      st.jostleVel.set(0, 0);
      st.jostleTilt.set(0, 0);
      st.mesh.position.copy(st.restPos);
      st.mesh.rotation.set(0, st.baseYaw, 0);
    }
  }

  public updateDeadMaskVisuals(deadMask: Uint8Array | null): void {
    for (const [idx, st] of this.boardStones.entries()) {
      const isDead = deadMask ? deadMask[idx] === 1 : false;
      if (isDead) {
        st.mesh.material = st.color === BLACK ? this.deadBlackMat : this.deadWhiteMat;
        st.mesh.castShadow = false;
      } else {
        st.mesh.material = st.color === BLACK ? this.blackMat : this.whiteMat;
        st.mesh.castShadow = true;
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
      this.boardStones.delete(idx);
    }
  }

  private triggerAdjacentMicroJostle(cx: number, cy: number, force: number): void {
    const dirs = [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ];
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || nx >= this.metrics.size || ny < 0 || ny >= this.metrics.size) continue;
      const nStone = this.boardStones.get(ny * this.metrics.size + nx);
      if (nStone && !nStone.placing) {
        const impulse = 0.22 * force * this.metrics.stoneRadius;
        nStone.jostleVel.x += dx * impulse * 18 + (Math.random() - 0.5) * impulse * 5;
        nStone.jostleVel.y += dy * impulse * 18 + (Math.random() - 0.5) * impulse * 5;
        nStone.jostleTilt.set(-dy * 0.11 * force, dx * 0.11 * force);
      }
    }
  }

  public update(dt: number): void {
    const clampedDt = Math.min(0.05, dt);

    // 1. Update bowl stone spring-damper micro-collisions
    const stepBowlList = (items: BowlStoneItem[]) => {
      const stiffness = 135;
      const damping = 12.5;
      for (const it of items) {
        it.vel.x += (-stiffness * it.offset.x - damping * it.vel.x) * clampedDt;
        it.vel.y += (-stiffness * it.offset.y - damping * it.vel.y) * clampedDt;
        it.vel.z += (-stiffness * it.offset.z - damping * it.vel.z) * clampedDt;
        it.offset.addScaledVector(it.vel, clampedDt);
        // Prevent sinking below base floor
        if (it.offset.y < -0.015) {
          it.offset.y = -0.015;
          it.vel.y *= -0.35;
        }

        it.rotVel.x += (-120 * it.rotOffset.x - 11 * it.rotVel.x) * clampedDt;
        it.rotVel.y += (-120 * it.rotOffset.y - 11 * it.rotVel.y) * clampedDt;
        it.rotOffset.x += it.rotVel.x * clampedDt;
        it.rotOffset.y += it.rotVel.y * clampedDt;

        it.mesh.position.copy(it.basePos).add(it.offset);
        it.mesh.rotation.set(
          it.baseRot.x + it.rotOffset.x,
          it.baseRot.y,
          it.baseRot.z + it.rotOffset.y
        );
      }
    };
    stepBowlList(this.bowlStonesBlack);
    stepBowlList(this.bowlStonesWhite);

    // 2. Update board stone placement trajectories & neighbor micro-jostle springs
    for (const st of this.boardStones.values()) {
      if (st.placing) {
        st.placing.elapsed += clampedDt;
        const t = Math.min(1, st.placing.elapsed / st.placing.duration);

        // Smooth ease-out cubic horizontal glide + parabolic arc + final crisp rim-to-belly snap!
        const ease = 1 - Math.pow(1 - t, 3);
        st.mesh.position.lerpVectors(st.placing.startPos, st.restPos, ease);

        // Arc height peaks around t = 0.42
        const arcLift = Math.sin(Math.PI * Math.pow(t, 0.82)) * 0.48;
        st.mesh.position.y += arcLift;

        // Biconvex rock-down angle: tilted slightly forward until t = 0.84, then snaps flat onto wood!
        let rockPitch = 0;
        if (t < 0.84) {
          rockPitch = 0.24 * (1 - t * 0.5);
        } else {
          const snapPhase = (t - 0.84) / 0.16;
          rockPitch = 0.14 * (1 - snapPhase);
        }
        st.mesh.rotation.set(rockPitch, st.baseYaw, 0);

        if (!st.placing.soundPlayed && t >= 0.92) {
          st.placing.soundPlayed = true;
          const half = Math.max(1, (this.metrics.size - 1) / 2);
          const normX = (st.gridX - half) / half;
          const normY = (st.gridY - half) / half;

          this.audio.playStonePlace({
            normX,
            normY,
            force: st.placing.force,
            isBlack: st.color === BLACK,
            adjacentStones: st.placing.adjacentCount,
          });
          this.triggerAdjacentMicroJostle(st.gridX, st.gridY, st.placing.force);
        }

        if (t >= 1) {
          st.mesh.position.copy(st.restPos);
          st.mesh.rotation.set(0, st.baseYaw, 0);
          st.placing = undefined;
        }
      } else {
        // Settle neighbor micro-jostle spring
        const k = 220;
        const d = 16;
        st.jostleVel.x += (-k * st.jostleOffset.x - d * st.jostleVel.x) * clampedDt;
        st.jostleVel.y += (-k * st.jostleOffset.y - d * st.jostleVel.y) * clampedDt;
        st.jostleOffset.x += st.jostleVel.x * clampedDt;
        st.jostleOffset.y += st.jostleVel.y * clampedDt;
        st.jostleTilt.multiplyScalar(Math.exp(-18 * clampedDt));

        st.mesh.position.set(
          st.restPos.x + st.jostleOffset.x,
          st.restPos.y,
          st.restPos.z + st.jostleOffset.y
        );
        st.mesh.rotation.set(st.jostleTilt.x, st.baseYaw, st.jostleTilt.y);
      }
    }

    // 3. Update flying captured prisoners arcing into the wooden lid
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

    // 4. Subtle wooden lid vibration when captured stones drop inside
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
