import { Vector3 } from 'three';
import { Terrain } from './terrain';
import { Aircraft, AircraftState, SimEvent, airDensity } from './aircraft';
import { Combat, Target } from './combat';

// Enemy air defences: a radar SAM site, radar-directed anti-aircraft guns and
// shoulder-fired heat-seeking missiles. Also the jet's chaff and flares and
// the radar warning receiver picture. Pure simulation, no rendering.

const G = 9.81;
export const CHAFF_COUNT = 60;
export const FLARE_COUNT = 60;

export type MissileKind = 'radar' | 'ir';

export interface Decoy {
  kind: 'chaff' | 'flare';
  pos: Vector3;
  vel: Vector3;
  life: number;
  age: number;
}

export interface Missile {
  id: number;
  kind: MissileKind;
  pos: Vector3;
  vel: Vector3;
  time: number;
  /** The radar that guides it (radar missiles), or the team that fired it. */
  sourceId: number;
  decoy: Decoy | null;
  /** Seeker lost the target for good. */
  lost: boolean;
  dead: boolean;
  hitPlayer: boolean;
  minDist: number;
}

export interface Shell {
  pos: Vector3;
  vel: Vector3;
  life: number;
}

export type RwrState = 'search' | 'track' | 'launch';
export interface RwrContact {
  id: number;
  type: 'SAM' | 'AAA';
  pos: Vector3;
  state: RwrState;
  range: number;
}

export type ThreatEvent =
  | { type: 'missileLaunch'; missile: Missile; pos: Vector3 }
  | { type: 'missileDetonate'; pos: Vector3; hitPlayer: boolean; damage: number; kind: MissileKind }
  | { type: 'missileEvaded'; kind: MissileKind }
  | { type: 'flakBurst'; pos: Vector3 }
  | { type: 'shellHit'; damage: number }
  | { type: 'dispense'; chaff: boolean; flare: boolean }
  | { type: 'cmEmpty' }
  | { type: 'newContact'; contact: RwrContact };

interface MissileSpec {
  boost: number; // s
  boostAcc: number; // m/s²
  sustain: number;
  sustainAcc: number;
  drag: number; // per m at sea level
  maxG: number;
  nav: number; // proportional navigation constant
  fuze: number; // proximity fuze radius, m
  life: number; // s
  minSpeed: number;
  maxDamage: number;
}

const SPECS: Record<MissileKind, MissileSpec> = {
  radar: { boost: 5, boostAcc: 230, sustain: 0, sustainAcc: 0, drag: 0.000045, maxG: 24, nav: 4, fuze: 12, life: 40, minSpeed: 300, maxDamage: 65 },
  ir: { boost: 2.2, boostAcc: 280, sustain: 3, sustainAcc: 35, drag: 0.00011, maxG: 22, nav: 3.5, fuze: 7, life: 18, minSpeed: 220, maxDamage: 50 },
};

/** Per-emplacement AI state. */
interface Emitter {
  t: Target;
  detect: number; // seconds of continuous detection
  tracking: boolean;
  trackTime: number;
  lockout: number; // radar decoyed by chaff: can't re-track for a while
  cooldown: number;
  missiles: number;
  firing: boolean;
  burst: number;
  fireAcc: number;
  aimError: Vector3;
  wasSeen: boolean;
  notchTime: number;
}

export const SAM_LAUNCH_RANGE = 14000;
export const SAM_DETECT_RANGE = 35000;
const SAM_TRACK_RANGE = 26000;
const AAA_RANGE = 4000;
const MANPADS_RANGE = 5000;

export class Threats {
  missiles: Missile[] = [];
  decoys: Decoy[] = [];
  shells: Shell[] = [];
  rwr: RwrContact[] = [];
  chaff = CHAFF_COUNT;
  flares = FLARE_COUNT;
  /** An enemy missile is inbound (missile warning). */
  missileWarning = false;
  /** Closest inbound missile, for the RWR and HUD. */
  inbound: Missile[] = [];
  evaded = 0;
  hitsTaken = 0;
  private emitters = new Map<number, Emitter>();
  private nextId = 1;
  private aiTimer = 0;
  private cmCooldown = 0;
  private prevPlayer = new Vector3();
  private seen = new Set<number>();

