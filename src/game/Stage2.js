import * as THREE from 'three';
import { Stage } from './Stage.js';
import { Target } from './entities/Target.js';
import { SteelPopper } from './entities/SteelPopper.js';
import { Ranchero } from './entities/Ranchero.js';

/*
  Stage 2 — "The Ranchero". A live-fire scenario: paper targets and a hostage
  (no-shoot), but a hostile ranchero is downrange and he shoots back. Use the
  barrels for cover, break his line of sight, and stop the threat before it
  stops you.
*/

export class Stage2 extends Stage {
  /**
   * @param {Object} ctx  { scene, environment, services }
   *   services: { player, sfx, fx, hasLineOfSight, damagePlayer }
   */
  constructor(ctx) {
    super(ctx);
    this.services = ctx.services;
    this.number = 2;
    this.name = 'The Ranchero';
    this.description =
      'A hostile ranchero is holed up downrange and he is armed. Break his line of sight behind the barrels, neutralize the threat, and clear the paper — without hitting the hostage.';
    this.parLines = [
      'STOP THE THREAT — down the ranchero (he shoots back!)',
      '3 paper targets — 2 rounds each',
      '1 steel popper — must fall',
      'Hostage no-shoot present — do NOT hit (−10)',
      'Hold [Ctrl] to CROUCH behind the barrels — it breaks his line of sight',
      'Press [F] when finished',
    ];
    this.build();
  }

  build() {
    const bay = this.environment.buildShootingBay({ width: 16, depth: 20, cover: true });
    this._installBay(bay);

    this.playerStart = { x: 0, z: Math.min(bay.bounds.maxZ - 0.8, 2.4) };
    this.playerFacing = 0; // yaw 0 = look downrange (-z)

    const shoot = [
      { x: -4.5, z: -8.0 },
      { x: 3.8, z: -9.2 },
      { x: -1.2, z: -11.5 },
    ];
    const hostages = [
      { x: 0.7, z: -9.6 },
      { x: -3.6, z: -8.6 },
    ];
    const steel = [{ x: 5.2, z: -12.5 }];
    const rancheroPos = { x: 1.5, y: 0, z: -10.6 };

    let id = 0;
    for (const p of shoot) {
      this._addPaper(
        new Target({ position: { x: p.x, y: 0, z: p.z }, rotationY: this.facePlayer(p.x, p.z), id: `t${id++}` })
      );
    }
    for (const p of hostages) {
      this._addPaper(
        new Target({
          position: { x: p.x, y: 0, z: p.z },
          rotationY: this.facePlayer(p.x, p.z),
          noShoot: true,
          id: `h${id++}`,
        })
      );
    }
    for (const s of steel) {
      this._addSteel(
        new SteelPopper({ position: { x: s.x, y: 0, z: s.z }, rotationY: this.facePlayer(s.x, s.z), id: `s${id++}` })
      );
    }

    // --- the hostile ranchero -----------------------------------------
    const svc = this.services;
    const enemyEye = new THREE.Vector3();
    let ranchero = null;
    ranchero = new Ranchero({
      position: rancheroPos,
      rotationY: this.facePlayer(rancheroPos.x, rancheroPos.z),
      getPlayerPosition: () => svc.player.getChestPosition(),
      isPlayerTargetable: () => {
        if (!svc.player.alive || !ranchero || !ranchero.alive) return false;
        enemyEye.set(ranchero.root.position.x, ranchero.root.position.y + 1.5, ranchero.root.position.z);
        return svc.hasLineOfSight(enemyEye, svc.player.getChestPosition());
      },
      damagePlayer: (amt) => svc.damagePlayer(amt),
      spawnTracer: (from, to, color) => svc.fx.spawnTracer(from, to, color ?? 0xff5a3a),
      spawnMuzzleFlash: (pos) => svc.fx.spawnMuzzleFlash(pos, 0xff7a3a),
      sfx: svc.sfx,
      difficulty: 0.5,
    });
    this._setRanchero(ranchero);
  }
}
