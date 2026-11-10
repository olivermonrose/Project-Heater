import { Vector3 } from 'three';
import { Terrain } from '../src/sim/terrain';
import { Aircraft, neutralInput, SimEvent } from '../src/sim/aircraft';
import { Combat, SITES } from '../src/sim/combat';
import { Threats, ThreatEvent } from '../src/sim/threats';

// Headless checks of the air defences: does each threat engage, hit an
// undefended jet, and can chaff, flares, the notch and altitude defeat it?

const t = new Terrain(7);
const dt = 1 / 120;

interface Plan {
  start: [number, number, number, number, number]; // x, alt(ft MSL above base), z, hdg, speed
  /** Called each step: returns desired heading and altitude, whether to dispense. */
  fly: (a: Aircraft, th: Threats, time: number) => { hdg: number; alt: number; dispense: boolean; throttle?: number };
  seconds: number;
  /** Only these defences are active (others start destroyed). */
  only?: string[];
}

function run(plan: Plan) {
  const a = new Aircraft(t);
  const c = new Combat(t);
  const th = new Threats(t);
  if (plan.only) for (const tg of c.targets) if (['samRadar', 'aaa', 'manpads'].includes(tg.kind) && !plan.only.includes(tg.kind)) tg.destroyed = true;
  th.reset(c);
  const [x, altFt, z, hdg, spd] = plan.start;
  a.resetInAir(x, 300 + altFt / 3.281, z, hdg, spd);
  const input = neutralInput();
  input.gearDown = false;
  input.throttle = 0.8;
  const ev: SimEvent[] = [];
  const tev: ThreatEvent[] = [];
  const log = { launches: 0, hits: 0, damage: 0, evaded: 0, shellHits: 0, destroyed: '', firstLaunchRange: 0, maxState: '' };
  for (let i = 0; i < plan.seconds * 120; i++) {
    const time = i * dt;
    const want = plan.fly(a, th, time);
    if (want.throttle !== undefined) input.throttle = want.throttle;
    const att = a.attitude();
    let he = want.hdg - att.heading;
    he = ((he + 540) % 360) - 180;
    const wantBank = Math.max(-75, Math.min(75, he * 3));
    input.roll = Math.max(-1, Math.min(1, (wantBank - att.bank) * 0.04));
    const bankRad = (att.bank * Math.PI) / 180;
    const pitchCmd = (want.alt - a.s.pos.y) * 0.002 - a.s.vel.y * 0.03 + (1 / Math.max(0.3, Math.cos(bankRad)) - 1) * 0.25;
    input.pitch = Math.max(-1, Math.min(1, pitchCmd));
    ev.length = 0;
    a.step(dt, input, ev);
    tev.length = 0;
    th.step(dt, a, want.dispense, tev, ev);
    for (const e of tev) {
      if (e.type === 'missileLaunch') {
        log.launches++;
        if (!log.firstLaunchRange) log.firstLaunchRange = Math.round(e.pos.distanceTo(a.s.pos));
      }
      if (e.type === 'missileDetonate' && e.hitPlayer) {
        log.hits++;
        log.damage += e.damage;
      }
      if (e.type === 'missileEvaded') log.evaded++;
      if (e.type === 'shellHit') log.shellHits++;
    }
    for (const e of ev) if (e.type === 'crash') log.destroyed = e.reason;
    for (const r of th.rwr) if (r.state === 'launch' || (r.state === 'track' && log.maxState !== 'launch')) log.maxState = r.state;
    if (a.s.destroyed) break;
  }
  log.damage = Math.round(log.damage);
  return { ...log, finalDamage: Math.round(a.s.damage), chaff: th.chaff, flares: th.flares };
}

const sam = SITES[2];
const bearingTo = (a: Aircraft, x: number, z: number) => ((Math.atan2(x - a.s.pos.x, -(z - a.s.pos.z)) * 180) / Math.PI + 360) % 360;

