import { Vector3 } from 'three';
import { Terrain } from './terrain';
import { AircraftState } from './aircraft';

// Ground targets, the targeting pod (TGP), laser-guided bombs and the gun.
// Pure simulation: no rendering, so a multiplayer server can run it later.

const G = 9.81;

export type TargetKind = 'truck' | 'tank' | 'apc' | 'fuelTank' | 'warehouse' | 'samLauncher' | 'samRadar';

export interface Target {
  id: number;
  kind: TargetKind;
  site: string;
  pos: Vector3;
  heading: number; // radians
  radius: number; // hit radius, m
  hp: number;
  maxHp: number;
  destroyed: boolean;
}

export interface TargetSite {
  name: string;
  label: string;
  x: number;
  z: number;
}

export const SITES: TargetSite[] = [
  { name: 'A', label: 'SUPPLY DEPOT', x: 11000, z: -5000 },
  { name: 'B', label: 'ARMOR COLUMN', x: 16000, z: -12000 },
  { name: 'C', label: 'SAM SITE', x: -4000, z: 16000 },
];

const KIND_INFO: Record<TargetKind, { radius: number; hp: number }> = {
  truck: { radius: 4, hp: 30 },
  apc: { radius: 4, hp: 50 },
  tank: { radius: 4.5, hp: 80 },
  fuelTank: { radius: 8, hp: 60 },
  warehouse: { radius: 16, hp: 220 },
  samLauncher: { radius: 5, hp: 60 },
  samRadar: { radius: 5, hp: 60 },
};

export type WeaponKind = 'LGB' | 'GUN';

export interface Bomb {
  id: number;
  pos: Vector3;
  vel: Vector3;
  time: number;
  guided: boolean;
}

export interface Bullet {
  pos: Vector3;
  vel: Vector3;
  life: number;
}

export interface TgpState {
  point: Vector3; // ground point the pod looks at
  tracking: boolean; // point track on a target vs area track on the ground
  trackedId: number;
  zoom: number; // index into TGP_FOVS
  masked: boolean;
  lasing: boolean;
  range: number; // slant range, m
}

export const TGP_FOVS = [20, 6, 1.8]; // degrees
export const LGB_COUNT = 4;
export const GUN_ROUNDS = 510;
export const BOMB_MASS = 230;

export type CombatEvent =
  | { type: 'targetDestroyed'; target: Target }
  | { type: 'bombImpact'; pos: Vector3; hit: boolean }
  | { type: 'bulletImpact'; pos: Vector3 }
  | { type: 'release'; weapon: WeaponKind }
  | { type: 'cantFire'; reason: string };

export interface CombatActions {
  slewX: number; // -1..1 continuous
  slewY: number;
  lockToggle: boolean;
  zoom: number; // -1, 0, +1
  weaponCycle: boolean;
  pickle: boolean; // press: release a bomb
  trigger: boolean; // held: fire the gun
  cueToSite: string | null; // point the pod at a target site
}

export const noActions = (): CombatActions => ({
  slewX: 0, slewY: 0, lockToggle: false, zoom: 0, weaponCycle: false, pickle: false, trigger: false, cueToSite: null,
});

export class Combat {
  targets: Target[] = [];
  bombs: Bomb[] = [];
  bullets: Bullet[] = [];
  lgbLeft = LGB_COUNT;
  gunLeft = GUN_ROUNDS;
  weapon: WeaponKind = 'LGB';
  tgp: TgpState;
  private nextBombId = 1;
  private gunCooldown = 0;

  constructor(private terrain: Terrain) {
    this.tgp = { point: new Vector3(), tracking: false, trackedId: -1, zoom: 0, masked: false, lasing: false, range: 0 };
    this.reset();
  }

  reset() {
    this.targets = buildTargets(this.terrain);
    this.bombs = [];
    this.bullets = [];
    this.lgbLeft = LGB_COUNT;
    this.gunLeft = GUN_ROUNDS;
    this.weapon = 'LGB';
    const a = SITES[0];
    this.tgp = { point: new Vector3(a.x, this.terrain.heightAt(a.x, a.z), a.z), tracking: false, trackedId: -1, zoom: 0, masked: false, lasing: false, range: 0 };
  }

  get storesMass() {
    return this.lgbLeft * BOMB_MASS + this.gunLeft * 0.3;
  }

