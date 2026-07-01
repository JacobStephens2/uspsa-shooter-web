import * as THREE from 'three';

/*
  The player's pistol: a low-poly view-model attached to the camera plus the
  fire/reload/recoil state machine. The Game resolves the actual raycast; this
  class owns ammo, timing, the muzzle position and all the hand animation.

  Semi-auto, magazine of 17, unlimited belt mags (reload always refills).
*/

const MAG_SIZE = 17;
const FIRE_INTERVAL = 0.11; // seconds between shots (cap)
const RELOAD_TIME = 1.9;

export class Weapon {
  constructor() {
    this.magSize = MAG_SIZE;
    this.ammo = MAG_SIZE;
    this.reloading = false;
    this._reloadT = 0;
    this._cooldown = 0;
    this._kick = 0; // 0..1 view-model recoil
    this._flash = 0; // 0..1 view-model muzzle flash
    this._trigger = 0;

    this.group = new THREE.Group();
    this.group.name = 'viewmodel';
    this._restPos = new THREE.Vector3(0.2, -0.2, -0.45);
    this._restRot = new THREE.Euler(0.02, -0.06, 0);
    this._buildModel();
    this._muzzleWorld = new THREE.Vector3();
  }

  attachTo(camera) {
    camera.add(this.group);
  }

  _buildModel() {
    const gun = new THREE.Group();

    const gunmetal = new THREE.MeshStandardMaterial({ color: 0x23262b, metalness: 0.85, roughness: 0.42 });
    const gripMat = new THREE.MeshStandardMaterial({ color: 0x14161a, metalness: 0.2, roughness: 0.85 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x0c0d10, metalness: 0.6, roughness: 0.5 });

    // slide
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.28), gunmetal);
    slide.position.set(0, 0, -0.06);
    gun.add(slide);

    // barrel tip / muzzle block
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.05, 0.06), accent);
    barrel.position.set(0, 0, -0.22);
    gun.add(barrel);

    // frame under slide
    const frame = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.045, 0.2), accent);
    frame.position.set(0, -0.055, -0.03);
    gun.add(frame);

    // grip (angled)
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.14, 0.07), gripMat);
    grip.position.set(0, -0.13, 0.06);
    grip.rotation.x = 0.28;
    gun.add(grip);

    // trigger guard
    const guard = new THREE.Mesh(new THREE.TorusGeometry(0.032, 0.008, 6, 12, Math.PI), accent);
    guard.position.set(0, -0.075, 0.01);
    guard.rotation.x = Math.PI / 2;
    gun.add(guard);

    // rear sight
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.02), accent);
    sight.position.set(0, 0.04, 0.06);
    gun.add(sight);

    for (const m of gun.children) {
      m.castShadow = false;
      m.receiveShadow = false;
    }
    gun.traverse((o) => (o.frustumCulled = false));

    // muzzle marker (front of the barrel) — used for tracer/flash origin
    this._muzzle = new THREE.Object3D();
    this._muzzle.position.set(0, 0, -0.26);
    gun.add(this._muzzle);

    this._gun = gun;
    this.group.add(gun);
    this.group.position.copy(this._restPos);
    this.group.rotation.copy(this._restRot);
  }

  reset() {
    this.ammo = this.magSize;
    this.reloading = false;
    this._reloadT = 0;
    this._cooldown = 0;
    this._kick = 0;
    this._flash = 0;
  }

  get isEmpty() {
    return this.ammo <= 0;
  }

  get isReloading() {
    return this.reloading;
  }

  canFire() {
    return !this.reloading && this.ammo > 0 && this._cooldown <= 0;
  }

  /**
   * Consume a round. Caller must have checked canFire().
   * @returns {{recoilPitch:number, recoilYaw:number, spread:number}}
   */
  fire() {
    this.ammo--;
    this._cooldown = FIRE_INTERVAL;
    this._kick = 1;
    this._flash = 1;
    this._trigger = 1;
    const recoilPitch = 0.017 + Math.random() * 0.006;
    const recoilYaw = (Math.random() - 0.5) * 0.012;
    return { recoilPitch, recoilYaw, spread: 0.0055 };
  }

  /** Empty-chamber trigger pull (no round). */
  dryFire() {
    this._trigger = 1;
  }

  startReload() {
    if (this.reloading || this.ammo >= this.magSize) return false;
    this.reloading = true;
    this._reloadT = RELOAD_TIME;
    return true;
  }

  getMuzzleWorldPosition(out = this._muzzleWorld) {
    this._muzzle.getWorldPosition(out);
    return out;
  }

  update(dt) {
    if (this._cooldown > 0) this._cooldown -= dt;
    if (this._trigger > 0) this._trigger = Math.max(0, this._trigger - dt * 14);

    // reload timer + refill at completion
    if (this.reloading) {
      this._reloadT -= dt;
      if (this._reloadT <= 0) {
        this.reloading = false;
        this.ammo = this.magSize;
      }
    }

    // decay view-model recoil + flash
    this._kick += (0 - this._kick) * Math.min(1, dt * 16);
    this._flash = Math.max(0, this._flash - dt * 18);

    this._animate();
  }

  _animate() {
    const g = this.group;
    // start from rest pose
    let px = this._restPos.x;
    let py = this._restPos.y;
    let pz = this._restPos.z;
    let rx = this._restRot.x;
    let ry = this._restRot.y;
    let rz = this._restRot.z;

    // recoil: gun kicks back and muzzle rises
    pz += this._kick * 0.05;
    py += this._kick * 0.012;
    rx -= this._kick * 0.35;

    // trigger finger tick (tiny)
    rx -= this._trigger * 0.01;

    // reload: dip down and cant while swapping mags
    if (this.reloading) {
      const t = 1 - this._reloadT / RELOAD_TIME; // 0..1 progress
      const dip = Math.sin(Math.min(1, t) * Math.PI); // up at ends, down mid
      py -= dip * 0.16;
      px -= dip * 0.04;
      rz += dip * 0.5;
      rx += dip * 0.2;
    }

    g.position.set(px, py, pz);
    g.rotation.set(rx, ry, rz);
  }
}
