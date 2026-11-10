import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { AircraftState } from '../sim/aircraft';

// Extra cockpit detail for the KR-7: textured panels and consoles, buttons
// around the screens, standby gauges, a proper throttle and stick, an
// ejection handle, mirrors and side walls. Small parts are merged into a few
// meshes so the cockpit stays cheap to draw.

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  draw(cv.getContext('2d')!);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Painted metal with faint wear, panel seams and screw heads. */
function metal(g: CanvasRenderingContext2D, w: number, h: number, base: string, seams: [number, number, number, number][]) {
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  let r = 77;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < (w * h) / 40; i++) {
    g.fillStyle = `rgba(${rnd() > 0.5 ? '255,255,255' : '0,0,0'},${0.015 + rnd() * 0.025})`;
    g.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 3, 1 + rnd() * 2);
  }
  for (const [x, y, sw, sh] of seams) {
    g.strokeStyle = 'rgba(0,0,0,0.55)';
    g.lineWidth = 2;
    g.strokeRect(x, y, sw, sh);
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.lineWidth = 1;
    g.strokeRect(x + 2, y + 2, sw - 4, sh - 4);
    for (const [sx, sy] of [[x + 6, y + 6], [x + sw - 6, y + 6], [x + 6, y + sh - 6], [x + sw - 6, y + sh - 6]]) {
      g.fillStyle = '#5c6268';
      g.beginPath();
      g.arc(sx, sy, 2.4, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.6)';
      g.beginPath();
      g.moveTo(sx - 2, sy);
      g.lineTo(sx + 2, sy);
      g.stroke();
    }
  }
}

/** Side console top: rows of control panels with knobs and white labels. */
function consoleTex(side: 'L' | 'R') {
  const labels = side === 'L'
    ? [['FUEL', 'EXT LT', 'IFF'], ['COMM 1', 'COMM 2', 'AUDIO'], ['TRIM', 'MANUAL', 'FLCS'], ['TEST', 'ANTI-ICE', 'ENG CTL']]
    : [['OXYGEN', 'O2 FLOW', 'MASK'], ['ECS', 'TEMP', 'DEFOG'], ['INT LT', 'FLOOD', 'CONSOLE'], ['SNSR PWR', 'HMCS', 'ZEROIZE']];
  return canvasTex(256, 1024, (g) => {
    const seams: [number, number, number, number][] = [];
    for (let i = 0; i < 4; i++) seams.push([6, 40 + i * 240, 244, 220]);
    metal(g, 256, 1024, '#2c3034', seams);
    g.font = 'bold 15px sans-serif';
    g.textAlign = 'center';
    labels.forEach((row, i) => {
      row.forEach((txt, j) => {
        const cx = 48 + j * 80, cy = 40 + i * 240;
        g.fillStyle = '#d9dcd6';
        g.fillText(txt, cx, cy + 40);
        // Knob or switch guard painted under where the 3D knob sits.
        g.strokeStyle = 'rgba(217,220,214,0.6)';
        g.lineWidth = 2;
        g.beginPath();
        g.arc(cx, cy + 110, 30, Math.PI * 0.8, Math.PI * 2.2);
        g.stroke();
        for (let t = 0; t < 5; t++) {
          const a = Math.PI * (0.8 + t * 0.35);
          g.beginPath();
          g.moveTo(cx + Math.cos(a) * 30, cy + 110 + Math.sin(a) * 30);
          g.lineTo(cx + Math.cos(a) * 36, cy + 110 + Math.sin(a) * 36);
          g.stroke();
        }
        g.fillStyle = 'rgba(217,220,214,0.85)';
        g.font = '11px sans-serif';
        g.fillText(t2(i, j), cx, cy + 175);
        g.font = 'bold 15px sans-serif';
      });
    });
  });
  function t2(i: number, j: number) {
    return ['OFF  NORM  ON', 'ARM  SAFE', 'AUTO  MAN', 'OFF  BRT'][(i + j) % 4];
  }
}

function wallTex() {
  return canvasTex(512, 256, (g) => {
    metal(g, 512, 256, '#33383d', [[4, 4, 250, 248], [258, 4, 250, 248]]);
    // Rivet rows along the frames.
    g.fillStyle = 'rgba(160,165,170,0.35)';
    for (let x = 12; x < 512; x += 16) {
      g.fillRect(x, 10, 2, 2);
      g.fillRect(x, 244, 2, 2);
    }
  });
}

