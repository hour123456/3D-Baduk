import * as THREE from 'three';
import {
  BoardGridMetrics,
  createGobanSideTexture,
  createGobanTopTextures,
  createJujubeWoodTexture,
  createMaruFloorTexture,
  createMotherOfPearlTexture,
  createSilkBrocadeTexture,
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
  ornateGroup: THREE.Group;
  lanternLight: THREE.PointLight;
  setOrnateFinish: (enabled: boolean) => void;
  setTextureAnisotropy: (anisotropy: number) => void;
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
  const motherOfPearlTex = createMotherOfPearlTexture();
  const blackSilkTex = createSilkBrocadeTexture(true);
  const whiteSilkTex = createSilkBrocadeTexture(false);

  const ornateGroup = new THREE.Group();
  root.add(ornateGroup);

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
  const buildCushion = (zPos: number, silkTex: THREE.CanvasTexture) => {
    const cushion = new THREE.Mesh(
      new THREE.CylinderGeometry(0.95, 1.02, 0.14, 32),
      new THREE.MeshPhysicalMaterial({
        map: silkTex,
        roughness: 0.58,
        metalness: 0.04,
        sheen: 0.6,
        sheenRoughness: 0.45,
        sheenColor: new THREE.Color(0xe5c488),
      })
    );
    cushion.scale.set(1.15, 1, 0.92);
    cushion.position.set(0, floorY + 0.09, zPos);
    cushion.castShadow = true;
    cushion.receiveShadow = true;
    root.add(cushion);
  };
  buildCushion(3.38, blackSilkTex);
  buildCushion(-3.38, whiteSilkTex);

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

  // 7. Ornate Korean Craft Finish (황동 두석 · 나전칠기 상감 · 한옥 사방등 · 금빛 햇살 입자)
  const brassMat = new THREE.MeshStandardMaterial({
    color: 0xd9ad5b,
    metalness: 0.86,
    roughness: 0.24,
  });

  const nacreMat = new THREE.MeshPhysicalMaterial({
    map: motherOfPearlTex,
    roughness: 0.14,
    metalness: 0.12,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
    iridescence: 1.0,
    iridescenceIOR: 1.44,
  });

  // 7a. Brass Corner Brackets & Nacre Coasters on Side Stands
  const addStandOrnaments = (cx: number, cz: number, depthZ: number) => {
    const hw = 1.48 * 0.5;
    const hd = depthZ * 0.5;
    const capGeo = new THREE.BoxGeometry(0.11, 0.095, 0.11);
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const cap = new THREE.Mesh(capGeo, brassMat);
        cap.position.set(cx + sx * (hw - 0.045), standTopY - 0.045, cz + sz * (hd - 0.045));
        ornateGroup.add(cap);
      }
    }
    const inlay = new THREE.Mesh(new THREE.PlaneGeometry(1.18, depthZ - 0.48), nacreMat);
    inlay.rotation.x = -Math.PI / 2;
    inlay.position.set(cx, standTopY + 0.0012, cz);
    inlay.receiveShadow = true;
    ornateGroup.add(inlay);
  };
  addStandOrnaments(3.18, 0.68, 2.85);
  addStandOrnaments(-3.18, -0.25, 4.15);

  // Brass Collar Trim around Coaster
  const coasterTrim = new THREE.Mesh(new THREE.TorusGeometry(0.285, 0.012, 10, 32), brassMat);
  coasterTrim.rotation.x = Math.PI / 2;
  coasterTrim.position.copy(teaPos).add(new THREE.Vector3(0, 0.036, 0));
  ornateGroup.add(coasterTrim);

  // Brass Ferrule Rings around Goban Gardenia-Pod Feet
  const footRingGeo = new THREE.TorusGeometry(0.17, 0.014, 10, 24);
  for (const [lx, lz] of legOffsets) {
    const ring = new THREE.Mesh(footRingGeo, brassMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(lx, floorY + 0.08, lz);
    ornateGroup.add(ring);
  }

  // 7b. Traditional Wooden Hanji Stand Lantern (한옥 사방등 + 은은한 조명)
  const lanternPos = new THREE.Vector3(-3.65, floorY + 0.03, -3.25);
  const lanternGroup = new THREE.Group();
  lanternGroup.position.copy(lanternPos);

  const lBase = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.08, 0.56), frameWoodMat);
  lBase.position.y = 0.04;
  lBase.castShadow = true;
  lanternGroup.add(lBase);

  const lCore = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.92, 0.42),
    new THREE.MeshStandardMaterial({
      color: 0xfef0d4,
      emissive: new THREE.Color(0xffb662),
      emissiveIntensity: 1.45,
      roughness: 0.9,
    })
  );
  lCore.position.y = 0.54;
  lanternGroup.add(lCore);

  for (const px of [-0.23, 0.23]) {
    for (const pz of [-0.23, 0.23]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.045, 1.06, 0.045), frameWoodMat);
      post.position.set(px, 0.56, pz);
      post.castShadow = true;
      lanternGroup.add(post);
    }
  }
  const lCap = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.07, 0.62), frameWoodMat);
  lCap.position.y = 1.08;
  lCap.castShadow = true;
  lanternGroup.add(lCap);
  ornateGroup.add(lanternGroup);

  const lanternLight = new THREE.PointLight(0xffba6b, 1.25, 10.5, 1.75);
  lanternLight.position.set(lanternPos.x + 0.15, lanternPos.y + 0.72, lanternPos.z + 0.15);
  ornateGroup.add(lanternLight);

  // 7c. Floating Golden Sunlit Dust Motes (햇살 속 미세 먼지 입자)
  const moteCount = 85;
  const motePositions = new Float32Array(moteCount * 3);
  const moteBase = new Float32Array(moteCount * 3);
  for (let i = 0; i < moteCount; i++) {
    const bx = (Math.random() - 0.5) * 7.8;
    const by = -0.8 + Math.random() * 4.2;
    const bz = (Math.random() - 0.5) * 7.2;
    moteBase[i * 3] = bx;
    moteBase[i * 3 + 1] = by;
    moteBase[i * 3 + 2] = bz;
    motePositions[i * 3] = bx;
    motePositions[i * 3 + 1] = by;
    motePositions[i * 3 + 2] = bz;
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePositions, 3));
  const dustMotes = new THREE.Points(
    moteGeo,
    new THREE.PointsMaterial({
      map: puffTex,
      color: 0xffe4aa,
      size: 0.075,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  ornateGroup.add(dustMotes);

  let ornateEnabled = true;
  const setOrnateFinish = (enabled: boolean) => {
    ornateEnabled = enabled;
    ornateGroup.visible = enabled;
    lanternLight.intensity = enabled ? 1.25 : 0;
  };

  const setTextureAnisotropy = (aniso: number) => {
    const safeAniso = Math.max(1, Math.min(16, aniso));
    topTexBundle.map.anisotropy = safeAniso;
    topTexBundle.bumpMap.anisotropy = Math.max(1, Math.floor(safeAniso / 2));
    topTexBundle.roughnessMap.anisotropy = Math.max(1, Math.floor(safeAniso / 2));
    tatamiTex.anisotropy = Math.max(1, Math.floor(safeAniso / 2));
    sideGrainTex.anisotropy = Math.max(1, Math.floor(safeAniso / 2));
    endGrainTex.anisotropy = Math.max(1, Math.floor(safeAniso / 2));
    motherOfPearlTex.anisotropy = Math.max(1, Math.floor(safeAniso / 2));
    topTexBundle.map.needsUpdate = true;
  };

  const updateBoardTop = (metrics: BoardGridMetrics, coordsVisible: boolean) => {
    const prevAniso = topTexBundle.map.anisotropy;
    topTexBundle.map.dispose();
    topTexBundle.bumpMap.dispose();
    topTexBundle.roughnessMap.dispose();
    topTexBundle = createGobanTopTextures(metrics, coordsVisible);
    topTexBundle.map.anisotropy = prevAniso;
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

    if (ornateEnabled) {
      const mAttr = moteGeo.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < moteCount; i++) {
        const bx = moteBase[i * 3];
        const by = moteBase[i * 3 + 1];
        const bz = moteBase[i * 3 + 2];
        mAttr.setXYZ(
          i,
          bx + Math.sin(elapsed * 0.35 + i * 1.3) * 0.16,
          by + Math.cos(elapsed * 0.28 + i * 0.9) * 0.12,
          bz + Math.sin(elapsed * 0.31 + i * 2.1) * 0.16
        );
      }
      mAttr.needsUpdate = true;
      lanternLight.intensity = 1.2 + Math.sin(elapsed * 4.2) * 0.07;
    }
  };

  return {
    root,
    gobanTopMesh,
    blackBowl,
    whiteBowl,
    steamParticles,
    ornateGroup,
    lanternLight,
    setOrnateFinish,
    setTextureAnisotropy,
    updateBoardTop,
    updateAtmosphere,
  };
}
