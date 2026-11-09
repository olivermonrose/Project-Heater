import * as THREE from 'three';
import { BASE_ELEV, CELL, GRID, RUNWAY, TERRAIN_SIZE, Terrain } from '../sim/terrain';
import { fbm } from '../sim/noise';

export const SKY_COLOR = new THREE.Color(0xa9c6dd);
const FOG_COLOR = new THREE.Color(0xd9d3c4);

// Airbase surfaces (centered rectangles: x, z, width (x), length (z)).
export const TAXIWAYS: [number, number, number, number][] = [
  [-180, 0, 20, 2900], // parallel taxiway
  [-90, 1450, 200, 20], // south connector to runway threshold
  [-90, 0, 200, 20], // mid connector
  [-90, -1450, 200, 20], // north connector
];
export const APRON: [number, number, number, number] = [-290, 1290, 200, 340];
export const RAMP_START = { x: -300, z: 1250, heading: 90 };
export const RUNWAY_START = { x: 0, z: 1430, heading: 0 };

export function buildWorld(scene: THREE.Scene, terrain: Terrain) {
  scene.background = SKY_COLOR;
  scene.fog = new THREE.Fog(FOG_COLOR, 9000, 42000);

  const hemi = new THREE.HemisphereLight(0xdfe9f5, 0x8a7356, 1.1);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.0);
  sun.position.set(0.5, 0.8, 0.35).normalize();
  scene.add(sun);

  scene.add(buildTerrainMesh(terrain));
  scene.add(buildOuterGround());
  scene.add(buildAirbase());
  scene.add(buildTowns(terrain));
  scene.add(buildSkyDome());
}

function buildTerrainMesh(terrain: Terrain) {
  const positions: number[] = [];
  const colors: number[] = [];
  const sand = new THREE.Color(0xd8b98a);
  const sandDark = new THREE.Color(0xc39f6e);
  const rock = new THREE.Color(0x9a7a5c);
  const rockDark = new THREE.Color(0x7a5e47);
  const c = new THREE.Color();
  const v = (i: number, j: number) => {
    const x = -TERRAIN_SIZE / 2 + i * CELL;
    const z = -TERRAIN_SIZE / 2 + j * CELL;
    return [x, terrain.heights[j * (GRID + 1) + i], z];
  };
  const pushTri = (a: number[], b: number[], d: number[]) => {
    positions.push(...a, ...b, ...d);
    // Color by elevation and slope.
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const wx = d[0] - a[0], wy = d[1] - a[1], wz = d[2] - a[2];
    const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const slope = 1 - Math.abs(ny) / Math.hypot(nx, ny, nz);
    const h = (a[1] + b[1] + d[1]) / 3 - BASE_ELEV;
    const noise = fbm(a[0] / 900, a[2] / 900, 2, 3);
    c.copy(sand).lerp(sandDark, noise);
    const rockiness = Math.min(1, Math.max(0, slope * 3.2 - 0.25 + h / 1400));
    c.lerp(noise > 0.5 ? rock : rockDark, rockiness);
    for (let k = 0; k < 3; k++) colors.push(c.r, c.g, c.b);
  };
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const p00 = v(i, j), p10 = v(i + 1, j), p01 = v(i, j + 1), p11 = v(i + 1, j + 1);
      // Same diagonal split as Terrain.heightAt. Wound counter-clockwise from above.
      pushTri(p00, p11, p10);
      pushTri(p00, p01, p11);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  return new THREE.Mesh(geo, mat);
}

function buildOuterGround() {
  const geo = new THREE.PlaneGeometry(400000, 400000);
  geo.rotateX(-Math.PI / 2);
  // Leave a hole-free plane slightly below the terrain edge height.
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0xcfb084 }));
  m.position.y = BASE_ELEV - 2;
  return m;
}

