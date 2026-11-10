import * as THREE from 'three';
import { Threats, ThreatEvent } from '../sim/threats';

// Enemy missiles with smoke trails, flak bursts and AAA tracers, plus the
// jet's own chaff and flares. Smoke, fire and sparks share one cheap point
// particle system (two draw calls: normal and additive).

const MAX_PARTICLES = 6000;

const vertexShader = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float size;
  attribute float alpha;
  attribute vec3 tint;
  uniform float scale;
  uniform float minSize;
  varying float vAlpha;
  varying vec3 vTint;
  void main(){
    vAlpha = alpha;
    vTint = tint;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(size * scale / max(-mv.z, 0.1), minSize, 256.0);
    #include <logdepthbuf_vertex>
  }`;
const fragmentShader = `
  #include <logdepthbuf_pars_fragment>
  varying float vAlpha;
  varying vec3 vTint;
  void main(){
    #include <logdepthbuf_fragment>
    vec2 d = gl_PointCoord - 0.5;
    float r = dot(d, d) * 4.0;
    if (r > 1.0) discard;
    gl_FragColor = vec4(vTint, vAlpha * (1.0 - r * r));
    #include <colorspace_fragment>
  }`;

interface Particle {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  life: number;
  size0: number;
  size1: number;
  alpha0: number;
  color: THREE.Color;
}

class ParticleSystem {
  readonly points: THREE.Points;
  private list: Particle[] = [];
  private pos = new Float32Array(MAX_PARTICLES * 3);
  private size = new Float32Array(MAX_PARTICLES);
  private alpha = new Float32Array(MAX_PARTICLES);
  private tint = new Float32Array(MAX_PARTICLES * 3);
  readonly material: THREE.ShaderMaterial;

  constructor(additive: boolean) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setAttribute('tint', new THREE.BufferAttribute(this.tint, 3));
    this.material = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 600 }, minSize: { value: additive ? 3 : 0 } },
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: false,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
  }

  add(pos: THREE.Vector3, vel: THREE.Vector3, life: number, size0: number, size1: number, alpha0: number, color: number) {
    if (this.list.length >= MAX_PARTICLES) this.list.shift();
    this.list.push({ pos: pos.clone(), vel: vel.clone(), age: 0, life, size0, size1, alpha0, color: new THREE.Color(color) });
  }

  clear() {
    this.list = [];
  }

  update(dt: number) {
    let n = 0;
    const keep: Particle[] = [];
    for (const p of this.list) {
      p.age += dt;
      if (p.age >= p.life) continue;
      keep.push(p);
      p.vel.multiplyScalar(Math.max(0, 1 - dt * 0.6));
      p.pos.addScaledVector(p.vel, dt);
      const t = p.age / p.life;
      this.pos[n * 3] = p.pos.x;
      this.pos[n * 3 + 1] = p.pos.y;
      this.pos[n * 3 + 2] = p.pos.z;
      this.size[n] = p.size0 + (p.size1 - p.size0) * Math.sqrt(t);
      this.alpha[n] = p.alpha0 * (1 - t);
      this.tint[n * 3] = p.color.r;
      this.tint[n * 3 + 1] = p.color.g;
      this.tint[n * 3 + 2] = p.color.b;
      n++;
    }
    this.list = keep;
    const g = this.points.geometry;
    for (const k of ['position', 'size', 'alpha', 'tint']) g.attributes[k].needsUpdate = true;
    g.setDrawRange(0, n);
  }
}

export class ThreatsView {
  readonly group = new THREE.Group();
  private smoke = new ParticleSystem(false);
  private glow = new ParticleSystem(true);
  private missileMeshes: THREE.Mesh[] = [];
  private tracers: THREE.LineSegments;
  private tracerPos = new Float32Array(1200 * 6);
  private trailTimer = 0;

  constructor() {
    this.group.add(this.smoke.points, this.glow.points);
    const geo = new THREE.CylinderGeometry(0.18, 0.22, 4.2, 8);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({ color: 0xe8e4da });
    for (let i = 0; i < 12; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      this.group.add(m);
      this.missileMeshes.push(m);
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.tracerPos, 3));
    this.tracers = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: 0xff8a4a }));
    this.tracers.frustumCulled = false;
    this.group.add(this.tracers);
  }

  reset() {
    this.smoke.clear();
    this.glow.clear();
  }

  /** Points are sized in metres; scale converts to pixels for the current camera. */
  setViewport(heightPx: number, fovDeg: number) {
    const s = heightPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
    this.smoke.material.uniforms.scale.value = s;
    this.glow.material.uniforms.scale.value = s;
  }

  onEvents(events: ThreatEvent[]) {
    const v0 = new THREE.Vector3();
    for (const e of events) {
      if (e.type === 'missileLaunch') {
        // Launch cloud of dust and smoke.
        for (let i = 0; i < 14; i++) {
          this.smoke.add(e.pos.clone().add(rv(6)), rv(6).setY(Math.random() * 4), 6 + Math.random() * 4, 6, 26, 0.6, 0xcabca0);
        }
        this.glow.add(e.pos, v0, 0.4, 10, 18, 1, 0xffc070);
      } else if (e.type === 'missileDetonate') {
        this.glow.add(e.pos, v0, 0.35, 20, 45, 1, 0xffd28a);
        for (let i = 0; i < 8; i++) this.glow.add(e.pos.clone().add(rv(4)), rv(30), 0.6, 4, 2, 1, 0xffa040);
        for (let i = 0; i < 6; i++) this.smoke.add(e.pos.clone().add(rv(5)), rv(3), 7, 10, 30, 0.75, 0x2a2622);
      } else if (e.type === 'flakBurst') {
        this.glow.add(e.pos, v0, 0.12, 6, 10, 1, 0xffc070);
        this.smoke.add(e.pos, rv(1), 4.5, 7, 16, 0.85, 0x1c1a18);
      }
    }
  }

  update(dt: number, th: Threats) {
    // Missiles and their smoke.
    this.trailTimer -= dt;
    const emit = this.trailTimer <= 0;
    if (emit) this.trailTimer = 0.03;
    const zero = new THREE.Vector3();
    this.missileMeshes.forEach((mesh, i) => {
      const m = th.missiles[i];
      mesh.visible = !!m;
      if (!m) return;
      mesh.position.copy(m.pos);
      mesh.lookAt(m.pos.clone().sub(m.vel));
      if (Threats.motorBurning(m)) {
        const tail = m.pos.clone().addScaledVector(m.vel.clone().normalize(), -2.6);
        this.glow.add(tail, zero, Math.max(0.12, dt * 1.6), 5, 3, 0.7, 0xfff0c0);
        if (emit) {
          const big = m.kind === 'radar';
          this.smoke.add(tail, rv(0.8), big ? 14 : 6, big ? 4 : 1.5, big ? 24 : 6, 0.65, 0xdcd8d0);
        }
      }
    });
    // Decoys: flares burn bright and leave a short smoke trail; chaff is a faint glittering cloud.
    for (const d of th.decoys) {
      if (d.kind === 'flare') {
        this.glow.add(d.pos, zero, Math.max(0.12, dt * 1.6), 6, 4, 0.8, 0xfff4d0);
        if (emit) this.smoke.add(d.pos, zero, 2.5, 1, 3, 0.45, 0xe6e2da);
      } else if (emit && d.age < 1.5) {
        this.smoke.add(d.pos.clone().add(rv(3)), zero, 2, 2.5, 6, 0.25, 0xc8ccd0);
      }
    }
    // AAA tracers: every second round is a tracer.
    let k = 0;
    th.shells.forEach((p, i) => {
      if (i % 2 !== 0 || k >= 1200) return;
      this.glow.add(p.pos, zero, Math.max(0.06, dt * 1.2), 1.6, 1.2, 0.9, 0xff9a50);
      const tail = p.pos.clone().addScaledVector(p.vel, -0.03);
      this.tracerPos.set([p.pos.x, p.pos.y, p.pos.z, tail.x, tail.y, tail.z], k * 6);
      k++;
    });
    this.tracers.geometry.attributes.position.needsUpdate = true;
    this.tracers.geometry.setDrawRange(0, k * 2);
    this.smoke.update(dt);
    this.glow.update(dt);

  }
}

function rv(s: number) {
  return new THREE.Vector3((Math.random() - 0.5) * 2 * s, (Math.random() - 0.5) * 2 * s, (Math.random() - 0.5) * 2 * s);
}
