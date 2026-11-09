import { Terrain } from '../src/sim/terrain';
import { Aircraft, neutralInput, SimEvent, speedOfSound } from '../src/sim/aircraft';
// Level flight at full afterburner: report the speed reached at several altitudes.
const t = new Terrain(7); const a = new Aircraft(t); const ev: SimEvent[] = []; const dt = 1 / 120;
for (const ft of [1500, 10000, 20000, 30000, 36000, 40000, 45000]) {
  const alt = ft / 3.281;
  a.resetInAir(0, alt, 30000, 0, 250);
  const c = neutralInput(); c.gearDown = false; c.throttle = 1;
  a.s.rpm = 1;
  let i = 0;
  for (; i < 120 * (ft < 5000 ? 110 : 300); i++) {
    // Simple altitude hold.
    const err = alt - a.s.pos.y;
    c.pitch = Math.max(-1, Math.min(1, err * 0.003 - a.s.vel.y * 0.02));
    a.s.fuel = 3200; ev.length = 0; a.step(dt, c, ev);
    if (a.s.destroyed) { console.log("destroyed", ft, ev.map(e=>JSON.stringify(e)).join()); break; }
  }
  const m = a.s.vel.length() / speedOfSound(a.s.pos.y);
  console.log(`${ft} ft: Mach ${m.toFixed(2)}, ${Math.round(a.s.vel.length() * 1.944)} kt TAS, fuel left ${Math.round(a.s.fuel * 2.2)} lb, dmg ${a.s.damage.toFixed(0)}`);
}