  constructor(private terrain: Terrain) {}

  reset(combat: Combat) {
    this.missiles = [];
    this.decoys = [];
    this.shells = [];
    this.rwr = [];
    this.inbound = [];
    this.chaff = CHAFF_COUNT;
    this.flares = FLARE_COUNT;
    this.missileWarning = false;
    this.evaded = 0;
    this.hitsTaken = 0;
    this.emitters.clear();
    this.seen.clear();
    this.aiTimer = 0;
    this.cmCooldown = 0;
    for (const t of combat.targets) {
      if (t.kind !== 'samRadar' && t.kind !== 'samLauncher' && t.kind !== 'aaa' && t.kind !== 'manpads') continue;
      this.emitters.set(t.id, {
        t, detect: 0, tracking: false, trackTime: 0, lockout: 0, cooldown: 0,
        missiles: t.kind === 'samLauncher' ? 1 : t.kind === 'manpads' ? 2 : 0,
        firing: false, burst: 0, fireAcc: 0, aimError: new Vector3(), wasSeen: false, notchTime: 0,
      });
    }
  }

  /** Line of sight between two points, blocked by terrain. */
  lineOfSight(a: Vector3, b: Vector3) {
    const d = b.clone().sub(a);
    const len = d.length();
    const steps = Math.ceil(len / 120);
    for (let i = 1; i < steps; i++) {
      const f = i / steps;
      const x = a.x + d.x * f, y = a.y + d.y * f, z = a.z + d.z * f;
      if (this.terrain.heightAt(x, z) > y + 2) return false;
    }
    return true;
  }

