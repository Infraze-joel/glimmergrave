/** Small deterministic PRNG (mulberry32) for client-side decoration. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  range(min: number, max: number): number;
  int(maxExclusive: number): number;
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
}

export function createRng(seed: number): Rng {
  let s = (seed | 0) ^ 0x9e3779b9;
  const next = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    chance: (p) => next() < p,
    pick: (items) => items[Math.floor(next() * items.length)],
  };
}
