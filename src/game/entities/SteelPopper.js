// src/game/entities/SteelPopper.js
//
// USPSA steel "pepper-popper" for "Practical Range".
//
// A pepper-popper is a galvanized steel reactive target: a tall, oval/tapered
// plate mounted on a short post with a hinge near the ground. When struck it
// pivots backward about that ground hinge and falls flat. A popper still
// standing at the end of a stage counts as a MISS, so we expose a `standing`
// getter for the scoring pass.
//
// Coordinate conventions (see project world spec):
//   - up is +y, downrange is -z, player looks toward -z from z > 0.
//   - At rotationY = 0 the plate faces +z (toward the player). It falls away
//     from the player (rotating so its top swings toward -z).
//
// Shootable entity contract:
//   - root       : THREE.Group added to the scene (positioned at base on ground).
//   - colliders  : [plateMesh]; plateMesh.userData.entity === this.
//   - onHit(hit) : starts the fall animation and returns a steel hit result.
//   - update(dt) : animates the backward fall (no audio here).

import * as THREE from 'three';

// --- Geometry dimensions (meters) --------------------------------------------
const PLATE_CENTER_Y = 1.0; // world height of the plate center above ground
const PLATE_WIDTH = 0.30; // widest span of the oval plate (x)
const PLATE_HEIGHT = 0.50; // vertical extent of the plate (y)
const PLATE_TOP_WIDTH = 0.10; // narrower "head" width at the top (tapered look)
const PLATE_THICKNESS = 0.015; // steel plate thickness (z)

const POST_RADIUS = 0.028; // support post radius
const HINGE_RADIUS = 0.05; // base hinge cylinder radius

// The whole popper rotates about a hinge at ground level (y = 0) so it swings
// backward and lands flat downrange.
const HINGE_Y = 0.06; // hinge pivot height above the ground

// --- Fall animation -----------------------------------------------------------
const FALL_ANGLE = THREE.MathUtils.degToRad(88); // final backward lean (~88deg)
const FALL_DURATION = 0.5; // seconds from hit to settled

