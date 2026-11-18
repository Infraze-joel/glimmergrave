/**
 * Client-side prediction of the own hero's movement with server reconciliation.
 * Uses the exact movement code the server runs (shared/sim/movement.ts) at the same fixed timestep.
 */
import { TICK_DT } from '@shared/constants.ts';
import { CLASSES, COMBO_WINDOW, secondaryOf } from '@shared/data/classes.ts';
import { startDash, stepMovement, type MoveBody } from '@shared/sim/movement.ts';
import { BTN, type ClassId, type InputCmd, type PlayerSnap, type RoomLayout, type SelfState } from '@shared/types.ts';

/** Corrections smaller than this are blended out instead of snapped. */
const SMOOTH_MAX_ERROR = 2.5;
/** Fraction of the remaining visual error removed per second. */
const ERROR_DECAY_RATE = 14;
const MAX_PENDING = 90;

interface Pending {
  cmd: InputCmd;
  dash: boolean;
  speedMul: number;
  rooted: boolean;
}

export type LocalAction = 'primary' | 'secondary' | 'dash' | 'ultimate' | 'denied';

export class Prediction {
  private readonly body: MoveBody = { x: 0, z: 0, dashTime: 0, dashDirX: 0, dashDirZ: 1, rootTime: 0, moveSpeed: 0 };
  private pending: Pending[] = [];
  private prevX = 0;
  private prevZ = 0;
  private errX = 0;
  private errZ = 0;
  private hasState = false;
  private baseSpeed = 0;
  private prevButtons = 0;
  // Local mirror of the ability lock so attacks slow the predicted hero without waiting for the server.
  private lockTime = 0;
  private lockMoveMul = 1;
  private primaryReady = 0;
  private comboIndex = 0;
  private comboTime = 0;
  private predictedDashes = 0;
  /** Ability the last `denied` action was meant for. */
  deniedSlot: 'secondary' | 'dash' | 'ultimate' = 'dash';

  reset(): void {
    this.pending.length = 0;
    this.hasState = false;
    this.errX = 0;
    this.errZ = 0;
    this.lockTime = 0;
    this.primaryReady = 0;
    this.comboIndex = 0;
    this.prevButtons = 0;
    this.predictedDashes = 0;
  }

  get ready(): boolean {
    return this.hasState;
  }

  /**
   * Advances the prediction by one fixed tick with a freshly sampled input.
   * Returns the action that was started locally (for instant feedback), if any.
   */
  step(cmd: InputCmd, room: RoomLayout, me: PlayerSnap | null, cls: ClassId, art = 0): LocalAction | null {
    if (!this.hasState) return null;
    const alive = me !== null && me.state === 'alive';
    const pressed = cmd.buttons & ~this.prevButtons;
    this.prevButtons = cmd.buttons;
    let action: LocalAction | null = null;
    let dash = false;

    this.lockTime = Math.max(0, this.lockTime - TICK_DT);
    this.primaryReady = Math.max(0, this.primaryReady - TICK_DT);
    this.comboTime = Math.max(0, this.comboTime - TICK_DT);

    if (alive && me) {
      const def = CLASSES[cls];
      if (pressed & BTN.DASH) {
        if (me.dashCharges - this.predictedDashes > 0) {
          dash = true;
          this.predictedDashes++;
          this.lockTime = 0;
          action = 'dash';
        } else {
          action = 'denied';
          this.deniedSlot = 'dash';
        }
      } else if (pressed & BTN.ULTIMATE && this.lockTime <= 0 && this.body.dashTime <= 0) {
        if (me.ult >= 1) {
          this.lockTime = def.ultimate.lock;
          this.lockMoveMul = def.ultimate.moveMul;
          action = 'ultimate';
        } else {
          action = 'denied';
          this.deniedSlot = 'ultimate';
        }
      } else if (pressed & BTN.SECONDARY && this.lockTime <= 0 && this.body.dashTime <= 0) {
        if (me.cdSecondary <= 0) {
          const secondary = secondaryOf(def, art);
          this.lockTime = secondary.lock;
          this.lockMoveMul = secondary.moveMul;
          action = 'secondary';
        } else {
          action = 'denied';
          this.deniedSlot = 'secondary';
        }
      } else if (cmd.buttons & BTN.PRIMARY && this.lockTime <= 0 && this.primaryReady <= 0 && this.body.dashTime <= 0) {
        if (this.comboTime <= 0) this.comboIndex = 0;
        const ability = def.primary[this.comboIndex % def.primary.length];
        this.lockTime = ability.lock;
        this.lockMoveMul = ability.moveMul;
        this.primaryReady = ability.cooldown;
        this.comboTime = ability.lock + COMBO_WINDOW;
        this.comboIndex++;
        action = 'primary';
      }
    }

    const locked = this.lockTime > 0;
    const entry: Pending = { cmd, dash, speedMul: locked ? this.lockMoveMul : 1, rooted: locked && this.lockMoveMul === 0 };
    this.pending.push(entry);
    if (this.pending.length > MAX_PENDING) this.pending.shift();

    this.prevX = this.body.x;
    this.prevZ = this.body.z;
    this.apply(entry, room, alive);
    return action;
  }

