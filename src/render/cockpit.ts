import * as THREE from 'three';
import { AircraftState, CONSTANTS } from '../sim/aircraft';
import { ControlInput } from '../sim/aircraft';
import { RUNWAY, TERRAIN_SIZE, Terrain, BASE_ELEV } from '../sim/terrain';
import { APRON, TAXIWAYS } from './world';
import { SwitchPanel } from './switches';
import { checklist } from '../checklist';

export type LeftPage = 'CHK' | 'ENG';
const LEFT_PAGES: LeftPage[] = ['CHK', 'ENG'];

// Original low-poly cockpit for the fictional KR-7 Kestrel.
// Units are meters, the pilot's eye is at the origin, -Z is forward.

const PANEL = 0x2b2f33;
const PANEL_DARK = 0x1c1f22;
const AIRFRAME = 0x6f767c;

export class Cockpit {
  readonly root = new THREE.Group(); // follows the aircraft
  readonly head = new THREE.Group(); // pilot head (look direction)
  readonly camera: THREE.PerspectiveCamera;
  readonly hudGlass: THREE.Mesh;
  private throttleGrip: THREE.Object3D;
  private stick: THREE.Object3D;
  private leftMfd: Mfd;
  private rightMfd: Mfd;
  private ufc: Mfd;
  private mfdTimer = 0;
  private mapImage: HTMLCanvasElement;
  private canopy = new THREE.Group();
  private navLights: { mesh: THREE.Mesh; on: number }[] = [];
  private strobe!: THREE.Mesh;
  readonly switches: SwitchPanel;
  leftPage: LeftPage = 'ENG';
  hasFlown = false;
  private powered = true;

  constructor(terrain: Terrain) {
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.03, 200000);
    this.head.add(this.camera);
    this.root.add(this.head);

