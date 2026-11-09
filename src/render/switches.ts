import * as THREE from 'three';
import { AircraftState, ControlInput } from '../sim/aircraft';

// Clickable cockpit switches. Each switch is a labelled plate with a toggle
// lever. The mouse clicks them directly; on the controller you enter switch
// mode and press A on the one under the centre reticle.

export interface SwitchDef {
  id: string;
  label: string;
  onText: string;
  offText: string;
  /** Position and orientation of the plate, in cockpit coordinates (eye at origin). */
  parent: 'root' | 'panel';
  pos: [number, number, number];
  flat?: boolean; // lies on a console facing up, otherwise faces the pilot
  get: (c: ControlInput, s: AircraftState) => boolean;
  toggle: (c: ControlInput, s: AircraftState) => void;
  /** Amber state text when "on" is the abnormal position (e.g. parking brake set). */
  onIsCaution?: boolean;
}

export const SWITCHES: SwitchDef[] = [
  { id: 'battery', label: 'BATTERY', onText: 'ON', offText: 'OFF', parent: 'root', pos: [-0.405, -0.468, -0.32], flat: true,
    get: (c) => c.switches.battery, toggle: (c) => (c.switches.battery = !c.switches.battery) },
  { id: 'fuelMaster', label: 'FUEL MASTER', onText: 'ON', offText: 'OFF', parent: 'root', pos: [-0.405, -0.468, -0.22], flat: true,
    get: (c) => c.switches.fuelMaster, toggle: (c) => (c.switches.fuelMaster = !c.switches.fuelMaster) },
  { id: 'jfs', label: 'JFS', onText: 'START', offText: 'OFF', parent: 'root', pos: [-0.405, -0.468, -0.12], flat: true,
    get: (c, s) => c.switches.jfs || s.jfsRunning, toggle: (c) => (c.switches.jfs = !c.switches.jfs) },
  { id: 'engine', label: 'ENGINE', onText: 'RUN', offText: 'CUTOFF', parent: 'root', pos: [-0.405, -0.468, -0.02], flat: true,
    get: (c) => c.switches.engine, toggle: (c) => (c.switches.engine = !c.switches.engine) },
  { id: 'avionics', label: 'AVIONICS', onText: 'ON', offText: 'OFF', parent: 'root', pos: [0.41, -0.468, -0.06], flat: true,
    get: (c) => c.switches.avionics, toggle: (c) => (c.switches.avionics = !c.switches.avionics) },
  { id: 'navLights', label: 'NAV LIGHTS', onText: 'ON', offText: 'OFF', parent: 'root', pos: [0.41, -0.468, 0.04], flat: true,
    get: (c) => c.switches.navLights, toggle: (c) => (c.switches.navLights = !c.switches.navLights) },
  { id: 'canopy', label: 'CANOPY', onText: 'CLOSE', offText: 'OPEN', parent: 'panel', pos: [-0.372, 0.1, 0.006],
    get: (c) => c.switches.canopyClosed, toggle: (c) => (c.switches.canopyClosed = !c.switches.canopyClosed) },
  { id: 'gear', label: 'GEAR', onText: 'DOWN', offText: 'UP', parent: 'panel', pos: [-0.372, -0.07, 0.006],
    get: (c) => c.gearDown, toggle: (c) => (c.gearDown = !c.gearDown) },
  { id: 'parkingBrake', label: 'PARK BRAKE', onText: 'SET', offText: 'OFF', parent: 'panel', pos: [0.372, -0.07, 0.006], onIsCaution: true,
    get: (c) => c.switches.parkingBrake, toggle: (c) => (c.switches.parkingBrake = !c.switches.parkingBrake) },
];

const PLATE_W = 0.068;
const PLATE_H = 0.044;

interface SwitchVisual {
  def: SwitchDef;
  plate: THREE.Mesh;
  lever: THREE.Object3D;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
  lastKey: string;
}

export class SwitchPanel {
  private visuals: SwitchVisual[] = [];
  private raycaster = new THREE.Raycaster();
  hovered: SwitchDef | null = null;

  constructor(root: THREE.Object3D, panel: THREE.Object3D) {
    this.raycaster.near = 0.01;
    this.raycaster.far = 1.5;
    for (const def of SWITCHES) {
      const holder = new THREE.Group();
      holder.position.set(...def.pos);
      if (def.flat) holder.rotation.x = -Math.PI / 2;
      (def.parent === 'root' ? root : panel).add(holder);

      const cv = document.createElement('canvas');
      cv.width = 136;
      cv.height = 88;
      const ctx = cv.getContext('2d')!;
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(PLATE_W, PLATE_H), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
      plate.userData.switchId = def.id;
      holder.add(plate);

      // Lever on the right side of the plate; tips toward the "on" end.
      const pivot = new THREE.Group();
      pivot.position.set(PLATE_W * 0.32, -PLATE_H * 0.05, 0.002);
      const lever = new THREE.Mesh(new THREE.BoxGeometry(0.007, 0.007, 0.026), new THREE.MeshLambertMaterial({ color: 0xd8dde0 }));
      lever.position.z = 0.013;
      lever.userData.switchId = def.id;
      pivot.add(lever);
      holder.add(pivot);
      this.visuals.push({ def, plate, lever: pivot, ctx, tex, lastKey: '' });
    }
  }

  private hitTargets() {
    return this.visuals.flatMap((v) => [v.plate, v.lever.children[0]]);
  }

  /** Switch under a normalized device coordinate (0,0 = screen centre). */
  pick(camera: THREE.Camera, ndcX: number, ndcY: number): SwitchDef | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
    const hit = this.raycaster.intersectObjects(this.hitTargets(), false)[0];
    if (!hit) return null;
    return SWITCHES.find((d) => d.id === hit.object.userData.switchId) ?? null;
  }

  update(c: ControlInput, s: AircraftState) {
    for (const v of this.visuals) {
      const on = v.def.get(c, s);
      const hov = this.hovered === v.def;
      v.lever.rotation.x = on ? -0.55 : 0.55;
      const key = `${on}|${hov}`;
      if (key === v.lastKey) continue;
      v.lastKey = key;
      const g = v.ctx;
      g.fillStyle = '#23272a';
      g.fillRect(0, 0, 136, 88);
      g.strokeStyle = hov ? '#ffd23c' : '#4a5258';
      g.lineWidth = hov ? 8 : 3;
      g.strokeRect(2, 2, 132, 84);
      g.fillStyle = '#e8ecee';
      g.font = 'bold 16px Menlo, monospace';
      g.textAlign = 'left';
      g.fillText(v.def.label, 9, 32);
      g.font = 'bold 22px Menlo, monospace';
      const caution = v.def.onIsCaution ? on : false;
      g.fillStyle = caution ? '#ffbf3c' : on ? '#7dff9e' : '#9aa3a8';
      g.fillText(on ? v.def.onText : v.def.offText, 9, 70);
      v.tex.needsUpdate = true;
    }
  }
}
