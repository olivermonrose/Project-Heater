import { ControlInput, CONSTANTS, coldSwitches, hotSwitches } from '../sim/aircraft';

// Standard gamepad mapping (Xbox Series / Elite controllers on macOS browsers).
const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

export interface LookInput {
  yaw: number; // radians, + = look left
  pitch: number; // radians, + = look up
  fov: number;
}

export interface UiActions {
  pause: boolean;
  restart: boolean;
  toggleHelp: boolean;
  recenter: boolean;
  interactCenter: boolean; // press whatever switch is under the centre reticle
  click: { x: number; y: number } | null; // mouse click in CSS pixels
  mfdPage: number; // -1 / +1 to cycle the left MFD page
}

function deadzone(v: number, dz = 0.12) {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return Math.sign(v) * (a - dz) / (1 - dz);
}
const expo = (v: number, e = 1.6) => Math.sign(v) * Math.pow(Math.abs(v), e);

export class Input {
  controls: ControlInput = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brakes: 0, gearDown: true, speedbrake: false, switches: hotSwitches() };
  /** Switch mode: the right stick moves your head and leaves it there, A presses the switch under the reticle. */
  interactMode = false;
  mouse = { x: -1, y: -1 };
  look: LookInput = { yaw: 0, pitch: 0, fov: 70 };
  gamepadName = '';
  invertPitch = false;

  private keys = new Set<string>();
  private pressedKeys = new Set<string>();
  private prevButtons: boolean[] = [];
  private mouseLook = { yaw: 0, pitch: 0 };
  private dragging = false;
  private padLook = { yaw: 0, pitch: 0 };
  private abGate = false; // must release and press again to cross into afterburner
  private downAt = { x: 0, y: 0 };
  private pendingClick: { x: number; y: number } | null = null;

  constructor(private canvas: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!this.keys.has(e.code)) this.pressedKeys.add(e.code);
      this.keys.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousedown', (e) => {
      this.dragging = true;
      this.downAt = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener('mouseup', (e) => {
      if (this.dragging && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) < 5) {
        this.pendingClick = { x: e.clientX, y: e.clientY };
      }
      this.dragging = false;
    });
    window.addEventListener('mousemove', (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      if (!this.dragging) return;
      this.mouseLook.yaw = clamp(this.mouseLook.yaw - e.movementX * 0.005, -2.6, 2.6);
      this.mouseLook.pitch = clamp(this.mouseLook.pitch - e.movementY * 0.005, -1.0, 1.4);
    });
    canvas.addEventListener('wheel', (e) => {
      this.look.fov = clamp(this.look.fov + e.deltaY * 0.03, 30, 90);
      e.preventDefault();
    }, { passive: false });
  }

  resetForNewFlight(kind: 'cold' | 'hot' | 'runway' | 'air') {
    const switches = kind === 'cold' ? coldSwitches() : hotSwitches();
    if (kind === 'hot') switches.parkingBrake = true;
    this.controls = {
      pitch: 0, roll: 0, yaw: 0, throttle: kind === 'air' ? 0.75 : 0, brakes: 0,
      gearDown: kind !== 'air', speedbrake: false, switches,
    };
    this.mouseLook = { yaw: 0, pitch: 0 };
    this.interactMode = false;
  }

  update(dt: number): UiActions {
    const ui: UiActions = { pause: false, restart: false, toggleHelp: false, recenter: false, interactCenter: false, click: this.pendingClick, mfdPage: 0 };
    this.pendingClick = null;
    const k = (c: string) => this.keys.has(c);
    const kp = (c: string) => this.pressedKeys.has(c);

    const pad = Array.from(navigator.getGamepads?.() ?? []).find((g) => g && g.connected) ?? null;
    this.gamepadName = pad ? pad.id : '';
    const b = (i: number) => !!pad && !!pad.buttons[i] && pad.buttons[i].pressed;
    const bv = (i: number) => (pad && pad.buttons[i] ? pad.buttons[i].value : 0);
    const bp = (i: number) => b(i) && !this.prevButtons[i];

    const c = this.controls;

    // ---- Flight stick ----
    let pitch = 0, roll = 0, yaw = 0;
    if (pad) {
      pitch = expo(deadzone(pad.axes[1] ?? 0, 0.08)); // stick toward you = nose up
      roll = expo(deadzone(pad.axes[0] ?? 0, 0.08));
      yaw = (b(BTN.RB) ? 1 : 0) - (b(BTN.LB) ? 1 : 0);
    }
    if (k('KeyS')) pitch = 1;
    if (k('KeyW')) pitch = -1;
    if (k('KeyD')) roll = 1;
    if (k('KeyA')) roll = -1;
    if (k('KeyE')) yaw = 1;
    if (k('KeyQ')) yaw = -1;
    if (this.invertPitch) pitch = -pitch;
    c.pitch = pitch;
    c.roll = roll;
    c.yaw = yaw;

    // ---- Throttle lever (persistent). RT = forward, LT = back. ----
    let thrRate = 0;
    if (pad) thrRate += bv(BTN.RT) - bv(BTN.LT);
    if (k('ShiftLeft') || k('ShiftRight')) thrRate += 1;
    if (k('ControlLeft') || k('ControlRight')) thrRate -= 1;
    const det = CONSTANTS.AB_DETENT;
    let thr = c.throttle + thrRate * 0.45 * dt;
    // Afterburner gate: the lever stops at the detent until you push again.
    if (c.throttle <= det && thr > det) {
      if (!this.abGate) thr = det;
    }
    if (thrRate <= 0.05) this.abGate = c.throttle >= det - 0.001;
    if (thr < det) this.abGate = false;
    c.throttle = clamp(thr, 0, 1);

    // ---- Brakes, gear, speedbrake ----
    // ---- Switch mode ----
    if (bp(BTN.VIEW) || kp('KeyF')) this.interactMode = !this.interactMode;
    if (this.interactMode && bp(BTN.B)) this.interactMode = false;
    if ((this.interactMode && bp(BTN.A)) || kp('Enter')) ui.interactCenter = true;
    if (bp(BTN.LEFT)) ui.mfdPage = -1;
    if (bp(BTN.RIGHT) || kp('KeyM')) ui.mfdPage = 1;

    c.brakes = (!this.interactMode && b(BTN.A)) || k('KeyB') ? 1 : 0;
    if (bp(BTN.Y) || kp('KeyG')) c.gearDown = !c.gearDown;
    if ((!this.interactMode && bp(BTN.B)) || kp('KeyV')) c.speedbrake = !c.speedbrake;

    // ---- Head look ----
    if (pad) {
      const rx = deadzone(pad.axes[2] ?? 0, 0.15);
      const ry = deadzone(pad.axes[3] ?? 0, 0.15);
      if (this.interactMode) {
        // Switch mode: the stick moves your head and the view stays put.
        this.mouseLook.yaw = clamp(this.mouseLook.yaw + this.padLook.yaw - rx * 1.4 * dt, -2.6, 2.6);
        this.mouseLook.pitch = clamp(this.mouseLook.pitch + this.padLook.pitch - ry * 1.0 * dt, -1.0, 1.4);
        this.padLook.yaw = this.padLook.pitch = 0;
      } else {
        // Right stick points your head: push it and you look that way, release to look ahead.
        const ty = -rx * 2.6;
        const tp = -ry * (ry < 0 ? 1.35 : 0.95);
        this.padLook.yaw += (ty - this.padLook.yaw) * Math.min(1, dt * 8);
        this.padLook.pitch += (tp - this.padLook.pitch) * Math.min(1, dt * 8);
      }
      if (b(BTN.UP)) this.look.fov = clamp(this.look.fov - 30 * dt, 30, 90);
      if (b(BTN.DOWN)) this.look.fov = clamp(this.look.fov + 30 * dt, 30, 90);
    } else {
      this.padLook.yaw = this.padLook.pitch = 0;
    }
    if (k('ArrowLeft')) this.mouseLook.yaw = clamp(this.mouseLook.yaw + 1.8 * dt, -2.6, 2.6);
    if (k('ArrowRight')) this.mouseLook.yaw = clamp(this.mouseLook.yaw - 1.8 * dt, -2.6, 2.6);
    if (k('ArrowUp')) this.mouseLook.pitch = clamp(this.mouseLook.pitch + 1.2 * dt, -1.0, 1.4);
    if (k('ArrowDown')) this.mouseLook.pitch = clamp(this.mouseLook.pitch - 1.2 * dt, -1.0, 1.4);
    if (k('Equal')) this.look.fov = clamp(this.look.fov - 30 * dt, 30, 90);
    if (k('Minus')) this.look.fov = clamp(this.look.fov + 30 * dt, 30, 90);
    if (bp(BTN.RS) || kp('KeyC')) {
      this.mouseLook = { yaw: 0, pitch: 0 };
      this.look.fov = 70;
      ui.recenter = true;
    }
    this.look.yaw = clamp(this.mouseLook.yaw + this.padLook.yaw, -2.7, 2.7);
    this.look.pitch = clamp(this.mouseLook.pitch + this.padLook.pitch, -1.0, 1.45);

    // ---- UI ----
    ui.pause = bp(BTN.MENU) || kp('Escape') || kp('KeyP');
    ui.restart = kp('KeyR');
    ui.toggleHelp = kp('KeyH');

    this.prevButtons = pad ? pad.buttons.map((x) => x.pressed) : [];
    this.pressedKeys.clear();
    return ui;
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}