    const lam = (c: number) => new THREE.MeshLambertMaterial({ color: c });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D = this.root) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };

    // Glare shield and its curved hood.
    add(new THREE.BoxGeometry(0.6, 0.03, 0.2), lam(PANEL_DARK), 0, -0.15, -0.72);
    // Main instrument panel, tilted back toward the pilot.
    const panel = new THREE.Group();
    panel.position.set(0, -0.36, -0.7);
    panel.rotation.x = -0.28;
    this.root.add(panel);
    add(new THREE.BoxGeometry(0.82, 0.38, 0.04), lam(PANEL), 0, 0, -0.02, panel);
    this.leftMfd = new Mfd(0.155);
    this.leftMfd.mesh.position.set(-0.235, -0.04, 0.005);
    panel.add(this.leftMfd.mesh);
    this.rightMfd = new Mfd(0.155);
    this.rightMfd.mesh.position.set(0.235, -0.04, 0.005);
    panel.add(this.rightMfd.mesh);
    this.ufc = new Mfd(0.12, 0.08, 256, 170);
    this.ufc.mesh.position.set(0, 0.09, 0.005);
    panel.add(this.ufc.mesh);
    // Bezels around the displays.
    for (const x of [-0.235, 0.235]) add(new THREE.BoxGeometry(0.19, 0.19, 0.012), lam(PANEL_DARK), x, -0.04, -0.004, panel);
    // Center pedestal down between the knees.
    add(new THREE.BoxGeometry(0.2, 0.25, 0.3), lam(PANEL), 0, -0.62, -0.55);

    // Side consoles.
    add(new THREE.BoxGeometry(0.17, 0.1, 0.95), lam(PANEL), -0.36, -0.52, -0.12);
    add(new THREE.BoxGeometry(0.17, 0.1, 0.95), lam(PANEL), 0.36, -0.52, -0.12);

    // Throttle on the left console, side stick on the right.
    this.throttleGrip = add(new THREE.BoxGeometry(0.05, 0.1, 0.07), lam(0x3c4146), -0.3, -0.42, -0.1);
    const stickPivot = new THREE.Group();
    stickPivot.position.set(0.33, -0.47, -0.25);
    this.root.add(stickPivot);
    const grip = add(new THREE.CylinderGeometry(0.018, 0.022, 0.12, 8), lam(0x3c4146), 0, 0.06, 0, stickPivot);
    grip.rotation.x = -0.25;
    this.stick = stickPivot;

    // HUD: frame posts and the combiner glass.
    const glassGeo = new THREE.PlaneGeometry(0.17, 0.19);
    this.hudGlass = new THREE.Mesh(glassGeo, new THREE.MeshBasicMaterial({
      color: 0x9fd8c0, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide,
    }));
    this.hudGlass.position.set(0, -0.03, -0.6);
    this.root.add(this.hudGlass);
    for (const x of [-0.09, 0.09]) add(new THREE.BoxGeometry(0.01, 0.2, 0.015), lam(PANEL_DARK), x, -0.035, -0.6);

    // Canopy rails and the bow behind the seat.
    add(new THREE.BoxGeometry(0.05, 0.05, 1.9), lam(PANEL_DARK), -0.44, -0.17, -0.1);
    add(new THREE.BoxGeometry(0.05, 0.05, 1.9), lam(PANEL_DARK), 0.44, -0.17, -0.1);
    // Canopy: a bubble hinged at the back that lifts at the front.
    this.canopy.position.set(0, -0.17, 0.75);
    this.root.add(this.canopy);
    const bow = add(new THREE.TorusGeometry(0.46, 0.022, 6, 24, Math.PI), lam(PANEL_DARK), 0, 0, -0.13, this.canopy);
    bow.scale.set(0.95, 1.05, 1);
    const bubbleGeo = new THREE.SphereGeometry(1, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    const bubble = new THREE.Mesh(bubbleGeo, new THREE.MeshBasicMaterial({
      color: 0xc9dbe6, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide,
    }));
    bubble.scale.set(0.47, 0.52, 1.25);
    bubble.position.set(0, 0, -1.0);
    this.canopy.add(bubble);
    // Canopy sill frames that travel with the glass.
    for (const x of [-0.45, 0.45]) add(new THREE.BoxGeometry(0.025, 0.03, 2.2), lam(PANEL_DARK), x, 0.01, -1.0, this.canopy);
    // Seat headrest.
    add(new THREE.BoxGeometry(0.3, 0.32, 0.1), lam(0x3a3430), 0, -0.08, 0.22);

    // Airframe visible from the seat: fuselage sides, spine, wings and tail.
    const air = lam(AIRFRAME);
    add(new THREE.BoxGeometry(0.3, 0.12, 3.2), air, -0.66, -0.5, -0.2);
    add(new THREE.BoxGeometry(0.3, 0.12, 3.2), air, 0.66, -0.5, -0.2);
    add(new THREE.BoxGeometry(1.0, 0.35, 5.5), air, 0, -0.42, 3.3);
    const nose = add(new THREE.ConeGeometry(0.55, 3.2, 12), air, 0, -0.75, -3.4);
    nose.rotation.x = -Math.PI / 2;
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, 0);
    wingShape.lineTo(4.6, 2.6);
    wingShape.lineTo(4.6, 3.6);
    wingShape.lineTo(0, 4.6);
    const wingGeo = new THREE.ShapeGeometry(wingShape);
    wingGeo.rotateX(Math.PI / 2);
    const wingMat = new THREE.MeshLambertMaterial({ color: AIRFRAME, side: THREE.DoubleSide });
    add(wingGeo, wingMat, 0.55, -0.85, 1.3);
    const wingL = add(wingGeo, wingMat, -0.55, -0.85, 1.3);
    wingL.scale.x = -1;
    const finShape = new THREE.Shape();
    finShape.moveTo(0, 0);
    finShape.lineTo(2.6, 0);
    finShape.lineTo(2.9, 2.2);
    finShape.lineTo(2.0, 2.2);
    const fin = add(new THREE.ShapeGeometry(finShape), wingMat, 0, -0.25, 5.2);
    fin.rotation.y = -Math.PI / 2;

    // Position lights: red left wingtip, green right, white strobe on the fin.
    const lightGeo = new THREE.SphereGeometry(0.06, 8, 6);
    for (const [x, color] of [[-5.15, 0xff2a2a], [5.15, 0x2aff5a]] as [number, number][]) {
      const m = add(lightGeo, new THREE.MeshBasicMaterial({ color: 0x222222 }), x, -0.85, 4.4);
      this.navLights.push({ mesh: m, on: color });
    }
    this.strobe = add(lightGeo, new THREE.MeshBasicMaterial({ color: 0x222222 }), 0, 1.95, 7.6);

    this.switches = new SwitchPanel(this.root, panel);

    this.mapImage = buildMapImage(terrain);
  }

  update(dt: number, s: AircraftState, input: ControlInput, look: { yaw: number; pitch: number; fov: number }) {
    this.root.position.copy(s.pos);
    this.root.quaternion.copy(s.quat);
    this.head.rotation.set(look.pitch, look.yaw, 0, 'YXZ');
    // Lean slightly to the side when looking behind, like a real pilot would.
    this.head.position.set(Math.sin(look.yaw) * -0.08, 0, Math.max(0, Math.abs(look.yaw) - 1.2) * -0.05);
    if (this.camera.fov !== look.fov) {
      this.camera.fov = look.fov;
      this.camera.updateProjectionMatrix();
    }
    this.throttleGrip.position.z = -0.02 - input.throttle * 0.2;
    this.canopy.visible = !s.canopyBroken;
    this.canopy.rotation.x = 0.5 * (1 - s.canopyPos);
    const lightsOn = input.switches.navLights && (s.batteryPower || s.generator);
    for (const l of this.navLights) (l.mesh.material as THREE.MeshBasicMaterial).color.setHex(lightsOn ? l.on : 0x222222);
    const flash = lightsOn && (s.time % 1.2) < 0.08;
    (this.strobe.material as THREE.MeshBasicMaterial).color.setHex(flash ? 0xffffff : 0x222222);
    this.switches.update(input, s);
    this.stick.rotation.set(input.pitch * 0.25, 0, -input.roll * 0.25);

    this.mfdTimer -= dt;
    if (this.mfdTimer <= 0) {
      this.mfdTimer = 0.1;
      if (s.avionicsPower) {
        if (this.leftPage === 'ENG') drawEnginePage(this.leftMfd, s, input);
        else drawChecklistPage(this.leftMfd, s, input, this.hasFlown);
        drawNavPage(this.rightMfd, s, this.mapImage);
        this.powered = true;
      } else if (this.powered) {
        for (const m of [this.leftMfd, this.rightMfd]) {
          m.ctx.fillStyle = '#020303';
          m.ctx.fillRect(0, 0, 256, 256);
          m.tex.needsUpdate = true;
        }
        this.powered = false;
      }
      drawUfc(this.ufc, s, input);
    }
  }

  cycleLeftPage(dir: number) {
    const i = LEFT_PAGES.indexOf(this.leftPage);
    this.leftPage = LEFT_PAGES[(i + dir + LEFT_PAGES.length) % LEFT_PAGES.length];
    this.mfdTimer = 0;
  }

  /** HUD combiner corners in world space, for clipping the HUD overlay. */
  hudCorners(): THREE.Vector3[] {
    const w = 0.085, h = 0.095;
    return [[-w, h], [w, h], [w, -h], [-w, -h]].map(([x, y]) =>
      this.hudGlass.localToWorld(new THREE.Vector3(x, y, 0)));
  }
}

