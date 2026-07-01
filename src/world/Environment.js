// src/world/Environment.js
//
// Shared outdoor range world + reusable props for "Practical Range".
//
// The Environment owns everything that is NOT a shootable entity: the ground,
// the sky/fog, the golden-hour lighting rig, and the procedurally-built
// shooting bays (berms, side walls, fault lines, barrels, cover). All geometry
// is generated procedurally and all textures are painted to HTMLCanvas ->
// THREE.CanvasTexture; there are no external asset files or network fetches.
//
// Coordinate conventions (see project world spec):
//   - Ground is the plane y = 0, up is +y.
//   - "Downrange" is the -z direction; targets live at negative z.
//   - The player stands near z ~ +1..+3 looking toward -z; +x is to the right.
//   - Player eye height ~1.6 m.
//
// Aesthetic: gritty outdoor shooting range at golden hour. Dry dirt/gravel
// ground, hazy warm sky, long low sun casting soft shadows.
//
// Public API:
//   new Environment(scene)
//     .root : THREE.Group   (env meshes: ground, sky dome, ...)
//     .sun  : THREE.DirectionalLight
//     .buildShootingBay(opts) -> { group, blockers, aabbs, bounds, coverObjects }
//   Environment.barrel(x, z) -> THREE.Mesh   (static helper, 55-gal drum)

import * as THREE from 'three';

// --- Golden-hour palette ------------------------------------------------------
// Warm hazy dusk. Sky is a soft amber-to-dusty-blue gradient; the sun is a low
// orange key light; ground/fog pick up the warm ambient bounce.
const SKY_TOP = 0x8899b8; // dusty blue high overhead
const SKY_HORIZON = 0xf0c48a; // warm hazy amber near the horizon
const SKY_BOTTOM = 0xc99a63; // dusty ground-glow just below the horizon
const FOG_COLOR = 0xdcb888; // matches the hazy horizon band
const SUN_COLOR = 0xffd9a0; // warm low-angle key light
const HEMI_SKY = 0xbfd0e8; // cool sky fill from above
const HEMI_GROUND = 0x9a7040; // warm dirt bounce from below

// Dirt / earth tones reused by ground and berms.
const DIRT_BASE = 0x9a7b4f; // dry packed dirt
const DIRT_DARK = 0x6f5636; // damp/shadowed dirt patches
const DIRT_LIGHT = 0xc2a877; // dusty highlights / fine gravel
const GRAVEL_GREY = 0x8a8378; // scattered gravel stones

export class Environment {
  /**
   * Build the shared world and add it to the given scene.
   * @param {THREE.Scene} scene
   */
  constructor(scene) {
    this.scene = scene;

    // Container for all non-shootable environment meshes.
    this.root = new THREE.Group();
    this.root.name = 'Environment';
    scene.add(this.root);

    // Cache shared dirt texture so ground + berms + bays reuse one upload.
    this._dirtTexture = null;

    this._buildSky();
    this._buildFog();
    this._buildGround();
    this._buildLighting();
  }

  // ---------------------------------------------------------------------------
  // Sky
  // ---------------------------------------------------------------------------

