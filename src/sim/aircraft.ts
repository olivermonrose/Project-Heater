import { Euler, Quaternion, Vector3 } from 'three';
import { Terrain } from './terrain';

// A fictional single-engine multirole fighter, the "KR-7 Kestrel". Numbers are
// in the ballpark of a light multirole jet but tuned for fun, not certified data.
const G = 9.81;
const WING_AREA = 27.9;
const DRY_MASS = 9600; // airframe, pilot, pylons
const INTERNAL_FUEL = 3200; // kg
const MIL_THRUST = 76000; // N at sea level
const AB_THRUST = 127000;
const CL_ALPHA = 5.0; // per radian
const ALPHA_LIMIT = 25 * Math.PI / 180; // fly-by-wire AoA limiter
const G_LIMIT = 9;
const NEG_G_LIMIT = -3;
const EYE_HEIGHT_GEAR = 3.0; // eye above ground on the wheels
const EYE_HEIGHT_BELLY = 1.3;
const AB_DETENT = 0.85;

export interface ControlInput {
  pitch: number; // -1..1, +1 = stick back (nose up)
  roll: number; // -1..1, +1 = roll right
  yaw: number; // -1..1, +1 = right rudder
  throttle: number; // 0..1 lever position, above 0.85 is afterburner
  brakes: number; // 0..1
  gearDown: boolean;
  speedbrake: boolean;
}

export const neutralInput = (): ControlInput => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0, brakes: 0, gearDown: true, speedbrake: false,
});

export type SimEvent =
  | { type: 'touchdown'; sinkRate: number }
  | { type: 'hardLanding'; sinkRate: number }
  | { type: 'crash'; reason: string }
  | { type: 'liftoff' }
  | { type: 'gloc' }
  | { type: 'flameout' };

export interface AircraftState {
  pos: Vector3; // pilot's eye position, world meters
  vel: Vector3;
  quat: Quaternion;
  engineRunning: boolean;
  rpm: number; // 0..1, idle ~0.68
  afterburner: number; // 0..1
  fuel: number; // kg internal
  fuelFlow: number; // kg/s
  thrust: number; // N
  gearPos: number; // 0 up .. 1 down
  speedbrakePos: number;
  onGround: boolean;
  damage: number; // 0..100
  destroyed: boolean;
  gLoad: number; // felt load factor along the seat
  alpha: number; // rad
  beta: number; // rad
  gStress: number; // 0..1, 1 = blacked out
  redStress: number;
  gloc: boolean;
  time: number;
}

export function airDensity(alt: number) {
  return 1.225 * Math.exp(-alt / 8500);
}
export function speedOfSound(alt: number) {
  return Math.max(295, 340.3 - 0.0040 * alt);
}

const tmpEuler = new Euler(0, 0, 0, 'YXZ');

export class Aircraft {
  s: AircraftState;
  private wasOnGround = true;

  constructor(private terrain: Terrain) {
    this.s = Aircraft.blankState();
  }

  static blankState(): AircraftState {
    return {
      pos: new Vector3(), vel: new Vector3(), quat: new Quaternion(),
      engineRunning: true, rpm: 0.68, afterburner: 0, fuel: INTERNAL_FUEL, fuelFlow: 0, thrust: 0,
      gearPos: 1, speedbrakePos: 0, onGround: true, damage: 0, destroyed: false,
      gLoad: 1, alpha: 0, beta: 0, gStress: 0, redStress: 0, gloc: false, time: 0,
    };
  }

  /** Place on the ground at (x, z) facing headingDeg (0 = north), engine idling. */
  resetOnGround(x: number, z: number, headingDeg: number) {
    this.s = Aircraft.blankState();
    const y = this.terrain.heightAt(x, z) + EYE_HEIGHT_GEAR;
    this.s.pos.set(x, y, z);
    this.s.quat.setFromEuler(new Euler(0, -headingDeg * Math.PI / 180, 0, 'YXZ'));
    this.wasOnGround = true;
  }

  /** Airborne start in level flight. */
  resetInAir(x: number, alt: number, z: number, headingDeg: number, speed: number) {
    this.s = Aircraft.blankState();
    const hdg = headingDeg * Math.PI / 180;
    this.s.pos.set(x, alt, z);
    this.s.quat.setFromEuler(new Euler(0.06, -hdg, 0, 'YXZ'));
    this.s.vel.set(Math.sin(hdg), 0, -Math.cos(hdg)).multiplyScalar(speed);
    this.s.gearPos = 0;
    this.s.onGround = false;
    this.s.rpm = 0.9;
    this.wasOnGround = false;
  }