class Mfd {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly tex: THREE.CanvasTexture;
  readonly mesh: THREE.Mesh;
  constructor(w: number, h = w, pw = 256, ph = 256) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pw;
    this.canvas.height = ph;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false }));
  }
}

const GREEN = '#7dff9e';
const AMBER = '#ffbf3c';
const RED = '#ff4a3c';
const WHITE = '#e6ecef';

function frame(m: Mfd, title: string, buttons: string[], active = '') {
  const g = m.ctx;
  g.fillStyle = '#05090a';
  g.fillRect(0, 0, 256, 256);
  g.font = 'bold 13px monospace';
  g.textAlign = 'center';
  buttons.forEach((b, i) => {
    if (b === active) {
      g.fillStyle = WHITE;
      g.fillRect(32 + i * 48 - 18, 4, 36, 16);
      g.fillStyle = '#05090a';
    } else g.fillStyle = WHITE;
    g.fillText(b, 32 + i * 48, 16);
  });
  g.fillStyle = GREEN;
  g.fillText(title, 128, 248);
}

function drawEnginePage(m: Mfd, s: AircraftState, input: ControlInput) {
  frame(m, 'ENG / FUEL   ◀ ▶ PAGE', ['CHK', 'ENG'], 'ENG');
  const g = m.ctx;
  g.textAlign = 'left';
  g.font = 'bold 15px monospace';
  // RPM arc gauge.
  const cx = 64, cy = 84, r = 38;
  g.strokeStyle = '#2f4a3a';
  g.lineWidth = 6;
  g.beginPath();
  g.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25);
  g.stroke();
  g.strokeStyle = s.afterburner > 0.05 ? AMBER : GREEN;
  g.beginPath();
  g.arc(cx, cy, r, Math.PI * 0.75, Math.PI * (0.75 + 1.5 * Math.min(1, s.rpm / 1.05)));
  g.stroke();
  g.fillStyle = WHITE;
  g.textAlign = 'center';
  g.fillText(`${Math.round(s.rpm * 100)}%`, cx, cy + 5);
  g.font = '11px monospace';
  g.fillText('RPM', cx, cy + 20);
  g.fillText(s.engineRunning ? (s.afterburner > 0.05 ? 'AFTERBURNER' : 'RUN') : 'OFF', cx, cy + 54);

  // Throttle bar with afterburner detent.
  const bx = 132, by = 40, bh = 100;
  g.strokeStyle = WHITE;
  g.lineWidth = 1;
  g.strokeRect(bx, by, 14, bh);
  const det = by + bh * (1 - CONSTANTS.AB_DETENT);
  g.strokeStyle = AMBER;
  g.beginPath();
  g.moveTo(bx - 4, det);
  g.lineTo(bx + 18, det);
  g.stroke();
  const ty = by + bh * (1 - input.throttle);
  g.fillStyle = input.throttle > CONSTANTS.AB_DETENT ? AMBER : GREEN;
  g.fillRect(bx + 1, ty, 12, by + bh - ty);
  g.fillStyle = WHITE;
  g.fillText('THR', bx + 7, by + bh + 14);

  // Fuel.
  g.textAlign = 'left';
  g.font = 'bold 14px monospace';
  const lbs = s.fuel * 2.2046;
  g.fillStyle = lbs < 1500 ? (lbs < 800 ? RED : AMBER) : GREEN;
  g.fillText(`FUEL ${Math.round(lbs).toString().padStart(5)}`, 164, 56);
  g.fillStyle = WHITE;
  g.font = '12px monospace';
  g.fillText(`FF ${Math.round(s.fuelFlow * 2.2046 * 3600).toString().padStart(6)}`, 164, 76);
  g.fillText('LB/HR', 196, 90);
  const mins = s.fuelFlow > 0 ? s.fuel / s.fuelFlow / 60 : 0;
  g.fillText(`END ${mins > 99 ? '99+' : mins.toFixed(0)} MIN`, 164, 110);

  // Gear, speedbrake.
  g.font = 'bold 13px monospace';
  const gearTxt = s.gearPos > 0.99 ? 'GEAR DN' : s.gearPos < 0.01 ? 'GEAR UP' : 'GEAR TRN';
  g.fillStyle = s.gearPos > 0.99 ? GREEN : s.gearPos < 0.01 ? WHITE : AMBER;
  g.fillText(gearTxt, 18, 170);
  g.fillStyle = s.speedbrakePos > 0.05 ? AMBER : WHITE;
  g.fillText(s.speedbrakePos > 0.05 ? 'SPDBRK OUT' : 'SPDBRK IN', 18, 190);
  g.fillStyle = input.brakes > 0 ? AMBER : WHITE;
  g.fillText(input.brakes > 0 ? 'WHL BRK ON' : '', 18, 210);

  // Damage gauge.
  g.fillStyle = WHITE;
  g.fillText('DMG', 150, 170);
  g.strokeStyle = WHITE;
  g.strokeRect(150, 178, 90, 14);
  const d = Math.min(100, s.damage);
  g.fillStyle = d > 66 ? RED : d > 33 ? AMBER : GREEN;
  g.fillRect(151, 179, 88 * (d / 100), 12);
  g.fillStyle = WHITE;
  g.fillText(`${Math.round(d)}%`, 196, 170);
  m.tex.needsUpdate = true;
}

