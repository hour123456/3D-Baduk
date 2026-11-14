import { BLACK, PlayerColor } from '../rules/types';
import type { PhysicsIntensity, StoneMotionStyle } from '../settings/SettingsManager';

export interface StonePhysicsBody {
  key: string;
  color: PlayerColor;
  x: number;
  y: number; // height offset above board surface (0 = resting flat)
  z: number;
  restX: number;
  restZ: number;
  vx: number;
  vy: number;
  vz: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  angVx: number;
  angVz: number;
  radius: number;
  halfHeight: number;
  motionStyle: StoneMotionStyle;
  phaseElapsed: number;
  flightDuration: number;
  flightActive: boolean;
  startPosX: number;
  startPosY: number;
  startPosZ: number;
  ctrlPosX: number;
  ctrlPosY: number;
  ctrlPosZ: number;
  impactFired: boolean;
  aoAlpha: number;
  rippleAge: number; // < 0 means inactive, >= 0 expands and fades
  hasMoved: boolean;
}

export interface BowlPhysicsParticle {
  x: number;
  y: number;
  z: number;
  restX: number;
  restY: number;
  restZ: number;
  vx: number;
  vy: number;
  vz: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  angVx: number;
  angVz: number;
}

export interface StonePhysicsCallbacks {
  onBoardImpact?: (body: StonePhysicsBody, impactEnergy: number) => void;
  onStoneClink?: (relSpeed: number, color: PlayerColor, worldX: number) => void;
}

const MAX_DT = 0.04;
const SUBSTEPS = 4;
const GRAVITY = 28.0;

/**
 * Pure TypeScript 2.5D rigid-body & motion solver for Baduk / Omok stones.
 * Decouples sub-stepped elastic circle impulse, Coulomb friction, and rim-to-belly
 * placement dynamics from Three.js mesh management.
 */
export class StonePhysicsWorld {
  private motionStyle: StoneMotionStyle = 'realistic';
  private physicsIntensity: PhysicsIntensity = 'realistic';
  private callbacks: StonePhysicsCallbacks;
  private clinkCooldown = 0;

  constructor(callbacks: StonePhysicsCallbacks = {}) {
    this.callbacks = callbacks;
  }

  public setMotionStyle(style: StoneMotionStyle): void {
    this.motionStyle = style;
  }

  public getMotionStyle(): StoneMotionStyle {
    return this.motionStyle;
  }

  public setPhysicsIntensity(intensity: PhysicsIntensity): void {
    this.physicsIntensity = intensity;
  }

  public getPhysicsIntensity(): PhysicsIntensity {
    return this.physicsIntensity;
  }

  private getIntensityScale(): number {
    switch (this.physicsIntensity) {
      case 'realistic':
        return 1.0;
      case 'subtle':
        return 0.45;
      case 'minimal':
        return 0.0;
    }
  }

