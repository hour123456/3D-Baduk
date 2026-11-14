import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  BLACK,
  WHITE,
  EMPTY,
  BoardSize,
  Coord,
  MoveRecord,
  PlayerColor,
  StoneColor,
} from '../rules/types';
import { coordToLabel } from '../rules/GoEngine';
import type { AISuggestion } from '../ai/MctsEngine';
import { AcousticStoneAudioEngine } from '../audio/AcousticStoneAudioEngine';
import type { LightingTheme } from '../settings/SettingsManager';
import { BoardGridMetrics, getBoardMetrics } from './ProceduralTextures';
import { BuiltRoomAssets, buildTraditionalBadukRoom } from './GobanBuilder';
import { StonePhysicsAnimator, createBiconvexStoneGeometry } from './StonePhysicsAnimator';

export type CameraPreset = 'default' | 'white' | 'top' | 'true_top' | 'cinema';

export interface HoverStatus {
  coord: Coord | null;
  valid: boolean;
  reason?: string;
}

export interface SceneCallbacks {
  onIntersectionHover: (
    x: number,
    y: number
  ) => { valid: boolean; reason?: string; showGhost: boolean; color: PlayerColor };
  onIntersectionClick: (x: number, y: number, pointerType?: string) => void;
  onHoverLeave: () => void;
}

export class SceneManager {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private perspectiveCamera: THREE.PerspectiveCamera;
  private orthoCamera: THREE.OrthographicCamera;
  private activeCamera: THREE.Camera;
  private controls: OrbitControls;
  private currentPreset: CameraPreset = 'default';
  private lockVerticalRotation = true;

  private audio: AcousticStoneAudioEngine;
  private callbacks: SceneCallbacks;
  private metrics: BoardGridMetrics;
  private room: BuiltRoomAssets;
  public stoneAnimator: StonePhysicsAnimator;

  private hemiLight!: THREE.HemisphereLight;
  private sunLight!: THREE.DirectionalLight;
  private lanternFill!: THREE.DirectionalLight;

  private showCoordinates = true;
  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2(-99, -99);
  private pointerDownPos = new THREE.Vector2();
  private lastHoveredCoordKey = '';
  private lastBowlHoverMs = 0;

  // Touch guard & Magnifier Loupe state
  private activePointers = new Set<number>();
  private multiTouchGuardUntil = 0;
  private touchLoupeEnabled = true;
  private touchDraggingLoupe = false;
  private loupeClientX = 0;
  private loupeClientY = 0;
  private loupeCoord: Coord | null = null;
  private loupeCanvas: HTMLCanvasElement;
  private loupeCtx: CanvasRenderingContext2D;

  // Board tactical visual helpers
  private hoverGhostMesh: THREE.Mesh;
  private hoverGhostBlackMat: THREE.MeshPhysicalMaterial;
  private hoverGhostWhiteMat: THREE.MeshPhysicalMaterial;
  private hoverRingMesh: THREE.Mesh;

  // Pending move 2-step confirmation marker (mobile/precision input)
  private pendingGroup: THREE.Group;
  private pendingGhostMesh: THREE.Mesh;
  private pendingRingMesh: THREE.Mesh;

  private forbiddenMarkerGroup: THREE.Group;
  private persistentForbiddenGroup = new THREE.Group();
  private hintGroup = new THREE.Group();
  private winningLineGroup = new THREE.Group();

  private lastMoveMarker: THREE.Mesh;
  private koPointMarker: THREE.Mesh;

  private moveNumberGroup = new THREE.Group();
  private territoryGroup = new THREE.Group();
  private territoryBlackGeo = new THREE.BoxGeometry(1, 0.35, 1);
  private territoryBlackMat = new THREE.MeshStandardMaterial({
    color: 0x15171a,
    roughness: 0.3,
    transparent: true,
    opacity: 0.88,
  });
  private territoryWhiteMat = new THREE.MeshStandardMaterial({
    color: 0xf7f3ea,
    roughness: 0.2,
    transparent: true,
    opacity: 0.9,
  });

  // Smooth camera transition state
  private camTransition: {
    active: boolean;
    elapsed: number;
    duration: number;
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
  } | null = null;

  private clock = new THREE.Clock();
  private rafId = 0;

  constructor(
    container: HTMLElement,
    audio: AcousticStoneAudioEngine,
    initialSize: BoardSize,
    callbacks: SceneCallbacks
  ) {
    this.container = container;
    this.audio = audio;
    this.callbacks = callbacks;
    this.metrics = getBoardMetrics(initialSize);

    // 1. Renderer setup
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.touchAction = 'none';
    container.appendChild(this.renderer.domElement);

    // 2. Scene & Environment lighting
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x16110c);
    this.scene.fog = new THREE.FogExp2(0x16110c, 0.036);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const roomEnv = new RoomEnvironment();
    this.scene.environment = pmrem.fromScene(roomEnv, 0.04).texture;
    this.scene.environmentIntensity = 0.42;
    roomEnv.dispose();
    pmrem.dispose();

    this.setupLighting();