  private apply(entry: Pending, room: RoomLayout, alive: boolean): void {
    const body = this.body;
    if (!alive) return;
    if (entry.dash) startDash(body, entry.cmd.moveX, entry.cmd.moveZ, entry.cmd.aim);
    if (entry.rooted && body.dashTime <= 0) {
      stepMovement(body, 0, 0, TICK_DT, room);
      return;
    }
    body.moveSpeed = this.baseSpeed * entry.speedMul;
    stepMovement(body, entry.cmd.moveX, entry.cmd.moveZ, TICK_DT, room);
  }

  /** Rewinds to the authoritative state and replays every input the server has not processed yet. */
  reconcile(self: SelfState, room: RoomLayout | null, me: PlayerSnap | null): void {
    const body = this.body;
    const beforeX = body.x;
    const beforeZ = body.z;
    const first = !this.hasState;

    body.x = self.x;
    body.z = self.z;
    body.dashTime = self.dashTime;
    body.dashDirX = self.dashDirX;
    body.dashDirZ = self.dashDirZ;
    body.rootTime = self.rootTime;
    body.moveSpeed = self.moveSpeed;
    this.hasState = true;

    // The server reports the speed it used (ability slows included). Only adopt it as the unslowed base
    // speed when the local mirror was not applying a slow for that input, otherwise keep the last base.
    const acked = this.pending.find((p) => p.cmd.seq === self.ackSeq);
    if (!acked || acked.speedMul === 1 || this.baseSpeed === 0) this.baseSpeed = self.moveSpeed;

    let drop = 0;
    while (drop < this.pending.length && this.pending[drop].cmd.seq <= self.ackSeq) drop++;
    if (drop > 0) this.pending.splice(0, drop);
    this.predictedDashes = 0;
    for (const p of this.pending) if (p.dash) this.predictedDashes++;

    const alive = me !== null && me.state === 'alive';
    if (room) for (const p of this.pending) this.apply(p, room, alive);

    if (first) {
      this.prevX = body.x;
      this.prevZ = body.z;
      this.errX = 0;
      this.errZ = 0;
      return;
    }
    const dx = beforeX - body.x;
    const dz = beforeZ - body.z;
    if (dx * dx + dz * dz > SMOOTH_MAX_ERROR * SMOOTH_MAX_ERROR) {
      // Teleport (new chamber, large correction): snap.
      this.prevX = body.x;
      this.prevZ = body.z;
      this.errX = 0;
      this.errZ = 0;
    } else {
      // Keep the hero where it was drawn and let the difference fade out.
      this.errX += dx;
      this.errZ += dz;
      this.prevX -= dx;
      this.prevZ -= dz;
      // Many small corrections in a row (frame stall, heavy jitter) must not add up to a visible offset.
      if (this.errX * this.errX + this.errZ * this.errZ > SMOOTH_MAX_ERROR * SMOOTH_MAX_ERROR) {
        this.prevX += this.errX;
        this.prevZ += this.errZ;
        this.errX = 0;
        this.errZ = 0;
      }
    }
  }

  /** Decays the visual correction error. Call once per rendered frame. */
  smooth(dt: number): void {
    const k = Math.exp(-ERROR_DECAY_RATE * dt);
    this.errX *= k;
    this.errZ *= k;
  }

  /** Position to draw at, `alpha` = progress between the last two fixed ticks (0..1). */
  renderX(alpha: number): number {
    return this.prevX + (this.body.x - this.prevX) * alpha + this.errX;
  }

  renderZ(alpha: number): number {
    return this.prevZ + (this.body.z - this.prevZ) * alpha + this.errZ;
  }

  get dashing(): boolean {
    return this.body.dashTime > 0;
  }

  get dashRot(): number {
    return Math.atan2(this.body.dashDirX, this.body.dashDirZ);
  }
}
