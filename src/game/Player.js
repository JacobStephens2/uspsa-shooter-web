import * as THREE from 'three';

/*
  First-person player: mouse-look, WASD movement with sprint, AABB collision
  against the shooting bay, weapon recoil applied to the view, and (stage 2)
  a health pool.

  position = feet on the ground plane (y = 0). The camera sits at eye height.
*/

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const HALF_PI = Math.PI / 2;

export class Player {
  constructor(camera) {
    this.camera = camera;
    this.position = new THREE.Vector3(0, 0, 2);
    this.yaw = 0; // yaw 0 looks down -z (downrange)
    this.pitch = 0;

    this.standEye = 1.6;
    this.crouchEye = 1.0;
    this._eye = 1.6; // current (lerped) eye height
    this.crouching = false;
    this.radius = 0.32;
    this.walkSpeed = 3.4;
    this.sprintSpeed = 5.4;

    this.sensitivity = 0.0022;

    this.recoilPitch = 0;
    this.recoilYaw = 0;

    this.maxHealth = 100;
    this.health = 100;

    this._bob = 0;
    this._vel = new THREE.Vector3();

    // scratch vectors
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._move = new THREE.Vector3();
    this._tmp = new THREE.Vector3();
  }

  reset(start, facingYaw) {
    this.position.set(start.x, 0, start.z);
    this.yaw = facingYaw ?? 0;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.health = this.maxHealth;
    this._eye = this.standEye;
    this.crouching = false;
    this._bob = 0;
    this._vel.set(0, 0, 0);
    this.syncCamera();
  }

  get alive() {
    return this.health > 0;
  }