  /**
   * Initializes a newly placed stone's trajectory & initial rigid-body kinematics.
   */
  public spawnPlacementBody(params: {
    key: string;
    color: PlayerColor;
    targetX: number;
    targetZ: number;
    bowlX: number;
    bowlY: number;
    bowlZ: number;
    radius: number;
    halfHeight: number;
    jitterX: number;
    jitterZ: number;
    boardSurfaceY: number;
  }): StonePhysicsBody {
    const {
      key,
      color,
      targetX,
      targetZ,
      bowlX,
      bowlY,
      bowlZ,
      radius,
      halfHeight,
      jitterX,
      jitterZ,
      boardSurfaceY,
    } = params;

    const restX = targetX + jitterX;
    const restZ = targetZ + jitterZ;
    const signZ = color === BLACK ? 1 : -1;

    if (this.motionStyle === 'instant') {
      return {
        key,
        color,
        x: restX,
        y: 0.012,
        z: restZ,
        restX,
        restZ,
        vx: 0,
        vy: -0.6,
        vz: 0,
        rotX: 0,
        rotY: Math.random() * Math.PI * 2,
        rotZ: 0,
        angVx: 0,
        angVz: 0,
        radius,
        halfHeight,
        motionStyle: 'instant',
        phaseElapsed: 0,
        flightDuration: 0,
        flightActive: false,
        startPosX: restX,
        startPosY: 0,
        startPosZ: restZ,
        ctrlPosX: restX,
        ctrlPosY: 0,
        ctrlPosZ: restZ,
        impactFired: true,
        aoAlpha: 1,
        rippleAge: 0,
        hasMoved: false,
      };
    }

    if (this.motionStyle === 'classic_bowl') {
      const startRelY = Math.max(0.08, bowlY - boardSurfaceY + 0.09);
      const dx = restX - bowlX;
      const dz = restZ - bowlZ;
      const dist = Math.hypot(dx, dz);
      const flightDuration = 0.275;
      const arcPeak = Math.max(0.75, dist * 0.22);

      return {
        key,
        color,
        x: bowlX,
        y: startRelY,
        z: bowlZ,
        restX,
        restZ,
        vx: 0,
        vy: 0,
        vz: 0,
        rotX: signZ * 0.16,
        rotY: Math.random() * Math.PI * 2,
        rotZ: (Math.random() - 0.5) * 0.12,
        angVx: -signZ * 1.4,
        angVz: (Math.random() - 0.5) * 1.2,
        radius,
        halfHeight,
        motionStyle: 'classic_bowl',
        phaseElapsed: 0,
        flightDuration,
        flightActive: true,
        startPosX: bowlX,
        startPosY: startRelY,
        startPosZ: bowlZ,
        ctrlPosX: (bowlX + restX) * 0.5 + (color === BLACK ? -0.18 : 0.18),
        ctrlPosY: Math.max(startRelY, 0.2) + arcPeak,
        ctrlPosZ: (bowlZ + restZ) * 0.5,
        impactFired: false,
        aoAlpha: 0.12,
        rippleAge: -1,
        hasMoved: true,
      };
    }

    // Default: 'realistic' master close-range fingertip release (rim-first snap -> belly slap)
    const offsetMag = radius * 0.36;
    const startX = restX + (Math.random() - 0.5) * radius * 0.18;
    const startY = Math.max(0.32, radius * 3.8);
    const startZ = restZ + signZ * offsetMag;
    const flightDuration = 0.088;

    return {
      key,
      color,
      x: startX,
      y: startY,
      z: startZ,
      restX,
      restZ,
      vx: (restX - startX) / flightDuration,
      vy: -2.4,
      vz: (restZ - startZ) / flightDuration,
      // Held between index & middle fingertip: slight forward/side rim pitch
      rotX: signZ * 0.34,
      rotY: Math.random() * Math.PI * 2,
      rotZ: (Math.random() > 0.5 ? 1 : -1) * 0.16,
      angVx: -signZ * 3.8,
      angVz: (Math.random() - 0.5) * 2.4,
      radius,
      halfHeight,
      motionStyle: 'realistic',
      phaseElapsed: 0,
      flightDuration,
      flightActive: true,
      startPosX: startX,
      startPosY: startY,
      startPosZ: startZ,
      ctrlPosX: (startX + restX) * 0.5,
      ctrlPosY: startY * 0.62,
      ctrlPosZ: (startZ + restZ) * 0.5,
      impactFired: false,
      aoAlpha: 0.08,
      rippleAge: -1,
      hasMoved: true,
    };
  }

