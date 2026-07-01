// src/game/entities/Ranchero.js
//
// The stage-2 hostile "ranchero" (armed rancher) for "Practical Range".
//
// A low-poly humanoid (~1.8m) built entirely from boxes and cylinders: boots,
// jeans, a colorful serape/poncho torso, a wide sombrero, and a stubby revolver
// held in the right hand. He faces the player, telegraphs a shot by raising the
// gun, then fires -- putting a tracer and (on an accuracy roll) damage on the
// player. Breaking line-of-sight during the telegraph makes the shot miss, so
// hiding behind cover is rewarded.
//
// Coordinate conventions (see project world spec):
//   - up is +y, downrange is -z, player looks toward -z from z > 0.
//   - At rotationY = 0 the body faces +z (toward the player). update() re-aims
//     the whole root at the player on the XZ plane each frame.
//
// Shootable entity contract:
//   - root       : THREE.Group added to the scene (positioned at feet on ground).
//   - colliders  : [torsoMesh, headMesh, ...limbMeshes]; each collider sets
//                  mesh.userData.entity === this and mesh.userData.zone in
//                  {'torso','head','limb'}.
//   - onHit(hit) : applies zone damage, returns an enemy hit result, and (on the
//                  transition to dead) starts a fall-over death animation.
//   - update(dt) : runs the aim + fire AI while alive; keeps the fallen body
//                  after death.
//
// Self-contained: imports only three.

import * as THREE from 'three';

// --- Damage per hit zone ------------------------------------------------------
const ZONE_DAMAGE = { head: 60, torso: 25, limb: 15 };

// --- Fire-cycle timing (seconds), before difficulty scaling -------------------
const TELEGRAPH_BASE = 0.5; // gun-raise time at difficulty 0 (faster when higher)
const TELEGRAPH_MIN = 0.22; // fastest telegraph at difficulty 1
const COOLDOWN_MAX = 1.8; // rest between shots at difficulty 0
const COOLDOWN_MIN = 1.2; // rest between shots at difficulty 1
const AIM_SETTLE = 0.35; // brief settle before the first shot can begin

// --- Accuracy / damage --------------------------------------------------------
const ACC_MIN = 0.35; // hit chance at difficulty 0
const ACC_MAX = 0.8; // hit chance at difficulty 1
const DAMAGE_MIN = 12; // player damage on a connecting shot (min)
const DAMAGE_MAX = 20; // player damage on a connecting shot (max)

// --- Death animation ----------------------------------------------------------
const FALL_DURATION = 0.8; // seconds to topple flat
const FALL_ANGLE = THREE.MathUtils.degToRad(90); // final backward lean

// --- Tracer color (warm, tracer-round orange) ---------------------------------
const TRACER_COLOR = 0xffa64d;

// Fire-cycle phases.
const PHASE_IDLE = 'idle'; // waiting for a targetable player
const PHASE_TELEGRAPH = 'telegraph'; // raising the gun toward the player
const PHASE_COOLDOWN = 'cooldown'; // recovering after a shot

// Shared scratch objects to avoid per-frame allocation.
const _muzzleWorld = new THREE.Vector3();
const _playerAim = new THREE.Vector3();
const _flatToPlayer = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();

