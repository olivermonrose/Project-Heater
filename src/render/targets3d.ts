import * as THREE from 'three';
import { Combat, Target, TargetKind, CombatEvent } from '../sim/combat';
import { Terrain } from '../sim/terrain';

// Low-poly ground targets, explosions, smoke, bombs in flight and gun tracers.
// "Hot" materials glow white in the targeting pod's infrared view.

export class TargetsView {
  readonly group = new THREE.Group();
  /** Materials that show up bright in the IR pod view. */
  readonly hotMaterials: THREE.MeshLambertMaterial[] = [];
  private meshes = new Map<number, THREE.Object3D>();
  private wreckMat = new THREE.MeshLambertMaterial({ color: 0x1d1a17 });
  private bombMeshes: THREE.Mesh[] = [];
  private tracers: THREE.LineSegments;
  private tracerPos: Float32Array;
  private effects: { mesh: THREE.Mesh; age: number; life: number; kind: 'flash' | 'smoke' | 'puff'; vel: THREE.Vector3 }[] = [];
  private smokeSources: { pos: THREE.Vector3; timer: number; until: number }[] = [];
  private flashGeo = new THREE.SphereGeometry(1, 10, 8);
  private smokeGeo = new THREE.IcosahedronGeometry(1, 0);

  constructor(private terrain: Terrain) {
    const bombGeo = new THREE.CylinderGeometry(0.17, 0.17, 2.2, 8);
    bombGeo.rotateX(Math.PI / 2);
    const bombMat = new THREE.MeshLambertMaterial({ color: 0x5f6656 });
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(bombGeo, bombMat);
      m.visible = false;
      this.group.add(m);
      this.bombMeshes.push(m);
    }
    this.tracerPos = new Float32Array(200 * 6);
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.tracerPos, 3));
    this.tracers = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: 0xffd27a }));
    this.tracers.frustumCulled = false;
    this.group.add(this.tracers);
  }

  private hot(color: number) {
    const m = new THREE.MeshLambertMaterial({ color });
    this.hotMaterials.push(m);
    return m;
  }

  rebuild(combat: Combat) {
    for (const m of this.meshes.values()) this.group.remove(m);
    this.meshes.clear();
    for (const fx of this.effects) this.group.remove(fx.mesh);
    this.effects = [];
    this.smokeSources = [];
    for (const t of combat.targets) {
      const obj = this.buildMesh(t.kind);
      obj.position.copy(t.pos);
      obj.rotation.y = -t.heading;
      this.group.add(obj);
      this.meshes.set(t.id, obj);
    }
  }

  private buildMesh(kind: TargetKind): THREE.Object3D {
    const g = new THREE.Group();
    const box = (w: number, h: number, l: number, x: number, y: number, z: number, mat: THREE.Material) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, l), mat);
      m.position.set(x, y, z);
      g.add(m);
      return m;
    };
    const olive = this.hot(0x6b6a45);
    const sand = this.hot(0xa38f66);
    switch (kind) {
      case 'truck':
        box(2.4, 1.6, 2.2, 0, 1.3, -2.4, olive);
        box(2.5, 2.2, 5, 0, 1.6, 1.2, sand);
        break;
      case 'tank':
        box(3.4, 1.2, 7, 0, 0.9, 0, olive);
        box(2.4, 0.9, 3, 0, 1.9, 0.3, olive);
        box(0.25, 0.25, 4.5, 0, 2.0, -3.2, olive);
        break;
      case 'apc':
        box(3, 2, 6.5, 0, 1.3, 0, olive);
        break;
      case 'fuelTank': {
        const m = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 8, 16), this.hot(0xb8b2a2));
        m.position.y = 4;
        g.add(m);
        break;
      }
      case 'warehouse':
        box(24, 9, 40, 0, 4.5, 0, this.hot(0xb4a382));
        break;
      case 'samLauncher':
        box(3, 1.5, 7, 0, 1, 0, olive);
        box(2.2, 2.2, 5.5, 0, 3, 0.5, sand).rotation.x = 0.6;
        break;
      case 'samRadar': {
        box(3, 2, 6, 0, 1.2, 0, olive);
        const dish = box(5, 3.5, 0.3, 0, 4.5, 0, sand);
        dish.rotation.x = -0.3;
        break;
      }
    }
    return g;
  }

  onEvents(events: CombatEvent[]) {
    for (const e of events) {
      if (e.type === 'bombImpact') {
        this.spawn('flash', e.pos, 22, 0.9);
        for (let i = 0; i < 6; i++) this.spawn('smoke', e.pos.clone().add(new THREE.Vector3(rand(8), 4 + i * 3, rand(8))), 9, 7);
      } else if (e.type === 'bulletImpact') {
        this.spawn('puff', e.pos, 1.5, 0.6);
      } else if (e.type === 'targetDestroyed') {
        this.wreck(e.target);
        this.spawn('flash', e.target.pos, e.target.radius * 2.2, 0.8);
        this.smokeSources.push({ pos: e.target.pos.clone(), timer: 0, until: 120 });
      }
    }
  }

  private wreck(t: Target) {
    const obj = this.meshes.get(t.id);
    if (!obj) return;
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) o.material = this.wreckMat;
    });
    obj.scale.y = 0.55;
    obj.rotation.z = 0.12;
  }

  private spawn(kind: 'flash' | 'smoke' | 'puff', pos: THREE.Vector3, size: number, life: number) {
    const mat = kind === 'flash'
      ? new THREE.MeshBasicMaterial({ color: 0xffc46b, transparent: true, opacity: 1, depthWrite: false })
      : new THREE.MeshLambertMaterial({ color: kind === 'puff' ? 0xc9b48e : 0x3b3631, transparent: true, opacity: 0.8, depthWrite: false, flatShading: true });
    const mesh = new THREE.Mesh(kind === 'flash' ? this.flashGeo : this.smokeGeo, mat);
    mesh.position.copy(pos);
    mesh.scale.setScalar(size);
    this.group.add(mesh);
    const vel = kind === 'smoke' ? new THREE.Vector3(1.5 + rand(1), 3 + Math.random() * 2, rand(1)) : new THREE.Vector3(0, 1, 0);
    this.effects.push({ mesh, age: 0, life, kind, vel });
  }

  update(dt: number, combat: Combat) {
    // Bombs in flight.
    this.bombMeshes.forEach((m, i) => {
      const b = combat.bombs[i];
      m.visible = !!b;
      if (b) {
        m.position.copy(b.pos);
        m.lookAt(b.pos.clone().sub(b.vel));
      }
    });
    // Tracers: a short streak along each fifth round.
    let k = 0;
    combat.bullets.forEach((p, i) => {
      if (i % 5 !== 0 || k >= 200) return;
      const tail = p.pos.clone().addScaledVector(p.vel, -0.025);
      this.tracerPos.set([p.pos.x, p.pos.y, p.pos.z, tail.x, tail.y, tail.z], k * 6);
      k++;
    });
    this.tracerPos.fill(0, k * 6);
    this.tracers.geometry.attributes.position.needsUpdate = true;
    this.tracers.geometry.setDrawRange(0, k * 2);

    // Burning wrecks keep smoking.
    for (const src of this.smokeSources) {
      src.until -= dt;
      src.timer -= dt;
      if (src.timer <= 0 && src.until > 0) {
        src.timer = 0.7;
        this.spawn('smoke', src.pos.clone().add(new THREE.Vector3(rand(3), 3, rand(3))), 4 + Math.random() * 3, 9);
      }
    }
    // Effects grow and fade.
    for (const fx of this.effects) {
      fx.age += dt;
      const t = fx.age / fx.life;
      const mat = fx.mesh.material as THREE.MeshBasicMaterial;
      if (fx.kind === 'flash') {
        fx.mesh.scale.multiplyScalar(1 + dt * 1.5);
        mat.opacity = Math.max(0, 1 - t);
      } else {
        fx.mesh.position.addScaledVector(fx.vel, dt);
        fx.mesh.scale.multiplyScalar(1 + dt * (fx.kind === 'smoke' ? 0.25 : 1.2));
        mat.opacity = 0.75 * Math.max(0, 1 - t);
      }
    }
    for (const fx of this.effects.filter((f) => f.age >= f.life)) {
      this.group.remove(fx.mesh);
      (fx.mesh.material as THREE.Material).dispose();
    }
    this.effects = this.effects.filter((f) => f.age < f.life);
    void this.terrain;
  }

  /** Make targets glow (IR view) or look normal. */
  setInfrared(on: boolean) {
    for (const m of this.hotMaterials) m.emissive.setHex(on ? 0xd8d8d8 : 0x000000);
  }
}

function rand(s: number) {
  return (Math.random() - 0.5) * 2 * s;
}