export class SteelPopper {
  /**
   * @param {Object} opts
   * @param {{x:number,y:number,z:number}} opts.position base of the popper on
   *   the ground (the post/hinge sits here).
   * @param {number} [opts.rotationY=0] yaw; 0 => plate faces +z (toward player).
   * @param {string} [opts.id] optional identifier.
   */
  constructor(opts = {}) {
    const {
      position = { x: 0, y: 0, z: 0 },
      rotationY = 0,
      id = null,
    } = opts;

    this.id = id;

    // Reactive state: down === "has been knocked over".
    this.down = false;

    // Fall animation bookkeeping.
    this._falling = false;
    this._fallTime = 0;

    // --- Root group, positioned at the base on the ground. -----------------
    this.root = new THREE.Group();
    this.root.name = id ? `SteelPopper:${id}` : 'SteelPopper';
    this.root.position.set(position.x, position.y, position.z);
    this.root.rotation.y = rotationY;

    // The pivot group holds every part that swings when the popper falls. It is
    // placed at the hinge height and rotated about local +x to lean backward.
    this._pivot = new THREE.Group();
    this._pivot.position.set(0, HINGE_Y, 0);
    this.root.add(this._pivot);

    this._buildStand();
    this._buildPlate();

    // Colliders: only the plate is shootable.
    this.colliders = [this._plateMesh];
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  /** Shared galvanized-steel material (spangled grey, low roughness metal). */
  _steelMaterial() {
    return new THREE.MeshStandardMaterial({
      color: 0x9fa4a8,
      roughness: 0.45,
      metalness: 0.85,
    });
  }

  /** Build the ground hinge + support post below the plate. */
  _buildStand() {
    const steelMat = this._steelMaterial();
    // Slightly darker steel for the base so the plate reads as the target.
    const baseMat = new THREE.MeshStandardMaterial({
      color: 0x82878b,
      roughness: 0.55,
      metalness: 0.8,
    });

    // Base plate flat on the ground (stays put; not part of the pivot).
    const footGeo = new THREE.CylinderGeometry(0.14, 0.16, 0.03, 16);
    const foot = new THREE.Mesh(footGeo, baseMat);
    foot.position.set(0, 0.015, 0);
    foot.castShadow = true;
    foot.receiveShadow = true;
    this.root.add(foot);

    // Hinge cylinder: oriented along local x so the plate pivots about it.
    const hingeGeo = new THREE.CylinderGeometry(
      HINGE_RADIUS,
      HINGE_RADIUS,
      0.14,
      12
    );
    const hinge = new THREE.Mesh(hingeGeo, baseMat);
    hinge.rotation.z = Math.PI / 2; // lay the cylinder along the x-axis
    hinge.position.set(0, HINGE_Y, 0);
    hinge.castShadow = true;
    // Hinge stays fixed at the base; add to root (not pivot) so it doesn't move.
    this.root.add(hinge);

    // Support post rising from the hinge up to the bottom of the plate. This
    // part swings with the plate, so it lives on the pivot group (local coords).
    const plateBottomLocal = PLATE_CENTER_Y - HINGE_Y - PLATE_HEIGHT / 2; // ~0.69
    const postGeo = new THREE.CylinderGeometry(
      POST_RADIUS,
      POST_RADIUS * 1.2,
      plateBottomLocal,
      10
    );
    const post = new THREE.Mesh(postGeo, steelMat);
    // Cylinder is centered; place so it spans from the hinge up to the plate.
    post.position.set(0, plateBottomLocal / 2, 0);
    post.castShadow = true;
    post.receiveShadow = true;
    this._pivot.add(post);
  }

  /**
   * Build the tapered oval steel plate. We lathe a symmetric silhouette so the
   * plate is wide at the body and narrows toward a rounded "head" at the top,
   * matching the classic pepper-popper profile, then flatten it in z into a
   * thin plate.
   */
  _buildPlate() {
    const steelMat = this._steelMaterial();
    steelMat.side = THREE.DoubleSide; // readable when hit from a slight angle
    steelMat.map = this._makePlateTexture();

    const geo = this._makePlateGeometry();
    const mesh = new THREE.Mesh(geo, steelMat);
    // Position the plate center at the desired height, in pivot-local coords.
    mesh.position.set(0, PLATE_CENTER_Y - HINGE_Y, 0);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    // Wire the entity contract onto the collider.
    mesh.userData.entity = this;

    this._plateMesh = mesh;
    this._pivot.add(mesh);
  }

  /**
   * Construct the flat tapered-oval plate geometry.
   *
   * We build a filled 2D silhouette (a rounded, bottom-heavy oval that pinches
   * to a smaller head) via THREE.Shape, extrude it to give the steel thickness,
   * and center it on the origin. The silhouette is defined in local plate space
   * with y-up; x is the horizontal half-profile mirrored left/right.
   *
   * @returns {THREE.BufferGeometry}
   */
  _makePlateGeometry() {
    const halfBody = PLATE_WIDTH / 2; // widest half-width
    const halfHead = PLATE_TOP_WIDTH / 2; // head half-width
    const top = PLATE_HEIGHT / 2; // local top y
    const bottom = -PLATE_HEIGHT / 2; // local bottom y

    // Vertical position where the body transitions into the narrower neck/head.
    const shoulderY = top - PLATE_HEIGHT * 0.42;

    const shape = new THREE.Shape();
    // Start at the bottom center and sweep up the RIGHT side, across the head,
    // and down the LEFT side using quadratic curves for smooth oval edges.
    shape.moveTo(0, bottom);
    // Bottom-right curve out to the widest point of the body.
    shape.quadraticCurveTo(halfBody, bottom, halfBody, bottom + PLATE_HEIGHT * 0.28);
    // Body-right up toward the shoulder.
    shape.quadraticCurveTo(halfBody, shoulderY, halfHead, shoulderY + PLATE_HEIGHT * 0.06);
    // Neck/head-right up and over the rounded top.
    shape.quadraticCurveTo(halfHead, top, 0, top);
    // Mirror across the top: head-left down to the shoulder.
    shape.quadraticCurveTo(-halfHead, top, -halfHead, shoulderY + PLATE_HEIGHT * 0.06);
    // Body-left down to the widest point.
    shape.quadraticCurveTo(-halfBody, shoulderY, -halfBody, bottom + PLATE_HEIGHT * 0.28);
    // Bottom-left curve back to center.
    shape.quadraticCurveTo(-halfBody, bottom, 0, bottom);

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: PLATE_THICKNESS,
      bevelEnabled: true,
      bevelThickness: 0.004,
      bevelSize: 0.004,
      bevelSegments: 1,
      curveSegments: 24,
    });

