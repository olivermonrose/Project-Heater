# Project Heater

A low-spec, cockpit-only combat flight game for the browser, built to run well on a MacBook Air.
You fly the **KR-7 Kestrel**, a fictional single-engine multirole fighter, over a fictional desert.
Realism sits around "study-lite": a simple startup, taxi, takeoff, the mission, landing and shutdown,
all from the cockpit, with limited fuel and weapons.

## Play

- **Easiest:** download `ProjectHeater.html` (built by `npm run build` into `dist/`) and double-click it. It opens in Safari or Chrome with no install.
- **Online:** once GitHub Pages is on, every push to `main` deploys to `https://olivermonrose.github.io/project-heater/`.
- **Develop:** `npm install`, then `npm run dev` and open the printed URL.

Plug in an Xbox controller (wired Elite Series 2 works) and press any button.

| Xbox controller | Action |
| --- | --- |
| Left stick | Flight stick (pull back = nose up) |
| RT / LT | Throttle up / down. The lever stops at the afterburner detent; release and push again for AB |
| LB / RB | Rudder and nosewheel steering |
| Right stick | Look around the cockpit; release to look ahead. Click to reset |
| A (hold) | Wheel brakes |
| View button | Switch mode: right stick moves your head and the view stays, A presses the switch under the dot, B exits |
| D-pad left / right | Left / right screen page |
| Y / B | Landing gear / speedbrake |
| A in the air | Drop a bomb / fire the gun (MASTER ARM must be ARM) |
| X | Pod mode: right stick slews the pod, click it to lock, D-pad up/down zoom, left next target area, right big pod view, X again exits |
| Left stick click | Change weapon (guided bombs / gun) |
| D-pad down (hold) | Chaff and flares |
| D-pad up (hold) | Zoom the view in |
| Menu | Pause |

Keyboard and trackpad: click switches directly (or F for switch mode and Enter to press), M / comma change the left / right screen page, Space fires, T pod mode, I J K L slew the pod, U lock, [ ] pod zoom, O big pod view, 1-3 cue a target area, X change weapon, W/S pitch, A/D roll, Q/E rudder, Shift/Ctrl throttle, B brakes, G gear, V speedbrake, Z chaff and flares, drag or arrows to look, C reset view, Esc pause, R restart.

## Roadmap

1. **Flight, cockpit and airfield**: flight model with fly-by-wire G and AoA limits, stall, blackout/G-LOC, fuel burn, gear and brakes, taxi/takeoff/landing, look-around cockpit, collimated HUD, ENG and NAV MFD pages, damage gauge.
2. **Cold start and shutdown**: battery, fuel master, jet fuel starter, engine light-off and spool, generator, avionics power, nav lights, canopy, parking brake. Clickable switches, a checklist MFD page that ticks itself off, and a flight debrief after a full shutdown.
3. **Targeting pod and ground attack**: an infrared pod camera on the right MFD (or a big picture-in-picture view), slew, zoom, point and area track, four laser-guided bombs, a 510-round gun with a HUD pipper, and three target areas (supply depot, armor column, SAM site) marked on the NAV page.
4. **Threats and countermeasures** (this increment): a radar SAM site with three launchers, radar-directed anti-aircraft guns, shoulder-fired heat-seeking missile teams, a radar warning display with tones, a missile warning, 60 chaff and 60 flares, missile hits that fill the damage gauge (heavy damage costs thrust and leaks fuel), and a NAV page ring showing the SAM's reach.
5. **Air-to-air**: radar page, IR and radar missiles, gun, enemy fighter AI.
6. **Standalone missions**, then **online multiplayer**, then night mode.

## Cold start in 30 seconds

Choose **Cold start on the ramp** and follow the CHECKLIST page on the left screen:
BATTERY on, FUEL MASTER on, JFS start, wait for 20% RPM, ENGINE run, wait for idle (68%) and the generator,
AVIONICS on, NAV LIGHTS on, CANOPY close, PARK BRAKE off. After landing, the same page shows the shutdown list.

## First bombing run

1. Air start, flip **MASTER ARM** to ARM (it is already armed on an air start).
2. Press **X** for pod mode. The pod starts on target area A (supply depot); D-pad left cycles A, B, C.
3. Zoom in with D-pad up, slew the crosshair onto a target with the right stick, click the stick to lock (POINT).
4. Fly toward it. When the HUD says **IN RNG PICKLE**, press **A**. Keep the pod on the target until impact (watch TOF); don't fly so far past it that the pod is MASKED.
5. For the gun, click the left stick to pick GUN, dive at a target and put the HUD pipper on it.

## Surviving the air defences

- **Radar warning display** (centre of the panel, under the UFC): **S** is the SAM radar, **A** an anti-aircraft gun. Outer ring and green = it can see you. Middle ring, amber with a box = it is locked on. Inner ring, red and flashing with LAUNCH = a missile is guiding on you. Red diamonds are missiles coming at you; the HUD flashes **MISSILE**.
- **SAM** (target area C, red dashed ring on the NAV page, about 7.5 nm): when it launches, turn until the S sits off your wingtip (you are "in the notch", flying across its beam) and hold D-pad down for chaff. Chaff works much better in the notch. Below about 150 ft, or behind a mountain, the radar can't see you at all. Kill the radar and its missiles go dumb.
- **Heat seekers** (with the armor column and the depot): no radar warning, just MISSILE. Drop flares and come out of afterburner. They can't reach you above about 13,000 ft.
- **Guns** (around every target area): stay above about 13,000 ft, or keep turning and changing altitude if you go low.

## Code layout

- `src/sim/` pure simulation (terrain, flight model). No rendering, so it can also run on a multiplayer server later.
- `src/render/` Three.js world (with procedural ground detail, scrub and boulders), cockpit (`cockpitDetail.ts` holds panels, gauges, stick and throttle), MFDs and HUD.
- `src/input/` controller and keyboard mapping.
- `npm run bomb-check` flies a guided-bomb attack and a gun pass against the targets; `npm run top-speed` reports top speed by altitude.
- `npm run threat-check` flies scripted passes against each air defence, with and without chaff, flares and the notch.
- `npm run flight-check` runs a scripted takeoff, 9 G pull and landing against the flight model.
