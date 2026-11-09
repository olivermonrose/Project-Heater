import * as THREE from 'three';
import { Terrain } from './sim/terrain';
import { Aircraft, SimEvent } from './sim/aircraft';
import { Input } from './input/input';
import { buildWorld, RAMP_START, RUNWAY_START } from './render/world';
import { Cockpit } from './render/cockpit';
import { Hud } from './render/hud';
import { EngineAudio } from './audio';
import { checklist } from './checklist';

const SIM_HZ = 120;

const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
const hudCanvas = document.getElementById('hud') as HTMLCanvasElement;
const blackout = document.getElementById('blackout') as HTMLDivElement;
const msgEl = document.getElementById('msg') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const menu = document.getElementById('menu') as HTMLDivElement;
const padStatus = document.getElementById('padStatus') as HTMLDivElement;
const resumeBtn = document.getElementById('btnResume') as HTMLButtonElement;
const reticle = document.getElementById('reticle') as HTMLDivElement;
const tip = document.getElementById('tip') as HTMLDivElement;
const debrief = document.getElementById('debrief') as HTMLDivElement;

const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();

const terrain = new Terrain(7);
buildWorld(scene, terrain);
const aircraft = new Aircraft(terrain);
const cockpit = new Cockpit(terrain);
scene.add(cockpit.root);
const hud = new Hud(hudCanvas);
const input = new Input(glCanvas);
const audio = new EngineAudio();

type StartKind = 'cold' | 'hot' | 'runway' | 'air';
let lastStart: StartKind = 'cold';
const stats = { liftoffAt: -1, flightTime: 0, maxG: 1, fuelStart: 0, landings: 0, debriefShown: false };
let paused = true;
let started = false;
let msgTimer = 0;
let restartCountdown = -1;

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  cockpit.camera.aspect = w / h;
  cockpit.camera.updateProjectionMatrix();
  hud.resize(w, h, Math.min(window.devicePixelRatio, 2));
}
window.addEventListener('resize', resize);
resize();

function showMessage(text: string, seconds = 3) {
  msgEl.textContent = text;
  msgEl.style.display = 'block';
  msgTimer = seconds;
}

function startFlight(kind: StartKind) {
  lastStart = kind;
  if (kind === 'cold' || kind === 'hot') aircraft.resetOnGround(RAMP_START.x, RAMP_START.z, RAMP_START.heading, kind === 'cold');
  else if (kind === 'runway') aircraft.resetOnGround(RUNWAY_START.x, RUNWAY_START.z, RUNWAY_START.heading);
  else aircraft.resetInAir(-6000, 300 + 8000 / 3.281, 9000, 20, 160);
  input.resetForNewFlight(kind);
  cockpit.leftPage = kind === 'cold' ? 'CHK' : 'ENG';
  cockpit.hasFlown = kind === 'air';
  Object.assign(stats, { liftoffAt: kind === 'air' ? 0 : -1, flightTime: 0, maxG: 1, fuelStart: aircraft.s.fuel, landings: 0, debriefShown: false });
  debrief.style.display = 'none';
  hud.resetMaxG();
  restartCountdown = -1;
  started = true;
  setPaused(false);
  audio.start();
  if (kind === 'cold') showMessage('Cold and dark. Follow the CHECKLIST page on the left screen. Press View (or F) for switch mode', 9);
  else if (kind === 'hot') showMessage('Release the PARK BRAKE, then taxi east and south to runway 36', 7);
  else if (kind === 'runway') showMessage('Cleared for takeoff, runway 36. Full throttle, rotate at 150 knots', 6);
  else showMessage('Airborne. Home base is on your NAV page', 4);
}

function setPaused(p: boolean) {
  paused = p;
  menu.style.display = p ? 'flex' : 'none';
  resumeBtn.style.display = started ? '' : 'none';
  if (p) audio.suspend();
  else audio.start();
}

for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-start]'))) {
  b.addEventListener('click', () => startFlight(b.dataset.start as StartKind));
}
resumeBtn.addEventListener('click', () => setPaused(false));