    // Extrude grows along +z from the shape plane; recenter so the plate is
    // centered on z = 0 and its face points toward +z (toward the player).
    geo.translate(0, 0, -PLATE_THICKNESS / 2);
    geo.computeVertexNormals();
    return geo;
  }

  /**
   * Procedural galvanized-steel texture: a mottled grey with faint "spangle"
   * crystals characteristic of hot-dip galvanizing, painted to a CanvasTexture.
   * @returns {THREE.CanvasTexture}
   */
  _makePlateTexture() {
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Base grey.
    ctx.fillStyle = '#9aa0a4';
    ctx.fillRect(0, 0, size, size);

    // Mottled patches for the uneven galvanized sheen.
    for (let i = 0; i < 220; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = Math.random() * 10 + 2;
      const light = Math.random() > 0.5;
      ctx.globalAlpha = Math.random() * 0.14;
      ctx.fillStyle = light ? '#d7dbde' : '#6d7276';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Sharp "spangle" facets: tiny bright crystal edges.
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = '#eef1f3';
    ctx.lineWidth = 1;
    for (let i = 0; i < 40; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const a = Math.random() * Math.PI;
      const len = Math.random() * 12 + 4;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(a) * len, y - Math.sin(a) * len);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  // ---------------------------------------------------------------------------
  // Hit handling
  // ---------------------------------------------------------------------------

  /**
   * Weapon calls this with the nearest raycast intersection against the plate.
   * The first valid hit knocks the popper over; subsequent hits are no-ops.
   * @param {{point:THREE.Vector3}} [intersection]
   * @returns {{kind:'steel', downed:true, already?:true}}
   */
  onHit(intersection) {
    if (this.down) {
      // Already knocked down: report the hit but do nothing.
      return { kind: 'steel', downed: true, already: true };
    }

    // Mark down immediately (so it scores as neutralized) and begin the fall.
    this.down = true;
    this._falling = true;
    this._fallTime = 0;

    return { kind: 'steel', downed: true };
  }

  // ---------------------------------------------------------------------------
  // Per-frame update
  // ---------------------------------------------------------------------------

  /**
   * Advance the fall animation. The pivot group rotates about its local +x axis
   * so the plate swings backward (top toward -z / downrange) with an ease-out,
   * then settles flat. Idle when standing or already settled.
   * @param {number} dt seconds since last frame.
   */
  update(dt) {
    if (!this._falling) return;

    this._fallTime += dt;
    const t = Math.min(this._fallTime / FALL_DURATION, 1);

    // Ease-out cubic for a snappy start that settles gently.
    const eased = 1 - Math.pow(1 - t, 3);

    // Negative rotation about +x tips the top away from the player (toward -z).
    this._pivot.rotation.x = -FALL_ANGLE * eased;

    if (t >= 1) {
      this._falling = false; // settled; stop animating.
    }
  }

  // ---------------------------------------------------------------------------
  // Scoring getter (used at stage end)
  // ---------------------------------------------------------------------------

  /**
   * A popper still standing at stage end is a MISS. `standing` is simply the
   * inverse of `down`.
   * @returns {boolean}
   */
  get standing() {
    return !this.down;
  }
}
