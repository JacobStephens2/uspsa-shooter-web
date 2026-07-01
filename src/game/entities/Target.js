// src/game/entities/Target.js
//
// USPSA cardboard target on a wooden stand for "Practical Range".
//
// A standard USPSA "metric" target is a tan cardboard silhouette with printed
// scoring zones. For our game we model it as a flat rectangular card mounted on
// a pair of wooden legs. The card carries a procedurally painted CanvasTexture
// whose scoring regions EXACTLY match the local-space zone math in onHit(), so
// what the player sees is what the raycast scores.
//
// Coordinate conventions (see project world spec):
//   - up is +y, downrange is -z, player looks toward -z from z > 0.
//   - At rotationY = 0 the card faces +z (toward the player).
//
// Shootable entity contract:
//   - root       : THREE.Group added to the scene.
//   - colliders  : [cardMesh]; cardMesh.userData.entity === this.
//   - onHit(hit) : returns a scoring result and spawns a bullet-hole decal.

import * as THREE from 'three';

// --- Card dimensions (meters) -------------------------------------------------
const CARD_W = 0.46; // card width  (x)
const CARD_H = 0.72; // card height (y)
const CARD_CENTER_Y = 1.05; // world height of the card's center above ground
const CARD_THICKNESS = 0.008;

// Texture resolution. Aspect matches the card so painted zones map linearly to
// local coordinates: localX in [-W/2, +W/2], localY in [-H/2, +H/2].
const TEX_W = 256;
const TEX_H = Math.round((TEX_W * CARD_H) / CARD_W); // ~400

// --- Scoring zone geometry (LOCAL card space, meters, origin at card center) --
// These constants are the single source of truth: they drive BOTH the painted
// texture and the onHit() hit-test, guaranteeing visual/logical agreement.
//
// Body A-zone: an upright rectangle in the center-upper body.
const A_BOX_HALF_W = 0.075; // half width  of body A box
const A_BOX_TOP = 0.135; // top edge (local y) of body A box
const A_BOX_BOTTOM = -0.155; // bottom edge (local y) of body A box
// Head A-zone: a circle near the top of the card.
const HEAD_A_CY = 0.265; // center y of head A circle
const HEAD_A_R = 0.058; // radius of head A circle
// C-zone: a rounded region enclosing the A box (and the neck up to the head).
// Modeled as a rectangle band around the A box plus vertical reach.
const C_BOX_HALF_W = 0.14; // half width of the C region around body
const C_TOP = 0.205; // top of the C body region
const C_BOTTOM = -0.235; // bottom of the C body region
// Everything outside C (outer edges + lower "legs" area) scores D.

// --- Scoring point values -----------------------------------------------------
const POINTS = { A: 5, C: 3, D: 1 };
const NOSHOOT_POINTS = -10;

// Shared throwaway vector to avoid per-hit allocation in worldToLocal path.
const _localPoint = new THREE.Vector3();

export class Target {
  /**
   * @param {Object} opts
   * @param {{x:number,y:number,z:number}} opts.position base of stand on ground.
   * @param {number} [opts.rotationY=0] yaw; 0 => card faces +z (toward player).
   * @param {boolean} [opts.noShoot=false] white no-shoot target (hits penalize).
   * @param {string} [opts.id] optional identifier.
   */
  constructor(opts = {}) {
    const {
      position = { x: 0, y: 0, z: 0 },
      rotationY = 0,
      noShoot = false,
      id = null,
    } = opts;

    this.noShoot = !!noShoot;
    this.id = id;

    // Recorded hits. Each entry: { zone, points } (best-2 logic in getters).
    this._hits = [];
    this._noShootHits = 0;

    // Active hit-flash animations (each has {mesh, life, maxLife}).
    this._flashes = [];
    // Persistent decal container so we can manage/limit bullet holes if needed.
    this._decals = [];

    // --- Root group, positioned at the stand base on the ground. ------------
    this.root = new THREE.Group();
    this.root.name = id ? `Target:${id}` : 'Target';
    this.root.position.set(position.x, position.y, position.z);
    this.root.rotation.y = rotationY;

    this._buildStand();
    this._buildCard();

    // Colliders: only the card is shootable.
    this.colliders = [this._cardMesh];
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  /** Build two wooden legs + a crossbar supporting the card. */
  _buildStand() {
    const woodMat = new THREE.MeshStandardMaterial({
      color: 0x6b4a2b,
      roughness: 0.9,
      metalness: 0.0,
    });

    // Card bottom edge height above ground.
    const cardBottom = CARD_CENTER_Y - CARD_H / 2; // ~0.69
    const legHeight = cardBottom + 0.06; // legs rise slightly past card bottom
    const legHalfSpan = CARD_W / 2 - 0.03; // legs just inside card edges
    const legR = 0.018;

    const legGeo = new THREE.CylinderGeometry(legR, legR * 1.15, legHeight, 8);

    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, woodMat);
      leg.position.set(sx * legHalfSpan, legHeight / 2, 0);
      leg.castShadow = true;
      leg.receiveShadow = true;
      this.root.add(leg);
    }