  /** Where the pod sits on the airframe (below the intake), world space. */
  podPosition(s: AircraftState) {
    return new Vector3(0.4, -1.8, -2.5).applyQuaternion(s.quat).add(s.pos);
  }

  step(dt: number, s: AircraftState, act: CombatActions, masterArm: boolean, podPower: boolean, events: CombatEvent[]) {
    const tgp = this.tgp;

    // ---------- Targeting pod ----------
    if (podPower && !s.destroyed) {
      if (act.cueToSite) {
        const site = SITES.find((x) => x.name === act.cueToSite);
        if (site) {
          tgp.point.set(site.x, this.terrain.heightAt(site.x, site.z), site.z);
          tgp.tracking = false;
          tgp.trackedId = -1;
        }
      }
      if (act.zoom) tgp.zoom = Math.max(0, Math.min(TGP_FOVS.length - 1, tgp.zoom + act.zoom));
      const pod = this.podPosition(s);
      const los = tgp.point.clone().sub(pod);
      tgp.range = los.length();

      // Slewing breaks a point track and moves the ground point across the image.
      if (Math.abs(act.slewX) > 0.02 || Math.abs(act.slewY) > 0.02) {
        if (tgp.tracking) {
          tgp.tracking = false;
          tgp.trackedId = -1;
        }
        const fov = (TGP_FOVS[tgp.zoom] * Math.PI) / 180;
        const horiz = new Vector3(los.x, 0, los.z);
        if (horiz.lengthSq() < 1) horiz.set(0, 0, -1);
        horiz.normalize();
        const right = new Vector3(-horiz.z, 0, horiz.x);
        // Moving "up" in the image moves the point away; scale by how oblique we look.
        const grazing = Math.max(0.15, Math.abs(los.y) / Math.max(tgp.range, 1));
        const rate = tgp.range * fov * 0.45 * dt;
        tgp.point.addScaledVector(right, act.slewX * rate);
        tgp.point.addScaledVector(horiz, (act.slewY * rate) / grazing);
        tgp.point.y = this.terrain.heightAt(tgp.point.x, tgp.point.z);
      }

      if (act.lockToggle) {
        if (tgp.tracking) {
          tgp.tracking = false;
          tgp.trackedId = -1;
        } else {
          // Snap to the closest live target near the crosshair, otherwise track the ground point.
          const fov = (TGP_FOVS[tgp.zoom] * Math.PI) / 180;
          const snap = Math.max(12, tgp.range * fov * 0.08);
          let best: Target | null = null;
          let bestD = snap;
          for (const t of this.targets) {
            if (t.destroyed) continue;
            const d = t.pos.distanceTo(tgp.point);
            if (d < bestD) {
              bestD = d;
              best = t;
            }
          }
          tgp.tracking = true;
          tgp.trackedId = best ? best.id : -1;
        }
      }
      if (tgp.tracking && tgp.trackedId >= 0) {
        const t = this.targets.find((x) => x.id === tgp.trackedId);
        if (t) tgp.point.copy(t.pos).y += 1;
      }

      // Gimbal limits: the pod can't see above the nose line or straight behind.
      const body = los.clone().applyQuaternion(s.quat.clone().invert()).normalize();
      const elev = Math.asin(Math.max(-1, Math.min(1, body.y)));
      const az = Math.atan2(body.x, -body.z);
      tgp.masked = elev > 0.35 || (Math.abs(az) > 2.6 && elev > -0.6);
      tgp.lasing = !tgp.masked && this.bombs.some((b) => b.guided);
    } else {
      tgp.lasing = false;
    }

    // ---------- Weapon controls ----------
    if (act.weaponCycle) this.weapon = this.weapon === 'LGB' ? 'GUN' : 'LGB';
    const canFire = masterArm && !s.onGround && !s.destroyed;
    if (act.pickle && this.weapon === 'LGB') {
      if (!masterArm) events.push({ type: 'cantFire', reason: 'MASTER ARM is SAFE' });
      else if (s.onGround) events.push({ type: 'cantFire', reason: 'Weight on wheels' });
      else if (this.lgbLeft <= 0) events.push({ type: 'cantFire', reason: 'No bombs left' });
      else {
        this.lgbLeft--;
        const side = this.lgbLeft % 2 === 0 ? 1 : -1;
        const pos = new Vector3(side * 2.2, -1.6, 1.5).applyQuaternion(s.quat).add(s.pos);
        const down = new Vector3(0, -1, 0).applyQuaternion(s.quat).multiplyScalar(3);
        this.bombs.push({ id: this.nextBombId++, pos, vel: s.vel.clone().add(down), time: 0, guided: true });
        events.push({ type: 'release', weapon: 'LGB' });
      }
    }
    this.gunCooldown -= dt;
    const firing = act.trigger && this.weapon === 'GUN';
    if (firing && !masterArm && act.pickle) events.push({ type: 'cantFire', reason: 'MASTER ARM is SAFE' });
    if (firing && canFire && this.gunLeft > 0) {
      while (this.gunCooldown <= 0 && this.gunLeft > 0) {
        this.gunCooldown += 1 / 100; // 6,000 rounds per minute
        this.gunLeft--;
        const fwd = new Vector3(0, 0, -1).applyQuaternion(s.quat);
        const muzzle = new Vector3(-0.9, -0.3, -1.5).applyQuaternion(s.quat).add(s.pos);
        // Small dispersion.
        const spread = new Vector3((Math.random() - 0.5) * 0.004, (Math.random() - 0.5) * 0.004, 0).applyQuaternion(s.quat);
        this.bullets.push({ pos: muzzle, vel: fwd.add(spread).multiplyScalar(1030).add(s.vel), life: 4 });
      }
    }
    if (this.gunCooldown < 0) this.gunCooldown = 0;

    // ---------- Bombs ----------
    for (const b of this.bombs) {
      b.time += dt;
      const speed = b.vel.length();
      const acc = new Vector3(0, -G, 0).addScaledVector(b.vel, -0.00005 * speed);
      // Guidance: steer the velocity toward the laser spot, with limited authority.
      if (b.guided && tgp.lasing && b.time > 1.0) {
        // Pursuit guidance with gravity compensation and limited fin authority.
        const losDir = tgp.point.clone().sub(b.pos).normalize();
        const steer = losDir.multiplyScalar(speed).sub(b.vel).multiplyScalar(1.6);
        steer.y += G * 0.85;
        if (steer.length() > 45) steer.setLength(45);
        acc.add(steer);
      }
      b.vel.addScaledVector(acc, dt);
      b.pos.addScaledVector(b.vel, dt);
      const gy = this.terrain.heightAt(b.pos.x, b.pos.z);
      // Hit a target directly or the ground.
      let impact = b.pos.y <= gy;
      for (const t of this.targets) if (!t.destroyed && t.pos.distanceTo(b.pos) < t.radius) impact = true;
      if (impact) {
        b.pos.y = Math.max(b.pos.y, gy);
        const hit = this.blast(b.pos, 32, 400, events);
        events.push({ type: 'bombImpact', pos: b.pos.clone(), hit });
        b.time = -1;
      }
    }
    this.bombs = this.bombs.filter((b) => b.time >= 0 && b.time < 90);

    // ---------- Bullets ----------
    for (const p of this.bullets) {
      p.life -= dt;
      const prev = p.pos.clone();
      p.vel.y -= G * dt;
      p.pos.addScaledVector(p.vel, dt);
      for (const t of this.targets) {
        if (t.destroyed) continue;
        if (segmentDistance(prev, p.pos, t.pos) < t.radius) {
          this.damage(t, 12, events);
          p.life = -1;
          events.push({ type: 'bulletImpact', pos: t.pos.clone() });
          break;
        }
      }
      if (p.life > 0 && p.pos.y <= this.terrain.heightAt(p.pos.x, p.pos.z)) {
        p.life = -1;
        events.push({ type: 'bulletImpact', pos: p.pos.clone() });
      }
    }
    this.bullets = this.bullets.filter((p) => p.life > 0);
  }

