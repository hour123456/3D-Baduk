import * as THREE from 'three';
import {
  BoardGridMetrics,
  createGobanSideTexture,
  createGobanTopTextures,
  createJujubeWoodTexture,
  createMaruFloorTexture,
  createTatamiTexture,
} from './ProceduralTextures';

export interface BowlAnchor {
  bowlCenter: THREE.Vector3; // Base center of bowl on stand
  stonePileOrigin: THREE.Vector3; // Interior center where bowl stones sit
  bowlCollider: THREE.Mesh; // Invisible sphere for easy raycast hover/click
  lidCenter: THREE.Vector3; // Interior floor center of prisoner lid
  lidMesh: THREE.Group;
}

export interface BuiltRoomAssets {
  root: THREE.Group;
  gobanTopMesh: THREE.Mesh; // Target for board intersection raycasting
  blackBowl: BowlAnchor;
  whiteBowl: BowlAnchor;
  steamParticles: THREE.Points;
  updateBoardTop: (metrics: BoardGridMetrics, showCoords: boolean) => void;
  updateAtmosphere: (dt: number, elapsed: number) => void;
}

export function buildTraditionalBadukRoom(
  initialMetrics: BoardGridMetrics,
  showCoords = true
): BuiltRoomAssets {
  const root = new THREE.Group();

  // Shared procedural textures
  const sideGrainTex = createGobanSideTexture(false);
  const endGrainTex = createGobanSideTexture(true);
  const jujubeTex = createJujubeWoodTexture();
  const tatamiTex = createTatamiTexture();
  const maruTex = createMaruFloorTexture();

  // 1. Maru Hardwood Floor & Tatami Rush Mat (Y = -2.10)
  const floorY = -2.1;
  const maruFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(30, 30),
    new THREE.MeshStandardMaterial({
      map: maruTex,
      roughness: 0.62,
      metalness: 0.04,
    })
  );
  maruFloor.rotation.x = -Math.PI / 2;
  maruFloor.position.y = floorY - 0.012;
  maruFloor.receiveShadow = true;
  root.add(maruFloor);

  const tatamiMat = new THREE.Mesh(
    new THREE.BoxGeometry(9.4, 0.045, 8.2),
    new THREE.MeshStandardMaterial({
      map: tatamiTex,
      roughness: 0.78,
      metalness: 0.0,
    })
  );
  tatamiMat.position.set(0, floorY + 0.01, 0);
  tatamiMat.receiveShadow = true;
  tatamiMat.castShadow = true;
  root.add(tatamiMat);

  // Silk Floor Cushions (비단 대국 방석 - 흑/백)
  const buildCushion = (zPos: number, colorHex: number) => {
    const cushion = new THREE.Mesh(
      new THREE.CylinderGeometry(0.95, 1.02, 0.14, 32),
      new THREE.MeshStandardMaterial({
        color: colorHex,
        roughness: 0.68,
        metalness: 0.05,
      })
    );
    cushion.scale.set(1.15, 1, 0.92);
    cushion.position.set(0, floorY + 0.09, zPos);
    cushion.castShadow = true;
    cushion.receiveShadow = true;
    root.add(cushion);
  };
  buildCushion(3.38, 0x2c221e);
  buildCushion(-3.38, 0x3b3028);

  // 2. Backlit Traditional Korean Changhoji / Shoji Screen Wall (Z = -5.6)
  const screenGroup = new THREE.Group();
  screenGroup.position.set(0, 0.6, -5.6);

  const paperPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(13.5, 6.2),
    new THREE.MeshStandardMaterial({
      color: 0xf5e6c8,
      emissive: new THREE.Color(0xffd699),
      emissiveIntensity: 0.24,
      roughness: 0.92,
    })
  );
  screenGroup.add(paperPanel);

  const frameWoodMat = new THREE.MeshStandardMaterial({
    color: 0x382214,
    roughness: 0.55,
  });

  // Vertical & horizontal wooden lattice bars (창살)
  for (let vx = -6.0; vx <= 6.01; vx += 1.5) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(0.06, 6.2, 0.06), frameWoodMat);
    bar.position.set(vx, 0, 0.03);
    screenGroup.add(bar);
  }
  for (let hy = -2.7; hy <= 2.71; hy += 0.9) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(13.5, 0.045, 0.05), frameWoodMat);
    bar.position.set(0, hy, 0.03);
    screenGroup.add(bar);
  }
  root.add(screenGroup);

  // 3. Thick Kaya Wood Goban (비자나무 각반, Top Surface at Y = 0)
  let topTexBundle = createGobanTopTextures(initialMetrics, showCoords);

  const sideMat = new THREE.MeshStandardMaterial({
    map: sideGrainTex,
    roughness: 0.42,
    metalness: 0.02,
  });
  const endMat = new THREE.MeshStandardMaterial({
    map: endGrainTex,
    roughness: 0.46,
    metalness: 0.02,
  });
  const topMat = new THREE.MeshPhysicalMaterial({
    map: topTexBundle.map,
    bumpMap: topTexBundle.bumpMap,
    bumpScale: 0.0045,
    roughnessMap: topTexBundle.roughnessMap,
    roughness: 0.85,
    clearcoat: 0.24,
    clearcoatRoughness: 0.32,
  });
  const bottomMat = new THREE.MeshStandardMaterial({
    color: 0x9b6728,
    roughness: 0.65,
  });

  // BoxGeometry material order: [+X, -X, +Y (top), -Y (bottom), +Z (front), -Z (back)]
  const gobanMaterials = [sideMat, sideMat, topMat, bottomMat, endMat, endMat];
  const gobanBlock = new THREE.Mesh(
    new THREE.BoxGeometry(initialMetrics.boardWidth, initialMetrics.slabThickness, initialMetrics.boardDepth),
    gobanMaterials
  );
  gobanBlock.position.set(0, -initialMetrics.slabThickness / 2, 0);
  gobanBlock.castShadow = true;
  gobanBlock.receiveShadow = true;
  root.add(gobanBlock);

  // Acoustic Pyramid Cavity ("혈 / 배꼽") carved into underside of Goban
  const hesoCavity = new THREE.Mesh(
    new THREE.ConeGeometry(0.32, 0.22, 4),
    new THREE.MeshStandardMaterial({ color: 0x4b2c0e, roughness: 0.85 })
  );
  hesoCavity.rotation.y = Math.PI / 4;
  hesoCavity.position.set(0, -initialMetrics.slabThickness + 0.09, 0);
  root.add(hesoCavity);

  // Invisible ultra-precise flat plane at Y = 0.0005 dedicated to board intersection raycasting
  const gobanTopMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(initialMetrics.boardWidth, initialMetrics.boardDepth),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  gobanTopMesh.rotation.x = -Math.PI / 2;
  gobanTopMesh.position.set(0, 0.0005, 0);
  root.add(gobanTopMesh);

  // 4 Carved Fluted Gardenia-Pod Legs (전통 치자 열매 조각 다리)
  const legProfile: THREE.Vector2[] = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.14, 0.0),
    new THREE.Vector2(0.17, 0.05),
    new THREE.Vector2(0.12, 0.12),
    new THREE.Vector2(0.24, 0.34),
    new THREE.Vector2(0.26, 0.50),
    new THREE.Vector2(0.17, 0.68),
    new THREE.Vector2(0.21, 0.75),
    new THREE.Vector2(0.22, 0.82),
    new THREE.Vector2(0.0, 0.82),
  ];
  const legGeo = new THREE.LatheGeometry(legProfile, 8); // Octagonal carved facets!
  const legMat = new THREE.MeshStandardMaterial({
    map: sideGrainTex,
    color: 0xc5893e,
    roughness: 0.45,
  });

  const legOffsets = [
    [-1.62, -1.74],
    [1.62, -1.74],
    [-1.62, 1.74],
    [1.62, 1.74],
  ];
  for (const [lx, lz] of legOffsets) {
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(lx, floorY + 0.03, lz);
    leg.rotation.y = Math.PI / 8;
    leg.castShadow = true;
    leg.receiveShadow = true;
    root.add(leg);
  }

  // 4. Raised Hardwood Side Tables (바둑통 좌탁, Top at Y = -0.78)
  const standTopY = -0.78;
  const standMat = new THREE.MeshStandardMaterial({
    map: maruTex,
    color: 0x4b2e1b,
    roughness: 0.76,
    metalness: 0.0,
  });

  const buildSideStand = (centerX: number, centerZ: number, depthZ: number) => {
    const grp = new THREE.Group();
    const topSlab = new THREE.Mesh(new THREE.BoxGeometry(1.48, 0.09, depthZ), standMat);
    topSlab.position.set(centerX, standTopY - 0.045, centerZ);
    topSlab.castShadow = true;
    topSlab.receiveShadow = true;
    grp.add(topSlab);

    const legH = standTopY - 0.09 - (floorY + 0.03);
    const sLegGeo = new THREE.BoxGeometry(0.11, legH, 0.11);
    const dx = 0.58;
    const dz = depthZ * 0.42;
    for (const sx of [-dx, dx]) {
      for (const sz of [-dz, dz]) {
        const sLeg = new THREE.Mesh(sLegGeo, standMat);
        sLeg.position.set(centerX + sx, floorY + 0.03 + legH / 2, centerZ + sz);
        sLeg.castShadow = true;
        sLeg.receiveShadow = true;
        grp.add(sLeg);
      }
    }
    root.add(grp);
  };

  buildSideStand(3.18, 0.68, 2.85); // Black's side table (Right-Front)
  buildSideStand(-3.18, -0.25, 4.15); // White's side table + tea area (Left)

  // 5. Lathe-Turned Jujube Wood Go Bowls (대추나무 바둑통) & Upside-Down Lids (사석 뚜껑)
  const bowlMat = new THREE.MeshPhysicalMaterial({
    map: jujubeTex,
    roughness: 0.24,
    clearcoat: 0.78,
    clearcoatRoughness: 0.16,
    side: THREE.DoubleSide,
  });

  // Hollow thick-walled bowl profile (outer curve -> rounded rim -> inner cavity)
  const bowlProfile: THREE.Vector2[] = [
    new THREE.Vector2(0.0, 0.0),
    new THREE.Vector2(0.36, 0.0),
    new THREE.Vector2(0.52, 0.10),
    new THREE.Vector2(0.60, 0.26),
    new THREE.Vector2(0.58, 0.44),
    new THREE.Vector2(0.49, 0.58),
    new THREE.Vector2(0.44, 0.60), // Lip outer
    new THREE.Vector2(0.40, 0.58), // Lip inner
    new THREE.Vector2(0.49, 0.42),
    new THREE.Vector2(0.50, 0.24),
    new THREE.Vector2(0.38, 0.11),
    new THREE.Vector2(0.0, 0.08),
  ];
  const bowlGeo = new THREE.LatheGeometry(bowlProfile, 48);

  // Upside-down Bowl Lid profile (바둑통 뚜껑을 뒤집어 놓은 형태 — 사석 담는 그릇)
  const lidProfile: THREE.Vector2[] = [
    new THREE.Vector2(0.0, 0.02),
    new THREE.Vector2(0.22, 0.02), // Bottom handle foot ring resting on table
    new THREE.Vector2(0.26, 0.05),
    new THREE.Vector2(0.46, 0.11),
    new THREE.Vector2(0.54, 0.21), // Outer rim
    new THREE.Vector2(0.50, 0.22), // Rim top
    new THREE.Vector2(0.43, 0.13), // Inner slope
    new THREE.Vector2(0.22, 0.07),
    new THREE.Vector2(0.0, 0.065), // Inner floor at +0.065
  ];
  const lidGeo = new THREE.LatheGeometry(lidProfile, 48);

  const buildBowlSet = (
    bowlX: number,
    bowlZ: number,
    lidX: number,
    lidZ: number,
    tag: 'black' | 'white'
  ): BowlAnchor => {
    const bowlMesh = new THREE.Mesh(bowlGeo, bowlMat);
    bowlMesh.position.set(bowlX, standTopY, bowlZ);
    bowlMesh.castShadow = true;
    bowlMesh.receiveShadow = true;
    root.add(bowlMesh);

    // Invisible hover/click sphere around bowl opening
    const collider = new THREE.Mesh(
      new THREE.SphereGeometry(0.64, 16, 12),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    collider.position.set(bowlX, standTopY + 0.34, bowlZ);
    collider.userData = { bowlSide: tag };
    root.add(collider);

    const lidGroup = new THREE.Group();
    lidGroup.position.set(lidX, standTopY, lidZ);
    const lidMesh = new THREE.Mesh(lidGeo, bowlMat);
    lidMesh.castShadow = true;
    lidMesh.receiveShadow = true;
    lidGroup.add(lidMesh);
    root.add(lidGroup);

    return {
      bowlCenter: new THREE.Vector3(bowlX, standTopY, bowlZ),
      stonePileOrigin: new THREE.Vector3(bowlX, standTopY + 0.31, bowlZ),
      bowlCollider: collider,
      lidCenter: new THREE.Vector3(lidX, standTopY + 0.075, lidZ),
      lidMesh: lidGroup,
    };
  };

  const blackBowl = buildBowlSet(3.18, 1.35, 3.16, 0.0, 'black');
  const whiteBowl = buildBowlSet(-3.18, -1.35, -3.16, 0.0, 'white');

  // 6. Celadon Tea Cup (고려청자 찻잔과 원목 다탁 받침) + Gentle Steam Particles
  const teaPos = new THREE.Vector3(-3.18, standTopY, 1.28);
  const coaster = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.24, 0.035, 28),
    new THREE.MeshStandardMaterial({ color: 0x2b170c, roughness: 0.45 })
  );
  coaster.position.copy(teaPos).add(new THREE.Vector3(0, 0.018, 0));
  coaster.castShadow = true;
  root.add(coaster);

  const cupProfile: THREE.Vector2[] = [
    new THREE.Vector2(0.0, 0.035),
    new THREE.Vector2(0.11, 0.035),
    new THREE.Vector2(0.18, 0.14),
    new THREE.Vector2(0.20, 0.28),
    new THREE.Vector2(0.185, 0.285),
    new THREE.Vector2(0.165, 0.15),
    new THREE.Vector2(0.0, 0.06),
  ];
  const cupMesh = new THREE.Mesh(
    new THREE.LatheGeometry(cupProfile, 32),
    new THREE.MeshPhysicalMaterial({
      color: 0x8fa998, // Subtle jade celadon glaze (비색 청자)
      roughness: 0.15,
      clearcoat: 0.9,
      side: THREE.DoubleSide,
    })
  );
  cupMesh.position.copy(teaPos);
  cupMesh.castShadow = true;
  root.add(cupMesh);

  const teaLiquid = new THREE.Mesh(
    new THREE.CircleGeometry(0.168, 24),
    new THREE.MeshStandardMaterial({
      color: 0x586b34,
      roughness: 0.48,
      metalness: 0.0,
      transparent: true,
      opacity: 0.92,
    })
  );
  teaLiquid.rotation.x = -Math.PI / 2;
  teaLiquid.position.copy(teaPos).add(new THREE.Vector3(0, 0.22, 0));
  root.add(teaLiquid);

  // Delicate rising steam wisps above the tea cup
  const steamCount = 22;
  const steamPositions = new Float32Array(steamCount * 3);
  const steamPhases = new Float32Array(steamCount);
  for (let i = 0; i < steamCount; i++) {
    steamPhases[i] = Math.random();
    steamPositions[i * 3] = teaPos.x + (Math.random() - 0.5) * 0.1;
    steamPositions[i * 3 + 1] = teaPos.y + 0.25 + steamPhases[i] * 0.55;
    steamPositions[i * 3 + 2] = teaPos.z + (Math.random() - 0.5) * 0.1;
  }
  const steamGeo = new THREE.BufferGeometry();
  steamGeo.setAttribute('position', new THREE.BufferAttribute(steamPositions, 3));

  // Soft circular puff sprite
  const puffCanvas = document.createElement('canvas');
  puffCanvas.width = 64;
  puffCanvas.height = 64;
  const pCtx = puffCanvas.getContext('2d')!;
  const grad = pCtx.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255, 248, 236, 0.32)');
  grad.addColorStop(1, 'rgba(255, 248, 236, 0)');
  pCtx.fillStyle = grad;
  pCtx.fillRect(0, 0, 64, 64);
  const puffTex = new THREE.CanvasTexture(puffCanvas);

  const steamParticles = new THREE.Points(
    steamGeo,
    new THREE.PointsMaterial({
      map: puffTex,
      size: 0.22,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  root.add(steamParticles);

  const updateBoardTop = (metrics: BoardGridMetrics, coordsVisible: boolean) => {
    topTexBundle.map.dispose();
    topTexBundle.bumpMap.dispose();
    topTexBundle.roughnessMap.dispose();
    topTexBundle = createGobanTopTextures(metrics, coordsVisible);
    topMat.map = topTexBundle.map;
    topMat.bumpMap = topTexBundle.bumpMap;
    topMat.roughnessMap = topTexBundle.roughnessMap;
    topMat.needsUpdate = true;
  };

  const updateAtmosphere = (dt: number, elapsed: number) => {
    const posAttr = steamGeo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < steamCount; i++) {
      steamPhases[i] += dt * 0.26;
      if (steamPhases[i] > 1) steamPhases[i] -= 1;
      const p = steamPhases[i];
      const swayX = Math.sin(elapsed * 1.4 + i * 1.7) * 0.045 * p;
      const swayZ = Math.cos(elapsed * 1.1 + i * 2.1) * 0.045 * p;
      posAttr.setXYZ(
        i,
        teaPos.x + swayX,
        teaPos.y + 0.24 + p * 0.62,
        teaPos.z + swayZ
      );
    }
    posAttr.needsUpdate = true;
  };

  return {
    root,
    gobanTopMesh,
    blackBowl,
    whiteBowl,
    steamParticles,
    updateBoardTop,
    updateAtmosphere,
  };
}
