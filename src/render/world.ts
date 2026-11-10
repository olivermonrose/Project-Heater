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
  scene.add(buildScatter(terrain));
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
  addGroundDetail(mat);
  return new THREE.Mesh(geo, mat);
}

// ---------- Ground detail ----------
// A tileable grain texture blended in at three scales in world space: large
// mottling seen from altitude, medium patches, and fine grain close to the
// ground that fades out with distance so it never shows as a repeating tile.

let detailTex: THREE.Texture | null = null;
function groundDetailTexture() {
  if (detailTex) return detailTex;
  const N = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(N, N);
  // Periodic value noise so the texture tiles seamlessly.
  const lattice = (period: number, seed: number) => {
    const v = new Float32Array(period * period);
    let r = seed;
    for (let i = 0; i < v.length; i++) v[i] = (r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    return (x: number, y: number) => {
      const fx = (x / N) * period, fy = (y / N) * period;
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const tx = fx - x0, ty = fy - y0;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const at = (i: number, j: number) => v[((j % period) * period) + (i % period)];
      const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    };
  };
  const octs = [lattice(4, 11), lattice(8, 23), lattice(16, 37), lattice(32, 51), lattice(64, 79)];
  const weights = [0.35, 0.25, 0.18, 0.12, 0.1];
  let r = 999;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let n = 0;
      octs.forEach((o, i) => (n += o(x, y) * weights[i]));
      // A little pixel grain (pebbles).
      n += (((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5) * 0.08;
      const v = Math.max(0, Math.min(255, Math.round(n * 255)));
      const k = (y * N + x) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = v;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  detailTex = tex;
  return tex;
}

function addGroundDetail(mat: THREE.MeshLambertMaterial) {
  const tex = groundDetailTexture();
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.detailMap = { value: tex };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundPos;\nuniform sampler2D detailMap;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float dist = length(vGroundPos - cameraPosition);
          float big = texture2D(detailMap, vGroundPos.xz / 2300.0).r;
          float mid = texture2D(detailMap, vGroundPos.xz / 310.0 + 0.37).r;
          float fine = texture2D(detailMap, vGroundPos.xz / 23.0).r;
          float grain = texture2D(detailMap, vGroundPos.xz / 3.1 + 0.11).r;
          float nearF = 1.0 - smoothstep(150.0, 1800.0, dist);
          float closeF = 1.0 - smoothstep(10.0, 140.0, dist);
          float k = (0.76 + 0.48 * big) * (0.82 + 0.36 * mid);
          k *= mix(1.0, 0.8 + 0.4 * fine, nearF);
          k *= mix(1.0, 0.86 + 0.28 * grain, closeF);
          // Darker gravel patches and lighter wind-blown sand.
          diffuseColor.rgb *= k;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.06, 1.02, 0.94), smoothstep(0.55, 0.75, mid));
        }`);
  };
}

/** Desert scrub and boulders scattered over the terrain (instanced: two draw calls). */
function buildScatter(terrain: Terrain) {
  const g = new THREE.Group();
  let r = 4242;
  const rand = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const slopeAt = (x: number, z: number) => {
    const d = 8;
    return Math.hypot(terrain.heightAt(x + d, z) - terrain.heightAt(x - d, z), terrain.heightAt(x, z + d) - terrain.heightAt(x, z - d)) / (2 * d);
  };
  const onAirbase = (x: number, z: number) => x > -900 && x < 500 && z > -2000 && z < 2000;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  // Scrub: low, dark olive-brown bushes on flat sandy ground.
  const bushGeo = new THREE.IcosahedronGeometry(1, 0);
  bushGeo.scale(1, 0.55, 1);
  const bushes = new THREE.InstancedMesh(bushGeo, new THREE.MeshLambertMaterial({ color: 0x6d6440, flatShading: true }), 16000);
  let k = 0;
  for (let tries = 0; tries < 60000 && k < 16000; tries++) {
    // Clumps: pick a centre, then scatter a few around it.
    const cx = (rand() - 0.5) * (TERRAIN_SIZE - 3000), cz = (rand() - 0.5) * (TERRAIN_SIZE - 3000);
    const n = 3 + Math.floor(rand() * 8);
    for (let i = 0; i < n && k < 16000; i++) {
      const x = cx + (rand() - 0.5) * 220, z = cz + (rand() - 0.5) * 220;
      if (onAirbase(x, z) || slopeAt(x, z) > 0.25) continue;
      const h = terrain.heightAt(x, z);
      if (h > BASE_ELEV + 250) continue;
      const s = 0.8 + rand() * 1.8;
      sc.set(s * (0.8 + rand() * 0.5), s, s * (0.8 + rand() * 0.5));
      q.setFromAxisAngle(up, rand() * 6.28);
      p.set(x, h + s * 0.15, z);
      bushes.setMatrixAt(k++, m.compose(p, q, sc));
    }
  }
  bushes.count = k;
  g.add(bushes);

  // Boulders on the slopes and around the foot of the ridges.
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const rocks = new THREE.InstancedMesh(rockGeo, new THREE.MeshLambertMaterial({ color: 0x8a6e54, flatShading: true }), 9000);
  k = 0;
  for (let tries = 0; tries < 90000 && k < 9000; tries++) {
    const x = (rand() - 0.5) * (TERRAIN_SIZE - 3000), z = (rand() - 0.5) * (TERRAIN_SIZE - 3000);
    if (onAirbase(x, z)) continue;
    const sl = slopeAt(x, z);
    if (sl < 0.15 && rand() > 0.08) continue;
    const s = 1.5 + rand() * rand() * 9;
    sc.set(s * (0.7 + rand() * 0.6), s * (0.5 + rand() * 0.4), s * (0.7 + rand() * 0.6));
    q.setFromEuler(new THREE.Euler(rand() * 0.6, rand() * 6.28, rand() * 0.6));
    p.set(x, terrain.heightAt(x, z) + s * 0.1, z);
    rocks.setMatrixAt(k++, m.compose(p, q, sc));
  }
  rocks.count = k;
  g.add(rocks);
  return g;
}

function buildOuterGround() {
  // A flat apron of desert around the terrain tile, with a square hole so it
  // never covers low ground inside the map.
  const R = 200000;
  const h = TERRAIN_SIZE / 2 - CELL; // overlap the tile's flat edge slightly
  const shape = new THREE.Shape();
  shape.moveTo(-R, -R);
  shape.lineTo(R, -R);
  shape.lineTo(R, R);
  shape.lineTo(-R, R);
  shape.closePath();
  const hole = new THREE.Path();
  hole.moveTo(-h, -h);
  hole.lineTo(-h, h);
  hole.lineTo(h, h);
  hole.lineTo(h, -h);
  hole.closePath();
  shape.holes.push(hole);
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  const outerMat = new THREE.MeshLambertMaterial({ color: 0xcfb084 });
  addGroundDetail(outerMat);
  const m = new THREE.Mesh(geo, outerMat);
  m.position.y = BASE_ELEV - 0.5;
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