  get mass() {
    return DRY_MASS + this.s.fuel;
  }

  /** Heading (deg, 0..360), pitch (deg), bank (deg, right positive). */
  attitude() {
    tmpEuler.setFromQuaternion(this.s.quat, 'YXZ');
    let hdg = (-tmpEuler.y * 180) / Math.PI;
    hdg = ((hdg % 360) + 360) % 360;
    return { heading: hdg, pitch: (tmpEuler.x * 180) / Math.PI, bank: (-tmpEuler.z * 180) / Math.PI };
  }

  step(dt: number, raw: ControlInput, events: SimEvent[]) {
    const s = this.s;
    s.time += dt;
    if (s.destroyed) return;

    // A blacked-out pilot can't fly.
    const input: ControlInput = s.gloc ? { ...raw, pitch: 0, roll: 0, yaw: 0 } : raw;

    const fwd = new Vector3(0, 0, -1).applyQuaternion(s.quat);
    const up = new Vector3(0, 1, 0).applyQuaternion(s.quat);
    const right = new Vector3(1, 0, 0).applyQuaternion(s.quat);

    const alt = s.pos.y;
    const rho = airDensity(alt);
    const speed = s.vel.length();
    const q = 0.5 * rho * speed * speed;
    const mach = speed / speedOfSound(alt);
    const vDir = speed > 1 ? s.vel.clone().divideScalar(speed) : fwd.clone();

    // Angle of attack and sideslip.
    const vF = s.vel.dot(fwd);
    const vU = s.vel.dot(up);
    const vR = s.vel.dot(right);
    s.alpha = speed > 5 ? Math.atan2(-vU, Math.max(vF, 0.1)) : 0;
    s.beta = speed > 5 ? Math.atan2(vR, Math.max(vF, 0.1)) : 0;

    // ---------- Engine ----------
    const throttle = Math.min(1, Math.max(0, input.throttle));
    if (s.fuel <= 0 && s.engineRunning) {
      s.engineRunning = false;
      events.push({ type: 'flameout' });
    }
    const milLever = Math.min(throttle / AB_DETENT, 1);
    const rpmTarget = s.engineRunning ? 0.68 + 0.32 * milLever : 0;
    const spool = rpmTarget > s.rpm ? 0.22 : 0.3;
    s.rpm += Math.sign(rpmTarget - s.rpm) * Math.min(Math.abs(rpmTarget - s.rpm), spool * dt);
    const wantAB = s.engineRunning && throttle > AB_DETENT + 0.01 && s.rpm > 0.97;
    const abTarget = wantAB ? 0.3 + 0.7 * (throttle - AB_DETENT) / (1 - AB_DETENT) : 0;
    s.afterburner += (abTarget - s.afterburner) * Math.min(1, dt * 3);
    const core = Math.max(0, (s.rpm - 0.68) / 0.32);
    const lapse = Math.pow(rho / 1.225, 0.75);
    s.thrust = s.engineRunning
      ? (MIL_THRUST * (0.05 + 0.95 * Math.pow(core, 1.5)) + (AB_THRUST - MIL_THRUST) * s.afterburner) * lapse
      : 0;
    s.fuelFlow = s.engineRunning ? 0.07 + 1.05 * Math.pow(core, 1.3) + 4.6 * s.afterburner : 0;
    s.fuel = Math.max(0, s.fuel - s.fuelFlow * dt);

    // ---------- Gear and speedbrake ----------
    const gearTarget = input.gearDown || s.onGround ? 1 : 0;
    s.gearPos += Math.sign(gearTarget - s.gearPos) * Math.min(Math.abs(gearTarget - s.gearPos), dt / 5);
    const sbTarget = input.speedbrake ? 1 : 0;
    s.speedbrakePos += Math.sign(sbTarget - s.speedbrakePos) * Math.min(Math.abs(sbTarget - s.speedbrakePos), dt / 1.5);

    // ---------- Aerodynamics ----------
    const flaps = s.gearPos * 0.25; // flaperons droop with the gear down
    const a = s.alpha;
    let cl: number;
    const stallA = 30 * Math.PI / 180;
    if (Math.abs(a) < stallA) cl = CL_ALPHA * a;
    else cl = Math.sign(a) * CL_ALPHA * stallA * Math.max(0.35, 1 - (Math.abs(a) - stallA) * 2);
    cl += flaps;
    const wave = 0.075 * smooth(0.82, 1.08, mach) - 0.02 * smooth(1.2, 1.8, mach);
    const cd = 0.024 + 0.115 * cl * cl + 0.03 * s.gearPos + 0.07 * s.speedbrakePos + wave;

    const force = new Vector3();
    // Lift acts perpendicular to the velocity, toward the canopy.
    const liftDir = up.clone().addScaledVector(vDir, -up.dot(vDir));
    if (liftDir.lengthSq() > 1e-6) liftDir.normalize();
    force.addScaledVector(liftDir, q * WING_AREA * cl);
    force.addScaledVector(vDir, -q * WING_AREA * cd);
    // Side force from sideslip.
    const sideDir = right.clone().addScaledVector(vDir, -right.dot(vDir));
    if (sideDir.lengthSq() > 1e-6) sideDir.normalize();
    force.addScaledVector(sideDir, -q * WING_AREA * 1.1 * s.beta);
    force.addScaledVector(fwd, s.thrust);

    const m = this.mass;
    const accel = force.clone().divideScalar(m);
    accel.y -= G;

    // ---------- Fly-by-wire attitude control ----------
    const authority = Math.min(1, Math.max(0.04, q / 9000));
    const omega = new Vector3();

    if (!s.onGround) {
      // Rotation needed to follow the curving flight path (keeps AoA steady).
      const vEff = Math.max(speed, 25);
      const aPerp = accel.clone().addScaledVector(vDir, -accel.dot(vDir));
      const omegaPath = vDir.clone().cross(aPerp).divideScalar(vEff);
      if (omegaPath.length() > 1.5) omegaPath.setLength(1.5);
      omega.add(omegaPath);

      // Pitch: the stick commands G. Neutral stick holds 1 G.
      const p = input.pitch;
      const nCmd = p >= 0 ? 1 + p * (G_LIMIT - 1) : 1 + p * (1 - NEG_G_LIMIT);
      const qs = Math.max(q * WING_AREA, 1);
      let alphaReq = (nCmd * m * G) / (qs * CL_ALPHA) - flaps / CL_ALPHA;
      alphaReq = Math.min(ALPHA_LIMIT, Math.max(-0.12, alphaReq));
      const pitchRate = clamp(4 * (alphaReq - s.alpha), -0.6 * authority - 0.05, 0.6 * authority + 0.05);
      omega.addScaledVector(right, pitchRate);

      // Roll about the velocity vector, like a real FBW jet.
      const rollRate = input.roll * 3.6 * Math.min(1, authority * 1.4);
      omega.addScaledVector(vDir, rollRate);

      // Yaw: rudder plus weathervane stability.
      const yawRate = input.yaw * 0.35 * authority + 3 * s.beta;
      omega.addScaledVector(up, -yawRate);
    }

    // ---------- Integrate ----------
    s.vel.addScaledVector(accel, dt);
    s.pos.addScaledVector(s.vel, dt);
    integrateQuat(s.quat, omega, dt);

    // ---------- Ground contact ----------
    const groundY = this.terrain.heightAt(s.pos.x, s.pos.z);
    const gearH = EYE_HEIGHT_BELLY + (EYE_HEIGHT_GEAR - EYE_HEIGHT_BELLY) * s.gearPos;
    const att = this.attitude();
    let normalAccel = 0;

    if (s.pos.y - groundY <= gearH) {
      const sink = -s.vel.y;
      if (!this.wasOnGround) {
        const gearOk = s.gearPos > 0.98;
        const slope = Math.abs(this.terrain.heightAt(s.pos.x + 20, s.pos.z) - groundY) +
          Math.abs(this.terrain.heightAt(s.pos.x, s.pos.z + 20) - groundY);
        if (slope > 4) this.crash(events, 'Flew into the terrain');
        else if (speed > 100) this.crash(events, 'Hit the ground far too fast');
        else if (!gearOk) this.crash(events, 'Belly landing: the gear was not down');
        else if (Math.abs(att.bank) > 20) this.crash(events, 'Wingtip strike: too much bank on touchdown');
        else if (att.pitch < -6 || sink > 9) this.crash(events, 'Flew into the ground');
        else if (sink > 3.5) {
          s.damage = Math.min(100, s.damage + (sink - 3.5) * 18);
          events.push({ type: 'hardLanding', sinkRate: sink });
        } else events.push({ type: 'touchdown', sinkRate: sink });
        if (s.destroyed) return;
      }
      s.onGround = true;
      s.pos.y = groundY + gearH;
      if (s.vel.y < 0) {
        normalAccel = -s.vel.y / dt;
        s.vel.y = 0;
      }
      this.groundHandling(dt, input, att, q, normalAccel);
    } else if (s.onGround && s.pos.y - groundY > gearH + 0.3) {
      s.onGround = false;
      events.push({ type: 'liftoff' });
    } else if (s.onGround) {
      // Small bounce: keep treating as on ground.
      this.groundHandling(dt, input, att, q, 0);
    }
    this.wasOnGround = s.onGround;

    // ---------- Felt G, blackout ----------
    const specific = force.clone().divideScalar(m);
    const felt = specific.dot(up) / G + (s.onGround ? Math.max(0, 1 - specific.y / G) * up.y : 0);
    s.gLoad += (felt - s.gLoad) * Math.min(1, dt * 10);
    const n = s.gLoad;
    if (n > 5) s.gStress += Math.pow(n - 5, 1.5) * 0.016 * dt;
    else s.gStress -= (n < 3 ? 0.12 : 0.05) * dt;
    s.gStress = clamp(s.gStress, 0, 1);
    if (n < -2) s.redStress += (-n - 2) * 0.12 * dt;
    else s.redStress -= 0.15 * dt;
    s.redStress = clamp(s.redStress, 0, 1);
    if (!s.gloc && s.gStress >= 1) {
      s.gloc = true;
      events.push({ type: 'gloc' });
    }
    if (s.gloc && s.gStress < 0.55) s.gloc = false;

    // ---------- Structural limits ----------
    if (n > 10.5 || n < -4.5) s.damage += (Math.abs(n) - (n > 0 ? 10.5 : 4.5)) * 25 * dt;
    const kts = speed * 1.944;
    if (s.gearPos > 0.05 && kts > 320 && !s.onGround) s.damage += (kts - 320) * 0.15 * dt;
    if (mach > 1.6) s.damage += (mach - 1.6) * 40 * dt;
    if (s.damage >= 100) this.crash(events, 'Airframe destroyed by overstress');
  }

