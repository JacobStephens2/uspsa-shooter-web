/*
  USPSA-style scoring (minor power factor).

  Paper targets are scored best-2-hits: A = 5, C = 3, D = 1.
  Misses and no-shoot hits are -10 each. Procedurals are -10 each.
  A standing steel popper at stage end counts as a miss.

  Hit factor = max(rawPoints, 0) / time.
*/

export const ZONE_POINTS = { A: 5, C: 3, D: 1 };
export const PENALTY = { MISS: 10, NO_SHOOT: 10, PROCEDURAL: 10 };

export class StageScore {
  constructor() {
    this.alpha = 0;
    this.charlie = 0;
    this.delta = 0;
    this.misses = 0;
    this.noShoots = 0;
    this.procedurals = 0;
    this.time = 0;
    this.passed = true;
  }

  /**
   * @param {Object} t tallies
   * @param {number} t.alpha  count of A hits (best-2 per paper)
   * @param {number} t.charlie
   * @param {number} t.delta
   * @param {number} t.misses      failure-to-neutralize + standing steel
   * @param {number} t.noShoots    hits on no-shoot targets
   * @param {number} t.procedurals rule penalties
   * @param {number} t.time        seconds
   * @param {boolean} [t.passed]
   */
  finalize(t) {
    this.alpha = t.alpha | 0;
    this.charlie = t.charlie | 0;
    this.delta = t.delta | 0;
    this.misses = t.misses | 0;
    this.noShoots = t.noShoots | 0;
    this.procedurals = t.procedurals | 0;
    this.time = Math.max(0.01, t.time || 0);
    this.passed = t.passed !== undefined ? t.passed : true;
    return this;
  }

  /** Raw stage points, may be negative. */
  get rawPoints() {
    const hits = this.alpha * ZONE_POINTS.A + this.charlie * ZONE_POINTS.C + this.delta * ZONE_POINTS.D;
    const pen =
      this.misses * PENALTY.MISS +
      this.noShoots * PENALTY.NO_SHOOT +
      this.procedurals * PENALTY.PROCEDURAL;
    return hits - pen;
  }

  /** Hit factor, floored at 0. */
  get hitFactor() {
    return Math.max(0, this.rawPoints) / this.time;
  }

  /** Shape consumed by Menu.showStageResults(). */
  get summary() {
    return {
      alpha: this.alpha,
      charlie: this.charlie,
      delta: this.delta,
      misses: this.misses,
      noShoots: this.noShoots,
      penalties: this.procedurals,
      points: this.rawPoints,
      time: this.time,
      hitFactor: this.hitFactor,
      passed: this.passed,
    };
  }
}

/**
 * Turn an average hit factor into a familiar USPSA classification letter.
 * Thresholds are tuned for this game's two courses of fire.
 */
export function classify(avgHitFactor) {
  if (avgHitFactor >= 7.0) return 'GM';
  if (avgHitFactor >= 5.5) return 'M';
  if (avgHitFactor >= 4.0) return 'A';
  if (avgHitFactor >= 2.75) return 'B';
  if (avgHitFactor >= 1.75) return 'C';
  if (avgHitFactor >= 0.75) return 'D';
  return 'U';
}