// Controller navigation in the menu: D-pad / left stick to move, A to choose.
let menuIndex = 0;
let menuPrev: boolean[] = [];
function menuPad() {
  const pad = Array.from(navigator.getGamepads?.() ?? []).find((g) => g && g.connected) ?? null;
  padStatus.textContent = pad
    ? `Controller connected: ${pad.id.replace(/\(.*?\)/g, '').trim() || 'gamepad'}. Use the D-pad and A to choose.`
    : 'No controller detected. Plug in your controller and press any button.';
  if (!pad) return;
  const btns = Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).filter((b) => b.style.display !== 'none');
  const pressed = (i: number) => pad.buttons[i]?.pressed && !menuPrev[i];
  const ax = pad.axes[0] ?? 0;
  if (pressed(15) || pressed(13) || (ax > 0.6 && !menuPrev[99])) menuIndex = (menuIndex + 1) % btns.length;
  if (pressed(14) || pressed(12) || (ax < -0.6 && !menuPrev[98])) menuIndex = (menuIndex + btns.length - 1) % btns.length;
  btns.forEach((b, i) => b.classList.toggle('focus', i === menuIndex));
  if (pressed(0)) btns[menuIndex]?.click();
  else if (pressed(9) && started) setPaused(false);
  menuPrev = pad.buttons.map((b) => b.pressed);
  menuPrev[99] = ax > 0.6;
  menuPrev[98] = ax < -0.6;
}

function handleEvents(events: SimEvent[]) {
  for (const e of events) {
    switch (e.type) {
      case 'lightoff':
        showMessage('Light-off. Engine spooling to idle', 3);
        break;
      case 'jfsOff':
        input.controls.switches.jfs = false;
        break;
      case 'engineShutdown':
        if (aircraft.s.onGround) showMessage('Engine shut down', 3);
        else showMessage('Engine shut down in flight! ENGINE to RUN for an airstart', 5);
        break;
      case 'canopyDamaged':
        showMessage('Canopy torn off: you rolled with it open', 5);
        break;
      case 'touchdown':
        stats.landings++;
        showMessage(`Touchdown, ${Math.round(e.sinkRate * 196.85)} ft/min`, 3);
        break;
      case 'hardLanding':
        stats.landings++;
        showMessage(`Hard landing, ${Math.round(e.sinkRate * 196.85)} ft/min. Airframe damaged`, 4);
        break;
      case 'crash':
        showMessage(`${e.reason}. Restarting in a few seconds`, 6);
        restartCountdown = 5;
        break;
      case 'gloc':
        showMessage('G-LOC: you blacked out. Ease off the stick', 3);
        break;
      case 'flameout':
        showMessage('Engine flameout: out of fuel', 5);
        break;
      case 'liftoff':
        cockpit.hasFlown = true;
        if (stats.liftoffAt < 0) stats.liftoffAt = aircraft.s.time;
        break;
    }
  }
}

function showDebrief() {
  const s = aircraft.s;
  const mins = Math.floor(stats.flightTime / 60), secs = Math.round(stats.flightTime % 60);
  const used = (stats.fuelStart - s.fuel) * 2.2046;
  debrief.innerHTML = `<div class="card"><h1>Flight complete</h1>
    <p class="sub">Shutdown checklist done. Nice work, pilot.</p>
    <table>
      <tr><td>Flight time</td><td>${mins} min ${secs} s</td></tr>
      <tr><td>Landings</td><td>${stats.landings}</td></tr>
      <tr><td>Max G</td><td>${stats.maxG.toFixed(1)}</td></tr>
      <tr><td>Fuel used</td><td>${Math.round(used).toLocaleString()} lb</td></tr>
      <tr><td>Damage</td><td>${Math.round(s.damage)}%</td></tr>
    </table>
    <div class="buttons" style="margin-top:18px"><button id="dbAgain">Fly again</button><button id="dbMenu">Main menu</button></div></div>`;
  debrief.style.display = 'flex';
  document.getElementById('dbAgain')!.onclick = () => startFlight(lastStart);
  document.getElementById('dbMenu')!.onclick = () => {
    debrief.style.display = 'none';
    setPaused(true);
  };
}

