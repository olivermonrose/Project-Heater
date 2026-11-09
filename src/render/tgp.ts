import * as THREE from 'three';
import { AircraftState } from '../sim/aircraft';
import { Combat, SITES, TGP_FOVS } from '../sim/combat';
import { TargetsView } from './targets3d';

// Targeting pod view: the scene rendered from the pod into a texture, shown
// in black-and-white "white hot" infrared on the right MFD, with symbology on top.

const SIZE = 384;

// The main renderer uses a logarithmic depth buffer, so custom shaders must write log depth too.
const vertexShader = `
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv;
  void main(){
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }`;
const fragmentShader = `
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D view; uniform sampler2D overlay; uniform float power; uniform float time;
  varying vec2 vUv;
  float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233)) + time) * 43758.5453); }
  void main(){
    #include <logdepthbuf_fragment>
    vec3 c = texture2D(view, vUv).rgb;
    float l = dot(c, vec3(0.30, 0.55, 0.15));
    l = clamp((l - 0.18) * 1.5, 0.0, 1.0);
    l = l * 0.92 + hash(vUv * 400.0) * 0.06;
    vec4 o = texture2D(overlay, vUv);
    vec3 col = mix(vec3(l), o.rgb, o.a) * power;
    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }`;

export class TgpView {
  readonly material: THREE.ShaderMaterial;
  private rt: THREE.WebGLRenderTarget;
  private cam = new THREE.PerspectiveCamera(20, 1, 2, 90000);
  private overlay: HTMLCanvasElement;
  private octx: CanvasRenderingContext2D;
  private overlayTex: THREE.CanvasTexture;
  private timer = 0;
  private pipScene = new THREE.Scene();
  private pipCam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
  /** Whether the pod has control (sensor of interest) — draws a thick border. */
  soi = false;

  constructor() {
    this.rt = new THREE.WebGLRenderTarget(SIZE, SIZE, { colorSpace: THREE.SRGBColorSpace });
    this.overlay = document.createElement('canvas');
    this.overlay.width = this.overlay.height = SIZE;
    this.octx = this.overlay.getContext('2d')!;
    this.overlayTex = new THREE.CanvasTexture(this.overlay);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        view: { value: this.rt.texture },
        overlay: { value: this.overlayTex },
        power: { value: 1 },
        time: { value: 0 },
      },
      vertexShader,
      fragmentShader,
      toneMapped: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.pipScene.add(quad);
  }

  /** Render the pod's camera view (throttled to ~25 Hz). */
  render(dt: number, renderer: THREE.WebGLRenderer, scene: THREE.Scene, s: AircraftState, combat: Combat,
    hide: THREE.Object3D[], targets: TargetsView, powered: boolean) {
    this.material.uniforms.time.value = (this.material.uniforms.time.value + dt) % 100;
    this.material.uniforms.power.value = powered ? 1 : 0;
    this.timer -= dt;
    if (this.timer > 0 || !powered) {
      if (!powered) this.drawOverlay(s, combat, false);
      return;
    }
    this.timer = 1 / 25;
    const tgp = combat.tgp;
    this.cam.position.copy(combat.podPosition(s));
    this.cam.up.set(0, 1, 0);
    this.cam.lookAt(tgp.point);
    this.cam.fov = TGP_FOVS[tgp.zoom];
    this.cam.updateProjectionMatrix();

    const fog = scene.fog;
    const bg = scene.background;
    scene.fog = null;
    scene.background = new THREE.Color(0x3a3a3a);
    const vis = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    targets.setInfrared(true);
    renderer.setRenderTarget(this.rt);
    renderer.render(scene, this.cam);
    renderer.setRenderTarget(null);
    targets.setInfrared(false);
    hide.forEach((o, i) => (o.visible = vis[i]));
    scene.fog = fog;
    scene.background = bg;
    this.drawOverlay(s, combat, true);
  }

  private drawOverlay(s: AircraftState, combat: Combat, powered: boolean) {
    const g = this.octx;
    const W = SIZE;
    g.clearRect(0, 0, W, W);
    if (!powered) {
      this.overlayTex.needsUpdate = true;
      return;
    }
    const tgp = combat.tgp;
    const c = W / 2;
    g.strokeStyle = '#ffffff';
    g.fillStyle = '#ffffff';
    g.lineWidth = 2;
    g.shadowColor = '#000';
    g.shadowBlur = 3;
    // Crosshair with a gap; a box when point-tracking.
    g.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      g.moveTo(c + dx * 14, c + dy * 14);
      g.lineTo(c + dx * 120, c + dy * 120);
    }
    g.stroke();
    if (tgp.tracking) g.strokeRect(c - 12, c - 12, 24, 24);

    g.font = 'bold 18px Menlo, monospace';
    g.textAlign = 'left';
    g.textBaseline = 'top';
    g.fillText(['WIDE', 'NARO', 'X-NARO'][tgp.zoom], 10, 10);
    g.fillText(tgp.tracking ? (tgp.trackedId >= 0 ? 'POINT' : 'AREA') : 'SLEW', 10, 32);
    g.textAlign = 'right';
    g.fillText(`RNG ${(tgp.range / 1852).toFixed(1)}`, W - 10, 10);
    const bearingSite = nearestSite(tgp.point);
    if (bearingSite) g.fillText(`${bearingSite.name} ${bearingSite.label}`, W - 10, 32);

    // Weapon status along the bottom.
    g.textAlign = 'left';
    g.textBaseline = 'bottom';
    const wpn = combat.weapon === 'LGB' ? `LGB ${combat.lgbLeft}` : `GUN ${combat.gunLeft}`;
    g.fillText(wpn, 10, W - 10);
    const bomb = combat.bombs[0];
    if (bomb) {
      g.textAlign = 'center';
      g.fillText(`TOF ${Math.round(bomb.pos.distanceTo(tgp.point) / Math.max(bomb.vel.length(), 1))}`, c, W - 10);
    } else if (combat.weapon === 'LGB' && combat.lgbLeft > 0 && !s.onGround) {
      const sol = combat.lgbSolution(s);
      g.textAlign = 'center';
      g.fillText(sol.inRange ? 'IN RNG' : 'OUT RNG', c, W - 10);
    }
    if (tgp.lasing && Math.floor(performance.now() / 300) % 2 === 0) {
      g.textAlign = 'right';
      g.font = 'bold 26px Menlo, monospace';
      g.fillText('L', W - 12, W - 8);
    }
    if (tgp.masked) {
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = 'bold 30px Menlo, monospace';
      g.fillText('MASKED', c, c - 50);
    }
    if (this.soi) {
      g.lineWidth = 6;
      g.strokeRect(3, 3, W - 6, W - 6);
    }
    this.overlayTex.needsUpdate = true;
  }

  /** Draw the pod view as a large picture-in-picture on screen. */
  drawPip(renderer: THREE.WebGLRenderer, x: number, y: number, size: number) {
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    const h = renderer.domElement.clientHeight;
    renderer.setScissor(x, h - y - size, size, size);
    renderer.setViewport(x, h - y - size, size, size);
    renderer.clearDepth();
    renderer.render(this.pipScene, this.pipCam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, renderer.domElement.clientWidth, h);
    renderer.autoClear = prevAuto;
  }
}

function nearestSite(p: THREE.Vector3) {
  let best = null as (typeof SITES)[number] | null;
  let bd = 3000;
  for (const s of SITES) {
    const d = Math.hypot(s.x - p.x, s.z - p.z);
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}
