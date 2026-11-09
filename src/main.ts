import * as THREE from 'three';
import { Terrain } from './sim/terrain';
import { Aircraft, SimEvent } from './sim/aircraft';
import { Input } from './input/input';
import { buildWorld, RAMP_START, RUNWAY_START } from './render/world';
import { Cockpit } from './render/cockpit';
import { Hud } from './render/hud';
import { EngineAudio } from './audio';

const SIM_HZ = 120;

const glCanvas = document.getElementById('gl') as HTMLCanvasElement;
const hudCanvas = document.getElementById('hud') as HTMLCanvasElement;
const blackout = document.getElementById('blackout') as HTMLDivElement;
const msgEl = document.getElementById('msg') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const menu = document.getElementById('menu') as HTMLDivElement;
const padStatus = document.getElementById('padStatus') as HTMLDivElement;
const resumeBtn = document.getElementById('btnResume') as HTMLButtonElement;

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

type StartKind = 'ramp' | 'runway' | 'air';
let lastStart: StartKind = 'ramp';
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
  if (kind === 'ramp') aircraft.resetOnGround(RAMP_START.x, RAMP_START.z, RAMP_START.heading);
  else if (kind === 'runway') aircraft.resetOnGround(RUNWAY_START.x, RUNWAY_START.z, RUNWAY_START.heading);
  else aircraft.resetInAir(-6000, 300 + 8000 / 3.281, 9000, 20, 160);
  input.resetForNewFlight(kind === 'air');
  hud.resetMaxG();
  restartCountdown = -1;
  started = true;
  setPaused(false);
  audio.start();
  if (kind === 'ramp') showMessage('Taxi to runway 36: follow the yellow line east, then north along the taxiway', 7);
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
      case 'touchdown':
        showMessage(`Touchdown, ${Math.round(e.sinkRate * 196.85)} ft/min`, 3);
        break;
      case 'hardLanding':
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
        break;
    }
  }
}

let acc = 0;
let last = performance.now();
let fpsT = 0, fpsN = 0, fps = 0;
const events: SimEvent[] = [];

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  if (paused) {
    menuPad();
  } else {
    const ui = input.update(dt);
    if (ui.pause) setPaused(true);
    if (ui.restart) startFlight(lastStart);

    acc += dt;
    const step = 1 / SIM_HZ;
    events.length = 0;
    while (acc >= step) {
      aircraft.step(step, input.controls, events);
      acc -= step;
    }
    handleEvents(events);
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
  hud.draw(dt, cockpit.camera, cockpit.hudCorners(), s, aircraft.attitude(), terrain);

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
(window as unknown as { __game: unknown }).__game = { aircraft, input, startFlight, setPaused };
requestAnimationFrame(frame);