  step(dt: number, ac: Aircraft, dispense: boolean, events: ThreatEvent[], simEvents: SimEvent[]) {
    const s = ac.s;
    const alive = !s.destroyed;
    const airborne = alive && !s.onGround;

    // ---------- Countermeasures ----------
    this.cmCooldown -= dt;
    if (dispense && airborne && this.cmCooldown <= 0) {
      this.cmCooldown = 0.45;
      const chaff = this.chaff > 0, flare = this.flares > 0;
      if (!chaff && !flare) events.push({ type: 'cmEmpty' });
      else {
        const back = new Vector3(0, -0.3, 1).applyQuaternion(s.quat).normalize();
        if (chaff) {
          this.chaff--;
          const d: Decoy = { kind: 'chaff', pos: s.pos.clone().addScaledVector(back, 5), vel: s.vel.clone().addScaledVector(back, 15), life: 3.5, age: 0 };
          this.decoys.push(d);
          this.trySpoof(d, s);
        }
        if (flare) {
          this.flares--;
          // Flares pop out to alternate sides so you can see them over your shoulder.
          const side = new Vector3(this.flares % 2 === 0 ? 1 : -1, 0.2, 0.3).applyQuaternion(s.quat).normalize();
          const d: Decoy = { kind: 'flare', pos: s.pos.clone().addScaledVector(back, 6), vel: s.vel.clone().addScaledVector(side, 70), life: 4.5, age: 0 };
          this.decoys.push(d);
          this.trySpoof(d, s);
        }
        events.push({ type: 'dispense', chaff, flare });
      }
    }
    for (const d of this.decoys) {
      d.age += dt;
      // Chaff stops almost at once in the airstream; flares slow and fall.
      const k = d.kind === 'chaff' ? 2.5 : 0.5;
      d.vel.multiplyScalar(Math.max(0, 1 - k * dt));
      d.vel.y -= (d.kind === 'chaff' ? 0.5 : G) * dt;
      d.pos.addScaledVector(d.vel, dt);
    }
    this.decoys = this.decoys.filter((d) => d.age < d.life);

    // ---------- Threat AI (10 Hz) ----------
    this.aiTimer -= dt;
    if (this.aiTimer <= 0) {
      this.aiTimer += 0.1;
      this.think(0.1, s, airborne, events);
    }

    // ---------- Guns ----------
    for (const e of this.emitters.values()) {
      if (e.t.kind !== 'aaa') continue;
      if (!e.firing || e.t.destroyed || !airborne) {
        e.burst = 0;
        continue;
      }
      const cycle = e.burst % 3.4;
      e.burst += dt;
      if (cycle < dt) {
        // New burst, new aiming error: the gunner's solution is never perfect.
        e.aimError.set(rand(1), rand(1), rand(1)).multiplyScalar(0.011);
      }
      if (cycle > 1.6) continue;
      e.fireAcc += dt * 24;
      while (e.fireAcc >= 1) {
        e.fireAcc -= 1;
        const muzzle = e.t.pos.clone().add(new Vector3(0, 3, 0));
        // Lead the target assuming it flies straight, and allow for shell drop.
        let tof = s.pos.distanceTo(muzzle) / 900;
        const aim = new Vector3();
        for (let i = 0; i < 2; i++) {
          aim.copy(s.pos).addScaledVector(s.vel, tof);
          tof = aim.distanceTo(muzzle) / 900;
        }
        aim.y += 0.5 * G * tof * tof;
        const dir = aim.sub(muzzle).normalize().add(e.aimError).add(new Vector3(rand(1), rand(1), rand(1)).multiplyScalar(0.007)).normalize();
        this.shells.push({ pos: muzzle, vel: dir.multiplyScalar(900), life: 4.4 });
      }
    }

    // Player motion over this step, for swept hit tests.
    const p1 = s.pos;
    const p0 = this.prevPlayer.lengthSq() > 0 && this.prevPlayer.distanceTo(p1) < 200 ? this.prevPlayer : p1.clone().addScaledVector(s.vel, -dt);

    for (const sh of this.shells) {
      const prev = sh.pos.clone();
      sh.vel.y -= G * dt;
      sh.pos.addScaledVector(sh.vel, dt);
      sh.life -= dt;
      if (alive && sweptDistance(prev, sh.pos, p0, p1) < 3.5) {
        const dmg = 2 + Math.random() * 2;
        this.hitsTaken++;
        events.push({ type: 'shellHit', damage: dmg });
        ac.applyDamage(dmg, 'Shot down by anti-aircraft fire', simEvents);
        sh.life = -1;
        continue;
      }
      if (sh.pos.y <= this.terrain.heightAt(sh.pos.x, sh.pos.z)) sh.life = -1;
      else if (sh.life <= 0) {
        // Self-destruct airburst.
        events.push({ type: 'flakBurst', pos: sh.pos.clone() });
        if (alive && sh.pos.distanceTo(p1) < 12) ac.applyDamage(3, 'Shot down by anti-aircraft fire', simEvents);
        sh.life = -1;
      }
    }
    this.shells = this.shells.filter((x) => x.life > 0);

    // ---------- Missiles ----------
    for (const m of this.missiles) this.stepMissile(m, dt, ac, p0, p1, events, simEvents);
    this.missiles = this.missiles.filter((m) => !m.dead);

    this.inbound = alive ? this.missiles.filter((m) => !m.lost && !m.decoy && m.pos.distanceTo(s.pos) < 12000
      && m.vel.clone().sub(s.vel).dot(s.pos.clone().sub(m.pos)) > 0) : [];
    this.missileWarning = this.inbound.length > 0;
    this.prevPlayer.copy(s.pos);
  }

  /** Chance for a fresh chaff bundle or flare to pull missiles off the jet. */
  private trySpoof(d: Decoy, s: AircraftState) {
    for (const m of this.missiles) {
      if (m.dead || m.lost || m.decoy) continue;
      if (d.kind === 'chaff' && m.kind === 'radar') {
        const radar = this.emitters.get(m.sourceId);
        // Chaff works far better when you are "in the notch": flying across the radar's beam.
        const notch = radar ? 1 - Math.min(1, Math.abs(radialSpeed(s, radar.t.pos)) / 160) : 0.5;
        const p = 0.3 + 0.6 * notch;
        if (Math.random() < p) {
          m.decoy = d;
          if (radar) {
            radar.tracking = false;
            radar.trackTime = 0;
            radar.lockout = 5 + Math.random() * 2;
          }
        }
      } else if (d.kind === 'flare' && m.kind === 'ir') {
        // A hot afterburner plume makes flares less convincing; idle power makes them better.
        let p = 0.5 - 0.3 * s.afterburner + (s.rpm < 0.8 ? 0.15 : 0);
        p = Math.max(0.1, Math.min(0.8, p));
        if (Math.random() < p) m.decoy = d;
      }
    }
  }

