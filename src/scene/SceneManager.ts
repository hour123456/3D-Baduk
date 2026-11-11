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
import { AcousticStoneAudioEngine } from '../audio/AcousticStoneAudioEngine';
import { BoardGridMetrics, getBoardMetrics } from './ProceduralTextures';
import { BuiltRoomAssets, buildTraditionalBadukRoom } from './GobanBuilder';
import { StonePhysicsAnimator, createBiconvexStoneGeometry } from './StonePhysicsAnimator';

export type CameraPreset = 'default' | 'white' | 'top' | 'cinema';

export interface HoverStatus {
  coord: Coord | null;
  valid: boolean;
  reason?: string;
}

export interface SceneCallbacks {
  onIntersectionHover: (x: number, y: number) => { valid: boolean; reason?: string; showGhost: boolean; color: PlayerColor };
  onIntersectionClick: (x: number, y: number) => void;
  onHoverLeave: () => void;
}

export class SceneManager {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;

  private audio: AcousticStoneAudioEngine;
  private callbacks: SceneCallbacks;
  private metrics: BoardGridMetrics;
  private room: BuiltRoomAssets;
  public stoneAnimator: StonePhysicsAnimator;

  private showCoordinates = true;
  private raycaster = new THREE.Raycaster();
  private pointerNdc = new THREE.Vector2(-99, -99);
  private pointerDownPos = new THREE.Vector2();
  private lastHoveredCoordKey = '';
  private lastBowlHoverMs = 0;

  // Board tactical visual helpers
  private hoverGhostMesh: THREE.Mesh;
  private hoverGhostBlackMat: THREE.MeshPhysicalMaterial;
  private hoverGhostWhiteMat: THREE.MeshPhysicalMaterial;
  private hoverRingMesh: THREE.Mesh;
  private forbiddenMarkerGroup: THREE.Group;
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

    // 3. Camera & OrbitControls
    this.camera = new THREE.PerspectiveCamera(
      38,
      container.clientWidth / container.clientHeight,
      0.1,
      50
    );
    this.camera.position.set(0, 5.35, 4.55);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.065;
    this.controls.target.set(0, -0.12, 0.08);
    this.controls.minDistance = 2.6;
    this.controls.maxDistance = 11.5;
    this.controls.maxPolarAngle = Math.PI * 0.465; // Keep camera respectfully above floor
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

    // Forbidden move red X seal
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