function drawChecklistPage(m: Mfd, s: AircraftState, input: ControlInput, hasFlown: boolean) {
  const list = checklist(s, input, hasFlown);
  frame(m, 'CHECKLIST   ◀ ▶ PAGE', ['CHK', 'ENG'], 'CHK');
  const g = m.ctx;
  g.textAlign = 'left';
  g.font = 'bold 15px monospace';
  g.fillStyle = list.phase === 'taxi' || list.phase === 'complete' ? GREEN : AMBER;
  g.fillText(list.phase === 'complete' ? 'SHUTDOWN COMPLETE' : list.title, 14, 42);
  g.font = 'bold 12px monospace';
  const next = list.items.findIndex((i) => !i.done);
  list.items.forEach((item, i) => {
    const y = 66 + i * 19;
    if (i === next) {
      g.fillStyle = 'rgba(125,255,158,0.15)';
      g.fillRect(8, y - 13, 240, 18);
    }
    g.fillStyle = item.done ? GREEN : i === next ? WHITE : '#7d878c';
    g.fillText(item.done ? '✓' : i === next ? '▶' : '·', 14, y);
    g.fillText(item.text, 32, y);
  });
  // Live RPM readout helps time the start.
  g.fillStyle = WHITE;
  g.fillText(`RPM ${Math.round(s.rpm * 100)}%  ${s.jfsRunning ? 'JFS RUN' : ''}${s.starting ? ' LIGHT-OFF' : ''}`, 14, 236);
  m.tex.needsUpdate = true;
}

