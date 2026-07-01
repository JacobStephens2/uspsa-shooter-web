import { Stage } from './Stage.js';
import { Target } from './entities/Target.js';
import { SteelPopper } from './entities/SteelPopper.js';

/*
  Stage 1 — "Steel & Paper". A classic freestyle array: cardboard targets
  (two of them shouldered by white no-shoots) plus three steel poppers.
  No threat — pure marksmanship against the clock.
*/

export class Stage1 extends Stage {
  constructor(ctx) {
    super(ctx);
    this.number = 1;
    this.name = 'Steel & Paper';
    this.description =
      'A standard freestyle array. Engage every cardboard target with two rounds and drop all three steel poppers. Mind the white no-shoots.';
    this.parLines = [
      '5 paper targets — 2 rounds each (best 2 hits scored)',
      '3 steel poppers — must fall',
      '2 white no-shoots — do NOT hit (−10 each)',
      'Timer starts on the beep; press [F] when finished',
    ];
    this.build();
  }

  build() {
    const bay = this.environment.buildShootingBay({ width: 16, depth: 20, cover: false });
    this._installBay(bay);

    // stand behind the fault line, centered
    this.playerStart = { x: 0, z: Math.min(bay.bounds.maxZ - 0.8, 2.4) };
    this.playerFacing = 0; // yaw 0 = look downrange (-z)

    const shoot = [
      { x: -4.5, z: -7.0 },
      { x: -1.8, z: -8.6 },
      { x: 1.8, z: -8.6 },
      { x: 4.5, z: -7.0 },
      { x: 0.0, z: -10.5 },
    ];
    const noShoot = [
      { x: -3.1, z: -7.6 },
      { x: 2.9, z: -8.2 },
    ];
    const steel = [
      { x: -6.0, z: -11.5 },
      { x: 1.4, z: -12.8 }, // offset from the center paper so it isn't hidden behind it
      { x: 6.0, z: -11.5 },
    ];

    let id = 0;
    for (const p of shoot) {
      this._addPaper(
        new Target({ position: { x: p.x, y: 0, z: p.z }, rotationY: this.facePlayer(p.x, p.z), id: `t${id++}` })
      );
    }
    for (const p of noShoot) {
      this._addPaper(
        new Target({
          position: { x: p.x, y: 0, z: p.z },
          rotationY: this.facePlayer(p.x, p.z),
          noShoot: true,
          id: `ns${id++}`,
        })
      );
    }
    for (const s of steel) {
      this._addSteel(
        new SteelPopper({ position: { x: s.x, y: 0, z: s.z }, rotationY: this.facePlayer(s.x, s.z), id: `s${id++}` })
      );
    }
  }
}