  /**
   * Advances all board stones through flight phase and sub-stepped rigid-body collision/friction.
   */
  public stepBoardStones(stones: StonePhysicsBody[], dtRaw: number): void {
    const dt = Math.min(MAX_DT, dtRaw);
    if (dt <= 0) return;

    if (this.clinkCooldown > 0) {
      this.clinkCooldown = Math.max(0, this.clinkCooldown - dt);
    }

    const intensity = this.getIntensityScale();
    const subDt = dt / SUBSTEPS;

    // Advance active pre-impact trajectories first
    for (let i = 0; i < stones.length; i++) {
      const s = stones[i];
      if (s.rippleAge >= 0) {
        s.rippleAge += dt;
        if (s.rippleAge > 0.42) s.rippleAge = -1;
      }

      if (!s.flightActive) continue;

      s.phaseElapsed += dt;
      const t = Math.min(1, s.phaseElapsed / Math.max(0.01, s.flightDuration));

      if (s.motionStyle === 'classic_bowl') {
        const omt = 1 - t;
        s.x = omt * omt * s.startPosX + 2 * omt * t * s.ctrlPosX + t * t * s.restX;
        s.y = omt * omt * s.startPosY + 2 * omt * t * s.ctrlPosY + t * t * 0;
        s.z = omt * omt * s.startPosZ + 2 * omt * t * s.ctrlPosZ + t * t * s.restZ;
        s.rotX *= 1 - Math.min(0.85, dt * 11);
        s.rotZ *= 1 - Math.min(0.85, dt * 11);
        s.aoAlpha = 0.15 + 0.85 * Math.pow(t, 2);

        if (t >= 1) {
          s.flightActive = false;
          s.y = 0.002;
          s.vy = -1.9 * (0.45 + 0.55 * intensity);
          s.impactFired = true;
          s.rippleAge = 0;
          s.aoAlpha = 1;
          this.applyImpactShockwave(stones, s, intensity * 0.9);
          this.callbacks.onBoardImpact?.(s, 0.85);
        }
      } else {
        // 'realistic' accelerated close fingertip release -> crisp gravity snap
        const ease = t * t * (0.35 + 0.65 * t);
        s.x = s.startPosX + (s.restX - s.startPosX) * ease;
        s.y = s.startPosY * (1 - ease);
        s.z = s.startPosZ + (s.restZ - s.startPosZ) * ease;
        // Rim hits first around t=0.82, then belly slaps down rapidly
        const tiltDecay = 1 - Math.pow(t, 1.8);
        s.rotX *= 0.86 + 0.12 * tiltDecay;
        s.rotZ *= 0.86 + 0.12 * tiltDecay;
        s.aoAlpha = 0.1 + 0.9 * ease;

        if (t >= 1) {
          s.flightActive = false;
          s.x = s.restX;
          s.y = 0.001;
          s.z = s.restZ;
          s.vx = (s.restX - s.startPosX) * 0.55;
          s.vy = -2.35 * (0.35 + 0.65 * intensity);
          s.vz = (s.restZ - s.startPosZ) * 0.55;
          // Impart belly-slap counter-rocking torque
          s.angVx = (s.color === BLACK ? 1 : -1) * 9.5 * (0.4 + 0.6 * intensity);
          s.angVz = (Math.random() - 0.5) * 6.0 * intensity;
          s.impactFired = true;
          s.rippleAge = 0;
          s.aoAlpha = 1;
          this.applyImpactShockwave(stones, s, intensity);
          this.callbacks.onBoardImpact?.(s, 1.0);
        }
      }
    }

    if (intensity <= 0.001) {
      // Minimal physics mode: quickly damp any residual bounce directly to rest
      for (let i = 0; i < stones.length; i++) {
        const s = stones[i];
        if (s.flightActive) continue;
        s.x += (s.restX - s.x) * Math.min(1, dt * 24);
        s.z += (s.restZ - s.z) * Math.min(1, dt * 24);
        s.y = Math.max(0, s.y * 0.5);
        s.rotX *= 0.6;
        s.rotZ *= 0.6;
      }
      return;
    }

    // Sub-stepped 2.5D rigid-body simulation (gravity, floor restitution, 2D circle impulse, Coulomb friction)
    const n = stones.length;
    for (let step = 0; step < SUBSTEPS; step++) {
      // 1. Pairwise horizontal collision resolution (only check nearby dynamic or bumped pairs)
      for (let i = 0; i < n; i++) {
        const a = stones[i];
        if (a.flightActive) continue;
        const speedA = Math.abs(a.vx) + Math.abs(a.vz);

        for (let j = i + 1; j < n; j++) {
          const b = stones[j];
          if (b.flightActive) continue;
          // Quick bounding-box skip
          const maxReach = (a.radius + b.radius) * 1.02;
          const dx = b.x - a.x;
          if (dx > maxReach || dx < -maxReach) continue;
          const dz = b.z - a.z;
          if (dz > maxReach || dz < -maxReach) continue;

          // Only collide if vertically overlapping within stone thickness
          if (Math.abs(a.y - b.y) > a.halfHeight * 2.1) continue;

          const minDist = (a.radius + b.radius) * 0.992;
          const distSq = dx * dx + dz * dz;
          if (distSq >= minDist * minDist) continue;

          const speedB = Math.abs(b.vx) + Math.abs(b.vz);
          if (speedA + speedB < 0.004 && distSq > (minDist * 0.96) ** 2) continue;

          const dist = Math.sqrt(Math.max(1e-8, distSq));
          const nx = dx / dist;
          const nz = dz / dist;
          const overlap = minDist - dist;

          // Positional correction (mass ratio 1:1)
          a.x -= nx * overlap * 0.52;
          a.z -= nz * overlap * 0.52;
          b.x += nx * overlap * 0.52;
          b.z += nz * overlap * 0.52;
          a.hasMoved = true;
          b.hasMoved = true;

          // Relative velocity along contact normal
          const rvx = b.vx - a.vx;
          const rvz = b.vz - a.vz;
          const velAlongNormal = rvx * nx + rvz * nz;

          if (velAlongNormal < 0) {
            const e = 0.58 * intensity;
            const impulse = (-(1 + e) * velAlongNormal) * 0.5;
            a.vx -= impulse * nx;
            a.vz -= impulse * nz;
            b.vx += impulse * nx;
            b.vz += impulse * nz;

            // Subtle rocking angular reaction when rim strikes neighbor
            a.angVz -= impulse * nx * 2.4;
            a.angVx += impulse * nz * 2.4;
            b.angVz += impulse * nx * 2.4;
            b.angVx -= impulse * nz * 2.4;

            const impactSpeed = -velAlongNormal;
            if (impactSpeed > 0.16 && this.clinkCooldown <= 0) {
              this.clinkCooldown = 0.038;
              this.callbacks.onStoneClink?.(
                Math.min(1.0, impactSpeed / 1.4),
                Math.random() < 0.5 ? a.color : b.color,
                a.x
              );
            }
          }
        }
      }

      // 2. Vertical gravity/bounce + Coulomb floor friction + subtle grid centering restore
      for (let i = 0; i < n; i++) {
        const s = stones[i];
        if (s.flightActive) continue;

        if (!s.hasMoved && Math.abs(s.y) < 0.0004 && Math.abs(s.rotX) < 0.001 && Math.abs(s.rotZ) < 0.001) {
          continue;
        }

        // Vertical dynamics
        if (s.y > 0 || s.vy !== 0) {
          s.vy -= GRAVITY * subDt;
          s.y += s.vy * subDt;
          if (s.y <= 0) {
            s.y = 0;
            if (Math.abs(s.vy) > 0.28) {
              s.vy = -s.vy * (0.21 * intensity);
            } else {
              s.vy = 0;
            }
          }
        }

        // Rotational spring-damper back to flat rest
        const springK = 195;
        const angDamp = 24;
        s.angVx += (-springK * s.rotX - angDamp * s.angVx) * subDt;
        s.angVz += (-springK * s.rotZ - angDamp * s.angVz) * subDt;
        s.rotX += s.angVx * subDt;
        s.rotZ += s.angVz * subDt;

        // Horizontal home restoring force (keeps grid coordinates legible) + Coulomb sliding friction
        const dx = s.restX - s.x;
        const dz = s.restZ - s.z;
        const anchorK = 36;
        s.vx += dx * anchorK * subDt;
        s.vz += dz * anchorK * subDt;

        const speed = Math.hypot(s.vx, s.vz);
        if (speed > 0.0005) {
          // Coulomb deceleration + viscous damping
          const drag = Math.exp(-15.5 * subDt);
          s.vx *= drag;
          s.vz *= drag;
        } else if (Math.hypot(dx, dz) < 0.0008) {
          s.x = s.restX;
          s.z = s.restZ;
          s.vx = 0;
          s.vz = 0;
        }

        s.x += s.vx * subDt;
        s.z += s.vz * subDt;

        // Clamp horizontal drift strictly inside 11% of stone radius so intersection alignment stays crisp
        const driftX = s.x - s.restX;
        const driftZ = s.z - s.restZ;
        const maxDrift = s.radius * 0.11;
        const driftDist = Math.hypot(driftX, driftZ);
        if (driftDist > maxDrift) {
          const clampScale = maxDrift / driftDist;
          s.x = s.restX + driftX * clampScale;
          s.z = s.restZ + driftZ * clampScale;
        }

        if (
          s.y === 0 &&
          s.vy === 0 &&
          Math.abs(s.vx) < 0.001 &&
          Math.abs(s.vz) < 0.001 &&
          Math.abs(s.rotX) < 0.0015 &&
          Math.abs(s.rotZ) < 0.0015 &&
          Math.hypot(s.x - s.restX, s.z - s.restZ) < 0.0008
        ) {
          s.x = s.restX;
          s.z = s.restZ;
          s.rotX = 0;
          s.rotZ = 0;
          s.angVx = 0;
          s.angVz = 0;
          s.hasMoved = false;
        }
      }
    }
  }