function trials(name: string, n: number, plan: () => Plan) {
  const results = [];
  for (let i = 0; i < n; i++) results.push(run(plan()));
  const launched = results.filter((r) => r.launches > 0).length;
  const hit = results.filter((r) => r.hits + r.shellHits > 0).length;
  const killed = results.filter((r) => r.destroyed).length;
  const avgDmg = Math.round(results.reduce((s, r) => s + r.finalDamage, 0) / n);
  console.log(`${name}: engaged ${launched}/${n}, hit ${hit}/${n}, destroyed ${killed}/${n}, avg damage ${avgDmg}%`);
  console.log("   e.g.", JSON.stringify(results[0]));
  if (process.env.ALL) for (const r of results) console.log("     ", r.finalDamage, r.shellHits, r.destroyed);
}

// 1. SAM: fly straight at the site at 20,000 ft, no defence.
trials('SAM, straight in at 20k ft, no chaff', 6, () => ({
  start: [sam.x - 30000, 20000, sam.z + 2000, 90, 230],
  fly: (a) => ({ hdg: bearingTo(a, sam.x, sam.z), alt: 300 + 20000 / 3.281, dispense: false }),
  seconds: 90,
    only: ['samRadar'],
}));

// 2. SAM: same, but on launch turn to put the site on the beam and dispense chaff.
trials('SAM, beam + chaff after launch', 10, () => {
  let launchedAt = -1;
  return {
    start: [sam.x - 30000, 20000, sam.z + 2000, 90, 230],
    fly: (a, th, time) => {
      if (launchedAt < 0 && th.missiles.length > 0) launchedAt = time;
      const brg = bearingTo(a, sam.x, sam.z);
      if (launchedAt < 0) return { hdg: brg, alt: 300 + 20000 / 3.281, dispense: false };
      const since = time - launchedAt;
      return { hdg: (brg + 90) % 360, alt: 300 + 18000 / 3.281, dispense: since > 6 && th.missileWarning && Math.floor(since * 2) % 3 === 0 };
    },
    seconds: 90,
    only: ['samRadar'],
  };
});

// 3. SAM: chaff only, no maneuver.
trials('SAM, chaff but flying straight at it', 10, () => ({
  start: [sam.x - 30000, 20000, sam.z + 2000, 90, 230],
  fly: (a, th) => ({ hdg: bearingTo(a, sam.x, sam.z), alt: 300 + 20000 / 3.281, dispense: th.missileWarning }),
  seconds: 90,
    only: ['samRadar'],
}));

// 4. SAM: beam only (notch), no chaff.
trials('SAM, beam only, no chaff', 10, () => {
  let launched = false;
  return {
    start: [sam.x - 30000, 20000, sam.z + 2000, 90, 230],
    fly: (a, th) => {
      if (th.missiles.length > 0) launched = true;
      const brg = bearingTo(a, sam.x, sam.z);
      return { hdg: launched ? (brg + 90) % 360 : brg, alt: 300 + 20000 / 3.281, dispense: false };
    },
    seconds: 90,
    only: ['samRadar'],
  };
});

// 5. Heat seekers at the armor column: low pass in afterburner, no flares.
const armor = SITES[1];
trials('MANPADS, low pass in AB, no flares', 10, () => ({
  start: [armor.x - 9000, 2500, armor.z + 300, 90, 250],
  fly: (a) => ({ hdg: 90, alt: 300 + 2500 / 3.281, dispense: false, throttle: 1 }),
  seconds: 70,
  only: ['manpads'],
}));
trials('MANPADS, low pass at mil power, flares on warning', 10, () => ({
  start: [armor.x - 9000, 2500, armor.z + 300, 90, 250],
  fly: (a, th) => ({ hdg: 90, alt: 300 + 2500 / 3.281, dispense: th.missileWarning, throttle: 0.8 }),
  seconds: 70,
  only: ['manpads'],
}));
trials('MANPADS, pass at 15k ft', 4, () => ({
  start: [armor.x - 9000, 15000, armor.z + 300, 90, 250],
  fly: () => ({ hdg: 90, alt: 300 + 15000 / 3.281, dispense: false }),
  seconds: 70,
  only: ['manpads'],
}));

