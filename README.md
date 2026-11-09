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
| Y / B | Landing gear / speedbrake |
| D-pad up / down | Zoom |
| Menu | Pause |

Keyboard: W/S pitch, A/D roll, Q/E rudder, Shift/Ctrl throttle, B brakes, G gear, V speedbrake, drag or arrows to look, C reset view, Esc pause, R restart.

## Roadmap

1. **Flight, cockpit and airfield** (this increment): flight model with fly-by-wire G and AoA limits, stall, blackout/G-LOC, fuel burn, gear and brakes, taxi/takeoff/landing, look-around cockpit, collimated HUD, ENG and NAV MFD pages, damage gauge.
2. **Cold start and shutdown**: short VTOL VR-style startup checklist with clickable/selectable switches.
3. **Targeting pod and ground attack**: TGP camera on an MFD, slew and lock ground targets, guided and unguided bombs.
4. **Threats and countermeasures**: SAM sites, AAA, radar warning receiver, chaff and flares.
5. **Air-to-air**: radar page, IR and radar missiles, gun, enemy fighter AI.
6. **Standalone missions**, then **online multiplayer**, then night mode.

## Code layout

- `src/sim/` pure simulation (terrain, flight model). No rendering, so it can also run on a multiplayer server later.
- `src/render/` Three.js world, cockpit, MFDs and HUD.
- `src/input/` controller and keyboard mapping.
- `npm run flight-check` runs a scripted takeoff, 9 G pull and landing against the flight model.
