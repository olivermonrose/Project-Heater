import * as THREE from 'three';
import { AircraftState, airDensity } from '../sim/aircraft';
import { Terrain } from '../sim/terrain';

// Collimated HUD: symbols are drawn on a 2D overlay at the screen position of
// real world/body directions, so they stay correct when you move your head,
// and are clipped to the combiner glass.

const DEG = Math.PI / 180;
const COLOR = 'rgba(110, 255, 150, 0.95)';

export class Hud {
  private ctx: CanvasRenderingContext2D;
  private maxG = 1;
  private blink = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
  }

  resize(w: number, h: number, dpr: number) {
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  resetMaxG() {
    this.maxG = 1;
  }

  draw(dt: number, camera: THREE.PerspectiveCamera, corners: THREE.Vector3[], s: AircraftState, attitude: { heading: number; pitch: number; bank: number }, terrain: Terrain) {
    const g = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    g.clearRect(0, 0, W, H);
    this.blink += dt;
    if (s.destroyed) return;

    const camPos = camera.getWorldPosition(new THREE.Vector3());
    const camQuatInv = camera.getWorldQuaternion(new THREE.Quaternion()).invert();
    const f = (H / 2) / Math.tan((camera.fov * DEG) / 2);
    const pxPerDeg = f * DEG;

    // Screen position of a world point or direction; null if behind the camera.
    const projDir = (dir: THREE.Vector3) => {
      const d = dir.clone().applyQuaternion(camQuatInv);
      if (d.z > -0.05) return null;
      return { x: W / 2 + (d.x / -d.z) * f, y: H / 2 - (d.y / -d.z) * f };
    };
    const projPoint = (p: THREE.Vector3) => projDir(p.clone().sub(camPos));

    const quad = corners.map(projPoint);
    if (quad.some((p) => p === null)) return;

    g.save();
    g.beginPath();
    quad.forEach((p, i) => (i ? g.lineTo(p!.x, p!.y) : g.moveTo(p!.x, p!.y)));
    g.closePath();
    g.clip();

    const scale = pxPerDeg;
    g.strokeStyle = COLOR;
    g.fillStyle = COLOR;
    g.lineWidth = Math.max(1.2, scale * 0.06);
    g.font = `${Math.round(scale * 0.8)}px "SF Mono", Menlo, monospace`;
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(110,255,150,0.6)';
    g.shadowBlur = scale * 0.15;

    // Body-fixed direction at azimuth/elevation (deg) from the boresight.
    const body = (az: number, el: number) =>
      new THREE.Vector3(Math.tan(az * DEG), Math.tan(el * DEG), -1).normalize().applyQuaternion(s.quat);
    const worldDir = (hdgDeg: number, pitchDeg: number) => {
      const h = hdgDeg * DEG, p = pitchDeg * DEG;
      return new THREE.Vector3(Math.sin(h) * Math.cos(p), Math.sin(p), -Math.cos(h) * Math.cos(p));
    };

    const speed = s.vel.length();
    const vDir = speed > 5 ? s.vel.clone().normalize() : new THREE.Vector3(0, 0, -1).applyQuaternion(s.quat);
    const fpmHdg = Math.atan2(vDir.x, -vDir.z) / DEG;

    // ---- Pitch ladder (centred on the flight path) ----
    const bankRad = attitude.bank * DEG;
    for (let p = -85; p <= 85; p += 5) {
      const c = projDir(worldDir(fpmHdg, p));
      if (!c) continue;
      const half = (p === 0 ? 9 : 3.2) * scale;
      const gap = (p === 0 ? 1.6 : 1.2) * scale;
      const ux = Math.cos(bankRad), uy = -Math.sin(bankRad);
      g.setLineDash(p < 0 ? [scale * 0.5, scale * 0.35] : []);
      g.beginPath();
      g.moveTo(c.x - ux * half, c.y - uy * half);
      g.lineTo(c.x - ux * gap, c.y - uy * gap);
      g.moveTo(c.x + ux * gap, c.y + uy * gap);
      g.lineTo(c.x + ux * half, c.y + uy * half);
      // End ticks point toward the horizon.
      if (p !== 0) {
        const t = (p > 0 ? 1 : -1) * scale * 0.5;
        g.moveTo(c.x - ux * half, c.y - uy * half);
        g.lineTo(c.x - ux * half - uy * t, c.y - uy * half + ux * t);
        g.moveTo(c.x + ux * half, c.y + uy * half);
        g.lineTo(c.x + ux * half - uy * t, c.y + uy * half + ux * t);
      }
      g.stroke();
      g.setLineDash([]);
      if (p !== 0) {
        g.textAlign = 'center';
        g.fillText(String(Math.abs(p)), c.x + ux * (half + scale * 1.1), c.y + uy * (half + scale * 1.1));
        g.fillText(String(Math.abs(p)), c.x - ux * (half + scale * 1.1), c.y - uy * (half + scale * 1.1));
      }
    }

    // ---- Boresight cross ----
    const bs = projDir(body(0, 0));
    if (bs) {
      g.beginPath();
      g.moveTo(bs.x - scale * 0.7, bs.y);
      g.lineTo(bs.x + scale * 0.7, bs.y);
      g.moveTo(bs.x, bs.y - scale * 0.7);
      g.lineTo(bs.x, bs.y + scale * 0.7);
      g.stroke();
    }

    // ---- Flight path marker ----
    const fpm = projDir(vDir);
    if (fpm) {
      const r = scale * 0.55;
      g.beginPath();
      g.arc(fpm.x, fpm.y, r, 0, Math.PI * 2);
      g.moveTo(fpm.x - r, fpm.y);
      g.lineTo(fpm.x - r * 3, fpm.y);
      g.moveTo(fpm.x + r, fpm.y);
      g.lineTo(fpm.x + r * 3, fpm.y);
      g.moveTo(fpm.x, fpm.y - r);
      g.lineTo(fpm.x, fpm.y - r * 2.2);
      g.stroke();
    }

    // ---- Airspeed (left) and altitude (right) boxes ----
    const kcas = speed * Math.sqrt(airDensity(s.pos.y) / 1.225) * 1.944;
    const altFt = s.pos.y * 3.281;
    const agl = (s.pos.y - terrain.heightAt(s.pos.x, s.pos.z)) * 3.281;
    const box = (pos: { x: number; y: number } | null, text: string, align: CanvasTextAlign) => {
      if (!pos) return;
      const w = scale * 3.8, h = scale * 1.1;
      g.strokeRect(pos.x - w / 2, pos.y - h / 2, w, h);
      g.textAlign = align;
      g.fillText(text, align === 'right' ? pos.x + w / 2 - scale * 0.25 : pos.x - w / 2 + scale * 0.25, pos.y + 1);
    };
    box(projDir(body(-6.2, -1.5)), String(Math.round(kcas)), 'right');
    box(projDir(body(6.2, -1.5)), String(Math.round(altFt / 10) * 10), 'right');
    const textAt = (az: number, el: number, txt: string, align: CanvasTextAlign = 'left') => {
      const p = projDir(body(az, el));
      if (!p) return;
      g.textAlign = align;
      g.fillText(txt, p.x, p.y);
    };
    if (agl < 5000) textAt(4.3, -3.0, `R ${Math.round(agl / 10) * 10}`);

    // ---- G, Mach, AoA, max G (left column) ----
    this.maxG = Math.max(this.maxG, s.gLoad);
    const mach = speed / Math.max(295, 340.3 - 0.004 * s.pos.y);
    textAt(-8.0, 3.2, `${s.gLoad.toFixed(1)}G`);
    textAt(-8.0, -4.2, `M ${mach.toFixed(2)}`);
    textAt(-8.0, -5.4, `${(s.alpha / DEG).toFixed(0)}α`);
    textAt(-8.0, -6.6, `${this.maxG.toFixed(1)}`);
    if (s.afterburner > 0.05) textAt(-8.0, -7.8, 'AB');

    // ---- Vertical velocity (right column) ----
    const vvi = s.vel.y * 196.85;
    textAt(4.3, -4.2, `${vvi >= 0 ? '+' : ''}${Math.round(vvi / 10) * 10}`);

    // ---- Heading tape (bottom) ----
    const tapeEl = -9.6;
    const hdg = attitude.heading;
    for (let dH = -12; dH <= 12; dH++) {
      const v = Math.round(hdg) + dH;
      const off = v - hdg;
      if (Math.abs(off) > 6.5) continue;
      if (v % 5 !== 0) continue;
      const p1 = projDir(body(off, tapeEl));
      const p2 = projDir(body(off, tapeEl + (v % 10 === 0 ? 0.6 : 0.35)));
      if (!p1 || !p2) continue;
      g.beginPath();
      g.moveTo(p1.x, p1.y);
      g.lineTo(p2.x, p2.y);
      g.stroke();
      if (v % 10 === 0) {
        g.textAlign = 'center';
        const lab = (((v % 360) + 360) % 360) / 10;
        g.fillText(String(lab).padStart(2, '0'), p1.x, p1.y + scale * 0.7);
      }
    }
    const caret = projDir(body(0, tapeEl - 1.5));
    if (caret) {
      g.beginPath();
      g.moveTo(caret.x, caret.y - scale * 0.5);
      g.lineTo(caret.x - scale * 0.35, caret.y);
      g.lineTo(caret.x + scale * 0.35, caret.y);
      g.closePath();
      g.stroke();
    }

    // ---- Warnings ----
    const blinkOn = Math.floor(this.blink * 3) % 2 === 0;
    const sink = -s.vel.y;
    const timeToImpact = sink > 1 ? (agl / 3.281) / sink : 99;
    if (!s.onGround && timeToImpact < 6 && blinkOn) {
      g.font = `bold ${Math.round(scale * 1.2)}px Menlo, monospace`;
      textAt(0, -5.5, 'PULL UP', 'center');
    } else if (!s.onGround && s.gearPos < 0.99 && agl < 1500 && kcas < 210 && sink > 2 && blinkOn) {
      g.font = `bold ${Math.round(scale * 1.0)}px Menlo, monospace`;
      textAt(0, -5.5, 'GEAR', 'center');
    }
    g.restore();
  }
}