function buildMapImage(terrain: Terrain) {
  const cv = document.createElement('canvas');
  const N = 256;
  cv.width = cv.height = N;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(N, N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = -TERRAIN_SIZE / 2 + (i + 0.5) * (TERRAIN_SIZE / N);
      const z = -TERRAIN_SIZE / 2 + (j + 0.5) * (TERRAIN_SIZE / N);
      const h = terrain.heightAt(x, z) - BASE_ELEV;
      const t = Math.max(0, Math.min(1, h / 900));
      const k = (j * N + i) * 4;
      img.data[k] = 40 + t * 120;
      img.data[k + 1] = 34 + t * 90;
      img.data[k + 2] = 22 + t * 50;
      img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return cv;
}

function drawNavPage(m: Mfd, s: AircraftState, map: HTMLCanvasElement) {
  frame(m, 'NAV  NORTH UP  40 NM', ['NAV'], 'NAV');
  const g = m.ctx;
  const area = { x: 8, y: 24, w: 240, h: 212 };
  g.save();
  g.beginPath();
  g.rect(area.x, area.y, area.w, area.h);
  g.clip();
  // Show a 75 km window centred on the aircraft.
  const span = 75000;
  const scale = area.w / span;
  const cx = area.x + area.w / 2;
  const cy = area.y + area.h / 2;
  const mapPx = TERRAIN_SIZE * scale;
  g.drawImage(map, cx - (s.pos.x + TERRAIN_SIZE / 2) * scale, cy - (s.pos.z + TERRAIN_SIZE / 2) * scale, mapPx, mapPx);
  const toScreen = (x: number, z: number) => [cx + (x - s.pos.x) * scale, cy + (z - s.pos.z) * scale];
  // Runway and taxiways.
  g.strokeStyle = WHITE;
  g.lineWidth = 3;
  g.beginPath();
  let [x1, y1] = toScreen(RUNWAY.x, RUNWAY.zSouth);
  let [x2, y2] = toScreen(RUNWAY.x, RUNWAY.zNorth);
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
  g.lineWidth = 1;
  g.strokeStyle = '#9a9a9a';
  for (const [x, z] of [[TAXIWAYS[0][0], TAXIWAYS[0][1]], [APRON[0], APRON[1]]]) {
    [x1, y1] = toScreen(x, z);
    g.strokeRect(x1 - 1, y1 - 1, 2, 2);
  }
  g.fillStyle = WHITE;
  g.font = '11px monospace';
  [x1, y1] = toScreen(RUNWAY.x, 0);
  g.fillText('HOME', x1 + 8, y1);
  // Range rings.
  g.strokeStyle = 'rgba(125,255,158,0.35)';
  for (const nm of [10, 20]) {
    g.beginPath();
    g.arc(cx, cy, nm * 1852 * scale, 0, Math.PI * 2);
    g.stroke();
  }
  g.restore();
  // Own aircraft symbol.
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(s.quat);
  const hdg = Math.atan2(fwd.x, -fwd.z);
  g.save();
  g.translate(cx, cy);
  g.rotate(hdg);
  g.strokeStyle = GREEN;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, -9);
  g.lineTo(0, 9);
  g.moveTo(-7, -1);
  g.lineTo(7, -1);
  g.moveTo(-3, 7);
  g.lineTo(3, 7);
  g.stroke();
  g.restore();
  // Bearing/range to home.
  const dx = RUNWAY.x - s.pos.x, dz = 0 - s.pos.z;
  const brg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  g.fillStyle = GREEN;
  g.font = 'bold 12px monospace';
  g.textAlign = 'left';
  g.fillText(`HOME ${brg.toFixed(0).padStart(3, '0')}° ${(Math.hypot(dx, dz) / 1852).toFixed(1)}NM`, 12, 232);
  m.tex.needsUpdate = true;
}

