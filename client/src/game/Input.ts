/** Keyboard + mouse sampling for the own hero. Produces one input frame per fixed tick. */
import { BTN } from '@shared/types.ts';

const MOVE_KEYS: Record<string, readonly [number, number]> = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
};
const KEY_BUTTONS: Record<string, number> = {
  Space: BTN.DASH, ShiftLeft: BTN.DASH, KeyE: BTN.INTERACT, KeyF: BTN.SECONDARY,
};
const MOUSE_BUTTONS: Record<number, number> = { 0: BTN.PRIMARY, 2: BTN.SECONDARY };
const MAX_AIM_DISTANCE = 25;

export interface InputSample {
  moveX: number;
  moveZ: number;
  aim: number;
  aimDist: number;
  buttons: number;
}

export class Input {
  /** Gameplay input is only read while this is true (in game, no overlay open). */
  enabled = false;
  mouseX = window.innerWidth / 2;
  mouseY = window.innerHeight / 2;

  private readonly keys = new Set<string>();
  private held = 0;
  /** Buttons pressed since the last sample, so taps shorter than one tick are never lost. */
  private latched = 0;
  private lastAim = 0;
  private readonly ground = { x: 0, z: 0 };
  private readonly disposers: (() => void)[] = [];

  constructor(canvas: HTMLCanvasElement) {
    const on = <K extends keyof WindowEventMap>(target: Window | HTMLElement, type: K, handler: (ev: WindowEventMap[K]) => void): void => {
      target.addEventListener(type, handler as EventListener);
      this.disposers.push(() => target.removeEventListener(type, handler as EventListener));
    };
    on(window, 'keydown', (ev) => {
      if (!this.enabled || ev.repeat || isTyping(ev)) return;
      if (ev.code in MOVE_KEYS || ev.code in KEY_BUTTONS) {
        ev.preventDefault();
        this.keys.add(ev.code);
        const button = KEY_BUTTONS[ev.code];
        if (button) { this.held |= button; this.latched |= button; }
      }
    });
    on(window, 'keyup', (ev) => {
      this.keys.delete(ev.code);
      const button = KEY_BUTTONS[ev.code];
      if (button) this.held &= ~button;
    });
    on(window, 'pointermove', (ev) => { this.mouseX = ev.clientX; this.mouseY = ev.clientY; });
    on(canvas, 'pointerdown', (ev) => {
      this.mouseX = ev.clientX;
      this.mouseY = ev.clientY;
      const button = MOUSE_BUTTONS[ev.button];
      if (!this.enabled || !button) return;
      ev.preventDefault();
      this.held |= button;
      this.latched |= button;
    });
    on(window, 'pointerup', (ev) => {
      const button = MOUSE_BUTTONS[ev.button];
      if (button) this.held &= ~button;
    });
    on(canvas, 'contextmenu', (ev) => ev.preventDefault());
    on(window, 'blur', () => this.release());
  }

  release(): void {
    this.keys.clear();
    this.held = 0;
    this.latched = 0;
  }

  /**
   * Samples the current input. `toGround` maps the mouse position to the ground plane (false if the ray
   * misses); the aim is measured from the hero position.
   */
  sample(heroX: number, heroZ: number, toGround: (clientX: number, clientY: number, out: { x: number; z: number }) => boolean, out: InputSample): InputSample {
    out.moveX = 0;
    out.moveZ = 0;
    out.buttons = 0;
    if (this.enabled) {
      for (const code of this.keys) {
        const dir = MOVE_KEYS[code];
        if (dir) { out.moveX += dir[0]; out.moveZ += dir[1]; }
      }
      out.moveX = Math.max(-1, Math.min(1, out.moveX));
      out.moveZ = Math.max(-1, Math.min(1, out.moveZ));
      out.buttons = this.held | this.latched;
    }
    this.latched = 0;
    out.aimDist = 0;
    if (toGround(this.mouseX, this.mouseY, this.ground)) {
      const dx = this.ground.x - heroX;
      const dz = this.ground.z - heroZ;
      const dist = Math.hypot(dx, dz);
      if (dist > 0.05) this.lastAim = Math.atan2(dx, dz);
      out.aimDist = Math.min(MAX_AIM_DISTANCE, dist);
    }
    out.aim = this.lastAim;
    return out;
  }

  dispose(): void {
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
  }
}

function isTyping(ev: KeyboardEvent): boolean {
  const el = ev.target;
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
}