export class CockpitDetail {
  private adi: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture };
  private alt: { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture };
  private timer = 0;

  constructor(root: THREE.Object3D, panel: THREE.Object3D, panelFace: THREE.Mesh, consoleL: THREE.Mesh, consoleR: THREE.Mesh, pedestal: THREE.Mesh) {
    const lam = (c: number) => new THREE.MeshLambertMaterial({ color: c });

    // Textured instrument panel face.
    const panelMap = canvasTex(512, 256, (g) => {
      metal(g, 512, 256, '#2b2f33', [[4, 4, 504, 248], [160, 4, 192, 92]]);
    });
    (panelFace.material as THREE.MeshLambertMaterial).map = panelMap;
    (panelFace.material as THREE.MeshLambertMaterial).color.set(0xffffff);

    // Console tops (box face index 2 is +Y).
    for (const [mesh, side] of [[consoleL, 'L'], [consoleR, 'R']] as [THREE.Mesh, 'L' | 'R'][]) {
      const sideMat = lam(0x2b2f33);
      const topMat = new THREE.MeshLambertMaterial({ map: consoleTex(side) });
      mesh.material = [sideMat, sideMat, topMat, sideMat, sideMat, sideMat];
    }
    pedestal.material = new THREE.MeshLambertMaterial({ map: canvasTex(256, 256, (g) => metal(g, 256, 256, '#2b2f33', [[4, 4, 248, 120], [4, 130, 248, 122]])) });

    // Knobs on the consoles, matching the painted panels (merged into one mesh).
    const knobGeos: THREE.BufferGeometry[] = [];
    for (const side of [-1, 1]) {
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 3; j++) {
          // Leave room for the clickable switch plates on the outboard edge.
          if ((side < 0 && j === 0 && (i === 1 || i === 2)) || (side > 0 && j === 2 && (i === 1 || i === 2))) continue;
          const kg = new THREE.CylinderGeometry(0.009, 0.011, 0.014, 10);
          const x = side * 0.36 + (-0.17 / 2 + ((48 + j * 80) / 256) * 0.17);
          const z = -0.12 - 0.95 / 2 + ((40 + i * 240 + 110) / 1024) * 0.95;
          kg.translate(x, -0.463, z);
          knobGeos.push(kg);
          const pointer = new THREE.BoxGeometry(0.002, 0.003, 0.009);
          pointer.translate(x, -0.455, z - 0.004);
          knobGeos.push(pointer);
        }
      }
    }
    const knobs = new THREE.Mesh(mergeGeometries(knobGeos), lam(0x15171a));
    root.add(knobs);

    // Option-select buttons around both MFDs (5 per edge).
    const btnGeos: THREE.BufferGeometry[] = [];
    for (const cx of [-0.235, 0.235]) {
      for (let i = 0; i < 5; i++) {
        const o = -0.06 + i * 0.03;
        for (const [x, y] of [[cx + o, -0.04 + 0.087], [cx + o, -0.04 - 0.087], [cx - 0.087, -0.04 + o], [cx + 0.087, -0.04 + o]]) {
          const bg = new THREE.BoxGeometry(0.013, 0.011, 0.008);
          bg.translate(x, y, 0.004);
          btnGeos.push(bg);
        }
      }
    }
    panel.add(new THREE.Mesh(mergeGeometries(btnGeos), lam(0x4a5056)));

    // Standby gauges either side of the UFC.
    this.adi = this.gauge(panel, -0.1, 0.09);
    this.alt = this.gauge(panel, 0.1, 0.09);

    // Glare shield lip and HUD control box under the combiner.
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.012, 0.03), lam(0x141618));
    lip.position.set(0, -0.137, -0.62);
    root.add(lip);
    const hudBox = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.045, 0.12), lam(0x202326));
    hudBox.position.set(0, -0.157, -0.66);
    root.add(hudBox);

    // Ejection handle between the knees: yellow and black striped loop.
    const stripe = canvasTex(256, 16, (g) => {
      for (let x = 0; x < 256; x += 32) {
        g.fillStyle = '#e8c21a';
        g.fillRect(x, 0, 16, 16);
        g.fillStyle = '#111';
        g.fillRect(x + 16, 0, 16, 16);
      }
    });
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.008, 6, 16, Math.PI), new THREE.MeshLambertMaterial({ map: stripe }));
    handle.position.set(0, -0.5, -0.4);
    handle.rotation.x = -0.4;
    root.add(handle);

    // Inner side walls between the consoles and the canopy rails.
    const wallMat = new THREE.MeshLambertMaterial({ map: wallTex() });
    for (const side of [-1, 1]) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.28), wallMat);
      wall.position.set(side * 0.445, -0.33, -0.15);
      wall.rotation.y = -side * Math.PI / 2;
      root.add(wall);
    }

    // Rear-view mirrors on the canopy frame ahead of you.
    const mirrorMat = new THREE.MeshBasicMaterial({ color: 0x8fa3b0 });
    const frameMat = lam(0x15171a);
    for (const [x, y, ry] of [[-0.3, 0.17, 0.5], [0, 0.26, 0], [0.3, 0.17, -0.5]]) {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.035, 0.012), frameMat);
      frame.position.set(x, y, -0.86);
      frame.rotation.y = ry;
      frame.rotation.x = 0.35;
      root.add(frame);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.027), mirrorMat);
      glass.position.set(0, 0, 0.0065);
      frame.add(glass);
    }
    // Canopy front arch the mirrors hang from.
    const arch = new THREE.Mesh(new THREE.TorusGeometry(0.44, 0.015, 6, 24, Math.PI), lam(0x1a1c1f));
    arch.position.set(0, -0.17, -0.88);
    arch.scale.set(1, 1.0, 1);
    root.add(arch);
  }

  private gauge(panel: THREE.Object3D, x: number, y: number) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const ctx = cv.getContext('2d')!;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.03, 24), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    face.position.set(x, y, 0.006);
    panel.add(face);
    const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.004, 6, 24), new THREE.MeshLambertMaterial({ color: 0x15171a }));
    bezel.position.set(x, y, 0.007);
    panel.add(bezel);
    return { ctx, tex };
  }

  /** Redraw the standby gauges (they work on battery, like the real thing). */
  update(dt: number, s: AircraftState) {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 1 / 15;
    const e = new THREE.Euler().setFromQuaternion(s.quat, 'YXZ');
    const attitude = { pitch: (e.x * 180) / Math.PI, bank: (-e.z * 180) / Math.PI };
    const powered = s.batteryPower || s.generator;

    // Standby attitude: sky/ground ball.
    let g = this.adi.ctx;
    g.save();
    g.clearRect(0, 0, 128, 128);
    g.beginPath();
    g.arc(64, 64, 63, 0, Math.PI * 2);
    g.clip();
    g.translate(64, 64);
    g.rotate((-attitude.bank * Math.PI) / 180);
    const off = Math.max(-60, Math.min(60, attitude.pitch * 1.6));
    g.fillStyle = powered ? '#3d7bc4' : '#20344d';
    g.fillRect(-100, -200 + off, 200, 200);
    g.fillStyle = powered ? '#7a5130' : '#3a2a1c';
    g.fillRect(-100, off, 200, 200);
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(-100, off);
    g.lineTo(100, off);
    for (const p of [-20, -10, 10, 20]) {
      const yy = off - p * 1.6;
      g.moveTo(-12, yy);
      g.lineTo(12, yy);
    }
    g.stroke();
    g.restore();
    // Fixed aircraft symbol.
    g.strokeStyle = '#ffbf3c';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(30, 64);
    g.lineTo(54, 64);
    g.lineTo(64, 72);
    g.lineTo(74, 64);
    g.lineTo(98, 64);
    g.stroke();
    if (!powered) {
      g.fillStyle = '#d33';
      g.fillRect(84, 14, 30, 14);
    }
    this.adi.tex.needsUpdate = true;

    // Standby altimeter: needle for hundreds, drum for thousands.
    g = this.alt.ctx;
    g.fillStyle = '#0d0f10';
    g.beginPath();
    g.arc(64, 64, 63, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#e6e6e6';
    g.fillStyle = '#e6e6e6';
    g.lineWidth = 2;
    g.font = 'bold 15px sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      g.beginPath();
      g.moveTo(64 + Math.cos(a) * 52, 64 + Math.sin(a) * 52);
      g.lineTo(64 + Math.cos(a) * 60, 64 + Math.sin(a) * 60);
      g.stroke();
      g.fillText(String(i), 64 + Math.cos(a) * 42, 64 + Math.sin(a) * 42);
    }
    const ft = s.pos.y * 3.281;
    g.fillStyle = '#000';
    g.fillRect(40, 72, 48, 18);
    g.fillStyle = '#e6e6e6';
    g.font = 'bold 14px monospace';
    g.fillText(String(Math.floor(ft / 1000)).padStart(2, '0'), 64, 82);
    const a = ((ft % 1000) / 1000) * Math.PI * 2 - Math.PI / 2;
    g.strokeStyle = '#fff';
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(64, 64);
    g.lineTo(64 + Math.cos(a) * 50, 64 + Math.sin(a) * 50);
    g.stroke();
    this.alt.tex.needsUpdate = true;
  }
}