  private think(dt: number, s: AircraftState, airborne: boolean, events: ThreatEvent[]) {
    const contacts: RwrContact[] = [];
    const agl = s.pos.y - this.terrain.heightAt(s.pos.x, s.pos.z);
    const radarInFlight = new Map<number, number>();
    for (const m of this.missiles) if (m.kind === 'radar') radarInFlight.set(m.sourceId, (radarInFlight.get(m.sourceId) ?? 0) + 1);

    for (const e of this.emitters.values()) {
      const t = e.t;
      e.cooldown -= dt;
      e.lockout -= dt;
      if (t.destroyed || !airborne) {
        e.tracking = false;
        e.firing = false;
        e.detect = 0;
        continue;
      }
      if (t.kind === 'samLauncher') continue; // launchers are slaved to the radar
      const sensor = t.pos.clone().add(new Vector3(0, 5, 0));
      const range = sensor.distanceTo(s.pos);
      const above = s.pos.y - t.pos.y;

      if (t.kind === 'samRadar') {
        if (range > SAM_DETECT_RANGE) {
          e.detect = 0;
          e.tracking = false;
          continue;
        }
        const los = this.lineOfSight(sensor, s.pos);
        // Below ~150 ft the radar loses you in ground clutter. Flying across its
        // beam (the "notch") makes the doppler return vanish too.
        const clutter = agl < 45;
        // Holding the notch for a second breaks the track.
        const inNotch = Math.abs(radialSpeed(s, sensor)) < 50 && agl < 6000;
        e.notchTime = inNotch ? e.notchTime + dt : 0;
        const notched = e.notchTime > 0.6;
        const sees = los && !clutter;
        if (sees) e.detect += dt;
        else e.detect = Math.max(0, e.detect - dt * 3);
        const canTrack = sees && !notched && e.detect > 3 && range < SAM_TRACK_RANGE && e.lockout <= 0;
        e.tracking = canTrack;
        e.trackTime = canTrack ? e.trackTime + dt : 0;
        const inFlight = radarInFlight.get(t.id) ?? 0;
        // One missile at a time, and a pause after each one before the next.
        if (inFlight > 0) e.cooldown = Math.max(e.cooldown, 12);
        if (e.tracking && e.trackTime > 4 && range < SAM_LAUNCH_RANGE && above < 16000 && e.cooldown <= 0 && inFlight < 1) {
          const launcher = [...this.emitters.values()].find((x) => x.t.kind === 'samLauncher' && x.t.site === t.site && !x.t.destroyed && x.missiles > 0);
          if (launcher) {
            launcher.missiles--;
            e.cooldown = 7;
            this.launch('radar', launcher.t.pos.clone().add(new Vector3(0, 3, 0)), t.id, s, events);
          }
        }
        if (los) {
          const state: RwrState = (radarInFlight.get(t.id) ?? 0) > 0 && e.tracking ? 'launch' : e.tracking ? 'track' : 'search';
          contacts.push({ id: t.id, type: 'SAM', pos: t.pos, state, range });
        }
      } else if (t.kind === 'aaa') {
        if (range > 9000) {
          e.firing = false;
          e.detect = 0;
          continue;
        }
        const los = this.lineOfSight(sensor, s.pos);
        if (los && range < AAA_RANGE + 1500 && above < 3600) e.detect += dt;
        else e.detect = 0;
        e.tracking = e.detect > 1.5;
        e.firing = e.tracking && range < AAA_RANGE;
        if (los) contacts.push({ id: t.id, type: 'AAA', pos: t.pos, state: e.tracking ? 'track' : 'search', range });
      } else if (t.kind === 'manpads') {
        // Heat seekers are passive: no radar warning. They need to see your
        // engine, so they reach further at your tail or when you're in afterburner.
        if (range > MANPADS_RANGE + 500 || e.missiles <= 0) {
          e.detect = 0;
          continue;
        }
        const toJet = s.pos.clone().sub(sensor).normalize();
        const fwd = new Vector3(0, 0, -1).applyQuaternion(s.quat);
        const tailAspect = fwd.dot(toJet) > 0.2; // jet flying away from the team
        const reach = tailAspect || s.afterburner > 0.1 ? MANPADS_RANGE : 3000;
        const los = this.lineOfSight(sensor, s.pos);
        if (los && range < reach && above < 3800 && s.engineRunning) e.detect += dt;
        else e.detect = Math.max(0, e.detect - dt);
        if (e.detect > 3 && e.cooldown <= 0) {
          e.missiles--;
          e.cooldown = 14;
          e.detect = 0;
          this.launch('ir', sensor.clone(), t.id, s, events);
        }
      }
    }

    for (const c of contacts) {
      if (!this.seen.has(c.id)) {
        this.seen.add(c.id);
        events.push({ type: 'newContact', contact: c });
      }
    }
    // Forget contacts that go quiet so they beep again when they come back.
    for (const id of [...this.seen]) if (!contacts.some((c) => c.id === id)) this.seen.delete(id);
    this.rwr = contacts;
  }