export class Ranchero {
  /**
   * @param {Object} ctx
   * @param {{x:number,y:number,z:number}} ctx.position feet position on ground.
   * @param {number} [ctx.rotationY=0] initial yaw; 0 => faces +z (player).
   * @param {()=>THREE.Vector3} ctx.getPlayerPosition player chest/eye world pos.
   * @param {()=>boolean} ctx.isPlayerTargetable true iff player alive AND in LOS.
   * @param {(amount:number)=>void} ctx.damagePlayer apply damage on a hit.
   * @param {(from:THREE.Vector3,to:THREE.Vector3,color?:number)=>void} ctx.spawnTracer
   * @param {(pos:THREE.Vector3)=>void} ctx.spawnMuzzleFlash
   * @param {{enemyShot():void,playerHurt():void,enemyDown():void}|null} ctx.sfx
   * @param {number} [ctx.difficulty=0.5] 0..1; higher => faster & more accurate.
   */
  constructor(ctx = {}) {
    const {
      position = { x: 0, y: 0, z: 0 },
      rotationY = 0,
      getPlayerPosition = () => new THREE.Vector3(0, 1.6, 3),
      isPlayerTargetable = () => false,
      damagePlayer = () => {},
      spawnTracer = () => {},
      spawnMuzzleFlash = () => {},
      sfx = null,
      difficulty = 0.5,
    } = ctx;

    // --- Wire callbacks / config -------------------------------------------
    this._getPlayerPosition = getPlayerPosition;
    this._isPlayerTargetable = isPlayerTargetable;
    this._damagePlayer = damagePlayer;
    this._spawnTracer = spawnTracer;
    this._spawnMuzzleFlash = spawnMuzzleFlash;
    this._sfx = sfx || null;
    this._difficulty = THREE.MathUtils.clamp(difficulty, 0, 1);

    // Derived per-instance tuning from difficulty.
    const d = this._difficulty;
    this._accuracy = THREE.MathUtils.lerp(ACC_MIN, ACC_MAX, d);
    this._telegraphTime = THREE.MathUtils.lerp(TELEGRAPH_BASE, TELEGRAPH_MIN, d);
    // Cooldown shrinks with difficulty; a little randomness added per cycle.
    this._cooldownBase = THREE.MathUtils.lerp(COOLDOWN_MAX, COOLDOWN_MIN, d);

    // --- Health / life state ------------------------------------------------
    this.health = 100;
    this._dead = false;

    // --- Fire-cycle state ---------------------------------------------------
    this._phase = PHASE_IDLE;
    this._phaseTime = 0; // seconds elapsed in the current phase
    this._cooldownTarget = this._cooldownBase;
    this._telegraphAbort = false; // set if LOS breaks mid-telegraph

    // --- Animation bookkeeping ---------------------------------------------
    this._age = Math.random() * Math.PI * 2; // idle-sway phase offset
    this._recoil = 0; // 0..1 recoil impulse, decays each frame
    this._gunRaise = 0; // 0..1 how far the gun arm is raised
    this._falling = false;
    this._fallTime = 0;

    // --- Root group, positioned at the feet on the ground. ------------------
    this.root = new THREE.Group();
    this.root.name = 'Ranchero';
    this.root.position.set(position.x, position.y, position.z);
    this.root.rotation.y = rotationY;
    this._targetYaw = rotationY;

    // The body group holds everything that leans over on death, so the fall
    // pivots about the feet without disturbing root's yaw-aiming.
    this._body = new THREE.Group();
    this.root.add(this._body);

    this._buildMaterials();
    this._buildBody();

    // Colliders in the shootable contract order: torso, head, then limbs.
    this.colliders = [
      this._torsoMesh,
      this._headMesh,
      ...this._limbMeshes,
    ];
  }

  // ---------------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------------

  /** Build and cache the shared MeshStandardMaterials used across body parts. */
  _buildMaterials() {
    this._mat = {};
    this._mat.skin = new THREE.MeshStandardMaterial({
      color: 0xb07a52,
      roughness: 0.85,
      metalness: 0.0,
    });
    this._mat.jeans = new THREE.MeshStandardMaterial({
      color: 0x3a4a63,
      roughness: 0.95,
      metalness: 0.0,
    });
    this._mat.boot = new THREE.MeshStandardMaterial({
      color: 0x3a2a1c,
      roughness: 0.8,
      metalness: 0.05,
    });
    this._mat.serape = new THREE.MeshStandardMaterial({
      map: this._makeSerapeTexture(),
      roughness: 0.9,
      metalness: 0.0,
    });
    this._mat.hat = new THREE.MeshStandardMaterial({
      color: 0xc9a24b,
      roughness: 0.85,
      metalness: 0.0,
    });
    this._mat.hatBand = new THREE.MeshStandardMaterial({
      color: 0x6b3a1f,
      roughness: 0.8,
      metalness: 0.0,
    });
    this._mat.steel = new THREE.MeshStandardMaterial({
      color: 0x6a6e72,
      roughness: 0.4,
      metalness: 0.85,
    });
    this._mat.grip = new THREE.MeshStandardMaterial({
      color: 0x4a2f1c,
      roughness: 0.7,
      metalness: 0.05,
    });
  }