function drawUfc(m: Mfd, s: AircraftState, input: ControlInput) {
  const g = m.ctx;
  g.fillStyle = '#0b0d0c';
  g.fillRect(0, 0, 256, 170);
  if (!s.batteryPower && !s.generator) {
    m.tex.needsUpdate = true;
    return;
  }
  g.font = 'bold 26px monospace';
  g.fillStyle = '#9dff6a';
  g.textAlign = 'left';
  const kts = s.vel.length() * 1.944;
  g.fillText(`GS ${Math.round(kts).toString().padStart(4)}`, 14, 40);
  g.fillText(`FUEL ${Math.round(s.fuel * 2.2046 / 100) / 10}K`, 14, 80);
  // Warning lights.
  const lights: [string, boolean, string][] = [
    ['ENG', !s.engineRunning, RED],
    ['GEN', !s.generator, AMBER],
    ['CNPY', s.canopyPos < 0.99, AMBER],
    ['BRK', input.brakes > 0 || s.parkingBrake, AMBER],
  ];
  g.font = 'bold 18px monospace';
  lights.forEach(([txt, on, col], i) => {
    const x = 10 + i * 61;
    g.fillStyle = on ? col : '#222';
    g.fillRect(x, 108, 56, 44);
    g.fillStyle = on ? '#000' : '#555';
    g.textAlign = 'center';
    g.fillText(txt, x + 28, 137);
  });
  m.tex.needsUpdate = true;
}