// 6. AAA over the depot.
const depot = SITES[0];
trials('AAA, straight over the depot at 2,500 ft', 6, () => ({
  start: [depot.x - 9000, 2500, depot.z - 300, 90, 230],
  fly: () => ({ hdg: 90, alt: 300 + 2500 / 3.281, dispense: false }),
  seconds: 50,
  only: ['aaa'],
}));
trials('AAA, over the depot at 14,000 ft', 3, () => ({
  start: [depot.x - 9000, 14000, depot.z - 300, 90, 230],
  fly: () => ({ hdg: 90, alt: 300 + 14000 / 3.281, dispense: false }),
  seconds: 70,
  only: ['aaa'],
}));

// 7. Home base is out of SAM reach.
const a = new Aircraft(t);
a.resetInAir(0, 300 + 15000 / 3.281, 0, 0, 200);
const th = new Threats(t);
th.reset(new Combat(t));
th.step(dt, a, false, [], []);
console.log('SAM site to home base', Math.round(new Vector3(sam.x, 0, sam.z).length() / 1000), 'km; site elevation', Math.round(t.heightAt(sam.x, sam.z)), 'm');

// 8. Depot bombing run from home: is the SAM out of reach while lasing?
trials('Depot run from home at 15k ft (all defences)', 4, () => ({
  start: [0, 15000, 0, 66, 230],
  fly: (a) => ({ hdg: bearingTo(a, depot.x, depot.z), alt: 300 + 15000 / 3.281, dispense: false }),
  seconds: 55,
}));

// 9. Bomb the SAM radar from 15k ft, dropping chaff whenever a missile is inbound.
{
  let kills = 0, deaths = 0;
  const n = 10;
  const { noActions } = await import('../src/sim/combat');
  for (let k = 0; k < n; k++) {
    const a = new Aircraft(t);
    const c = new Combat(t);
    const th = new Threats(t);
    th.reset(c);
    const radar = c.targets.find((x) => x.kind === 'samRadar')!;
    const alt = 300 + 15000 / 3.281;
    a.resetInAir(radar.pos.x - 24000, alt, radar.pos.z + 3000, 90, 230);
    const input = neutralInput();
    input.gearDown = false;
    input.throttle = 0.8;
    c.tgp.point.copy(radar.pos);
    let act = noActions();
    act.lockToggle = true;
    c.step(dt, a.s, act, true, true, []);
    let released = false;
    const ev: SimEvent[] = [];
    for (let i = 0; i < 120 * 150 && !a.s.destroyed; i++) {
      const hdgTo = bearingTo(a, radar.pos.x, radar.pos.z);
      const att = a.attitude();
      const he = ((hdgTo - att.heading + 540) % 360) - 180;
      input.roll = Math.max(-1, Math.min(1, (Math.max(-60, Math.min(60, he * 3)) - att.bank) * 0.04));
      input.pitch = Math.max(-1, Math.min(1, (alt - a.s.pos.y) * 0.002 - a.s.vel.y * 0.03 + (1 / Math.max(0.3, Math.cos((att.bank * Math.PI) / 180)) - 1) * 0.25));
      ev.length = 0;
      a.step(dt, input, ev);
      act = noActions();
      if (!released && c.lgbSolution(a.s).inRange) {
        act.pickle = true;
        released = true;
      }
      c.step(dt, a.s, act, true, true, []);
      th.step(dt, a, th.missileWarning, [], ev);
      if (radar.destroyed) break;
    }
    if (radar.destroyed) kills++;
    if (a.s.destroyed) deaths++;
  }
  console.log(`Bomb the SAM radar from 15k ft with chaff: radar killed ${kills}/${n}, shot down ${deaths}/${n}`);
}