  private launch(kind: MissileKind, pos: Vector3, sourceId: number, s: AircraftState, events: ThreatEvent[]) {
    // Leave the rail climbing steeply toward the target.
    const to = s.pos.clone().sub(pos);
    const horiz = new Vector3(to.x, 0, to.z).normalize();
    const climb = kind === 'radar' ? 0.9 : 0.35;
    const dir = horiz.multiplyScalar(Math.cos(climb)).add(new Vector3(0, Math.sin(climb), 0));
    const elevTo = Math.atan2(to.y, Math.hypot(to.x, to.z));
    if (elevTo > climb) dir.copy(to).normalize();
    const m: Missile = {
      id: this.nextId++, kind, pos, vel: dir.multiplyScalar(kind === 'radar' ? 40 : 60), time: 0, sourceId,
      decoy: null, lost: false, dead: false, hitPlayer: false, minDist: Infinity,
    };
    this.missiles.push(m);
    events.push({ type: 'missileLaunch', missile: m, pos: pos.clone() });
  }

  private stepMissile(m: Missile, dt: number, ac: Aircraft, p0: Vector3, p1: Vector3, events: ThreatEvent[], simEvents: SimEvent[]) {
    const s = ac.s;
    const spec = SPECS[m.kind];
    m.time += dt;
    const speed = m.vel.length();
    const fwd = m.vel.clone().divideScalar(Math.max(speed, 1));
    const rho = airDensity(m.pos.y) / 1.225;

    // What the missile is steering at.
    if (m.decoy && m.decoy.age >= m.decoy.life) m.decoy = null;
    let aim: Vector3 | null = null;
    let aimVel = new Vector3();
    if (m.decoy) {
      aim = m.decoy.pos;
      aimVel = m.decoy.vel;
    } else if (!m.lost && !s.destroyed) {
      if (m.kind === 'radar') {
        // Semi-active: only guides while the ground radar is tracking you.
        const radar = this.emitters.get(m.sourceId);
        if (radar && !radar.t.destroyed && radar.tracking) {
          aim = s.pos;
          aimVel = s.vel;
        }
      } else {
        // The heat seeker must keep the engine inside its field of view.
        const los = s.pos.clone().sub(m.pos).normalize();
        if (m.time > 0.4 && los.dot(fwd) < Math.cos(0.75)) m.lost = true;
        else if (s.engineRunning) {
          aim = s.pos;
          aimVel = s.vel;
        }
      }
    }

    const lat = new Vector3();
    if (aim && m.time > 0.5) {
      const r = aim.clone().sub(m.pos);
      const dist = Math.max(r.length(), 1);
      const vr = aimVel.clone().sub(m.vel);
      const rHat = r.clone().divideScalar(dist);
      const closing = -vr.dot(rHat);
      const omega = r.clone().cross(vr).divideScalar(dist * dist);
      lat.copy(omega.cross(rHat)).multiplyScalar(spec.nav * Math.max(closing, 100));
      // Fly toward the target in the first seconds after launch.
      if (m.time < 2) lat.add(rHat.clone().sub(fwd).multiplyScalar(speed * 1.5));
    }
    lat.y += G; // hold up against gravity
    lat.addScaledVector(fwd, -lat.dot(fwd)); // fins only push sideways
    const maxAcc = spec.maxG * G * Math.min(1, Math.max(0.15, (rho * speed * speed) / (400 * 400)));
    if (lat.length() > maxAcc) lat.setLength(maxAcc);

    const thrust = m.time < spec.boost ? spec.boostAcc : m.time < spec.boost + spec.sustain ? spec.sustainAcc : 0;
    const acc = fwd.clone().multiplyScalar(thrust - spec.drag * rho * speed * speed - 0.05 * lat.length());
    acc.add(lat);
    acc.y -= G;
    const prev = m.pos.clone();
    m.vel.addScaledVector(acc, dt);
    m.pos.addScaledVector(m.vel, dt);

    // Proximity fuze against the jet.
    if (!s.destroyed) {
      const d = sweptDistance(prev, m.pos, p0, p1);
      if (d < spec.fuze) {
        const dmg = Math.max(8, spec.maxDamage * (1 - (d / spec.fuze) * 0.7) + rand(6));
        m.dead = true;
        m.hitPlayer = true;
        this.hitsTaken++;
        events.push({ type: 'missileDetonate', pos: m.pos.clone(), hitPlayer: true, damage: dmg, kind: m.kind });
        ac.applyDamage(dmg, m.kind === 'radar' ? 'Shot down by a SAM' : 'Shot down by a heat-seeking missile', simEvents);
        return;
      }
      const now = m.pos.distanceTo(s.pos);
      if (now < m.minDist) m.minDist = now;
      else if (m.minDist < 1500 && now > m.minDist + 300 && !m.lost) {
        // It went past.
        m.lost = true;
      }
    }
    // Fuzing on a decoy.
    if (m.decoy && m.pos.distanceTo(m.decoy.pos) < spec.fuze * 0.8) {
      this.endMissile(m, events, true);
      return;
    }
    const ground = m.pos.y <= this.terrain.heightAt(m.pos.x, m.pos.z);
    const slow = m.time > spec.boost + spec.sustain + 1 && speed < spec.minSpeed;
    if (ground || slow || m.time > spec.life || (m.lost && m.time > 3 && m.minDist < Infinity && m.pos.distanceTo(s.pos) > m.minDist + 2500)) {
      this.endMissile(m, events, !ground);
    }
  }

