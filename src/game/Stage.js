import * as THREE from 'three';
import { StageScore } from './Scoring.js';

/*
  Base class for a course of fire. Subclasses populate the bay with targets,
  steel and (stage 2) the enemy. The base tracks neutralization, exposes the
  raycast lists the weapon needs, and computes the final USPSA score.
*/

export class Stage {
  /**
   * @param {Object} ctx
   * @param {THREE.Scene} ctx.scene
   * @param {import('../world/Environment.js').Environment} ctx.environment
   */
  constructor(ctx) {
    this.scene = ctx.scene;
    this.environment = ctx.environment;

    this.number = 1;
    this.name = 'Stage';
    this.description = '';
    this.parLines = [];
    this.hasThreat = false;

    this.root = new THREE.Group();
    this.root.name = 'stage';
    this.scene.add(this.root);

    this.papers = []; // shoot cardboard
    this.noShoots = []; // no-shoot cardboard
    this.steels = [];
    this.ranchero = null;

    this.shootables = []; // collider meshes (targets/steel/enemy)
    this.solids = []; // shot-blocking meshes (walls/berms/barrels)

    this.collision = { aabbs: [], bounds: { minX: -6, maxX: 6, minZ: -2, maxZ: 4 } };
    this.playerStart = { x: 0, z: 2 };
    this.playerFacing = 0; // yaw 0 = look downrange (-z)

    this._raycastTargets = null;
  }

  /* --- registration helpers ------------------------------------------- */
  _addPaper(target) {
    this.root.add(target.root);
    for (const c of target.colliders) this.shootables.push(c);
    if (target.noShoot) this.noShoots.push(target);
    else this.papers.push(target);
    this._raycastTargets = null;
  }

  _addSteel(steel) {
    this.root.add(steel.root);
    for (const c of steel.colliders) this.shootables.push(c);
    this.steels.push(steel);
    this._raycastTargets = null;
  }

  _setRanchero(r) {
    this.root.add(r.root);
    for (const c of r.colliders) this.shootables.push(c);
    this.ranchero = r;
    this.hasThreat = true;
    this._raycastTargets = null;
  }

  _installBay(bay) {
    this.scene.add(bay.group);
    this._bay = bay;
    this.solids = bay.blockers.slice();
    this.collision = { aabbs: bay.aabbs.slice(), bounds: bay.bounds };
    this._raycastTargets = null;
  }

  /** Rotation (about Y) that makes a card at (x,z) face the player start. */
  facePlayer(x, z) {
    const px = this.playerStart.x;
    const pz = this.playerStart.z;
    return Math.atan2(px - x, pz - z);
  }

  /** Combined mesh list for shot raycasts (targets + solids). */
  get raycastTargets() {
    if (!this._raycastTargets) this._raycastTargets = this.shootables.concat(this.solids);
    return this._raycastTargets;
  }

  /* --- progress ------------------------------------------------------- */
  get totalTargets() {
    return this.papers.length + this.steels.length + (this.ranchero ? 1 : 0);
  }

  get remaining() {
    let n = 0;
    for (const p of this.papers) if (p.hitCount < 2) n++;
    for (const s of this.steels) if (s.standing) n++;
    if (this.ranchero && this.ranchero.alive) n++;
    return n;
  }

  allNeutralized() {
    return this.remaining === 0;
  }

  /* --- lifecycle ------------------------------------------------------ */
  update(dt) {
    for (const p of this.papers) p.update?.(dt);
    for (const s of this.noShoots) s.update?.(dt);
    for (const s of this.steels) s.update?.(dt);
    if (this.ranchero) this.ranchero.update(dt);
  }

  /**
   * Compute the final USPSA score for this stage.
   * @param {number} time seconds
   */
  finalize(time) {
    let alpha = 0;
    let charlie = 0;
    let delta = 0;
    let misses = 0;
    let noShoots = 0;
    let procedurals = 0;

    for (const p of this.papers) {
      const sc = p.scoreCounts;
      alpha += sc.A;
      charlie += sc.C;
      delta += sc.D;
      const scored = Math.min(p.hitCount, 2);
      misses += 2 - scored; // failure-to-neutralize = miss per unscored hit
    }
    for (const ns of this.noShoots) noShoots += ns.noShootHitCount;
    for (const s of this.steels) if (s.standing) misses += 1;

    const passed = this.allNeutralized();
    if (this.ranchero && this.ranchero.alive) procedurals += 5; // failure to stop the threat

    return new StageScore().finalize({
      alpha,
      charlie,
      delta,
      misses,
      noShoots,
      procedurals,
      time,
      passed,
    });
  }

  dispose() {
    if (this._bay) this.scene.remove(this._bay.group);
    this.scene.remove(this.root);
    // three disposes GPU resources lazily; for a short two-stage match this is fine.
  }
}