  /**
   * Large inverted gradient dome painted with a golden-hour sky. Rendered on
   * the BackSide so it wraps the whole scene; it is unlit (MeshBasicMaterial)
   * and does not cast/receive shadows.
   */
  _buildSky() {
    const tex = this._makeSkyTexture();

    // A big sphere well beyond the fog far-plane so it reads as a distant sky.
    const geo = new THREE.SphereGeometry(400, 32, 16);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false, // the dome IS the horizon color; don't double-fog it
    });

    const dome = new THREE.Mesh(geo, mat);
    dome.name = 'SkyDome';
    dome.renderOrder = -1; // draw first, behind everything
    this.root.add(dome);
    this._skyDome = dome;

    // Also set the scene background to the horizon color so any gap outside the
    // dome (or before it draws) still reads as sky, and it seeds fog blending.
    this.scene.background = new THREE.Color(SKY_HORIZON);
  }

  /**
   * Paint a vertical sky gradient onto a tall thin canvas. The gradient maps up
   * the sphere: bottom = warm ground glow, middle = hazy amber horizon, top =
   * dusty blue. Equirectangular mapping means the V axis is the vertical sweep.
   * @returns {THREE.CanvasTexture}
   */
  _makeSkyTexture() {
    const w = 16;
    const h = 256;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    // V=0 (canvas top) maps to the sphere's top pole; V=1 (bottom) to the
    // bottom pole. So paint blue at the top and warm glow at the bottom.
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0.0, '#' + toHex(SKY_TOP));
    grad.addColorStop(0.45, '#' + toHex(SKY_TOP));
    grad.addColorStop(0.62, '#' + toHex(SKY_HORIZON)); // hazy horizon band
    grad.addColorStop(0.72, '#' + toHex(SKY_HORIZON));
    grad.addColorStop(1.0, '#' + toHex(SKY_BOTTOM));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // A faint warm sun bloom smeared into the horizon band for atmosphere.
    const bloom = ctx.createRadialGradient(w / 2, h * 0.64, 0, w / 2, h * 0.64, h * 0.18);
    bloom.addColorStop(0, 'rgba(255,240,205,0.55)');
    bloom.addColorStop(1, 'rgba(255,240,205,0)');
    ctx.fillStyle = bloom;
    ctx.fillRect(0, h * 0.4, w, h * 0.5);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    return tex;
  }

  // ---------------------------------------------------------------------------
  // Fog
  // ---------------------------------------------------------------------------

  /** Gentle linear fog matching the hazy horizon so distant berms fade out. */
  _buildFog() {
    // Near/far chosen so the ~30 m deep bay stays crisp but the far berm and
    // sky blend softly into the golden haze.
    this.scene.fog = new THREE.Fog(FOG_COLOR, 18, 120);
  }

  // ---------------------------------------------------------------------------
  // Ground
  // ---------------------------------------------------------------------------

  /** Large flat dirt/gravel plane at y = 0 that receives shadows. */
  _buildGround() {
    const tex = this._getDirtTexture();
    // Tile the dirt across the big plane so the grain stays fine, not stretched.
    const ground = tex.clone();
    ground.needsUpdate = true;
    ground.wrapS = ground.wrapT = THREE.RepeatWrapping;
    ground.repeat.set(60, 60);
    ground.colorSpace = THREE.SRGBColorSpace;

    const mat = new THREE.MeshStandardMaterial({
      map: ground,
      color: 0xffffff,
      roughness: 1.0,
      metalness: 0.0,
    });

    const geo = new THREE.PlaneGeometry(300, 300, 1, 1);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'Ground';
    mesh.rotation.x = -Math.PI / 2; // lay flat, facing +y
    mesh.position.y = 0;
    mesh.receiveShadow = true;
    this.root.add(mesh);
    this._ground = mesh;
  }

  /**
   * Lazily build (and cache) the shared dry-dirt/gravel CanvasTexture. The base
   * pattern is a subtle mottle of dirt tones speckled with small gravel stones;
   * it is designed to tile seamlessly via RepeatWrapping.
   * @returns {THREE.CanvasTexture}
   */
  _getDirtTexture() {
    if (this._dirtTexture) return this._dirtTexture;

    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');

    // Base dirt fill.
    ctx.fillStyle = '#' + toHex(DIRT_BASE);
    ctx.fillRect(0, 0, size, size);

    // Soft blotchy dirt patches (darker damp + lighter dusty) for large-scale
    // variation. Drawn with wrap-around so tiling has no visible seam.
    const blotch = (color, count, rMin, rMax, aMax) => {
      ctx.fillStyle = color;
      for (let i = 0; i < count; i++) {
        const x = Math.random() * size;
        const y = Math.random() * size;
        const r = rMin + Math.random() * (rMax - rMin);
        ctx.globalAlpha = Math.random() * aMax;
        // Draw the blotch and its wrapped copies so edges match across tiles.
        for (const ox of [-size, 0, size]) {
          for (const oy of [-size, 0, size]) {
            ctx.beginPath();
            ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.globalAlpha = 1;
    };
    blotch('#' + toHex(DIRT_DARK), 40, 10, 34, 0.25);
    blotch('#' + toHex(DIRT_LIGHT), 46, 8, 28, 0.22);

    // Fine speckle noise for grain.
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const s = Math.random() * 1.6 + 0.3;
      ctx.globalAlpha = Math.random() * 0.18;
      ctx.fillStyle = Math.random() > 0.5 ? '#4f3d24' : '#d8c39a';
      ctx.fillRect(x, y, s, s);
    }

    // Scattered gravel stones: small grey pebbles with a tiny highlight.
    ctx.globalAlpha = 1;
    for (let i = 0; i < 130; i++) {
      const x = Math.random() * size;
      const y = Math.random() * size;
      const r = Math.random() * 2.4 + 0.8;
      const shade = 0.7 + Math.random() * 0.5;
      ctx.fillStyle = '#' + toHex(scaleColor(GRAVEL_GREY, shade));
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      // faint top-left highlight so pebbles catch the low sun
      ctx.fillStyle = 'rgba(255,246,225,0.35)';
      ctx.beginPath();
      ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    this._dirtTexture = tex;
    return tex;
  }

  // ---------------------------------------------------------------------------
  // Lighting
  // ---------------------------------------------------------------------------

  /** Golden-hour rig: warm low sun (shadows) + hemisphere fill + soft ambient. */
  _buildLighting() {
    // --- Sun: warm, low-angle key light, casts shadows. --------------------
    const sun = new THREE.DirectionalLight(SUN_COLOR, 2.6);
    sun.name = 'Sun';
    // Low golden-hour angle: high-ish z (behind/over the player's shoulder) and
    // off to one side so shadows rake long across the bay toward downrange.
    sun.position.set(-14, 10, 16);
    sun.target.position.set(0, 0, -8); // aim down into the bay
    sun.castShadow = true;

    // Shadow camera sized to comfortably cover a ~30 m deep bay plus margins.
    sun.shadow.mapSize.set(2048, 2048);
    const cam = sun.shadow.camera;
    cam.near = 0.5;
    cam.far = 80;
    cam.left = -22;
    cam.right = 22;
    cam.top = 22;
    cam.bottom = -22;
    // Bias tuning to reduce shadow acne / peter-panning on the flat ground.
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    cam.updateProjectionMatrix();

    this.root.add(sun);
    this.root.add(sun.target);
    this.sun = sun;

    // --- Hemisphere fill: cool sky above, warm dirt bounce below. ----------
    const hemi = new THREE.HemisphereLight(HEMI_SKY, HEMI_GROUND, 0.55);
    hemi.name = 'HemiFill';
    hemi.position.set(0, 20, 0);
    this.root.add(hemi);
    this._hemi = hemi;

    // --- Light ambient so shadowed sides never go fully black. -------------
    const ambient = new THREE.AmbientLight(0xffe6c2, 0.18);
    ambient.name = 'Ambient';
    this.root.add(ambient);
    this._ambient = ambient;
  }

  // ---------------------------------------------------------------------------
  // Shooting bay
  // ---------------------------------------------------------------------------

  /**
   * Build a downrange shooting bay: low earth berms / side walls framing the
   * area, a tall back berm behind the targets (downrange, -z), wooden
   * fault-line markers at the front, and scattered range props. Optionally
   * places cover (barrels / low walls) inside the walkable area.
   *
   * The bay is centered on x = 0. The player-walkable box sits near the front
   * (z ~ +0.5..+3) and the targets/back berm are downrange at negative z.
   *
   * @param {Object} opts
   * @param {number} opts.width  full interior width of the bay (x span, meters).
   * @param {number} opts.depth  full interior depth (z span from front to back berm).
   * @param {boolean} [opts.cover=false] if true, add 2-4 cover props inside the
   *   walkable area (both blockers AND coverObjects, with matching aabbs).
   * @returns {{
   *   group: THREE.Group,
   *   blockers: THREE.Mesh[],
   *   aabbs: Array<{minX:number,maxX:number,minZ:number,maxZ:number}>,
   *   bounds: {minX:number,maxX:number,minZ:number,maxZ:number},
   *   coverObjects: THREE.Mesh[]
   * }}
   */
  buildShootingBay(opts = {}) {
    const { width = 12, depth = 20, cover = false } = opts;

    const group = new THREE.Group();
    group.name = 'ShootingBay';

    /** @type {THREE.Mesh[]} */
    const blockers = [];
    /** @type {Array<{minX:number,maxX:number,minZ:number,maxZ:number}>} */
    const aabbs = [];
    /** @type {THREE.Mesh[]} */
    const coverObjects = [];

    const halfW = width / 2;

    // Bay layout along z:
    //   front edge (player side) at z = FRONT (positive)
    //   back berm (downrange) at z = BACK (negative)
    const FRONT_Z = 3.2; // just downrange of the player's start box
    const BACK_Z = FRONT_Z - depth; // downrange back wall (negative)

    // Materials shared across this bay.
    const bermMat = this._makeBermMaterial();
    const woodMat = new THREE.MeshStandardMaterial({
      color: 0x6b4a2b,
      roughness: 0.92,
      metalness: 0.0,
    });

    // --- Side berms (left/right earth walls running downrange). -------------
    // Each is a long trapezoidal earth mound. We model it as a box with a
    // slightly tapered top for a mounded look, sitting just outside the
    // walkable width. They block shots and player movement.
    const bermHeight = 1.6;
    const bermThickness = 1.4; // footprint thickness (x) of each side berm
    const bermLen = FRONT_Z - BACK_Z + 2; // slightly longer than the bay
    const bermCenterZ = (FRONT_Z + BACK_Z) / 2 - 1; // shifted to cover back

    for (const sx of [-1, 1]) {
      const berm = this._makeBerm(bermThickness, bermHeight, bermLen, bermMat);
      const cx = sx * (halfW + bermThickness / 2);
      berm.position.set(cx, 0, bermCenterZ);
      group.add(berm);
      blockers.push(berm);
      aabbs.push({
        minX: cx - bermThickness / 2,
        maxX: cx + bermThickness / 2,
        minZ: bermCenterZ - bermLen / 2,
        maxZ: bermCenterZ + bermLen / 2,
      });
    }

    // --- Tall back berm (downrange, behind the targets). -------------------
    // Higher and thicker than the sides to safely stop rounds. Spans the full
    // interior width plus the side berms.
    const backHeight = 3.2;
    const backThickness = 2.2;
    const backWidth = width + bermThickness * 2 + 1;
    const backCenterZ = BACK_Z - backThickness / 2;
    const backBerm = this._makeBerm(backWidth, backHeight, backThickness, bermMat);
    backBerm.position.set(0, 0, backCenterZ);
    group.add(backBerm);
    blockers.push(backBerm);
    aabbs.push({
      minX: -backWidth / 2,
      maxX: backWidth / 2,
      minZ: backCenterZ - backThickness / 2,
      maxZ: backCenterZ + backThickness / 2,
    });

    // --- Wooden fault-line markers at the front of the bay. -----------------
    // Two low planks laid on the ground marking the forward fault line the
    // player may not cross. Purely visual (they do not block shots/movement),
    // so they are added to the group but not to blockers/aabbs.
    this._buildFaultLine(group, woodMat, halfW, FRONT_Z);

    // --- Scattered range props (visual dressing, non-blocking). ------------
    this._scatterProps(group, halfW, FRONT_Z, BACK_Z);

    // --- Walkable bounds (player collision box). ---------------------------
    // Keep the player inside the interior width and between the fault line and
    // a rear limit just behind the start position.
    const bounds = {
      minX: -halfW + 0.4,
      maxX: halfW - 0.4,
      minZ: FRONT_Z - depth * 0.35, // don't let them wander too far downrange
      maxZ: FRONT_Z + 0.2, // stay behind the fault line (front)
    };
    // Clamp the walkable rear so the player start box (z ~ +0.5..+3) fits.
    bounds.minZ = Math.min(bounds.minZ, 0.5);

    // --- Optional cover props inside the walkable area. --------------------
    if (cover) {
      this._placeCover(group, woodMat, bounds, blockers, aabbs, coverObjects);
    }

    return { group, blockers, aabbs, bounds, coverObjects };
  }

  /**
   * Shared berm material: a mounded-earth look reusing the dirt texture but
   * darker/tan so berms read distinct from the flat ground.
   * @returns {THREE.MeshStandardMaterial}
   */
  _makeBermMaterial() {
    const tex = this._getDirtTexture().clone();
    tex.needsUpdate = true;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 3);
    tex.colorSpace = THREE.SRGBColorSpace;
    return new THREE.MeshStandardMaterial({
      map: tex,
      color: 0xb59468, // warm tan tint over the dirt grain
      roughness: 1.0,
      metalness: 0.0,
    });
  }

  /**
   * Build a single mounded earth berm as a box with a tapered (narrower) top,
   * giving a trapezoidal cross-section. Dimensions are the FOOTPRINT (base)
   * size; the top is inset. Casts and receives shadows.
   * @param {number} w base width (x)
   * @param {number} h height (y)
   * @param {number} d base depth (z)
   * @param {THREE.Material} mat
   * @returns {THREE.Mesh}
   */
  _makeBerm(w, h, d, mat) {
    // Start from a box and taper the top vertices inward for a mound profile.
    const geo = new THREE.BoxGeometry(w, h, d, 1, 1, 1);
    const pos = geo.attributes.position;
    const topY = h / 2;
    const inset = 0.55; // fraction the top is pulled in relative to the base
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getY(i) - topY) < 1e-4) {
        pos.setX(i, pos.getX(i) * inset);
        pos.setZ(i, pos.getZ(i) * inset);
      }
    }
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = h / 2; // sit the base on the ground
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.solid = true;
    return mesh;
  }

  /**
   * Lay two wooden fault-line planks on the ground at the front of the bay.
   * Visual only (non-blocking). They flank the center so the player reads the
   * forward line they must stay behind.
   * @param {THREE.Group} group
   * @param {THREE.Material} woodMat
   * @param {number} halfW
   * @param {number} frontZ
   */
  _buildFaultLine(group, woodMat, halfW, frontZ) {
    const plankLen = halfW * 0.85;
    const geo = new THREE.BoxGeometry(plankLen, 0.05, 0.14);
    for (const sx of [-1, 1]) {
      const plank = new THREE.Mesh(geo, woodMat);
      plank.position.set(sx * (halfW - plankLen / 2 - 0.2), 0.025, frontZ);
      plank.castShadow = true;
      plank.receiveShadow = true;
      group.add(plank);
    }
  }

  /**
   * Scatter a few small non-blocking range props for grit: sandbags, a stray
   * shell-bucket, small rocks. These are decorative only and are NOT added to
   * blockers/aabbs so they never trap the player or stop bullets.
   * @param {THREE.Group} group
   * @param {number} halfW
   * @param {number} frontZ
   * @param {number} backZ
   */
  _scatterProps(group, halfW, frontZ, backZ) {
    // A short stack of sandbags near a side berm.
    const sandbagMat = new THREE.MeshStandardMaterial({
      color: 0x9c8a5e,
      roughness: 1.0,
      metalness: 0.0,
    });
    const bagGeo = new THREE.BoxGeometry(0.5, 0.16, 0.28);
    const stackX = -halfW + 0.9;
    const stackZ = frontZ - 1.6;
    const layout = [
      [0, 0], [0.22, 0], [-0.22, 0],
      [0.11, 1], [-0.11, 1],
    ];
    layout.forEach(([dx, layer], i) => {
      const bag = new THREE.Mesh(bagGeo, sandbagMat);
      bag.position.set(stackX + dx, 0.08 + layer * 0.16, stackZ + (i % 2) * 0.05);
      bag.rotation.y = (Math.random() - 0.5) * 0.25;
      bag.castShadow = true;
      bag.receiveShadow = true;
      group.add(bag);
    });

    // A metal shell bucket on the other side.
    const bucketMat = new THREE.MeshStandardMaterial({
      color: 0x5f6468,
      roughness: 0.6,
      metalness: 0.6,
    });
    const bucket = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.13, 0.34, 16, 1, true),
      bucketMat
    );
    bucket.material.side = THREE.DoubleSide;
    bucket.position.set(halfW - 0.8, 0.17, frontZ - 1.2);
    bucket.castShadow = true;
    bucket.receiveShadow = true;
    group.add(bucket);

    // A scatter of small rocks along the mid-bay for grit.
    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x7c7469,
      roughness: 1.0,
      metalness: 0.0,
    });
    const rockGeo = new THREE.IcosahedronGeometry(0.12, 0);
    const midZ = (frontZ + backZ) / 2;
    for (let i = 0; i < 7; i++) {
      const rock = new THREE.Mesh(rockGeo, rockMat);
      const s = 0.4 + Math.random() * 0.9;
      rock.scale.set(s, s * 0.7, s);
      rock.position.set(
        (Math.random() - 0.5) * (halfW * 1.7),
        0.05 * s,
        midZ + (Math.random() - 0.5) * (frontZ - backZ) * 0.6
      );
      rock.rotation.set(Math.random(), Math.random(), Math.random());
      rock.castShadow = true;
      rock.receiveShadow = true;
      group.add(rock);
    }
  }

  /**
   * Place 2-4 cover props (barrels + a low wooden wall) inside the walkable
   * area. Each is both a blocker (stops shots + player) and a cover object, and
   * gets a matching top-down AABB for player collision.
   * @param {THREE.Group} group
   * @param {THREE.Material} woodMat
   * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} bounds
   * @param {THREE.Mesh[]} blockers
   * @param {Array} aabbs
   * @param {THREE.Mesh[]} coverObjects
   */
  _placeCover(group, woodMat, bounds, blockers, aabbs, coverObjects) {
    const cx = (bounds.minX + bounds.maxX) / 2;
    // Put cover a little downrange of the player start so they must move to it.
    const coverZ = bounds.minZ + (bounds.maxZ - bounds.minZ) * 0.35;

    const addCover = (mesh, halfX, halfZ) => {
      group.add(mesh);
      blockers.push(mesh);
      coverObjects.push(mesh);
      aabbs.push({
        minX: mesh.position.x - halfX,
        maxX: mesh.position.x + halfX,
        minZ: mesh.position.z - halfZ,
        maxZ: mesh.position.z + halfZ,
      });
    };

    // Two barrels flanking center.
    const bLeft = Environment.barrel(cx - 1.6, coverZ);
    addCover(bLeft, 0.29, 0.29);
    const bRight = Environment.barrel(cx + 1.6, coverZ + 0.4);
    addCover(bRight, 0.29, 0.29);

    // A low wooden cover wall (waist-high) near center, angled slightly.
    const wallW = 1.2;
    const wallH = 1.0;
    const wallT = 0.12;
    const wallGeo = new THREE.BoxGeometry(wallW, wallH, wallT);
    const wall = new THREE.Mesh(wallGeo, this._makePlywoodMaterial(woodMat));
    wall.position.set(cx + 0.2, wallH / 2, coverZ - 1.3);
    wall.castShadow = true;
    wall.receiveShadow = true;
    wall.userData.solid = true;
    // Add small posts so the wall reads as free-standing.
    const postGeo = new THREE.BoxGeometry(0.08, wallH + 0.1, 0.08);
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, woodMat);
      post.position.set(sx * (wallW / 2 - 0.04), 0.05, 0);
      post.castShadow = true;
      post.receiveShadow = true;
      wall.add(post);
    }
    // For the AABB, use the wall's footprint (axis-aligned; no rotation applied).
    addCover(wall, wallW / 2, wallT / 2 + 0.02);
  }

  /**
   * A plywood-ish material for cover walls: reuse the wood base but give it a
   * lighter, drier plywood tint so cover reads distinct from the target stands.
   * @param {THREE.Material} baseWood unused fallback reference
   * @returns {THREE.MeshStandardMaterial}
   */
  _makePlywoodMaterial() {
    return new THREE.MeshStandardMaterial({
      color: 0xb9945a,
      roughness: 0.85,
      metalness: 0.0,
    });
  }

  // ---------------------------------------------------------------------------
  // Static props
  // ---------------------------------------------------------------------------

  /**
   * Build a ~0.9 m tall 55-gallon steel drum standing at ground level, centered
   * at (x, z). The barrel is a ribbed cylinder with darker top/bottom rims. It
   * is a solid blocker (userData.solid = true) and casts/receives shadows.
   *
   * NOTE: this is a static factory so callers can drop barrels anywhere (e.g.
   * as cover) without an Environment instance.
   *
   * @param {number} x world x of the barrel center.
   * @param {number} z world z of the barrel center.
   * @returns {THREE.Mesh} the barrel mesh (rims are children).
   */
  static barrel(x, z) {
    const HEIGHT = 0.9; // ~55-gal drum height (a touch shortened for the bay)
    const RADIUS = 0.29; // ~0.58 m diameter

    // Body material: weathered painted steel (rusty blue/grey drum).
    const bodyMat = new THREE.MeshStandardMaterial({
      map: Environment._barrelTexture(),
      color: 0xffffff,
      roughness: 0.7,
      metalness: 0.45,
    });

    const bodyGeo = new THREE.CylinderGeometry(RADIUS, RADIUS, HEIGHT, 20, 1);
    const barrel = new THREE.Mesh(bodyGeo, bodyMat);
    barrel.position.set(x, HEIGHT / 2, z);
    barrel.castShadow = true;
    barrel.receiveShadow = true;
    barrel.userData.solid = true;
    barrel.name = 'Barrel';

    // Rim material: darker bare steel.
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0x5a5f63,
      roughness: 0.5,
      metalness: 0.7,
    });

    // Top and bottom rolling hoops plus two body ribs (as thin torus rings).
    const ribRadius = RADIUS + 0.012;
    const ribTube = 0.02;
    const ribYs = [
      -HEIGHT / 2 + 0.05, // bottom rim
      -HEIGHT * 0.18, // lower rib
      HEIGHT * 0.18, // upper rib
      HEIGHT / 2 - 0.05, // top rim
    ];
    for (const ry of ribYs) {
      const rib = new THREE.Mesh(
        new THREE.TorusGeometry(ribRadius, ribTube, 8, 20),
        rimMat
      );
      rib.rotation.x = Math.PI / 2; // lay the torus flat (ring around the body)
      rib.position.y = ry;
      rib.castShadow = true;
      rib.receiveShadow = true;
      barrel.add(rib);
    }

    // A slightly recessed top lid disc so the barrel doesn't look open.
    const lid = new THREE.Mesh(
      new THREE.CircleGeometry(RADIUS - 0.01, 20),
      rimMat
    );
    lid.rotation.x = -Math.PI / 2; // face up
    lid.position.y = HEIGHT / 2 - 0.005;
    lid.castShadow = false;
    lid.receiveShadow = true;
    barrel.add(lid);

    return barrel;
  }

  /**
   * Lazily build (and cache on the class) a weathered painted-drum texture:
   * a faded blue-grey body with rust streaks and a couple of hazard bands.
   * Cached so many barrels share a single GPU upload.
   * @returns {THREE.CanvasTexture}
   */
  static _barrelTexture() {
    if (Environment.__barrelTex) return Environment.__barrelTex;

    const w = 256;
    const h = 128;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    // Faded blue-grey base coat.
    ctx.fillStyle = '#5b6b74';
    ctx.fillRect(0, 0, w, h);

    // Subtle vertical paint streaking.
    for (let i = 0; i < 60; i++) {
      const x = Math.random() * w;
      ctx.globalAlpha = Math.random() * 0.12;
      ctx.fillStyle = Math.random() > 0.5 ? '#7a8992' : '#3f4c53';
      ctx.fillRect(x, 0, 1 + Math.random() * 2, h);
    }
    ctx.globalAlpha = 1;

    // A couple of horizontal hazard bands (weathered off-white).
    ctx.fillStyle = 'rgba(210,200,180,0.55)';
    ctx.fillRect(0, h * 0.30, w, h * 0.06);
    ctx.fillRect(0, h * 0.64, w, h * 0.06);

    // Rust streaks bleeding down from the top rim.
    for (let i = 0; i < 30; i++) {
      const x = Math.random() * w;
      const len = 10 + Math.random() * (h * 0.5);
      const rust = Math.random() > 0.5 ? '#7a3d1e' : '#94582c';
      ctx.strokeStyle = rust;
      ctx.globalAlpha = 0.12 + Math.random() * 0.22;
      ctx.lineWidth = 1 + Math.random() * 2;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + (Math.random() - 0.5) * 6, len);
      ctx.stroke();
    }
    // Rust patches around the bottom.
    for (let i = 0; i < 24; i++) {
      const x = Math.random() * w;
      const y = h - Math.random() * (h * 0.25);
      const r = Math.random() * 6 + 2;
      ctx.globalAlpha = 0.1 + Math.random() * 0.2;
      ctx.fillStyle = '#7a3d1e';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const tex = new THREE.CanvasTexture(canvas);
    // Wrap horizontally around the drum body.
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    Environment.__barrelTex = tex;
    return tex;
  }
}

// -----------------------------------------------------------------------------
// Small color helpers (module-local; no side effects).
// -----------------------------------------------------------------------------

/** Convert a 0xRRGGBB number to a 6-char hex string (no leading #). */
function toHex(n) {
  return (n & 0xffffff).toString(16).padStart(6, '0');
}

/**
 * Multiply a 0xRRGGBB color's channels by a scalar, clamped to [0,255].
 * @param {number} n color
 * @param {number} s scale factor
 * @returns {number} scaled color
 */
function scaleColor(n, s) {
  const r = Math.min(255, Math.round(((n >> 16) & 0xff) * s));
  const g = Math.min(255, Math.round(((n >> 8) & 0xff) * s));
  const b = Math.min(255, Math.round((n & 0xff) * s));
  return (r << 16) | (g << 8) | b;
}