  private blast(pos: Vector3, radius: number, power: number, events: CombatEvent[]) {
    let hit = false;
    for (const t of this.targets) {
      if (t.destroyed) continue;
      const d = Math.max(0, t.pos.distanceTo(pos) - t.radius);
      if (d < radius) {
        hit = true;
        this.damage(t, power * (1 - d / radius) ** 1.5, events);
      }
    }
    return hit;
  }

  private damage(t: Target, amount: number, events: CombatEvent[]) {
    if (t.destroyed) return;
    t.hp -= amount;
    if (t.hp <= 0) {
      t.hp = 0;
      t.destroyed = true;
      if (this.tgp.trackedId === t.id) this.tgp.trackedId = -1; // pod stays on the wreck as an area track
      events.push({ type: 'targetDestroyed', target: t });
    }
  }

  /**
   * Predicted impact point of an unguided bomb released now, and a simple
   * "in range" check for a guided one against the TGP point.
   */
  lgbSolution(s: AircraftState) {
    const pos = s.pos.clone();
    const vel = s.vel.clone();
    let t = 0;
    while (t < 60) {
      const speed = vel.length();
      vel.y -= G * 0.1;
      vel.addScaledVector(vel, -0.00005 * speed * 0.1);
      pos.addScaledVector(vel, 0.1);
      t += 0.1;
      if (pos.y <= this.terrain.heightAt(pos.x, pos.z)) break;
    }
    const miss = new Vector3(this.tgp.point.x - pos.x, 0, this.tgp.point.z - pos.z);
    const fwd = new Vector3(s.vel.x, 0, s.vel.z).normalize();
    const along = miss.dot(fwd); // + means target beyond the ballistic impact
    const cross = Math.abs(miss.clone().addScaledVector(fwd, -along).length());
    // A guided bomb can stretch its glide or turn by an amount that grows with fall time.
    const reachLong = t * 30;
    const reachShort = t * 25;
    const reachCross = t * 22;
    const inRange = along < reachLong && along > -reachShort && cross < reachCross;
    return { impact: pos, timeOfFlight: t, inRange, along, cross };
  }