/** A throttle grip with a few buttons and a side stick with a trigger and hat. */
export function buildThrottle(lam: (c: number) => THREE.MeshLambertMaterial) {
  const g = new THREE.Group();
  const body = lam(0x34393e);
  const dark = lam(0x15171a);
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.05, 0.06), body);
  base.position.y = -0.03;
  g.add(base);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.06, 0.08), body);
  grip.position.set(0.006, 0.02, 0);
  grip.rotation.z = -0.15;
  g.add(grip);
  for (const [x, y, z] of [[0.03, 0.035, -0.02], [0.03, 0.02, 0.01], [0.0, 0.052, -0.02], [-0.018, 0.045, 0.02]]) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.008, 8), dark);
    b.position.set(x, y, z);
    if (Math.abs(x) > 0.02) b.rotation.z = Math.PI / 2;
    g.add(b);
  }
  return g;
}

export function buildStick(lam: (c: number) => THREE.MeshLambertMaterial) {
  const g = new THREE.Group();
  const body = lam(0x34393e);
  const dark = lam(0x15171a);
  const boot = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.03, 10), dark);
  boot.position.y = 0.0;
  g.add(boot);
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.1, 10), body);
  grip.position.y = 0.065;
  grip.rotation.x = -0.25;
  g.add(grip);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.045), body);
  head.position.set(0, 0.12, -0.012);
  head.rotation.x = -0.25;
  g.add(head);
  const hat = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.01, 8), dark);
  hat.position.set(0, 0.138, -0.015);
  g.add(hat);
  const trigger = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.025, 0.008), dark);
  trigger.position.set(0, 0.095, -0.03);
  g.add(trigger);
  return g;
}