  /**
   * Procedural serape (poncho) texture: a woven blanket of warm horizontal
   * stripes in reds/oranges/creams, painted to a CanvasTexture. Wraps around
   * the torso for a colorful low-poly look.
   * @returns {THREE.CanvasTexture}
   */
  _makeSerapeTexture() {
    const w = 64;
    const h = 128;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    // Warm serape palette (bottom-to-top stripe cycle).
    const stripes = [
      '#a83232',
      '#d9662b',
      '#e8c15a',
      '#e8ddc0',
      '#8a3b2e',
      '#c74f2c',
      '#5e6b4a',
    ];

    ctx.fillStyle = '#a83232';
    ctx.fillRect(0, 0, w, h);

    // Horizontal woven stripes of varying height.
    let y = 0;
    let i = 0;
    while (y < h) {
      const band = 6 + ((i * 7) % 11); // pseudo-varied band heights
      ctx.fillStyle = stripes[i % stripes.length];
      ctx.fillRect(0, y, w, band);
      // Fine vertical weave threads for texture.
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = i % 2 ? '#000000' : '#ffffff';
      for (let x = 0; x < w; x += 3) {
        ctx.fillRect(x, y, 1, band);
      }
      ctx.globalAlpha = 1;
      y += band;
      i++;
    }

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * Assemble the humanoid from primitive meshes. The rig is intentionally simple:
   *   - legs/boots and torso/serape/head are static within the body group;
   *   - the RIGHT arm lives in a shoulder pivot group (`_gunArm`) that rotates to
   *     raise the revolver during the telegraph/fire;
   *   - the revolver's muzzle is an empty Object3D (`_muzzle`) whose world
   *     position we read every frame for flashes/tracers.
   */
  _buildBody() {
    this._limbMeshes = [];

    // ---- Legs + boots -----------------------------------------------------
    const hipY = 0.9; // top of legs / bottom of torso
    const legLen = 0.8;
    const legR = 0.09;
    const legGeo = new THREE.CylinderGeometry(legR, legR * 0.9, legLen, 8);
    for (const sx of [-1, 1]) {
      const leg = new THREE.Mesh(legGeo, this._mat.jeans);
      leg.position.set(sx * 0.11, hipY - legLen / 2, 0);
      leg.castShadow = true;
      leg.receiveShadow = true;
      leg.userData.entity = this;
      leg.userData.zone = 'limb';
      this._body.add(leg);
      this._limbMeshes.push(leg);

      // Boot: a low block at the bottom of each leg, nudged forward at the toe.
      const boot = new THREE.Mesh(
        new THREE.BoxGeometry(0.12, 0.1, 0.24),
        this._mat.boot
      );
      boot.position.set(sx * 0.11, 0.05, 0.04);
      boot.castShadow = true;
      boot.receiveShadow = true;
      this._body.add(boot);
    }

    // ---- Torso (separate mesh, zone 'torso') ------------------------------
    // A slightly tapered box for the chest, wrapped in the serape texture.
    const torsoH = 0.62;
    const torsoY = hipY + torsoH / 2;
    const torsoGeo = new THREE.BoxGeometry(0.42, torsoH, 0.26);
    const torso = new THREE.Mesh(torsoGeo, this._mat.serape);
    torso.position.set(0, torsoY, 0);
    torso.castShadow = true;
    torso.receiveShadow = true;
    torso.userData.entity = this;
    torso.userData.zone = 'torso';
    this._body.add(torso);
    this._torsoMesh = torso;

    // Serape drape: a wider, thinner skirt of poncho hanging over the belt line.
    const drape = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 0.28, 0.34),
      this._mat.serape
    );
    drape.position.set(0, hipY + 0.02, 0);
    drape.castShadow = true;
    this._body.add(drape);

