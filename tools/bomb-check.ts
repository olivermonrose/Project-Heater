import { Terrain } from '../src/sim/terrain';
import { Aircraft, neutralInput, SimEvent } from '../src/sim/aircraft';
import { Combat, CombatEvent, noActions, SITES } from '../src/sim/combat';
// Fly level toward site A, track the warehouse with the pod, release a guided bomb when in range.
const t = new Terrain(7); const a = new Aircraft(t); const c = new Combat(t);
const ev: SimEvent[] = []; const cev: CombatEvent[] = []; const dt = 1 / 120;
const site = SITES[0];
const alt = 300 + 15000 / 3.281;
// Start 25 km south-west of the depot, pointing at it.
const sx = site.x - 18000, sz = site.z + 18000;
const hdg = (Math.atan2(site.x - sx, -(site.z - sz)) * 180) / Math.PI;
a.resetInAir(sx, alt, sz, hdg, 230);
const input = neutralInput(); input.gearDown = false; input.throttle = 0.8;
let act = noActions(); act.cueToSite = 'A';
c.step(dt, a.s, act, true, true, cev);
// Slew onto the first warehouse, then lock.
const wh = c.targets.find((x) => x.kind === 'warehouse')!;
c.tgp.point.copy(wh.pos);
act = noActions(); act.lockToggle = true; c.step(dt, a.s, act, true, true, cev);
console.log('tracking', c.tgp.tracking, 'target', c.tgp.trackedId, wh.kind);
let released = false;
for (let i = 0; i < 120 * 240; i++) {
  input.pitch = Math.max(-1, Math.min(1, (alt - a.s.pos.y) * 0.003 - a.s.vel.y * 0.02));
  ev.length = 0; a.step(dt, input, ev);
  act = noActions();
  const sol = c.lgbSolution(a.s);
  if (!released && sol.inRange) { act.pickle = true; released = true; console.log(`release at range ${(c.tgp.range / 1852).toFixed(1)} nm, tof ${sol.timeOfFlight.toFixed(0)} s, along ${sol.along.toFixed(0)} m`); }
  cev.length = 0; c.step(dt, a.s, act, true, true, cev);
  for (const e of cev) {
    if (e.type === 'bombImpact') console.log('impact', e.hit ? 'HIT' : 'miss', 'dist to warehouse', e.pos.distanceTo(wh.pos).toFixed(1), 'm');
    if (e.type === 'targetDestroyed') console.log('destroyed', e.target.kind);
  }
  if (released && c.bombs.length === 0) break;
}
console.log('targets left', c.liveCount(), 'of', c.targets.length);
// Gun: dive at a truck.
const truck = c.targets.find((x) => x.kind === 'truck' && !x.destroyed)!;
const tp = truck.pos;
a.resetInAir(tp.x, tp.y + 900, tp.z + 2400, 0, 200);
// point straight at truck
const dir = tp.clone().sub(a.s.pos).normalize();
a.s.vel.copy(dir).multiplyScalar(200);
const { Vector3 } = await import('three');
a.s.quat.setFromUnitVectors(new Vector3(0, 0, -1), dir);
c.weapon = 'GUN';
for (let i = 0; i < 120 * 10; i++) {
  input.pitch = 0;
  ev.length = 0; a.step(dt, input, ev);
  // keep nose on target
  const dist = tp.distanceTo(a.s.pos); const tof = dist / 1200;
  const d = tp.clone().add(new Vector3(0, 0.5 * 9.81 * tof * tof, 0)).sub(a.s.pos).normalize();
  a.s.quat.setFromUnitVectors(new Vector3(0, 0, -1), d);
  act = noActions(); act.trigger = a.s.pos.distanceTo(tp) < 1200;
  cev.length = 0; c.step(dt, a.s, act, true, true, cev);
  for (const e of cev) if (e.type === 'targetDestroyed') console.log('gun destroyed', e.target.kind, 'rounds left', c.gunLeft);
  if (truck.destroyed) break;
}
console.log('truck destroyed by gun', truck.destroyed);