    // Small feet blocks for stability / visual grounding.
    const footGeo = new THREE.BoxGeometry(0.08, 0.02, 0.12);
    for (const sx of [-1, 1]) {
      const foot = new THREE.Mesh(footGeo, woodMat);
      foot.position.set(sx * legHalfSpan, 0.01, 0);
      foot.castShadow = true;
      foot.receiveShadow = true;
      this.root.add(foot);
    }

    // A horizontal crossbar behind the card top for a stapled-on look.
    const barGeo = new THREE.BoxGeometry(CARD_W * 0.9, 0.03, 0.02);
    const bar = new THREE.Mesh(barGeo, woodMat);
    bar.position.set(0, cardBottom + 0.08, -CARD_THICKNESS);
    bar.castShadow = true;
    this.root.add(bar);
  }

  /** Build the cardboard card mesh with a painted scoring texture. */
  _buildCard() {
    const texture = this._makeCardTexture();

    const cardMat = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.95,
      metalness: 0.0,
      // Slight two-sidedness so a shot from an angle still reads solid.
      side: THREE.FrontSide,
    });

    const cardGeo = new THREE.BoxGeometry(CARD_W, CARD_H, CARD_THICKNESS);
    const mesh = new THREE.Mesh(cardGeo, cardMat);
    mesh.position.set(0, CARD_CENTER_Y, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Wire the entity contract onto the collider.
    mesh.userData.entity = this;

    this._cardMesh = mesh;
    this._cardTexture = texture;
    this.root.add(mesh);
  }

  /**
   * Paint the scoring zones onto a canvas and return a CanvasTexture.
   * The painting mirrors the LOCAL-space zone math used by _zoneForLocal().
   */
  _makeCardTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = TEX_W;
    canvas.height = TEX_H;
    const ctx = canvas.getContext('2d');

    // Helper: convert local card coords (meters) -> canvas pixels.
    // localX in [-W/2,+W/2] -> [0,TEX_W]; localY up-positive -> canvas down.
    const px = (lx) => ((lx + CARD_W / 2) / CARD_W) * TEX_W;
    const py = (ly) => ((CARD_H / 2 - ly) / CARD_H) * TEX_H;
    const pw = (w) => (w / CARD_W) * TEX_W; // width scale
    const ph = (h) => (h / CARD_H) * TEX_H; // height scale

    if (this.noShoot) {
      // NO-SHOOT: white card with a clear dark border.
      ctx.fillStyle = '#e9e9e6';
      ctx.fillRect(0, 0, TEX_W, TEX_H);
      // subtle paper mottling
      this._paintNoise(ctx, TEX_W, TEX_H, 0.04, '#000000');
      // heavy dark border
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = Math.max(6, TEX_W * 0.045);
      ctx.strokeRect(
        ctx.lineWidth / 2,
        ctx.lineWidth / 2,
        TEX_W - ctx.lineWidth,
        TEX_H - ctx.lineWidth
      );
      // A big "X" cue that this is not to be shot.
      ctx.strokeStyle = '#2a2a2a';
      ctx.lineWidth = Math.max(3, TEX_W * 0.02);
      ctx.beginPath();
      ctx.moveTo(TEX_W * 0.2, TEX_H * 0.18);
      ctx.lineTo(TEX_W * 0.8, TEX_H * 0.82);
      ctx.moveTo(TEX_W * 0.8, TEX_H * 0.18);
      ctx.lineTo(TEX_W * 0.2, TEX_H * 0.82);
      ctx.stroke();
    } else {
      // NORMAL: tan/brown cardboard base.
      ctx.fillStyle = '#c8a976';
      ctx.fillRect(0, 0, TEX_W, TEX_H);
      this._paintNoise(ctx, TEX_W, TEX_H, 0.06, '#5a4326');

      // D-zone is the base tan; darken C region, darker still for A.
      // C-zone body region (rounded rectangle) painted a mid brown.
      ctx.fillStyle = '#b2895a';
      this._roundRect(
        ctx,
        px(-C_BOX_HALF_W),
        py(C_TOP),
        pw(C_BOX_HALF_W * 2),
        ph(C_TOP - C_BOTTOM),
        pw(0.05)
      );
      ctx.fill();

      // Neck/head C connective region + head disc backing.
      ctx.beginPath();
      ctx.arc(px(0), py(HEAD_A_CY), pw(HEAD_A_R + 0.03), 0, Math.PI * 2);
      ctx.fill();

      // Body A-zone box (darker brown).
      ctx.fillStyle = '#8a6338';
      ctx.fillRect(
        px(-A_BOX_HALF_W),
        py(A_BOX_TOP),
        pw(A_BOX_HALF_W * 2),
        ph(A_BOX_TOP - A_BOX_BOTTOM)
      );

      // Head A-zone circle (darker brown).
      ctx.beginPath();
      ctx.arc(px(0), py(HEAD_A_CY), pw(HEAD_A_R), 0, Math.PI * 2);
      ctx.fill();

      // Printed black scoring outlines (perforation-style zone borders).
      ctx.strokeStyle = '#141210';
      ctx.lineWidth = Math.max(1, TEX_W * 0.006);
      // A box outline
      ctx.strokeRect(
        px(-A_BOX_HALF_W),
        py(A_BOX_TOP),
        pw(A_BOX_HALF_W * 2),
        ph(A_BOX_TOP - A_BOX_BOTTOM)
      );
      // Head A circle outline
      ctx.beginPath();
      ctx.arc(px(0), py(HEAD_A_CY), pw(HEAD_A_R), 0, Math.PI * 2);
      ctx.stroke();
      // C region outline
      this._roundRect(
        ctx,
        px(-C_BOX_HALF_W),
        py(C_TOP),
        pw(C_BOX_HALF_W * 2),
        ph(C_TOP - C_BOTTOM),
        pw(0.05)
      );
      ctx.stroke();

      // Perforation dashed lines across the card (visual detail only).
      ctx.setLineDash([TEX_W * 0.02, TEX_W * 0.02]);
      ctx.strokeStyle = 'rgba(20,18,16,0.5)';
      ctx.lineWidth = Math.max(1, TEX_W * 0.004);
      // horizontal perf near shoulders
      ctx.beginPath();
      ctx.moveTo(px(-CARD_W / 2), py(C_TOP + 0.02));
      ctx.lineTo(px(CARD_W / 2), py(C_TOP + 0.02));
      ctx.stroke();
      ctx.setLineDash([]);

      // Thin outer border so the card edge reads cleanly.
      ctx.strokeStyle = 'rgba(60,45,26,0.8)';
      ctx.lineWidth = Math.max(2, TEX_W * 0.01);
      ctx.strokeRect(
        ctx.lineWidth / 2,
        ctx.lineWidth / 2,
        TEX_W - ctx.lineWidth,
        TEX_H - ctx.lineWidth
      );
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  /** Lightweight speckle noise for a weathered paper look. */
  _paintNoise(ctx, w, h, amount, color) {
    ctx.save();
    ctx.fillStyle = color;
    const count = Math.floor(w * h * amount * 0.02);
    for (let i = 0; i < count; i++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      const s = Math.random() * 1.5 + 0.3;
      ctx.globalAlpha = Math.random() * amount;
      ctx.fillRect(x, y, s, s);
    }
    ctx.restore();
  }

  /** Trace a rounded rectangle path (does not fill/stroke). */
  _roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // ---------------------------------------------------------------------------
  // Hit handling
  // ---------------------------------------------------------------------------

  /**
   * Map a LOCAL-space (x,y) point on the card to a scoring zone.
   * Geometry here MUST match the painted texture in _makeCardTexture().
   * @returns {'A'|'C'|'D'}
   */
  _zoneForLocal(lx, ly) {
    // Head A-zone circle.
    const dxh = lx;
    const dyh = ly - HEAD_A_CY;
    if (dxh * dxh + dyh * dyh <= HEAD_A_R * HEAD_A_R) return 'A';

    // Body A-zone box.
    if (
      lx >= -A_BOX_HALF_W &&
      lx <= A_BOX_HALF_W &&
      ly >= A_BOX_BOTTOM &&
      ly <= A_BOX_TOP
    ) {
      return 'A';
    }

    // C-zone body region (rectangle) OR the head-backing disc region.
    if (
      lx >= -C_BOX_HALF_W &&
      lx <= C_BOX_HALF_W &&
      ly >= C_BOTTOM &&
      ly <= C_TOP
    ) {
      return 'C';
    }
    const rC = HEAD_A_R + 0.03;
    if (dxh * dxh + dyh * dyh <= rC * rC) return 'C';

    // Everything else (outer edges + lower area) is D.
    return 'D';
  }

  /**
   * Weapon calls this with the nearest raycast intersection.
   * @param {{point:THREE.Vector3}} intersection
   * @returns {{kind:string, zone:'A'|'C'|'D', points:number, noShoot:boolean}}
   */
  onHit(intersection) {
    // Convert the world-space hit point into the card mesh's local space.
    _localPoint.copy(intersection.point);
    this._cardMesh.worldToLocal(_localPoint);

    const lx = _localPoint.x;
    const ly = _localPoint.y;

    let zone;
    let points;
    if (this.noShoot) {
      // No-shoot: any hit is a penalty. Zone reported for UI; value is fixed.
      zone = this._zoneForLocalNoShoot(lx, ly);
      points = NOSHOOT_POINTS;
      this._noShootHits++;
    } else {
      zone = this._zoneForLocal(lx, ly);
      points = POINTS[zone];
      this._hits.push({ zone, points });
    }

    // Persistent bullet-hole decal + brief flash at the local hit location.
    this._spawnDecal(lx, ly);
    this._spawnFlash(lx, ly);

    return {
      kind: this.noShoot ? 'noshoot' : 'target',
      zone,
      points,
      noShoot: this.noShoot,
    };
  }

  /**
   * No-shoot targets do not have printed scoring zones, but we still report a
   * coarse zone for UI/debug. Inside the border => 'A', very edge => 'D'.
   */
  _zoneForLocalNoShoot(lx, ly) {
    const edge = 0.03;
    const inX = Math.abs(lx) <= CARD_W / 2 - edge;
    const inY = Math.abs(ly) <= CARD_H / 2 - edge;
    return inX && inY ? 'A' : 'D';
  }

  /** Add a small, dark, persistent bullet-hole decal on the card face. */
  _spawnDecal(lx, ly) {
    const r = 0.008;
    const geo = new THREE.CircleGeometry(r, 10);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x0a0a0a,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const decal = new THREE.Mesh(geo, mat);
    // Place just in front of the card face (+z local) so it renders on top.
    decal.position.set(lx, ly, CARD_THICKNESS / 2 + 0.001);
    decal.renderOrder = 2;
    this._cardMesh.add(decal);
    this._decals.push(decal);
  }

  /** Brief expanding flash ring at the hit point; animated in update(). */
  _spawnFlash(lx, ly) {
    const geo = new THREE.RingGeometry(0.004, 0.014, 12);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xfff2c0,
      transparent: true,
      opacity: 1.0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const flash = new THREE.Mesh(geo, mat);
    flash.position.set(lx, ly, CARD_THICKNESS / 2 + 0.002);
    flash.renderOrder = 3;
    this._cardMesh.add(flash);
    this._flashes.push({ mesh: flash, life: 0, maxLife: 0.18 });
  }

  // ---------------------------------------------------------------------------
  // Per-frame update
  // ---------------------------------------------------------------------------

  /** Advance hit-flash animations. Idle otherwise. */
  update(dt) {
    if (this._flashes.length === 0) return;
    for (let i = this._flashes.length - 1; i >= 0; i--) {
      const f = this._flashes[i];
      f.life += dt;
      const t = f.life / f.maxLife;
      if (t >= 1) {
        this._cardMesh.remove(f.mesh);
        f.mesh.geometry.dispose();
        f.mesh.material.dispose();
        this._flashes.splice(i, 1);
        continue;
      }
      const s = 1 + t * 2.2;
      f.mesh.scale.set(s, s, s);
      f.mesh.material.opacity = 1 - t;
    }
  }

  // ---------------------------------------------------------------------------
  // Scoring getters (used at stage end)
  // ---------------------------------------------------------------------------

  /** Total number of scoring hits recorded on this (shoot) target. */
  get hitCount() {
    return this._hits.length;
  }

  /** Number of no-shoot hits (each is a NOSHOOT_POINTS penalty). */
  get noShootHitCount() {
    return this._noShootHits;
  }

  /**
   * USPSA scores the BEST 2 hits per paper target. Returns the {A,C,D} counts
   * among those best-two hits (by point value). No-shoot targets score none.
   */
  get scoreCounts() {
    const counts = { A: 0, C: 0, D: 0 };
    if (this.noShoot || this._hits.length === 0) return counts;

    // Sort a copy by descending point value and take the best two.
    const best = this._hits
      .slice()
      .sort((a, b) => b.points - a.points)
      .slice(0, 2);

    for (const h of best) counts[h.zone]++;
    return counts;
  }
}