let acc = 0;
let last = performance.now();
let debriefPrevA = true;
let fpsT = 0, fpsN = 0, fps = 0;
const events: SimEvent[] = [];

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (paused) {
    menuPad();
  } else if (debrief.style.display === 'flex') {
    const pad = Array.from(navigator.getGamepads?.() ?? []).find((g) => g && g.connected);
    if (pad?.buttons[0]?.pressed && !debriefPrevA) startFlight(lastStart);
    debriefPrevA = !!pad?.buttons[0]?.pressed;
  } else {
    const ui = input.update(dt);
    if (ui.pause) setPaused(true);
    if (ui.restart) startFlight(lastStart);
    if (ui.mfdPage) cockpit.cycleLeftPage(ui.mfdPage);

    // Cockpit switches: hover with the mouse or the centre reticle, click or press A.
    const w = window.innerWidth, h = window.innerHeight;
    const overMouse = input.mouse.x >= 0 && !input.interactMode
      ? cockpit.switches.pick(cockpit.camera, (input.mouse.x / w) * 2 - 1, -(input.mouse.y / h) * 2 + 1) : null;
    const overCenter = input.interactMode ? cockpit.switches.pick(cockpit.camera, 0, 0) : null;
    cockpit.switches.hovered = overCenter ?? overMouse;
    if (ui.click) {
      const hit = cockpit.switches.pick(cockpit.camera, (ui.click.x / w) * 2 - 1, -(ui.click.y / h) * 2 + 1);
      if (hit) hit.toggle(input.controls, aircraft.s);
    }
    if (ui.interactCenter && overCenter) overCenter.toggle(input.controls, aircraft.s);
    reticle.style.display = input.interactMode ? 'block' : 'none';
    const hov = cockpit.switches.hovered;
    if (hov) {
      const on = hov.get(input.controls, aircraft.s);
      tip.textContent = `${hov.label}: ${on ? hov.onText : hov.offText}  →  ${input.interactMode ? 'A' : 'click'} for ${on ? hov.offText : hov.onText}`;
      tip.style.display = 'block';
      const atMouse = !input.interactMode;
      tip.style.left = atMouse ? `${input.mouse.x}px` : '50%';
      tip.style.top = atMouse ? `${input.mouse.y + 24}px` : 'calc(50% + 22px)';
    } else tip.style.display = input.interactMode ? 'block' : 'none';
    if (!hov && input.interactMode) tip.textContent = 'SWITCH MODE: right stick to look, A to press, B or View to exit';
    glCanvas.style.cursor = overMouse ? 'pointer' : 'default';

    acc += dt;
    const step = 1 / SIM_HZ;
    events.length = 0;
    while (acc >= step) {
      aircraft.step(step, input.controls, events);
      acc -= step;
    }
    handleEvents(events);
    const st = aircraft.s;
    stats.maxG = Math.max(stats.maxG, st.gLoad);
    if (!st.onGround && stats.liftoffAt >= 0) stats.flightTime += dt;
    if (!stats.debriefShown && cockpit.hasFlown && !st.destroyed) {
      const list = checklist(st, input.controls, true);
      if (list.phase === 'complete') {
        stats.debriefShown = true;
        showDebrief();
      }
    }
    if (restartCountdown > 0) {
      restartCountdown -= dt;
      if (restartCountdown <= 0) startFlight(lastStart);
    }
  }

  const s = aircraft.s;
  cockpit.update(dt, s, input.controls, input.look);
  audio.update(s);

  // Blackout tunnel (grey-out from ~40% stress) and red-out.
  const st = Math.max(0, (s.gStress - 0.4) / 0.6);
  if (s.destroyed) {
    blackout.style.opacity = '0.85';
    blackout.style.background = '#000';
  } else if (s.redStress > 0.3) {
    blackout.style.opacity = String(Math.min(1, (s.redStress - 0.3) / 0.6));
    blackout.style.background = 'radial-gradient(circle, rgba(120,0,0,0.5) 20%, rgba(90,0,0,1) 75%)';
  } else {
    blackout.style.opacity = s.gloc ? '1' : String(Math.min(1, st * 1.1));
    const inner = Math.max(0, 45 - st * 45);
    blackout.style.background = `radial-gradient(circle, rgba(0,0,0,${0.15 + st * 0.85}) ${inner}%, #000 ${inner + 35}%)`;
  }

  renderer.render(scene, cockpit.camera);
  if (s.avionicsPower) hud.draw(dt, cockpit.camera, cockpit.hudCorners(), s, aircraft.attitude(), terrain);
  else hud.clear();

  if (msgTimer > 0) {
    msgTimer -= dt;
    if (msgTimer <= 0) msgEl.style.display = 'none';
  }
  fpsT += dt;
  fpsN++;
  if (fpsT > 0.5) {
    fps = Math.round(fpsN / fpsT);
    fpsT = fpsN = 0;
    const kts = Math.round(s.vel.length() * 1.944);
    statusEl.textContent = `${fps} fps · ${input.gamepadName ? 'controller' : 'keyboard'} · GS ${kts} kt · ${s.onGround ? 'on ground' : 'airborne'}`;
  }
}

// Expose a tiny hook for automated tests.
(window as unknown as { __game: unknown }).__game = { aircraft, input, cockpit, startFlight, setPaused };
requestAnimationFrame(frame);