  /**
   * Imparts shockwave micro-jostle to existing neighbor stones when a stone strikes the Goban.
   */
  private applyImpactShockwave(stones: StonePhysicsBody[], source: StonePhysicsBody, intensity: number): void {
    if (intensity <= 0.05) return;
    const maxRadius = source.radius * 2.55;
    for (let i = 0; i < stones.length; i++) {
      const other = stones[i];
      if (other === source || other.flightActive) continue;
      const dx = other.x - source.x;
      const dz = other.z - source.z;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.001 && dist < maxRadius) {
        const factor = (1 - dist / maxRadius) * intensity;
        const nx = dx / dist;
        const nz = dz / dist;
        other.vx += nx * 0.34 * factor;
        other.vz += nz * 0.34 * factor;
        other.vy += 0.38 * factor;
        other.angVx += nz * 2.1 * factor;
        other.angVz -= nx * 2.1 * factor;
        other.hasMoved = true;
      }
    }
  }

  /**
   * Advances circular N-body stone collisions & bowl-dish gravity inside bowls and capture lids.
   */
  public stepContainerStones(
    particles: BowlPhysicsParticle[],
    dtRaw: number,
    containerRadius: number,
    stoneRadius: number,
    dishCurve: number
  ): void {
    const dt = Math.min(0.032, dtRaw);
    const n = particles.length;
    if (n === 0 || dt <= 0) return;

    const minDist = stoneRadius * 1.92;
    const minDistSq = minDist * minDist;

    // 1. N-body circle collisions inside bowl / lid
    for (let i = 0; i < n; i++) {
      const a = particles[i];
      for (let j = i + 1; j < n; j++) {
        const b = particles[j];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const dy = b.y - a.y;
        if (Math.abs(dy) > stoneRadius * 1.2) continue;
        const dSq = dx * dx + dz * dz;
        if (dSq > 1e-6 && dSq < minDistSq) {
          const d = Math.sqrt(dSq);
          const nx = dx / d;
          const nz = dz / d;
          const overlap = (minDist - d) * 0.42;
          a.x -= nx * overlap;
          a.z -= nz * overlap;
          b.x += nx * overlap;
          b.z += nz * overlap;

          const rvx = b.vx - a.vx;
          const rvz = b.vz - a.vz;
          const vn = rvx * nx + rvz * nz;
          if (vn < 0) {
            const jImp = -0.62 * vn;
            a.vx -= nx * jImp;
            a.vz -= nz * jImp;
            b.vx += nx * jImp;
            b.vz += nz * jImp;
          }
        }
      }
    }

    // 2. Dish boundary + spring-damped settling
    const maxR = Math.max(stoneRadius, containerRadius - stoneRadius * 0.9);
    for (let i = 0; i < n; i++) {
      const p = particles[i];
      const fx = (p.restX - p.x) * 28 - p.vx * 11;
      const fy = (p.restY - p.y) * 170 - p.vy * 14;
      const fz = (p.restZ - p.z) * 28 - p.vz * 11;

      p.vx += fx * dt;
      p.vy += fy * dt;
      p.vz += fz * dt;

      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      const r = Math.hypot(p.x, p.z);
      if (r > maxR) {
        const s = maxR / r;
        p.x *= s;
        p.z *= s;
        p.vx *= -0.35;
        p.vz *= -0.35;
      }

      const dishFloor = p.restY + (r / maxR) ** 2 * dishCurve;
      if (p.y < dishFloor - 0.008) {
        p.y = dishFloor - 0.008;
        if (p.vy < 0) p.vy = -p.vy * 0.25;
      }

      p.angVx += (-p.rotX * 140 - p.angVx * 15) * dt;
      p.angVz += (-p.rotZ * 140 - p.angVz * 15) * dt;
      p.rotX += p.angVx * dt;
      p.rotZ += p.angVz * dt;
    }
  }
}