  private endMissile(m: Missile, events: ThreatEvent[], burst: boolean) {
    m.dead = true;
    if (burst) events.push({ type: 'missileDetonate', pos: m.pos.clone(), hitPlayer: false, damage: 0, kind: m.kind });
    if (!m.hitPlayer) {
      this.evaded++;
      events.push({ type: 'missileEvaded', kind: m.kind });
    }
  }

  /** Is this missile's motor still burning (for smoke trails)? */
  static motorBurning(m: Missile) {
    const spec = SPECS[m.kind];
    return m.time < spec.boost + spec.sustain;
  }

  /** Positions of SAM radars still alive. */
  samRadars() {
    return [...this.emitters.values()].filter((e) => e.t.kind === 'samRadar' && !e.t.destroyed).map((e) => e.t.pos);
  }

  /** Remaining missiles at a SAM site's launchers. */
  samMissilesLeft(site: string) {
    let n = 0;
    for (const e of this.emitters.values()) if (e.t.kind === 'samLauncher' && e.t.site === site && !e.t.destroyed) n += e.missiles;
    return n;
  }
}

/** Speed toward (+) or away from (-) a ground point. Near zero means flying across its line of sight. */
function radialSpeed(s: AircraftState, from: Vector3) {
  const los = s.pos.clone().sub(from).normalize();
  return s.vel.dot(los);
}

/** Closest approach between a moving point (a0→a1) and another (b0→b1) during the same step. */
function sweptDistance(a0: Vector3, a1: Vector3, b0: Vector3, b1: Vector3) {
  const d0 = a0.clone().sub(b0);
  const d1 = a1.clone().sub(b1);
  const dd = d1.clone().sub(d0);
  const t = Math.max(0, Math.min(1, -d0.dot(dd) / Math.max(dd.lengthSq(), 1e-9)));
  return d0.addScaledVector(dd, t).length();
}

function rand(s: number) {
  return (Math.random() - 0.5) * 2 * s;
}