    // 3. Dual Cameras (Perspective + True 90° Orthographic) & OrbitControls
    const aspect = Math.max(0.25, container.clientWidth / Math.max(1, container.clientHeight));
    this.perspectiveCamera = new THREE.PerspectiveCamera(38, aspect, 0.1, 50);
    this.perspectiveCamera.position.set(0, 5.35, 4.55);

    this.orthoCamera = new THREE.OrthographicCamera(-3, 3, 3, -3, 0.1, 40);
    this.orthoCamera.position.set(0, 12, 0);
    this.orthoCamera.up.set(0, 0, -1);
    this.updateOrthoFrustum();

    this.activeCamera = this.perspectiveCamera;

    this.controls = new OrbitControls(this.perspectiveCamera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.065;
    this.controls.target.set(0, -0.12, 0.08);
    this.controls.minDistance = 2.6;
    this.controls.maxDistance = 11.5;
    this.controls.maxPolarAngle = Math.PI * 0.465;
    this.controls.minPolarAngle = 0.04;
    this.controls.update();

    // 4. Build Traditional Baduk Room & Stone Animator
    this.room = buildTraditionalBadukRoom(this.metrics, this.showCoordinates);
    this.scene.add(this.room.root);

    this.stoneAnimator = new StonePhysicsAnimator({
      parent: this.room.root,
      audio: this.audio,
      metrics: this.metrics,
      blackBowl: this.room.blackBowl,
      whiteBowl: this.room.whiteBowl,
    });

    // 5. Build Board Tactical Visual Helpers
    const ghostGeo = createBiconvexStoneGeometry();
    this.hoverGhostBlackMat = new THREE.MeshPhysicalMaterial({
      color: 0x16181c,
      roughness: 0.25,
      transparent: true,
      opacity: 0.56,
      depthWrite: false,
    });
    this.hoverGhostWhiteMat = new THREE.MeshPhysicalMaterial({
      color: 0xfaf7f0,
      roughness: 0.18,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
    });
    this.hoverGhostMesh = new THREE.Mesh(ghostGeo, this.hoverGhostBlackMat);
    this.hoverGhostMesh.visible = false;
    this.scene.add(this.hoverGhostMesh);

    this.hoverRingMesh = new THREE.Mesh(
      new THREE.RingGeometry(0.86, 1.04, 32),
      new THREE.MeshBasicMaterial({
        color: 0xf4cf86,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.65,
      })
    );
    this.hoverRingMesh.rotation.x = -Math.PI / 2;
    this.hoverRingMesh.visible = false;
    this.scene.add(this.hoverRingMesh);

    // Pending move confirmation visual (mobile / confirm mode)
    this.pendingGroup = new THREE.Group();
    this.pendingGhostMesh = new THREE.Mesh(ghostGeo, this.hoverGhostBlackMat.clone());
    (this.pendingGhostMesh.material as THREE.MeshPhysicalMaterial).opacity = 0.78;
    this.pendingRingMesh = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 1.18, 36),
      new THREE.MeshBasicMaterial({
        color: 0xffd268,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.94,
        depthTest: false,
      })
    );
    this.pendingRingMesh.rotation.x = -Math.PI / 2;
    this.pendingRingMesh.renderOrder = 11;
    this.pendingGroup.add(this.pendingGhostMesh, this.pendingRingMesh);
    this.pendingGroup.visible = false;
    this.scene.add(this.pendingGroup);

    // Forbidden move red X seal (hover)
    this.forbiddenMarkerGroup = new THREE.Group();
    const forbidMat = new THREE.MeshBasicMaterial({
      color: 0xd93829,
      transparent: true,
      opacity: 0.88,
      side: THREE.DoubleSide,
    });
    const bar1 = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.22), forbidMat);
    bar1.rotation.x = -Math.PI / 2;
    bar1.rotation.z = Math.PI / 4;
    const bar2 = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.22), forbidMat);
    bar2.rotation.x = -Math.PI / 2;
    bar2.rotation.z = -Math.PI / 4;
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.72, 0.9, 28), forbidMat);
    ring.rotation.x = -Math.PI / 2;
    this.forbiddenMarkerGroup.add(bar1, bar2, ring);
    this.forbiddenMarkerGroup.visible = false;
    this.scene.add(this.forbiddenMarkerGroup);

    // Last Move Ring Marker sitting cleanly atop the stone dome
    this.lastMoveMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.5, 32),
      new THREE.MeshBasicMaterial({
        color: 0xe64833,
        side: THREE.DoubleSide,
        depthTest: false,
      })
    );
    this.lastMoveMarker.rotation.x = -Math.PI / 2;
    this.lastMoveMarker.renderOrder = 10;
    this.lastMoveMarker.visible = false;
    this.scene.add(this.lastMoveMarker);

    // Active Ko Point Amber Square Marker
    this.koPointMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.58, 4),
      new THREE.MeshBasicMaterial({
        color: 0xd94e34,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.78,
      })
    );
    this.koPointMarker.rotation.x = -Math.PI / 2;
    this.koPointMarker.rotation.z = Math.PI / 4;
    this.koPointMarker.visible = false;
    this.scene.add(this.koPointMarker);

    this.scene.add(this.moveNumberGroup);
    this.scene.add(this.territoryGroup);
    this.scene.add(this.persistentForbiddenGroup);
    this.scene.add(this.hintGroup);
    this.scene.add(this.winningLineGroup);

    // 6. Floating 2.6x Touch Magnifier Loupe Canvas (rendered seamlessly before frame swap)
    this.loupeCanvas = document.createElement('canvas');
    this.loupeCanvas.id = 'touch-loupe-canvas';
    this.loupeCanvas.width = 144;
    this.loupeCanvas.height = 144;
    this.loupeCanvas.style.cssText = [
      'position:fixed',
      'width:128px',
      'height:128px',
      'border-radius:999px',
      'pointer-events:none',
      'z-index:26',
      'display:none',
      'border:2.5px solid rgba(236, 194, 114, 0.92)',
      'box-shadow:0 10px 28px rgba(0, 0, 0, 0.65), inset 0 0 12px rgba(255, 224, 160, 0.2)',
      'background:#1a130d',
    ].join(';');
    this.loupeCtx = this.loupeCanvas.getContext('2d')!;
    container.appendChild(this.loupeCanvas);

    this.bindEvents();
    this.animate();
  }

  private setupLighting(): void {
    this.hemiLight = new THREE.HemisphereLight(0xffe9c8, 0x3a2618, 0.68);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight(0xfff0d4, 2.25);
    this.sunLight.position.set(-3.6, 7.2, -3.8);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 1.0;
    this.sunLight.shadow.camera.far = 20.0;
    const d = 5.4;
    this.sunLight.shadow.camera.left = -d;
    this.sunLight.shadow.camera.right = d;
    this.sunLight.shadow.camera.top = d;
    this.sunLight.shadow.camera.bottom = -d;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.012;
    this.scene.add(this.sunLight);

    this.lanternFill = new THREE.DirectionalLight(0xffd7a3, 0.72);
    this.lanternFill.position.set(4.5, 4.2, 4.8);
    this.scene.add(this.lanternFill);
  }

  public setLightingTheme(theme: LightingTheme): void {
    if (theme === 'studio_bright') {
      this.scene.background = new THREE.Color(0x282018);
      this.scene.fog = new THREE.FogExp2(0x282018, 0.022);
      this.hemiLight.color.setHex(0xffffff);
      this.hemiLight.groundColor.setHex(0x523c28);
      this.hemiLight.intensity = 0.94;
      this.sunLight.color.setHex(0xfff9ee);
      this.sunLight.intensity = 2.65;
      this.lanternFill.color.setHex(0xffe8cb);
      this.lanternFill.intensity = 0.92;
      this.renderer.toneMappingExposure = 1.14;
    } else if (theme === 'night_lantern') {
      this.scene.background = new THREE.Color(0x0c0806);
      this.scene.fog = new THREE.FogExp2(0x0c0806, 0.052);
      this.hemiLight.color.setHex(0xffcb8c);
      this.hemiLight.groundColor.setHex(0x20130c);
      this.hemiLight.intensity = 0.45;
      this.sunLight.color.setHex(0xffd9a0);
      this.sunLight.intensity = 1.85;
      this.lanternFill.color.setHex(0xffb45c);
      this.lanternFill.intensity = 0.85;
      this.renderer.toneMappingExposure = 0.96;
    } else {
      // 'hanok_warm'
      this.scene.background = new THREE.Color(0x16110c);
      this.scene.fog = new THREE.FogExp2(0x16110c, 0.036);
      this.hemiLight.color.setHex(0xffe9c8);
      this.hemiLight.groundColor.setHex(0x3a2618);
      this.hemiLight.intensity = 0.68;
      this.sunLight.color.setHex(0xfff0d4);
      this.sunLight.intensity = 2.25;
      this.lanternFill.color.setHex(0xffd7a3);
      this.lanternFill.intensity = 0.72;
      this.renderer.toneMappingExposure = 1.06;
    }
  }

  public setTouchLoupeEnabled(enabled: boolean): void {
    this.touchLoupeEnabled = enabled;
    if (!enabled) {
      this.touchDraggingLoupe = false;
      this.loupeCanvas.style.display = 'none';
    }
  }

  public setLockVerticalRotation(locked: boolean): void {
    this.lockVerticalRotation = locked;
    if (this.currentPreset === 'true_top') {
      this.applyOrthoControlConstraints();
    }
  }

  public getCameraPreset(): CameraPreset {
    return this.currentPreset;
  }

  public setBoardSize(size: BoardSize): void {
    this.metrics = getBoardMetrics(size);
    this.room.updateBoardTop(this.metrics, this.showCoordinates);
    this.stoneAnimator.setMetrics(this.metrics);
    this.clearHover();
    this.setPendingMove(null);
    this.clearTerritoryMarkers();
    this.clearMoveNumbers();
    this.renderPersistentForbiddenPoints([]);
    this.renderHintSuggestions([]);
    this.renderOmokWinningLine(null);
    this.updateOrthoFrustum();
  }

  public toggleCoordinates(): boolean {
    this.showCoordinates = !this.showCoordinates;
    this.room.updateBoardTop(this.metrics, this.showCoordinates);
    return this.showCoordinates;
  }

  public setCoordinatesVisible(visible: boolean): void {
    if (this.showCoordinates !== visible) {
      this.showCoordinates = visible;
      this.room.updateBoardTop(this.metrics, this.showCoordinates);
    }
  }

  private updateOrthoFrustum(): void {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    const aspect = Math.max(0.25, w / h);
    const isPortraitMobile = w <= 820 && aspect < 1;

    const neededHalfW = isPortraitMobile ? 2.32 : 2.95;
    const neededHalfH = isPortraitMobile ? 2.95 : 2.68;
    const halfH = Math.max(neededHalfH, neededHalfW / aspect);
    const halfW = halfH * aspect;

    this.orthoCamera.left = -halfW;
    this.orthoCamera.right = halfW;
    this.orthoCamera.top = halfH;
    this.orthoCamera.bottom = -halfH;
    this.orthoCamera.updateProjectionMatrix();
  }

  private applyOrthoControlConstraints(): void {
    const isPortraitMobile = this.container.clientWidth <= 820 && this.container.clientHeight > this.container.clientWidth;
    const targetZ = isPortraitMobile ? 0.14 : 0;
    this.orthoCamera.position.set(0, 12, targetZ);
    this.orthoCamera.up.set(0, 0, -1);
    this.orthoCamera.zoom = 1;
    this.orthoCamera.updateProjectionMatrix();

    this.controls.object = this.orthoCamera;
    this.controls.target.set(0, 0, targetZ);
    this.controls.enableRotate = !this.lockVerticalRotation;
    this.controls.enablePan = true;
    this.controls.enableZoom = true;
    this.controls.minZoom = 0.78;
    this.controls.maxZoom = 3.2;
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = this.lockVerticalRotation ? 0.001 : Math.PI * 0.42;
    this.controls.touches = this.lockVerticalRotation
      ? { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN }
      : { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.update();
  }

  public setCameraPreset(preset: CameraPreset): void {
    this.currentPreset = preset;

    if (preset === 'true_top') {
      this.camTransition = null;
      this.activeCamera = this.orthoCamera;
      this.updateOrthoFrustum();
      this.applyOrthoControlConstraints();
      return;
    }

    // Switching from Ortho back to Perspective camera
    if (this.activeCamera !== this.perspectiveCamera) {
      this.activeCamera = this.perspectiveCamera;
      this.controls.object = this.perspectiveCamera;
      this.controls.enableRotate = true;
      this.controls.enablePan = true;
      this.controls.enableZoom = true;
      this.controls.minDistance = 2.6;
      this.controls.maxDistance = 11.5;
      this.controls.minPolarAngle = 0.04;
      this.controls.maxPolarAngle = Math.PI * 0.465;
      this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    }

    const isPortraitMobile =
      this.container.clientWidth <= 820 &&
      this.container.clientHeight > this.container.clientWidth;

    let toPos = new THREE.Vector3(0, isPortraitMobile ? 6.8 : 5.35, isPortraitMobile ? 5.6 : 4.55);
    let toTarget = new THREE.Vector3(0, -0.12, 0.08);

    switch (preset) {
      case 'default':
        toPos.set(0, isPortraitMobile ? 6.8 : 5.35, isPortraitMobile ? 5.6 : 4.55);
        toTarget.set(0, -0.12, 0.08);
        break;
      case 'white':
        toPos.set(0, isPortraitMobile ? 6.8 : 5.35, isPortraitMobile ? -5.6 : -4.55);
        toTarget.set(0, -0.12, -0.08);
        break;
      case 'top':
        toPos.set(0, isPortraitMobile ? 9.2 : 6.85, 0.03);
        toTarget.set(0, 0, isPortraitMobile ? 0.12 : 0);
        break;
      case 'cinema':
        toPos.set(3.65, 4.15, 4.35);
        toTarget.set(0.15, -0.18, 0.1);
        break;
    }

    this.camTransition = {
      active: true,
      elapsed: 0,
      duration: 0.58,
      fromPos: this.perspectiveCamera.position.clone(),
      toPos,
      fromTarget: this.controls.target.clone(),
      toTarget,
    };
  }

  public setPendingMove(coord: Coord | null, color: PlayerColor = BLACK): void {
    if (!coord) {
      this.pendingGroup.visible = false;
      return;
    }
    const worldPos = this.stoneAnimator.gridToWorld(coord.x, coord.y);
    const mat = this.pendingGhostMesh.material as THREE.MeshPhysicalMaterial;
    mat.color.setHex(color === BLACK ? 0x16181c : 0xfaf7f0);
    mat.opacity = 0.78;
    this.pendingGhostMesh.scale.setScalar(this.metrics.stoneRadius);
    this.pendingGhostMesh.position.set(worldPos.x, worldPos.y + 0.035, worldPos.z);

    this.pendingRingMesh.scale.setScalar(this.metrics.stoneRadius);
    this.pendingRingMesh.position.set(worldPos.x, 0.008, worldPos.z);
    this.pendingGroup.visible = true;
  }

  public updateMarkers(lastMove: Coord | null, lastColor: PlayerColor | null, koPoint: Coord | null): void {
    if (lastMove && lastColor) {
      const pos = this.stoneAnimator.gridToWorld(lastMove.x, lastMove.y);
      this.lastMoveMarker.position.set(pos.x, pos.y + this.metrics.stoneRadius * 0.47, pos.z);
      this.lastMoveMarker.scale.setScalar(this.metrics.stoneRadius);
      (this.lastMoveMarker.material as THREE.MeshBasicMaterial).color.setHex(
        lastColor === BLACK ? 0xf2b857 : 0xd93b2b
      );
      this.lastMoveMarker.visible = true;
    } else {
      this.lastMoveMarker.visible = false;
    }

    if (koPoint) {
      const kPos = this.stoneAnimator.gridToWorld(koPoint.x, koPoint.y);
      this.koPointMarker.position.set(kPos.x, 0.004, kPos.z);
      this.koPointMarker.scale.setScalar(this.metrics.stoneRadius);
      this.koPointMarker.visible = true;
    } else {
      this.koPointMarker.visible = false;
    }
  }

  public renderPersistentForbiddenPoints(points: Coord[]): void {
    while (this.persistentForbiddenGroup.children.length > 0) {
      const ch = this.persistentForbiddenGroup.children.pop() as THREE.Mesh;
      ch.geometry.dispose();
      if (ch.material instanceof THREE.Material) ch.material.dispose();
    }
    if (points.length === 0) return;

    const r = this.metrics.stoneRadius;
    const mat = new THREE.MeshBasicMaterial({
      color: 0xd93829,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
    });
    const barGeo = new THREE.PlaneGeometry(r * 1.15, r * 0.22);

    for (const pt of points) {
      const pos = this.stoneAnimator.gridToWorld(pt.x, pt.y);
      const b1 = new THREE.Mesh(barGeo.clone(), mat.clone());
      b1.rotation.x = -Math.PI / 2;
      b1.rotation.z = Math.PI / 4;
      b1.position.set(pos.x, 0.004, pos.z);
      const b2 = new THREE.Mesh(barGeo.clone(), mat.clone());
      b2.rotation.x = -Math.PI / 2;
      b2.rotation.z = -Math.PI / 4;
      b2.position.set(pos.x, 0.004, pos.z);
      this.persistentForbiddenGroup.add(b1, b2);
    }
    barGeo.dispose();
    mat.dispose();
  }

  public renderHintSuggestions(hints: AISuggestion[]): void {
    while (this.hintGroup.children.length > 0) {
      const ch = this.hintGroup.children.pop() as THREE.Mesh;
      ch.geometry.dispose();
      if (ch.material instanceof THREE.Material) {
        const m = ch.material as THREE.MeshBasicMaterial;
        if (m.map) m.map.dispose();
        m.dispose();
      }
    }
    if (!hints || hints.length === 0) return;

    const colors = [0x4be096, 0x67b6ff, 0xf2c15a];
    hints.slice(0, 3).forEach((hint, idx) => {
      const pos = this.stoneAnimator.gridToWorld(hint.coord.x, hint.coord.y);
      const r = this.metrics.stoneRadius;
      const color = colors[idx] ?? 0x67b6ff;

      const ringMesh = new THREE.Mesh(
        new THREE.RingGeometry(r * 0.74, r * 0.98, 28),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
          depthTest: false,
        })
      );
      ringMesh.rotation.x = -Math.PI / 2;
      ringMesh.position.set(pos.x, 0.009, pos.z);
      ringMesh.renderOrder = 13;

      const canvas = document.createElement('canvas');
      canvas.width = 96;
      canvas.height = 96;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
      ctx.beginPath();
      ctx.arc(48, 48, 36, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0e0c0a';
      ctx.font = '800 38px "Pretendard", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(idx + 1), 48, 50);

      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      const badge = new THREE.Mesh(
        new THREE.PlaneGeometry(r * 1.4, r * 1.4),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false })
      );
      badge.rotation.x = -Math.PI / 2;
      badge.position.set(pos.x, 0.012, pos.z);
      badge.renderOrder = 14;

      this.hintGroup.add(ringMesh, badge);
    });
  }

  public renderOmokWinningLine(line: Coord[] | null): void {
    while (this.winningLineGroup.children.length > 0) {
      const ch = this.winningLineGroup.children.pop() as THREE.Mesh;
      ch.geometry.dispose();
      if (ch.material instanceof THREE.Material) ch.material.dispose();
    }
    if (!line || line.length < 2) return;

    const first = this.stoneAnimator.gridToWorld(line[0].x, line[0].y);
    const last = this.stoneAnimator.gridToWorld(line[line.length - 1].x, line[line.length - 1].y);
    const r = this.metrics.stoneRadius;
    const beamY = first.y + r * 0.5;

    const start = new THREE.Vector3(first.x, beamY, first.z);
    const end = new THREE.Vector3(last.x, beamY, last.z);
    const dir = new THREE.Vector3().subVectors(end, start);
    const len = dir.length();

    const beamGeo = new THREE.CylinderGeometry(r * 0.16, r * 0.16, len, 12);
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xffd66e,
      transparent: true,
      opacity: 0.92,
      depthTest: false,
    });
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.copy(start).addScaledVector(dir, 0.5);
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    beam.renderOrder = 15;
    this.winningLineGroup.add(beam);

    const ringGeo = new THREE.RingGeometry(r * 0.98, r * 1.24, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xffd25a,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthTest: false,
    });
    for (const pt of line) {
      const wp = this.stoneAnimator.gridToWorld(pt.x, pt.y);
      const m = new THREE.Mesh(ringGeo.clone(), ringMat.clone());
      m.rotation.x = -Math.PI / 2;
      m.position.set(wp.x, 0.008, wp.z);
      m.renderOrder = 14;
      this.winningLineGroup.add(m);
    }
    ringGeo.dispose();
    ringMat.dispose();
  }

  public renderMoveNumbers(history: MoveRecord[], upToMoveCount: number, currentBoard: Uint8Array): void {
    this.clearMoveNumbers();
    const size = this.metrics.size;
    const latestNum = new Int16Array(size * size);
    const limit = Math.min(upToMoveCount, history.length);
    for (let i = 0; i < limit; i++) {
      const m = history[i];
      if (m.coord) {
        latestNum[m.coord.y * size + m.coord.x] = m.moveNumber;
      }
    }

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = y * size + x;
        const stone = currentBoard[idx] as StoneColor;
        const num = latestNum[idx];
        if (stone === EMPTY || num <= 0) continue;

        const sprite = this.createNumberLabelMesh(num, stone === BLACK, num === limit);
        const pos = this.stoneAnimator.gridToWorld(x, y);
        sprite.position.set(pos.x, pos.y + this.metrics.stoneRadius * 0.48, pos.z);
        const s = this.metrics.stoneRadius * 1.45;
        sprite.scale.set(s, s, 1);
        this.moveNumberGroup.add(sprite);
      }
    }
  }

  public clearMoveNumbers(): void {
    while (this.moveNumberGroup.children.length > 0) {
      const ch = this.moveNumberGroup.children.pop() as THREE.Mesh;
      ch.geometry.dispose();
      if (ch.material instanceof THREE.MeshBasicMaterial && ch.material.map) {
        ch.material.map.dispose();
      }
      if (ch.material instanceof THREE.Material) ch.material.dispose();
    }
  }

  private createNumberLabelMesh(num: number, onBlackStone: boolean, isLatest: boolean): THREE.Mesh {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 96;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, 96, 96);

    ctx.fillStyle = isLatest ? '#ff6a4d' : onBlackStone ? '#f5efe4' : '#181410';
    const fontSize = num >= 100 ? 38 : num >= 10 ? 44 : 50;
    ctx.font = `700 ${fontSize}px "Pretendard", "Malgun Gothic", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(num), 48, 50);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    plane.rotation.x = -Math.PI / 2;
    plane.renderOrder = 12;
    return plane;
  }

  public renderTerritoryMap(territoryMap: Int8Array | null): void {
    this.clearTerritoryMarkers();
    if (!territoryMap) return;

    const size = this.metrics.size;
    const markerWidth = this.metrics.stoneRadius * 0.56;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const owner = territoryMap[y * size + x];
        if (owner !== BLACK && owner !== WHITE) continue;

        const mesh = new THREE.Mesh(
          this.territoryBlackGeo,
          owner === BLACK ? this.territoryBlackMat : this.territoryWhiteMat
        );
        const pos = this.stoneAnimator.gridToWorld(x, y);
        mesh.scale.set(markerWidth, markerWidth, markerWidth);
        mesh.position.set(pos.x, markerWidth * 0.18, pos.z);
        mesh.rotation.y = Math.PI / 4;
        this.territoryGroup.add(mesh);
      }
    }
  }

  public clearTerritoryMarkers(): void {
    while (this.territoryGroup.children.length > 0) {
      this.territoryGroup.children.pop();
    }
  }

  public clearHover(): void {
    this.hoverGhostMesh.visible = false;
    this.hoverRingMesh.visible = false;
    this.forbiddenMarkerGroup.visible = false;
    this.lastHoveredCoordKey = '';
  }

  private updateNdcFromClient(clientX: number, clientY: number): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointerNdc.x = ((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    this.pointerNdc.y = -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1;
  }

  private bindEvents(): void {
    const dom = this.renderer.domElement;

    dom.addEventListener('pointermove', (e) => {
      this.updateNdcFromClient(e.clientX, e.clientY);

      if (e.pointerType === 'touch') {
        this.loupeClientX = e.clientX;
        this.loupeClientY = e.clientY;
      }

      if (this.activePointers.size >= 2) {
        this.touchDraggingLoupe = false;
        this.clearHover();
        return;
      }

      const coord = this.handlePointerHover();
      if (e.pointerType === 'touch' && this.touchLoupeEnabled && this.activePointers.has(e.pointerId)) {
        this.loupeCoord = coord;
        this.touchDraggingLoupe = coord !== null;
      }
    });

    dom.addEventListener('pointerleave', () => {
      this.clearHover();
      this.touchDraggingLoupe = false;
      this.loupeCoord = null;
      this.callbacks.onHoverLeave();
    });

    dom.addEventListener('pointerdown', (e) => {
      this.audio.ensureReady();
      this.activePointers.add(e.pointerId);
      this.pointerDownPos.set(e.clientX, e.clientY);
      this.updateNdcFromClient(e.clientX, e.clientY);

      if (this.activePointers.size >= 2) {
        this.multiTouchGuardUntil = performance.now() + 280;
        this.touchDraggingLoupe = false;
        this.loupeCoord = null;
        return;
      }

      if (e.pointerType === 'touch' && this.touchLoupeEnabled) {
        const coord = this.handlePointerHover();
        this.loupeClientX = e.clientX;
        this.loupeClientY = e.clientY;
        this.loupeCoord = coord;
        this.touchDraggingLoupe = coord !== null;
      }
    });

    const handlePointerEnd = (e: PointerEvent, triggerClick: boolean) => {
      this.activePointers.delete(e.pointerId);
      this.touchDraggingLoupe = false;
      this.loupeCoord = null;

      if (!triggerClick) return;
      if (e.pointerType === 'mouse' && e.button !== 0) return;

      // Multi-touch pinch cooldown guard prevents accidental placements after zooming!
      if (this.activePointers.size > 0 || performance.now() < this.multiTouchGuardUntil) {
        return;
      }

      const dragThreshold = e.pointerType === 'touch' ? 14 : 7;
      const movedDist = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
      if (movedDist > dragThreshold) return;

      this.updateNdcFromClient(e.clientX, e.clientY);
      this.handlePointerClick(e.pointerType);
    };

    dom.addEventListener('pointerup', (e) => handlePointerEnd(e, true));
    dom.addEventListener('pointercancel', (e) => handlePointerEnd(e, false));

    window.addEventListener('resize', () => {
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      if (w === 0 || h === 0) return;
      this.perspectiveCamera.aspect = w / h;
      this.perspectiveCamera.updateProjectionMatrix();
      this.updateOrthoFrustum();
      this.renderer.setSize(w, h);
    });
  }

  private raycastBoardIntersection(): Coord | null {
    this.raycaster.setFromCamera(this.pointerNdc, this.activeCamera);
    const hits = this.raycaster.intersectObject(this.room.gobanTopMesh, false);
    if (hits.length === 0) return null;

    const pt = hits[0].point;
    const fx = (pt.x + this.metrics.gridSpanX / 2) / this.metrics.cellX;
    const fy = (pt.z + this.metrics.gridSpanZ / 2) / this.metrics.cellZ;
    const gx = Math.round(fx);
    const gy = Math.round(fy);

    if (gx < 0 || gx >= this.metrics.size || gy < 0 || gy >= this.metrics.size) {
      return null;
    }

    if (Math.abs(fx - gx) > 0.46 || Math.abs(fy - gy) > 0.46) {
      return null;
    }
    return { x: gx, y: gy };
  }

  private handlePointerHover(): Coord | null {
    this.raycaster.setFromCamera(this.pointerNdc, this.activeCamera);

    const bowlHits = this.raycaster.intersectObjects(
      [this.room.blackBowl.bowlCollider, this.room.whiteBowl.bowlCollider],
      false
    );
    if (bowlHits.length > 0) {
      const side = bowlHits[0].object.userData.bowlSide as 'black' | 'white';
      const now = performance.now();
      if (now - this.lastBowlHoverMs > 180) {
        this.lastBowlHoverMs = now;
        this.stoneAnimator.stirBowl(side, 0.58, true);
      }
      this.renderer.domElement.style.cursor = 'grab';
      this.clearHover();
      return null;
    }

    const coord = this.raycastBoardIntersection();
    if (!coord) {
      this.renderer.domElement.style.cursor = 'default';
      this.clearHover();
      this.callbacks.onHoverLeave();
      return null;
    }

    const key = `${coord.x},${coord.y}`;
    const info = this.callbacks.onIntersectionHover(coord.x, coord.y);
    const worldPos = this.stoneAnimator.gridToWorld(coord.x, coord.y);

    if (info.showGhost && info.valid) {
      this.renderer.domElement.style.cursor = 'pointer';
      this.hoverGhostMesh.material = info.color === BLACK ? this.hoverGhostBlackMat : this.hoverGhostWhiteMat;
      this.hoverGhostMesh.scale.setScalar(this.metrics.stoneRadius);
      this.hoverGhostMesh.position.set(worldPos.x, worldPos.y + 0.035, worldPos.z);
      this.hoverGhostMesh.visible = true;

      this.hoverRingMesh.scale.setScalar(this.metrics.stoneRadius);
      this.hoverRingMesh.position.set(worldPos.x, 0.003, worldPos.z);
      this.hoverRingMesh.visible = true;
      this.forbiddenMarkerGroup.visible = false;
    } else if (!info.valid && info.reason && info.reason !== 'OCCUPIED' && info.reason !== 'GAME_NOT_ACTIVE') {
      this.renderer.domElement.style.cursor = 'not-allowed';
      this.hoverGhostMesh.visible = false;
      this.hoverRingMesh.visible = false;
      this.forbiddenMarkerGroup.scale.setScalar(this.metrics.stoneRadius);
      this.forbiddenMarkerGroup.position.set(worldPos.x, 0.005, worldPos.z);
      this.forbiddenMarkerGroup.visible = true;
    } else {
      this.renderer.domElement.style.cursor = info.valid ? 'pointer' : 'default';
      this.hoverGhostMesh.visible = false;
      this.forbiddenMarkerGroup.visible = false;
      if (info.valid) {
        this.hoverRingMesh.scale.setScalar(this.metrics.stoneRadius * 1.08);
        this.hoverRingMesh.position.set(worldPos.x, 0.005, worldPos.z);
        this.hoverRingMesh.visible = true;
      } else {
        this.hoverRingMesh.visible = false;
      }
    }

    this.lastHoveredCoordKey = key;
    return coord;
  }

  private handlePointerClick(pointerType?: string): void {
    this.raycaster.setFromCamera(this.pointerNdc, this.activeCamera);

    const bowlHits = this.raycaster.intersectObjects(
      [this.room.blackBowl.bowlCollider, this.room.whiteBowl.bowlCollider],
      false
    );
    if (bowlHits.length > 0) {
      const side = bowlHits[0].object.userData.bowlSide as 'black' | 'white';
      this.stoneAnimator.stirBowl(side, 1.05, true);
      return;
    }

    const coord = this.raycastBoardIntersection();
    if (coord) {
      this.callbacks.onIntersectionClick(coord.x, coord.y, pointerType);
    }
  }

  private drawTouchLoupeOverlay(): void {
    if (!this.touchDraggingLoupe || !this.touchLoupeEnabled || !this.loupeCoord) {
      if (this.loupeCanvas.style.display !== 'none') {
        this.loupeCanvas.style.display = 'none';
      }
      return;
    }

    const dom = this.renderer.domElement;
    const rect = dom.getBoundingClientRect();
    const dpr = this.renderer.getPixelRatio();
    const lw = this.loupeCanvas.width;
    const lh = this.loupeCanvas.height;

    const srcSampleCss = 50; // ~2.6x magnification into 128px CSS circle
    const srcSamplePx = srcSampleCss * dpr;
    const sx = (this.loupeClientX - rect.left) * dpr - srcSamplePx * 0.5;
    const sy = (this.loupeClientY - rect.top) * dpr - srcSamplePx * 0.5;

    // Position loupe cleanly above finger, clamped inside viewport
    const boxSize = 128;
    const left = Math.max(10, Math.min(window.innerWidth - boxSize - 10, this.loupeClientX - boxSize * 0.5));
    const top = Math.max(54, this.loupeClientY - boxSize - 56);
    this.loupeCanvas.style.left = `${Math.round(left)}px`;
    this.loupeCanvas.style.top = `${Math.round(top)}px`;
    this.loupeCanvas.style.display = 'block';

    const ctx = this.loupeCtx;
    ctx.clearRect(0, 0, lw, lh);
    ctx.save();
    ctx.beginPath();
    ctx.arc(lw / 2, lh / 2, lw / 2, 0, Math.PI * 2);
    ctx.clip();

    ctx.fillStyle = '#1e1610';
    ctx.fillRect(0, 0, lw, lh);
    ctx.drawImage(dom, sx, sy, srcSamplePx, srcSamplePx, 0, 0, lw, lh);

    // Center golden aiming crosshair
    ctx.strokeStyle = 'rgba(255, 212, 118, 0.92)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(lw / 2 - 14, lh / 2);
    ctx.lineTo(lw / 2 + 14, lh / 2);
    ctx.moveTo(lw / 2, lh / 2 - 14);
    ctx.lineTo(lw / 2, lh / 2 + 14);
    ctx.stroke();

    // Bottom coordinate pill badge inside loupe
    const label = coordToLabel(this.loupeCoord.x, this.loupeCoord.y, this.metrics.size);
    ctx.fillStyle = 'rgba(18, 13, 9, 0.84)';
    ctx.fillRect(lw / 2 - 28, lh - 26, 56, 20);
    ctx.fillStyle = '#f6d695';
    ctx.font = '700 12px "Pretendard", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lw / 2, lh - 16);
    ctx.restore();
  }

  private animate = (): void => {
    this.rafId = requestAnimationFrame(this.animate);
    const dt = this.clock.getDelta();
    const elapsed = this.clock.elapsedTime;

    if (this.camTransition && this.camTransition.active) {
      this.camTransition.elapsed += dt;
      const t = Math.min(1, this.camTransition.elapsed / this.camTransition.duration);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.perspectiveCamera.position.lerpVectors(this.camTransition.fromPos, this.camTransition.toPos, ease);
      this.controls.target.lerpVectors(this.camTransition.fromTarget, this.camTransition.toTarget, ease);
      if (t >= 1) this.camTransition.active = false;
    }

    if (this.pendingGroup.visible) {
      const pulse = 1 + Math.sin(elapsed * 5.2) * 0.06;
      this.pendingRingMesh.scale.setScalar(this.metrics.stoneRadius * pulse);
    }

    this.controls.update();

    // Clamp ortho pan bounds so players can't pan the board off-screen
    if (this.currentPreset === 'true_top') {
      this.controls.target.x = Math.max(-1.85, Math.min(1.85, this.controls.target.x));
      this.controls.target.z = Math.max(-1.85, Math.min(1.85, this.controls.target.z));
      this.orthoCamera.position.x = this.controls.target.x;
      this.orthoCamera.position.z = this.controls.target.z;
    }

    this.stoneAnimator.update(dt);
    this.room.updateAtmosphere(dt, elapsed);
    this.renderer.render(this.scene, this.activeCamera);
    this.drawTouchLoupeOverlay();
  };
}
