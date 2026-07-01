import * as THREE from 'three';

/*
  Pooled visual effects: bullet tracers, muzzle flashes and impact puffs
  (dust / sparks / paper / blood). Everything is additively blended and
  recycled so the game never allocates per shot in the hot path.
*/

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const IMPACT_COLORS = {
  dust: 0xc9b48a,
  spark: 0xffb23a,
  paper: 0xd8c59a,
  steel: 0xfff2c0,
  blood: 0xc21414,
};

export class Fx {
  constructor(scene) {
    this.group = new THREE.Group();
    this.group.name = 'fx';
    scene.add(this.group);

    this._glow = makeGlowTexture();

    this._tracers = [];
    this._flashes = [];
    this._puffs = [];

    this._buildTracerPool(24);
    this._buildFlashPool(4);
    this._buildPuffPool(48);

    this._up = new THREE.Vector3(0, 1, 0);
    this._dir = new THREE.Vector3();
    this._mid = new THREE.Vector3();
    this._quat = new THREE.Quaternion();
  }

  /* --- tracers --------------------------------------------------------- */
  _buildTracerPool(n) {
    // A unit cylinder along +Y that we stretch/orient between two points.
    const geo = new THREE.CylinderGeometry(0.012, 0.012, 1, 5, 1, true);
    geo.translate(0, 0.5, 0); // origin at the base so scale.y = length
    for (let i = 0; i < n; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffe08a,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this._tracers.push({ mesh, life: 0, maxLife: 0.06 });
    }
  }

  spawnTracer(from, to, color = 0xffe08a) {
    const t = this._tracers.find((x) => x.life <= 0);
    if (!t) return;
    this._dir.copy(to).sub(from);
    const len = this._dir.length();
    if (len < 1e-4) return;
    this._dir.normalize();
    this._quat.setFromUnitVectors(this._up, this._dir);
    t.mesh.position.copy(from);
    t.mesh.quaternion.copy(this._quat);
    t.mesh.scale.set(1, len, 1);
    t.mesh.material.color.setHex(color);
    t.mesh.material.opacity = 0.9;
    t.mesh.visible = true;
    t.life = t.maxLife = 0.06;
  }

  /* --- muzzle flashes -------------------------------------------------- */
  _buildFlashPool(n) {
    for (let i = 0; i < n; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this._glow,
        color: 0xffd27a,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      sprite.scale.setScalar(0.5);
      this.group.add(sprite);
      const light = new THREE.PointLight(0xffb648, 0, 6, 2);
      light.visible = false;
      this.group.add(light);
      this._flashes.push({ sprite, light, life: 0, maxLife: 0.06 });
    }
  }

  spawnMuzzleFlash(pos, color = 0xffd27a) {
    const f = this._flashes.find((x) => x.life <= 0);
    if (!f) return;
    f.sprite.position.copy(pos);
    f.sprite.material.color.setHex(color);
    f.sprite.material.opacity = 1;
    f.sprite.scale.setScalar(0.4 + Math.random() * 0.25);
    f.sprite.material.rotation = Math.random() * Math.PI;
    f.sprite.visible = true;
    f.light.position.copy(pos);
    f.light.color.setHex(color);
    f.light.intensity = 8;
    f.light.visible = true;
    f.life = f.maxLife = 0.06;
  }

  /* --- impact puffs ---------------------------------------------------- */
  _buildPuffPool(n) {
    for (let i = 0; i < n; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this._glow,
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      this.group.add(sprite);
      this._puffs.push({ sprite, life: 0, maxLife: 0.3, growth: 1 });
    }
  }

  /**
   * @param {THREE.Vector3} point
   * @param {string} type one of dust|spark|paper|steel|blood
   * @param {number} [count]
   */
  spawnImpact(point, type = 'dust', count = 3) {
    const color = IMPACT_COLORS[type] ?? IMPACT_COLORS.dust;
    for (let i = 0; i < count; i++) {
      const p = this._puffs.find((x) => x.life <= 0);
      if (!p) return;
      p.sprite.position.set(
        point.x + (Math.random() - 0.5) * 0.08,
        point.y + (Math.random() - 0.5) * 0.08,
        point.z + (Math.random() - 0.5) * 0.08
      );
      p.sprite.material.color.setHex(color);
      p.sprite.material.opacity = 0.9;
      const s = 0.06 + Math.random() * 0.08;
      p.sprite.scale.setScalar(s);
      p.sprite.visible = true;
      p.life = p.maxLife = 0.22 + Math.random() * 0.15;
      p.growth = 0.6 + Math.random() * 1.2;
    }
  }

  /* --- per-frame update ------------------------------------------------ */
  update(dt) {
    for (const t of this._tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      const k = Math.max(0, t.life / t.maxLife);
      t.mesh.material.opacity = 0.9 * k;
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const f of this._flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const k = Math.max(0, f.life / f.maxLife);
      f.sprite.material.opacity = k;
      f.light.intensity = 8 * k;
      if (f.life <= 0) {
        f.sprite.visible = false;
        f.light.visible = false;
      }
    }
    for (const p of this._puffs) {
      if (p.life <= 0) continue;
      p.life -= dt;
      const k = Math.max(0, p.life / p.maxLife);
      p.sprite.material.opacity = 0.9 * k;
      p.sprite.scale.addScalar(p.growth * dt * 0.25);
      p.sprite.position.y += dt * 0.15; // puffs drift up a touch
      if (p.life <= 0) p.sprite.visible = false;
    }
  }
}