    // Last Move Vermilion/Gold Ring Marker sitting cleanly atop the stone dome
    this.lastMoveMarker = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.50, 32),
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

    this.bindEvents();
    this.animate();
  }

  private setupLighting(): void {
    // Warm soft room ambient fill
    const hemi = new THREE.HemisphereLight(0xffe9c8, 0x3a2618, 0.68);
    this.scene.add(hemi);

    // Primary warm Changhoji window sunlight casting crisp soft shadows across stones & Goban
    const sunLight = new THREE.DirectionalLight(0xfff0d4, 2.25);
    sunLight.position.set(-3.6, 7.2, -3.8);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.set(2048, 2048);
    sunLight.shadow.camera.near = 1.0;
    sunLight.shadow.camera.far = 20.0;
    const d = 5.4;
    sunLight.shadow.camera.left = -d;
    sunLight.shadow.camera.right = d;
    sunLight.shadow.camera.top = d;
    sunLight.shadow.camera.bottom = -d;
    sunLight.shadow.bias = -0.0004;
    sunLight.shadow.normalBias = 0.012;
    this.scene.add(sunLight);

    // Subtle front-right warm lantern fill so black slate stones show elegant rim sheen
    const lanternFill = new THREE.DirectionalLight(0xffd7a3, 0.72);
    lanternFill.position.set(4.5, 4.2, 4.8);
    this.scene.add(lanternFill);
  }

  public setBoardSize(size: BoardSize): void {
    this.metrics = getBoardMetrics(size);
    this.room.updateBoardTop(this.metrics, this.showCoordinates);
    this.stoneAnimator.setMetrics(this.metrics);
    this.clearHover();
    this.clearTerritoryMarkers();
    this.clearMoveNumbers();
  }

  public toggleCoordinates(): boolean {
    this.showCoordinates = !this.showCoordinates;
    this.room.updateBoardTop(this.metrics, this.showCoordinates);
    return this.showCoordinates;
  }

  public setCameraPreset(preset: CameraPreset): void {
    let toPos = new THREE.Vector3(0, 5.35, 4.55);
    let toTarget = new THREE.Vector3(0, -0.12, 0.08);

    switch (preset) {
      case 'default':
        toPos.set(0, 5.35, 4.55);
        toTarget.set(0, -0.12, 0.08);
        break;
      case 'white':
        toPos.set(0, 5.35, -4.55);
        toTarget.set(0, -0.12, -0.08);
        break;
      case 'top':
        toPos.set(0, 6.85, 0.02);
        toTarget.set(0, 0, 0);
        break;
      case 'cinema':
        toPos.set(3.65, 4.15, 4.35);
        toTarget.set(0.15, -0.18, 0.1);
        break;
    }

    this.camTransition = {
      active: true,
      elapsed: 0,
      duration: 0.65,
      fromPos: this.camera.position.clone(),
      toPos,
      fromTarget: this.controls.target.clone(),
      toTarget,
    };
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

  public renderMoveNumbers(history: MoveRecord[], upToMoveCount: number, currentBoard: Uint8Array): void {
    this.clearMoveNumbers();
    const size = this.metrics.size;
    // Latest move number occupying each cell
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

  /**
   * Renders 3D territory markers (small polished square gems) during Scoring or Territory Hint mode!
   */
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
        mesh.rotation.y = Math.PI / 4; // Elegant diamond orientation
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

  private bindEvents(): void {
    const dom = this.renderer.domElement;

    dom.addEventListener('pointermove', (e) => {
      const rect = dom.getBoundingClientRect();
      this.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.handlePointerHover();
    });

    dom.addEventListener('pointerleave', () => {
      this.clearHover();
      this.callbacks.onHoverLeave();
    });

    dom.addEventListener('pointerdown', (e) => {
      this.audio.ensureReady();
      this.pointerDownPos.set(e.clientX, e.clientY);
    });

    dom.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      const movedDist = Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y);
      if (movedDist > 6) return; // Was an OrbitControls camera drag, not a click!

      const rect = dom.getBoundingClientRect();
      this.pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.handlePointerClick();
    });

    window.addEventListener('resize', () => {
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      if (w === 0 || h === 0) return;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
  }

  private raycastBoardIntersection(): Coord | null {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
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

  private handlePointerHover(): void {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);

    // 1. Check if pointer hovers over either Go bowl -> stir stones & play organic rattle!
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
      return;
    }

    // 2. Check board intersection hover
    const coord = this.raycastBoardIntersection();
    if (!coord) {
      this.renderer.domElement.style.cursor = 'default';
      this.clearHover();
      this.callbacks.onHoverLeave();
      return;
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
      // Show red forbidden seal on KO / SUICIDE / SUPERKO intersections!
      this.renderer.domElement.style.cursor = 'not-allowed';
      this.hoverGhostMesh.visible = false;
      this.hoverRingMesh.visible = false;
      this.forbiddenMarkerGroup.scale.setScalar(this.metrics.stoneRadius);
      this.forbiddenMarkerGroup.position.set(worldPos.x, 0.005, worldPos.z);
      this.forbiddenMarkerGroup.visible = true;
    } else {
      // Occupied stone in scoring mode or normal play
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
  }

  private handlePointerClick(): void {
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);

    // Clicking a Go bowl stirs the stones vigorously with a rich rattle!
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
      this.callbacks.onIntersectionClick(coord.x, coord.y);
    }
  }

  private animate = (): void => {
    this.rafId = requestAnimationFrame(this.animate);
    const dt = this.clock.getDelta();
    const elapsed = this.clock.elapsedTime;

    if (this.camTransition && this.camTransition.active) {
      this.camTransition.elapsed += dt;
      const t = Math.min(1, this.camTransition.elapsed / this.camTransition.duration);
      const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      this.camera.position.lerpVectors(this.camTransition.fromPos, this.camTransition.toPos, ease);
      this.controls.target.lerpVectors(this.camTransition.fromTarget, this.camTransition.toTarget, ease);
      if (t >= 1) this.camTransition.active = false;
    }

    this.controls.update();
    this.stoneAnimator.update(dt);
    this.room.updateAtmosphere(dt, elapsed);
    this.renderer.render(this.scene, this.camera);
  };
}