  applyDamage(n) {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - n);
  }

  heal(n) {
    this.health = Math.min(this.maxHealth, this.health + n);
  }

  addRecoil(pitch, yaw) {
    this.recoilPitch += pitch;
    this.recoilYaw += yaw;
  }

  look(dx, dy) {
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    const limit = HALF_PI - 0.05;
    this.pitch = Math.max(-limit, Math.min(limit, this.pitch));
  }

  /**
   * @param {number} dt
   * @param {Input} input
   * @param {{aabbs:Array, bounds:Object}} collision
   */
  update(dt, input, collision) {
    // --- mouse look ---
    // Apply accumulated pointer-lock mouse motion to yaw/pitch. Only when an
    // input is supplied (i.e. during live gameplay, not the countdown).
    if (input) {
      const md = input.consumeMouseDelta();
      if (md.x || md.y) this.look(md.x, md.y);
    }

    // --- look (recoil recovery) ---
    this.recoilPitch += (0 - this.recoilPitch) * Math.min(1, dt * 12);
    this.recoilYaw += (0 - this.recoilYaw) * Math.min(1, dt * 12);

    // --- movement ---
    this.camera.rotation.set(0, this.yaw, 0, 'YXZ');
    this._forward.set(0, 0, -1).applyEuler(this.camera.rotation);
    this._forward.y = 0;
    this._forward.normalize();
    this._right.crossVectors(this._forward, WORLD_UP).normalize();

    let f = 0;
    let s = 0;
    if (input) {
      if (input.isDown('KeyW') || input.isDown('ArrowUp')) f += 1;
      if (input.isDown('KeyS') || input.isDown('ArrowDown')) f -= 1;
      if (input.isDown('KeyD') || input.isDown('ArrowRight')) s += 1;
      if (input.isDown('KeyA') || input.isDown('ArrowLeft')) s -= 1;
    }
    // crouch: hold Ctrl or C — lowers the view so cover actually breaks LOS
    this.crouching = !!(input && (input.isDown('ControlLeft') || input.isDown('ControlRight') || input.isDown('KeyC')));
    const targetEye = this.crouching ? this.crouchEye : this.standEye;
    this._eye += (targetEye - this._eye) * Math.min(1, dt * 12);

    const sprinting = !this.crouching && input && (input.isDown('ShiftLeft') || input.isDown('ShiftRight'));
    const speed = this.crouching ? this.walkSpeed * 0.5 : sprinting ? this.sprintSpeed : this.walkSpeed;

    this._move.set(0, 0, 0);
    this._move.addScaledVector(this._forward, f);
    this._move.addScaledVector(this._right, s);
    if (this._move.lengthSq() > 1) this._move.normalize();

    const moving = this._move.lengthSq() > 0.0001;
    // smooth velocity for a little weight
    const target = this._tmp.copy(this._move).multiplyScalar(speed);
    this._vel.lerp(target, Math.min(1, dt * 14));

    this.position.addScaledVector(this._vel, dt);

    if (collision) this._resolveCollision(collision);

    // head bob
    if (moving) this._bob += dt * (sprinting ? 13 : 9);
    else this._bob += (0 - (this._bob % (Math.PI * 2))) * 0; // idle: leave phase
    const bobAmt = moving ? (sprinting ? 0.055 : 0.035) : 0;

    this._bobOffset = Math.sin(this._bob) * bobAmt;

    this.syncCamera();
  }

  _resolveCollision(collision) {
    const p = this.position;
    const r = this.radius;

    // Push the player circle out of each solid AABB (top-down).
    if (collision.aabbs) {
      for (const b of collision.aabbs) {
        const cx = Math.max(b.minX, Math.min(p.x, b.maxX));
        const cz = Math.max(b.minZ, Math.min(p.z, b.maxZ));
        const dx = p.x - cx;
        const dz = p.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 < r * r) {
          if (d2 > 1e-6) {
            const d = Math.sqrt(d2);
            p.x = cx + (dx / d) * r;
            p.z = cz + (dz / d) * r;
          } else {
            // center inside the box: pop out along the nearest face
            const left = Math.abs(p.x - b.minX);
            const rightD = Math.abs(b.maxX - p.x);
            const back = Math.abs(p.z - b.minZ);
            const front = Math.abs(b.maxZ - p.z);
            const m = Math.min(left, rightD, back, front);
            if (m === left) p.x = b.minX - r;
            else if (m === rightD) p.x = b.maxX + r;
            else if (m === back) p.z = b.minZ - r;
            else p.z = b.maxZ + r;
          }
        }
      }
    }

    // Keep inside the walkable bounds.
    if (collision.bounds) {
      const b = collision.bounds;
      p.x = Math.max(b.minX + r, Math.min(b.maxX - r, p.x));
      p.z = Math.max(b.minZ + r, Math.min(b.maxZ - r, p.z));
    }
  }

  syncCamera() {
    const cam = this.camera;
    cam.position.set(
      this.position.x,
      this._eye + (this._bobOffset || 0),
      this.position.z
    );
    cam.rotation.set(this.pitch + this.recoilPitch, this.yaw + this.recoilYaw, 0, 'YXZ');
  }

  getEyePosition(out = new THREE.Vector3()) {
    return out.set(this.position.x, this._eye, this.position.z);
  }

  getChestPosition(out = new THREE.Vector3()) {
    // tracks crouch so low cover breaks the enemy's line of sight to the chest
    return out.set(this.position.x, Math.max(0.5, this._eye - 0.45), this.position.z);
  }

  /** World-space aim direction from the camera, with an optional spread cone. */
  getAimDirection(spreadRad = 0, out = new THREE.Vector3()) {
    this.camera.getWorldDirection(out);
    if (spreadRad > 0) {
      // jitter within a small cone: pitch about the view-right axis, yaw about world up
      const ax = (Math.random() - 0.5) * 2 * spreadRad;
      const ay = (Math.random() - 0.5) * 2 * spreadRad;
      out.applyAxisAngle(this._right, ax).applyAxisAngle(WORLD_UP, ay);
      out.normalize();
    }
    return out;
  }
}
