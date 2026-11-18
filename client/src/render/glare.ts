/**
 * Brightness governor (polish 1). Additive glows, flashes and shockwaves of many heroes used to add up to a white
 * screen. Every additive quad of a governed batch reports how much light it wants to put on its patch of floor; when
 * the demand on a patch exceeds the budget, everything there is scaled down by the same factor, so the SUM stays at
 * the budget however many ultimates and reactions overlap. A single ordinary effect never reaches the budget and is
 * drawn unchanged.
 *
 * The demand of the previous frame decides the factor (stable, no flicker); the running demand of the current frame
 * catches the first frame of a sudden pile-up. Hostile telegraphs reserve part of the budget of the floor they cover
 * (protect), so friendly light is turned down further exactly where a warning has to be read.
 */
const GLARE = {
  CELL: 3,
  COLS: 28,
  ROWS: 24,
  /** Summed demand a patch may show; about one strong flash. */
  BUDGET: 1.25,
  /** Quads smaller than this (sparks, motes) are neither counted nor dimmed. */
  MIN_SIZE: 0.9,
  /** Big quads spread their demand over this many cells around the centre. */
  MAX_SPAN: 2,
  FLOOR: 0.1,
  /** Demand a telegraph adds to the cells it covers. */
  TELEGRAPH: 1.6,
} as const;

export class Glare {
  /** Metres a quad is shifted north per metre of height, so a glow in the air loads the floor it is seen against. */
  lift = 0.65;
  private prev = new Float32Array(GLARE.COLS * GLARE.ROWS);
  private cur = new Float32Array(GLARE.COLS * GLARE.ROWS);
  private peakValue = 0;

  /** Highest demand of the last finished frame relative to the budget (debug overlay; above 1 = the cap was at work). */
  get peak(): number {
    return this.peakValue / GLARE.BUDGET;
  }

  begin(): void {
    const done = this.cur;
    let peak = 0;
    for (let i = 0; i < done.length; i++) if (done[i] > peak) peak = done[i];
    this.peakValue = peak;
    this.cur = this.prev;
    this.prev = done;
    this.cur.fill(0);
  }

  private cell(x: number, z: number): number {
    const cx = Math.floor(x / GLARE.CELL + GLARE.COLS / 2);
    const cz = Math.floor(z / GLARE.CELL + GLARE.ROWS / 2);
    if (cx < 0 || cz < 0 || cx >= GLARE.COLS || cz >= GLARE.ROWS) return -1;
    return cz * GLARE.COLS + cx;
  }

  /** Registers a quad's demand and returns the factor (0..1] its alpha has to be multiplied with. */
  take(x: number, y: number, z: number, size: number, energy: number): number {
    if (size < GLARE.MIN_SIZE || energy <= 0) return 1;
    const gz = z - y * this.lift;
    const c = this.cell(x, gz);
    if (c < 0) return 1;
    const cover = Math.min(1, (size * size) / (GLARE.CELL * GLARE.CELL));
    const e = energy * cover;
    const span = Math.min(GLARE.MAX_SPAN, Math.floor((size * 0.5) / GLARE.CELL));
    const cur = this.cur;
    cur[c] += e;
    if (span > 0) {
      const cx = c % GLARE.COLS;
      const cz = (c - cx) / GLARE.COLS;
      for (let dz = -span; dz <= span; dz++) {
        const rz = cz + dz;
        if (rz < 0 || rz >= GLARE.ROWS) continue;
        for (let dx = -span; dx <= span; dx++) {
          const rx = cx + dx;
          if ((dx === 0 && dz === 0) || rx < 0 || rx >= GLARE.COLS) continue;
          cur[rz * GLARE.COLS + rx] += e * (1 - Math.max(Math.abs(dx), Math.abs(dz)) / (span + 1));
        }
      }
    }
    const load = Math.max(this.prev[c], cur[c]);
    return load > GLARE.BUDGET ? Math.max(GLARE.FLOOR, GLARE.BUDGET / load) : 1;
  }

  /** A hostile warning covers this circle: friendly light there gets a smaller share. */
  protect(x: number, z: number, radius: number): void {
    const span = Math.min(GLARE.MAX_SPAN + 1, Math.ceil(radius / GLARE.CELL));
    const c = this.cell(x, z);
    if (c < 0) return;
    const cx = c % GLARE.COLS;
    const cz = (c - cx) / GLARE.COLS;
    for (let dz = -span; dz <= span; dz++) {
      const rz = cz + dz;
      if (rz < 0 || rz >= GLARE.ROWS) continue;
      for (let dx = -span; dx <= span; dx++) {
        const rx = cx + dx;
        if (rx < 0 || rx >= GLARE.COLS) continue;
        // only cells the circle really reaches
        if (Math.hypot(dx, dz) * GLARE.CELL > radius + GLARE.CELL * 0.75) continue;
        const i = rz * GLARE.COLS + rx;
        if (this.cur[i] < 1e6) this.cur[i] += GLARE.TELEGRAPH;
      }
    }
  }

  clear(): void {
    this.prev.fill(0);
    this.cur.fill(0);
    this.peakValue = 0;
  }
}