function buildSkyDome() {
  const geo = new THREE.SphereGeometry(150000, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x3f6fa8) },
      horizon: { value: new THREE.Color(0xd9e2e6) },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * p; gl_Position.z = gl_Position.w; }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; varying vec3 vDir; void main(){ float t = clamp(vDir.y*2.2, 0.0, 1.0); gl_FragColor = vec4(mix(horizon, top, pow(t,0.7)), 1.0); }`,
  });
  const dome = new THREE.Mesh(geo, mat);
  dome.frustumCulled = false;
  dome.renderOrder = -1;
  dome.onBeforeRender = (_r, _s, camera) => dome.position.copy(camera.getWorldPosition(new THREE.Vector3()));
  return dome;
}

function runwayTexture() {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 4096;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#3a3a3c';
  g.fillRect(0, 0, 128, 4096);
  // Subtle tire marks near the ends.
  g.fillStyle = 'rgba(20,20,20,0.35)';
  g.fillRect(30, 3500, 68, 450);
  g.fillRect(30, 150, 68, 450);
  g.fillStyle = '#e8e8e8';
  // Edge lines.
  g.fillRect(4, 0, 3, 4096);
  g.fillRect(121, 0, 3, 4096);
  // Centerline dashes.
  for (let y = 260; y < 3840; y += 80) g.fillRect(62, y, 4, 42);
  // Threshold bars (piano keys) at both ends.
  for (let i = 0; i < 8; i++) {
    const x = 10 + i * 14 + (i >= 4 ? 4 : 0);
    g.fillRect(x, 4096 - 70, 8, 60);
    g.fillRect(x, 10, 8, 60);
  }
  // Runway numbers.
  g.font = 'bold 40px sans-serif';
  g.textAlign = 'center';
  g.save();
  g.translate(64, 4096 - 120);
  g.scale(1, 1.8);
  g.fillText('36', 0, 0);
  g.restore();
  g.save();
  g.translate(64, 120);
  g.rotate(Math.PI);
  g.scale(1, 1.8);
  g.fillText('18', 0, 0);
  g.restore();
  // Aiming point blocks.
  g.fillRect(28, 4096 - 560, 14, 110);
  g.fillRect(86, 4096 - 560, 14, 110);
  g.fillRect(28, 450, 14, 110);
  g.fillRect(86, 450, 14, 110);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 8;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function flatRect(cx: number, cz: number, w: number, l: number, mat: THREE.Material, y: number) {
  const geo = new THREE.PlaneGeometry(w, l);
  geo.rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(geo, mat);
  m.position.set(cx, y, cz);
  return m;
}

function buildAirbase() {
  const g = new THREE.Group();
  const y = BASE_ELEV + 0.12;
  const runwayLen = RUNWAY.zSouth - RUNWAY.zNorth;
  g.add(flatRect(RUNWAY.x, 0, RUNWAY.width, runwayLen, new THREE.MeshLambertMaterial({ map: runwayTexture() }), y + 0.04));

  const taxiMat = new THREE.MeshLambertMaterial({ color: 0x55534f });
  for (const [x, z, w, l] of TAXIWAYS) g.add(flatRect(x, z, w, l, taxiMat, y));
  g.add(flatRect(APRON[0], APRON[1], APRON[2], APRON[3], new THREE.MeshLambertMaterial({ color: 0x67645e }), y - 0.02));

  // Yellow taxi centerlines.
  const lineMat = new THREE.MeshBasicMaterial({ color: 0xd9b23a });
  for (const [x, z, w, l] of TAXIWAYS) {
    if (w < l) g.add(flatRect(x, z, 0.4, l, lineMat, y + 0.03));
    else g.add(flatRect(x, z, w, 0.4, lineMat, y + 0.03));
  }

  // Hardened aircraft shelters along the apron.
  const shelterMat = new THREE.MeshLambertMaterial({ color: 0xa79a83 });
  for (let i = 0; i < 4; i++) {
    const geo = new THREE.CylinderGeometry(12, 12, 30, 12, 1, false, 0, Math.PI);
    geo.rotateZ(Math.PI / 2);
    geo.rotateY(Math.PI / 2);
    const m = new THREE.Mesh(geo, shelterMat);
    m.position.set(-420, BASE_ELEV, 1150 + i * 70);
    m.rotation.y = Math.PI / 2;
    g.add(m);
  }
  // Control tower and a few buildings.
  const bMat = new THREE.MeshLambertMaterial({ color: 0xcdbfa6 });
  const tower = new THREE.Mesh(new THREE.BoxGeometry(8, 22, 8), bMat);
  tower.position.set(-330, BASE_ELEV + 11, 800);
  g.add(tower);
  const cab = new THREE.Mesh(new THREE.BoxGeometry(11, 4, 11), new THREE.MeshLambertMaterial({ color: 0x3b4b57 }));
  cab.position.set(-330, BASE_ELEV + 24, 800);
  g.add(cab);
  const boxes: [number, number, number, number, number][] = [
    [-420, 600, 40, 10, 25], [-430, 450, 30, 8, 30], [-380, 350, 50, 12, 20], [-470, 900, 25, 6, 60],
  ];
  for (const [x, z, w, h, l] of boxes) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), bMat);
    m.position.set(x, BASE_ELEV + h / 2, z);
    g.add(m);
  }
  // Runway edge lights (small posts) to help judge the flare.
  const lightGeo = new THREE.BoxGeometry(0.5, 0.6, 0.5);
  const lightMat = new THREE.MeshBasicMaterial({ color: 0xf2f2e6 });
  const n = 2 * Math.floor(runwayLen / 60);
  const inst = new THREE.InstancedMesh(lightGeo, lightMat, n);
  const mtx = new THREE.Matrix4();
  let k = 0;
  for (let z = RUNWAY.zNorth; z < RUNWAY.zSouth && k < n; z += 60) {
    for (const s of [-1, 1]) {
      mtx.makeTranslation(RUNWAY.x + s * (RUNWAY.width / 2 + 3), BASE_ELEV + 0.3, z);
      if (k < n) inst.setMatrixAt(k++, mtx);
    }
  }
  g.add(inst);
  return g;
}

function buildTowns(terrain: Terrain) {
  const g = new THREE.Group();
  const centers = [
    [9000, -8000], [-12000, 7000], [4000, 14000], [-6000, -15000], [15000, 9000],
  ];
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  const mat = new THREE.MeshLambertMaterial({ color: 0xe0d2b8 });
  const count = centers.length * 70;
  const inst = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  let k = 0;
  let r = 12345;
  const rand = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (const [cx, cz] of centers) {
    for (let i = 0; i < 70; i++) {
      const x = cx + (rand() - 0.5) * 900;
      const z = cz + (rand() - 0.5) * 900;
      const w = 10 + rand() * 25;
      s.set(w, 5 + rand() * 12, 10 + rand() * 25);
      p.set(x, terrain.heightAt(x, z) - 1, z);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.floor(rand() * 4) * 0.2);
      m.compose(p, q, s);
      inst.setMatrixAt(k++, m);
    }
  }
  g.add(inst);
  return g;
}
