import { AircraftState, ControlInput } from './sim/aircraft';

export interface CheckItem {
  text: string;
  done: boolean;
}

export type ChecklistPhase = 'startup' | 'taxi' | 'flight' | 'shutdown' | 'complete';

/** Works out which checklist applies and which items are done. Pure, so it is easy to test. */
export function checklist(s: AircraftState, c: ControlInput, hasFlown: boolean): { phase: ChecklistPhase; title: string; items: CheckItem[] } {
  const sw = c.switches;
  const kts = s.vel.length() * 1.944;
  if (!s.onGround) {
    return {
      phase: 'flight', title: 'IN FLIGHT', items: [
        { text: 'GEAR UP after liftoff', done: s.gearPos < 0.01 },
        { text: 'Return: NAV page, HOME', done: false },
        { text: 'GEAR DOWN before landing', done: s.gearPos > 0.99 },
      ],
    };
  }
  if (hasFlown && kts < 30) {
    const items: CheckItem[] = [
      { text: 'Stop, PARK BRAKE set', done: kts < 1 && sw.parkingBrake },
      { text: 'THROTTLE idle', done: c.throttle < 0.02 },
      { text: 'ENGINE cutoff', done: !sw.engine },
      { text: 'JFS off', done: !s.jfsRunning },
      { text: 'AVIONICS off', done: !sw.avionics },
      { text: 'NAV LIGHTS off', done: !sw.navLights },
      { text: 'CANOPY open', done: !sw.canopyClosed && s.canopyPos < 0.02 },
      { text: 'BATTERY off', done: !sw.battery },
    ];
    const complete = items.every((i) => i.done) && s.rpm < 0.05;
    return { phase: complete ? 'complete' : 'shutdown', title: 'SHUTDOWN', items };
  }
  const items: CheckItem[] = [
    { text: 'BATTERY on', done: sw.battery },
    { text: 'FUEL MASTER on', done: sw.fuelMaster },
    { text: 'JFS start', done: sw.jfs || s.jfsRunning || s.engineRunning },
    { text: 'RPM 20%, ENGINE run', done: sw.engine && s.engineRunning },
    { text: 'Wait: idle 68%, GEN on', done: s.engineRunning && !s.starting && s.generator },
    { text: 'AVIONICS on', done: sw.avionics },
    { text: 'NAV LIGHTS on', done: sw.navLights },
    { text: 'CANOPY close', done: sw.canopyClosed && s.canopyPos > 0.99 },
    { text: 'PARK BRAKE off, taxi', done: !sw.parkingBrake },
  ];
  const ready = items.every((i) => i.done);
  return { phase: ready ? 'taxi' : 'startup', title: ready ? 'READY TO TAXI' : 'STARTUP', items };
}