  private groundHandling(dt: number, input: ControlInput, att: { heading: number; pitch: number }, q: number, _n: number) {
    const s = this.s;
    let heading = att.heading * Math.PI / 180;
    let pitch = att.pitch * Math.PI / 180;

    const hDir = new Vector3(Math.sin(heading), 0, -Math.cos(heading));
    let along = s.vel.dot(hDir);

    // Nosewheel steering at taxi speed, rudder authority at high speed.
    const steer = clamp(input.yaw + (Math.abs(along) < 30 ? input.roll * 0.6 : 0), -1, 1);
    const nwsRate = Math.min(0.7, Math.abs(along) / 14) * Math.max(0, 1 - Math.abs(along) / 45);
    const rudderRate = 0.08 * Math.min(1, q / 6000);
    heading += steer * (nwsRate + rudderRate) * Math.sign(along || 1) * dt;

    // Rolling friction and wheel brakes, scaled by weight still on the wheels.
    const liftFrac = clamp((q * WING_AREA * CL_ALPHA * Math.max(pitch, 0)) / (this.mass * G), 0, 1);
    const onWheels = 1 - liftFrac;
    const decel = (0.25 + input.brakes * 5.5) * onWheels * dt;
    if (Math.abs(along) <= decel) along = 0;
    else along -= Math.sign(along) * decel;

    // Rotate for takeoff once there is enough airflow over the tail.
    const rotAuthority = clamp((q - 1800) / 3000, 0, 1);
    const targetPitch = input.pitch > 0 ? input.pitch * 0.23 * rotAuthority : 0;
    const pitchRate = 0.12 + 0.1 * rotAuthority;
    pitch += clamp(targetPitch - pitch, -pitchRate * dt, pitchRate * dt);
    pitch = clamp(pitch, 0, 0.24);

    const newDir = new Vector3(Math.sin(heading), 0, -Math.cos(heading));
    s.vel.set(newDir.x * along, Math.max(s.vel.y, 0), newDir.z * along);
    s.quat.setFromEuler(new Euler(pitch, -heading, 0, 'YXZ'));
  }

  private crash(events: SimEvent[], reason: string) {
    if (this.s.destroyed) return;
    this.s.destroyed = true;
    this.s.damage = 100;
    this.s.engineRunning = false;
    this.s.vel.set(0, 0, 0);
    events.push({ type: 'crash', reason });
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
function smooth(e0: number, e1: number, x: number) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

const tmpQ = new Quaternion();
function integrateQuat(q: Quaternion, w: Vector3, dt: number) {
  const angle = w.length() * dt;
  if (angle < 1e-9) return;
  tmpQ.setFromAxisAngle(w.clone().normalize(), angle);
  q.premultiply(tmpQ).normalize();
}

export const CONSTANTS = { INTERNAL_FUEL, AB_DETENT, G_LIMIT };