  /** Gun pipper: where rounds fired now would hit the ground (or null beyond 4 km). */
  gunPipper(s: AircraftState) {
    const fwd = new Vector3(0, 0, -1).applyQuaternion(s.quat);
    const pos = s.pos.clone();
    const vel = fwd.multiplyScalar(1030).add(s.vel);
    for (let t = 0; t < 4; t += 0.02) {
      vel.y -= G * 0.02;
      pos.addScaledVector(vel, 0.02);
      if (pos.y <= this.terrain.heightAt(pos.x, pos.z)) return pos;
    }
    return null;
  }

  liveCount() {
    return this.targets.filter((t) => !t.destroyed).length;
  }
}

function segmentDistance(a: Vector3, b: Vector3, p: Vector3) {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-9)));
  return a.clone().addScaledVector(ab, t).distanceTo(p);
}

function buildTargets(terrain: Terrain): Target[] {
  const list: Target[] = [];
  let id = 0;
  const add = (site: string, kind: TargetKind, x: number, z: number, heading: number) => {
    const info = KIND_INFO[kind];
    list.push({
      id: id++, kind, site, pos: new Vector3(x, terrain.heightAt(x, z), z), heading,
      radius: info.radius, hp: info.hp, maxHp: info.hp, destroyed: false,
    });
  };
  // A: supply depot. Warehouses, fuel tanks and parked trucks.
  const [ax, az] = [SITES[0].x, SITES[0].z];
  add('A', 'warehouse', ax - 60, az - 40, 0.3);
  add('A', 'warehouse', ax + 50, az - 70, 0.3);
  for (let i = 0; i < 3; i++) add('A', 'fuelTank', ax - 80 + i * 26, az + 60, 0);
  for (let i = 0; i < 5; i++) add('A', 'truck', ax + 40 + i * 12, az + 30, 1.2);
  // B: armor column strung out along a track.
  const [bx, bz] = [SITES[1].x, SITES[1].z];
  for (let i = 0; i < 7; i++) add('B', i % 3 === 2 ? 'apc' : 'tank', bx + i * 28, bz + i * 18, -1.0);
  // C: SAM site, three launchers around a radar (they don't shoot yet).
  const [cx, cz] = [SITES[2].x, SITES[2].z];
  add('C', 'samRadar', cx, cz, 0);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    add('C', 'samLauncher', cx + Math.cos(a) * 70, cz + Math.sin(a) * 70, -a);
  }
  add('C', 'truck', cx + 20, cz - 110, 0.5);
  return list;
}