    // ---- Neck + head (separate mesh, zone 'head') -------------------------
    const neck = new THREE.Mesh(
      new THREE.CylinderGeometry(0.06, 0.07, 0.1, 8),
      this._mat.skin
    );
    neck.position.set(0, torsoY + torsoH / 2 + 0.05, 0);
    neck.castShadow = true;
    this._body.add(neck);

    const headR = 0.13;
    const headY = neck.position.y + 0.05 + headR * 0.9;
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(headR, 12, 12),
      this._mat.skin
    );
    head.position.set(0, headY, 0);
    head.scale.set(1, 1.1, 1); // slightly ovoid
    head.castShadow = true;
    head.userData.entity = this;
    head.userData.zone = 'head';
    this._body.add(head);
    this._headMesh = head;
    this._headY = headY;

    // Simple moustache slab under the nose for character.
    const stache = new THREE.Mesh(
      new THREE.BoxGeometry(0.11, 0.025, 0.04),
      new THREE.MeshStandardMaterial({
        color: 0x2a1c12,
        roughness: 0.9,
        metalness: 0,
      })
    );
    stache.position.set(0, headY - 0.03, headR * 0.95);
    this._body.add(stache);

    // ---- Sombrero (wide brim + tall crown) --------------------------------
    const hat = new THREE.Group();
    hat.position.set(0, headY + headR * 0.9, 0);
    const brim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.34, 0.34, 0.02, 20),
      this._mat.hat
    );
    brim.castShadow = true;
    hat.add(brim);
    const crown = new THREE.Mesh(
      new THREE.CylinderGeometry(0.13, 0.16, 0.2, 16),
      this._mat.hat
    );
    crown.position.set(0, 0.1, 0);
    crown.castShadow = true;
    hat.add(crown);
    const band = new THREE.Mesh(
      new THREE.CylinderGeometry(0.165, 0.165, 0.04, 16),
      this._mat.hatBand
    );
    band.position.set(0, 0.02, 0);
    hat.add(band);
    this._body.add(hat);

    // ---- Left arm (static, hangs at side) ---------------------------------
    const armGeo = new THREE.CylinderGeometry(0.055, 0.05, 0.5, 7);
    const leftArm = new THREE.Mesh(armGeo, this._mat.serape);
    leftArm.position.set(-0.27, torsoY + 0.05, 0);
    leftArm.rotation.z = 0.12;
    leftArm.castShadow = true;
    leftArm.userData.entity = this;
    leftArm.userData.zone = 'limb';
    this._body.add(leftArm);
    this._limbMeshes.push(leftArm);

    // ---- Right arm on a shoulder pivot (raises to aim the revolver) -------
    // The pivot sits at the right shoulder; rotating it about +x swings the
    // whole forearm+gun up to point downrange (toward the player at +z).
    const shoulderY = torsoY + torsoH / 2 - 0.06;
    this._gunArm = new THREE.Group();
    this._gunArm.position.set(0.27, shoulderY, 0);
    // Resting (arm-down) orientation: pointing mostly downward.
    this._armRestX = 0.15;
    // Raised orientation: forearm pointing forward/up toward the player.
    this._armAimX = -Math.PI / 2 + 0.15;
    this._gunArm.rotation.x = this._armRestX;
    this._body.add(this._gunArm);

    // Upper+fore arm as one cylinder extending along local -y from the shoulder.
    const gunArmMesh = new THREE.Mesh(armGeo, this._mat.serape);
    gunArmMesh.position.set(0, -0.25, 0);
    gunArmMesh.castShadow = true;
    gunArmMesh.userData.entity = this;
    gunArmMesh.userData.zone = 'limb';
    this._gunArm.add(gunArmMesh);
    this._limbMeshes.push(gunArmMesh);

    // Hand (skin) at the end of the arm.
    const hand = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 8, 8),
      this._mat.skin
    );
    hand.position.set(0, -0.5, 0.02);
    hand.castShadow = true;
    this._gunArm.add(hand);

    // ---- Revolver held in the hand ----------------------------------------
    // A small gun group parented to the hand end of the arm. When the arm is
    // rotated up to aim, +z of this group points downrange toward the player.
    this._gun = new THREE.Group();
    this._gun.position.set(0, -0.52, 0.05);
    this._gunArm.add(this._gun);

    // Grip (angled down/back), frame, short barrel, cylinder.
    const grip = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.11, 0.04),
      this._mat.grip
    );
    grip.position.set(0, -0.05, -0.03);
    grip.rotation.x = 0.4;
    this._gun.add(grip);

    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.05, 0.1),
      this._mat.steel
    );
    frame.position.set(0, 0.0, 0.03);
    this._gun.add(frame);

    const cyl = new THREE.Mesh(
      new THREE.CylinderGeometry(0.028, 0.028, 0.05, 10),
      this._mat.steel
    );
    cyl.rotation.z = Math.PI / 2;
    cyl.position.set(0, 0.005, 0.02);
    this._gun.add(cyl);

    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(0.014, 0.014, 0.14, 10),
      this._mat.steel
    );
    barrel.rotation.x = Math.PI / 2; // lay barrel along +z
    barrel.position.set(0, 0.01, 0.13);
    this._gun.add(barrel);

    // Muzzle marker: empty object at the tip of the barrel. Its world position
    // is read each frame for muzzle flashes and tracer origins.
    this._muzzle = new THREE.Object3D();
    this._muzzle.position.set(0, 0.01, 0.2);
    this._gun.add(this._muzzle);
  }

  // ---------------------------------------------------------------------------
  // Life / hit handling
  // ---------------------------------------------------------------------------

  /** @returns {boolean} true while the ranchero still has health. */
  get alive() {
    return this.health > 0;
  }

  /**
   * Weapon calls this with the nearest raycast intersection against a collider.
   * Applies zone damage, and on the transition to dead starts the death anim.
   * @param {{object:THREE.Object3D}} intersection
   * @returns {{kind:'enemy', zone:string, points:number, downed:boolean}}
   */
  onHit(intersection) {
    // Resolve the zone from the struck collider (default to torso if missing).
    const zone =
      (intersection &&
        intersection.object &&
        intersection.object.userData &&
        intersection.object.userData.zone) ||
      'torso';

    // Already dead: report but apply no further damage (idempotent).
    if (this._dead) {
      return { kind: 'enemy', zone, points: 0, downed: true };
    }

    const dmg = ZONE_DAMAGE[zone] != null ? ZONE_DAMAGE[zone] : ZONE_DAMAGE.torso;
    this.health -= dmg;

    if (this.health <= 0) {
      this.health = 0;
      this._die();
    } else {
      // Non-fatal: a small flinch (reuse the recoil channel for a body twitch).
      this._recoil = Math.min(1, this._recoil + 0.5);
    }

    return {
      kind: 'enemy',
      zone,
      points: 0,
      downed: this.health <= 0,
    };
  }

  /** Transition to the dead state: stop shooting and begin the fall-over anim. */
  _die() {
    if (this._dead) return; // idempotent guard
    this._dead = true;
    this._phase = PHASE_IDLE;
    this._telegraphAbort = false;
    this._falling = true;
    this._fallTime = 0;
    // Choose a random topple direction so bodies don't all fall identically.
    this._fallDir = Math.random() < 0.5 ? -1 : 1;
    if (this._sfx && typeof this._sfx.enemyDown === 'function') {
      this._sfx.enemyDown();
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame update
  // ---------------------------------------------------------------------------

  /**
   * Advance AI (while alive) or the death fall (once dead).
   * @param {number} dt seconds since last frame.
   */
  update(dt) {
    if (!Number.isFinite(dt) || dt <= 0) dt = 0;
    this._age += dt;

    // Decay the recoil/flinch impulse toward rest.
    if (this._recoil > 0) {
      this._recoil = Math.max(0, this._recoil - dt * 6);
    }

    if (this._dead) {
      this._updateDeath(dt);
      return;
    }

    this._updateAim(dt);
    this._updateFireCycle(dt);
    this._updatePose(dt);
  }

  /** Rotate root to face the player on the XZ plane (smooth turn). */
  _updateAim(dt) {
    const player = this._getPlayerPosition ? this._getPlayerPosition() : null;
    if (!player) return;

    _flatToPlayer.set(
      player.x - this.root.position.x,
      0,
      player.z - this.root.position.z
    );
    if (_flatToPlayer.lengthSq() < 1e-6) return;

    // Yaw so that local +z points at the player (body faces +z at yaw 0).
    this._targetYaw = Math.atan2(_flatToPlayer.x, _flatToPlayer.z);

    // Smoothly interpolate current yaw toward the target (shortest path).
    let delta = this._targetYaw - this.root.rotation.y;
    delta = Math.atan2(Math.sin(delta), Math.cos(delta)); // wrap to [-PI, PI]
    const turnRate = 6; // rad/s cap-ish via exponential smoothing
    this.root.rotation.y += delta * Math.min(1, turnRate * dt);
  }

  /**
   * Drive the telegraph -> fire -> cooldown state machine.
   * @param {number} dt
   */
  _updateFireCycle(dt) {
    const targetable = this._isPlayerTargetable
      ? !!this._isPlayerTargetable()
      : false;

    this._phaseTime += dt;

    switch (this._phase) {
      case PHASE_IDLE: {
        // Wait for a targetable player, then begin the telegraph. A small
        // settle delay keeps him from firing the instant he spots the player.
        if (targetable && this._phaseTime >= AIM_SETTLE) {
          this._enterPhase(PHASE_TELEGRAPH);
          this._telegraphAbort = false;
        }
        break;
      }

      case PHASE_TELEGRAPH: {
        // If LOS breaks mid-telegraph, abort the shot (miss) -> straight to
        // cooldown. This rewards the player for ducking behind cover.
        if (!targetable) {
          this._telegraphAbort = true;
          this._beginCooldown();
          break;
        }
        // Gun-raise progress drives the arm pose in _updatePose().
        if (this._phaseTime >= this._telegraphTime) {
          this._fire();
          this._beginCooldown();
        }
        break;
      }

      case PHASE_COOLDOWN: {
        if (this._phaseTime >= this._cooldownTarget) {
          // Return to idle; if still targetable it will re-telegraph promptly.
          this._enterPhase(PHASE_IDLE);
          // Skip the settle delay on subsequent cycles by pre-charging time.
          this._phaseTime = AIM_SETTLE;
        }
        break;
      }

      default:
        this._enterPhase(PHASE_IDLE);
        break;
    }
  }

  /** Enter a new fire-cycle phase and reset its timer. */
  _enterPhase(phase) {
    this._phase = phase;
    this._phaseTime = 0;
  }

  /** Begin the post-shot cooldown with a little per-cycle jitter. */
  _beginCooldown() {
    this._enterPhase(PHASE_COOLDOWN);
    // +-0.2s jitter so a group of rancheros doesn't fire in lockstep.
    this._cooldownTarget = this._cooldownBase + (Math.random() * 0.4 - 0.2);
  }

  /**
   * Execute a shot: muzzle flash + tracer + sfx, then an accuracy roll gated on
   * the player STILL being targetable at the fire instant. On a connecting shot,
   * apply damage and play the hurt sfx.
   */
  _fire() {
    // Re-check targetability at the exact fire instant: if the player broke LOS
    // in the last frame of the telegraph, the shot misses.
    const stillTargetable = this._isPlayerTargetable
      ? !!this._isPlayerTargetable()
      : false;

    // Compute the muzzle world position (source of flash + tracer).
    this._muzzle.getWorldPosition(_muzzleWorld);

    // Aim point: the player's chest/eye position (fallback: straight downrange).
    const player = this._getPlayerPosition ? this._getPlayerPosition() : null;
    if (player) {
      _playerAim.copy(player);
    } else {
      _playerAim.copy(_muzzleWorld);
      _playerAim.z -= 10;
    }

    // Muzzle flash + tracer are always shown (the gun visibly goes off).
    if (this._spawnMuzzleFlash) this._spawnMuzzleFlash(_muzzleWorld.clone());
    if (this._spawnTracer) {
      // On a miss, nudge the tracer endpoint slightly off the player so it reads
      // as a near-miss whizzing past.
      _tmpVec.copy(_playerAim);
      if (!stillTargetable) {
        _tmpVec.x += (Math.random() - 0.5) * 0.8;
        _tmpVec.y += (Math.random() - 0.5) * 0.6;
        _tmpVec.z += (Math.random() - 0.5) * 0.4;
      }
      this._spawnTracer(_muzzleWorld.clone(), _tmpVec.clone(), TRACER_COLOR);
    }
    if (this._sfx && typeof this._sfx.enemyShot === 'function') {
      this._sfx.enemyShot();
    }

    // Kick the recoil animation.
    this._recoil = 1;

    // Damage resolution: must still have LOS AND pass the accuracy roll.
    if (stillTargetable && Math.random() < this._accuracy) {
      const amount = THREE.MathUtils.lerp(
        DAMAGE_MIN,
        DAMAGE_MAX,
        Math.random()
      );
      if (this._damagePlayer) this._damagePlayer(amount);
      if (this._sfx && typeof this._sfx.playerHurt === 'function') {
        this._sfx.playerHurt();
      }
    }
  }

  /**
   * Update the visible pose: idle sway, gun-arm raise (driven by phase), and
   * a short recoil kick. Runs only while alive.
   * @param {number} dt
   */
  _updatePose(dt) {
    // ---- Gun-arm raise target based on phase ------------------------------
    // Raised while telegraphing (ramping in) and briefly held through recoil;
    // lowered while idle/cooldown once the recoil has decayed.
    let raiseTarget;
    if (this._phase === PHASE_TELEGRAPH) {
      // Ramp 0 -> 1 across the telegraph so the gun visibly comes up.
      raiseTarget = THREE.MathUtils.clamp(
        this._phaseTime / this._telegraphTime,
        0,
        1
      );
    } else if (this._phase === PHASE_COOLDOWN && this._phaseTime < 0.4) {
      raiseTarget = 1; // hold the gun up briefly right after firing
    } else {
      raiseTarget = 0;
    }

    // Smooth the raise value toward its target.
    const k = Math.min(1, dt * 10);
    this._gunRaise += (raiseTarget - this._gunRaise) * k;

    // Map raise 0..1 between the resting and aimed shoulder rotations, then add
    // a recoil kick that snaps the muzzle up briefly after a shot.
    const recoilKick = this._recoil * 0.35;
    this._gunArm.rotation.x =
      THREE.MathUtils.lerp(this._armRestX, this._armAimX, this._gunRaise) -
      recoilKick;
    // Slight sideways recoil twist for life.
    this._gunArm.rotation.z = -this._recoil * 0.12;

    // ---- Idle sway: gentle breathing + weight shift ------------------------
    const sway = Math.sin(this._age * 1.6) * 0.02;
    const bob = Math.sin(this._age * 0.9) * 0.01;
    this._body.rotation.z = sway * 0.4;
    this._body.position.y = bob;
    // A tiny recoil lean-back on the torso when firing.
    this._body.rotation.x = -this._recoil * 0.05;
  }

  /**
   * Advance the death fall: the body group topples about the feet with an
   * ease-out and settles flat. Idempotent once settled; the body remains.
   * @param {number} dt
   */
  _updateDeath(dt) {
    if (!this._falling) return;

    this._fallTime += dt;
    const t = Math.min(this._fallTime / FALL_DURATION, 1);

    // Ease-out cubic: quick topple that settles gently.
    const eased = 1 - Math.pow(1 - t, 3);
    const angle = FALL_ANGLE * eased;

    // Fall backward (away from the player) with a slight sideways component so
    // the body reads as crumpling rather than a rigid board.
    this._body.rotation.x = -angle;
    this._body.rotation.z = this._fallDir * angle * 0.25;
    // Lower the body a touch as it goes over so it visually meets the ground.
    this._body.position.y = -0.15 * eased;

    // Also flop the gun arm loose during the fall.
    this._gunArm.rotation.x = THREE.MathUtils.lerp(
      this._gunArm.rotation.x,
      this._armRestX + 0.6,
      Math.min(1, dt * 4)
    );

    if (t >= 1) {
      this._falling = false; // settled; keep the fallen body in place.
    }
  }
}
