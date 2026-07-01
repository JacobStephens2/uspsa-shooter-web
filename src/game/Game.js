import * as THREE from 'three';

import { Input } from './Input.js';
import { Player } from './Player.js';
import { Weapon } from './Weapon.js';
import { Fx } from './Fx.js';
import { Stage1 } from './Stage1.js';
import { Stage2 } from './Stage2.js';
import { classify } from './Scoring.js';

import { Environment } from '../world/Environment.js';
import { AudioEngine } from '../audio/AudioEngine.js';
import { Sfx } from '../audio/Sfx.js';
import { Music } from '../audio/Music.js';
import { HUD } from '../ui/HUD.js';
import { Menu } from '../ui/Menu.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const STAGE_CLASSES = [Stage1, Stage2];

// countdown timeline (seconds from state entry): [time, label, beep, go]
const COUNTDOWN = [
  [0.0, 'STANDBY', false, false],
  [1.3, '3', true, false],
  [2.1, '2', true, false],
  [2.9, '1', true, false],
  [3.7, '', false, true], // start beep + go
];

export class Game {
  constructor() {
    this.sceneRoot = document.getElementById('scene-root');
    this.state = 'boot';

    this._initRenderer();
    this._initScene();

    this.input = new Input(this.renderer.domElement);
    this.player = new Player(this.camera);
    this.weapon = new Weapon();
    this.weapon.attachTo(this.camera);
    this.fx = new Fx(this.scene);

    this.environment = new Environment(this.scene);

    // audio
    this.audio = new AudioEngine();
    this.sfx = new Sfx(this.audio);
    this.music = new Music(this.audio);
    this._musicMode = null;

    // ui
    this.hud = new HUD(document.getElementById('hud-root'));
    this.hud.hide(); // start hidden until a stage begins
    this.menu = new Menu(document.getElementById('menu-root'));

    // match state
    this.stageIndex = 0;
    this.stage = null;
    this.matchScores = [];
    this.elapsed = 0;
    this._cdT = 0;
    this._cdIndex = 0;

    // scratch
    this._v1 = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._v3 = new THREE.Vector3();
    this._v4 = new THREE.Vector3();
    this._shotRay = new THREE.Raycaster();
    this._losRay = new THREE.Raycaster();
    this._losDir = new THREE.Vector3();

    this._services = {
      player: this.player,
      sfx: this.sfx,
      fx: this.fx,
      hasLineOfSight: (from, to) => this.hasLineOfSight(from, to),
      damagePlayer: (amt) => {
        this.player.applyDamage(amt);
        this.hud.damageFlash();
      },
    };

    this._wireInput();
    this._wireMenuSettings();

    this.clock = new THREE.Clock();
    this._onResize = this._onResize.bind(this);
    window.addEventListener('resize', this._onResize);
    this._onResize();

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  /* ================================================================== */
  /*  Setup                                                              */
  /* ================================================================== */
  _initRenderer() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.sceneRoot.appendChild(this.renderer.domElement);
  }

  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x2a3138);
    this.camera = new THREE.PerspectiveCamera(76, window.innerWidth / window.innerHeight, 0.03, 600);
    this.camera.rotation.order = 'YXZ';
    this.camera.position.set(0, 1.6, 2);
    this.scene.add(this.camera); // so the weapon view-model (a child) renders

    // Image-based lighting: without an environment map, metallic PBR materials
    // (the pistol, steel poppers, the revolver) reflect nothing and read pure
    // black. A cheap generated room environment gives them believable specular.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.5;
    pmrem.dispose();
  }

  _wireInput() {
    this.input.on('lockchange', (locked) => {
      if (!locked && this.state === 'running') this._pause();
    });
    this.input.on('reload', () => {
      if (this.state !== 'running') return;
      if (this.weapon.startReload()) this.sfx.reload();
    });
    this.input.on('firedown', () => {
      if (this.state !== 'running') return;
      if (this.weapon.isEmpty && !this.weapon.isReloading) {
        this.weapon.dryFire();
        this.sfx.dryFire();
        this.hud.toast('EMPTY — press R to reload', 900);
      }
    });
    this.input.on('keydown', (code) => {
      if (this.state === 'running') {
        if (code === 'KeyF' || code === 'Enter') this._completeStage();
        else if (code === 'KeyP') this._pause();
      }
    });
  }

  _wireMenuSettings() {
    this.menu.setSettingsHandlers({
      onVolume: (v) => this.audio.setMasterVolume(v),
      onMute: (b) => this.audio.setMuted(b),
    });
  }

  /* ================================================================== */
  /*  Flow / state machine                                               */
  /* ================================================================== */
  showTitle() {
    this.state = 'title';
    this.hud.hide();
    this.menu.showTitle({ onStart: () => this._onStart() });
  }

  _onStart() {
    // first user gesture: unlock audio and kick off ambient music
    this.audio.unlock().then(() => {
      this.sfx.uiClick();
      this._setMusic('menu');
    });
    this.matchScores = [];
    this.stageIndex = 0;
    this._showBriefing(0);
  }

  _showBriefing(index) {
    this.stageIndex = index;
    this.state = 'briefing';
    this.hud.hide();
    this.input.exitLock();
    this._setMusic('menu');

    // build a throwaway instance just to read its briefing metadata
    const meta = this._stageMeta(index);
    this.menu.showBriefing({
      stageNumber: meta.number,
      stageName: meta.name,
      description: meta.description,
      parLines: meta.parLines,
      onBegin: () => this._beginStage(index),
    });
  }

  _stageMeta(index) {
    // Metadata is static; read it without side effects by constructing lazily.
    // We construct the real stage in _beginStage, so here return known text.
    return STAGE_META[index];
  }

  _beginStage(index) {
    this.audio.unlock();
    this.menu.hideAll();
    this._disposeStage();

    const StageClass = STAGE_CLASSES[index];
    this.stage = new StageClass({ scene: this.scene, environment: this.environment, services: this._services });

    // place the player at the stage start, facing downrange
    this.player.reset(this.stage.playerStart, this.stage.playerFacing);
    this.weapon.reset();
    this.hud.reset();
    this.hud.show();
    this.hud.setAmmo(this.weapon.ammo, this.weapon.magSize);
    this.hud.setHealthVisible(this.stage.hasThreat);
    if (this.stage.hasThreat) this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.setStageInfo(this.stage.name, this.stage.remaining, this.stage.totalTargets);
    this.hud.setThreat(false);
    this.hud.setTimer(0);

    this.input.requestLock();

    this.elapsed = 0;
    this._cdT = 0;
    this._cdIndex = 0;
    this.state = 'countdown';
    this.menu.showCountdown(COUNTDOWN[0][1]);
  }

  _startRunning() {
    this.state = 'running';
    this.menu.showCountdown('');
    this.menu.hideAll();
    this.sfx.startBeep();
    this._setMusic(this.stageIndex === 0 ? 'stage1' : 'stage2');
    if (!this.input.isLocked) this.input.requestLock();
  }

  _completeStage() {
    if (this.state !== 'running') return;
    this.state = 'stageresults';
    this.input.exitLock();

    const score = this.stage.finalize(this.elapsed);
    this.matchScores[this.stageIndex] = {
      number: this.stage.number,
      name: this.stage.name,
      score,
    };

    this.hud.hide();
    this._setMusic('menu');
    if (score.summary.passed) this.sfx.stageComplete();
    else this.sfx.stageFail();

    const isLast = this.stageIndex >= STAGE_CLASSES.length - 1;
    this.menu.showStageResults({
      stageNumber: this.stage.number,
      stageName: this.stage.name,
      summary: score.summary,
      nextLabel: isLast ? 'MATCH RESULTS' : 'NEXT STAGE',
      onNext: () => {
        if (isLast) this._showMatchResults();
        else this._showBriefing(this.stageIndex + 1);
      },
    });
  }

  _failStage() {
    if (this.state !== 'running') return;
    this.state = 'failed';
    this.input.exitLock();
    this.hud.hide();
    this._setMusic('menu');
    this.sfx.stageFail();
    this.menu.showFailed({
      stageName: this.stage.name,
      reason: 'You were neutralized by the ranchero.',
      onRetry: () => this._beginStage(this.stageIndex),
      onQuit: () => this._quitToTitle(),
    });
  }

  _showMatchResults() {
    this.state = 'matchresults';
    this.input.exitLock();
    this.hud.hide();
    this._setMusic('menu');

    const stages = this.matchScores.filter(Boolean).map((s) => ({
      stageNumber: s.number,
      stageName: s.name,
      hitFactor: s.score.hitFactor,
      points: s.score.rawPoints,
      time: s.score.time,
    }));
    const totalPoints = stages.reduce((a, s) => a + s.points, 0);
    const avgHf = stages.length ? stages.reduce((a, s) => a + s.hitFactor, 0) / stages.length : 0;
    const grade = classify(avgHf);
    this.sfx.stageComplete();

    this.menu.showMatchResults({
      stages,
      totalPoints,
      grade,
      onReplay: () => this._quitToTitle(),
    });
  }

  _pause() {
    if (this.state !== 'running') return;
    this.state = 'paused';
    this.input.exitLock();
    this.input.clearKeys();
    this.menu.showPause({
      onResume: () => this._resume(),
      onRestart: () => this._beginStage(this.stageIndex),
      onQuit: () => this._quitToTitle(),
    });
  }

  _resume() {
    if (this.state !== 'paused') return;
    this.menu.hideAll();
    this.hud.show();
    this.state = 'running';
    this.input.requestLock();
  }

  _quitToTitle() {
    this._disposeStage();
    this.showTitle();
  }

  _disposeStage() {
    if (this.stage) {
      this.stage.dispose();
      this.stage = null;
    }
  }

  _setMusic(mode) {
    if (this._musicMode === mode) return;
    this._musicMode = mode;
    if (!this.audio.ready) return;
    if (mode === 'menu') this.music.playMenu();
    else if (mode === 'stage1') this.music.playStage(0.25);
    else if (mode === 'stage2') this.music.playStage(0.85);
    else if (mode === 'stop') this.music.stop();
  }

  /* ================================================================== */
  /*  Shooting                                                           */
  /* ================================================================== */
  _handleShooting() {
    if (this.input.isFiring && this.weapon.canFire()) {
      const shot = this.weapon.fire();
      this.player.addRecoil(shot.recoilPitch, shot.recoilYaw);
      this.sfx.gunshot();
      this.fx.spawnMuzzleFlash(this.weapon.getMuzzleWorldPosition(this._v1));
      this._resolveShot(shot.spread);
    }
  }

  _resolveShot(spread) {
    const stage = this.stage;
    if (!stage) return;
    const origin = this.player.getEyePosition(this._v2);
    const dir = this.player.getAimDirection(spread, this._v3);
    this._shotRay.set(origin, dir);
    this._shotRay.far = 150;

    const hits = this._shotRay.intersectObjects(stage.raycastTargets, true);
    const end = this._v4.copy(origin).addScaledVector(dir, 120);

    if (hits.length) {
      const h = hits[0];
      end.copy(h.point);
      const ent = this._entityOf(h.object);
      if (ent && ent.onHit) this._applyHit(ent.onHit(h), h);
      else this.fx.spawnImpact(h.point, 'dust', 3); // hit a wall/berm
    }

    const muzzle = this.weapon.getMuzzleWorldPosition(this._v1);
    this.fx.spawnTracer(muzzle, end, 0xffe08a);
  }

  _entityOf(object) {
    let o = object;
    while (o) {
      if (o.userData && o.userData.entity) return o.userData.entity;
      o = o.parent;
    }
    return null;
  }

  _applyHit(res, h) {
    if (!res) return;
    switch (res.kind) {
      case 'target':
        this.hud.showHitMarker(res.zone);
        this.sfx.paperHit();
        this.fx.spawnImpact(h.point, 'paper', 2);
        break;
      case 'noshoot':
        this.hud.showHitMarker('noshoot');
        this.sfx.paperHit();
        this.fx.spawnImpact(h.point, 'paper', 2);
        this.hud.toast('NO-SHOOT! −10', 1100);
        break;
      case 'steel':
        this.hud.showHitMarker('steel');
        this.sfx.steelHit();
        this.fx.spawnImpact(h.point, 'steel', 4);
        if (!res.already) this.sfx.steelFall();
        break;
      case 'enemy':
        this.hud.showHitMarker(res.zone);
        this.fx.spawnImpact(h.point, 'blood', 4);
        if (res.downed) this.hud.toast('THREAT DOWN', 1400);
        break;
      default:
        this.fx.spawnImpact(h.point, 'dust', 3);
    }
  }

  /** True if nothing solid blocks the segment from -> to. */
  hasLineOfSight(from, to) {
    const stage = this.stage;
    if (!stage || !stage.solids.length) return true;
    this._losDir.copy(to).sub(from);
    const dist = this._losDir.length();
    if (dist < 1e-4) return true;
    this._losDir.normalize();
    this._losRay.set(from, this._losDir);
    this._losRay.far = dist - 0.05;
    const hits = this._losRay.intersectObjects(stage.solids, true);
    return hits.length === 0;
  }

  /* ================================================================== */
  /*  Main loop                                                          */
  /* ================================================================== */
  _loop() {
    requestAnimationFrame(this._loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this._update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  _update(dt) {
    this.fx.update(dt);
    this.weapon.update(dt);

    if (this.state === 'countdown') {
      this._updateCountdown(dt);
      // hold the player still on the start position until the beep
      this.player.update(dt, null, this.stage ? this.stage.collision : null);
      return;
    }

    if (this.state !== 'running') return;

    // --- live gameplay ---
    this.input.enabled = true;
    this.player.update(dt, this.input, this.stage.collision);
    // Refresh world matrices BEFORE any raycast this frame. The renderer also
    // updates them, but that happens after _update(), so shot/LOS raycasts would
    // otherwise use last frame's (or, right after a stage loads, identity) matrices.
    this.scene.updateMatrixWorld();
    this._handleShooting();
    this.stage.update(dt);

    this.elapsed += dt;

    // HUD
    this.hud.setAmmo(this.weapon.ammo, this.weapon.magSize);
    this.hud.setReloading(this.weapon.isReloading);
    this.hud.setTimer(this.elapsed);
    this.hud.setStageInfo(this.stage.name, this.stage.remaining, this.stage.totalTargets);
    if (this.stage.hasThreat) {
      this.hud.setHealth(this.player.health, this.player.maxHealth);
      this.hud.setThreat(!!(this.stage.ranchero && this.stage.ranchero.alive));
    }

    // --- win / lose ---
    if (this.stage.hasThreat && !this.player.alive) {
      this._failStage();
      return;
    }
    if (this.stage.allNeutralized()) {
      this._completeStage();
    }
  }

  _updateCountdown(dt) {
    this._cdT += dt;
    while (this._cdIndex < COUNTDOWN.length && this._cdT >= COUNTDOWN[this._cdIndex][0]) {
      const [, label, beep, go] = COUNTDOWN[this._cdIndex];
      if (go) {
        this._startRunning();
        return;
      }
      this.menu.showCountdown(label);
      if (beep) this.sfx.countBeep();
      this._cdIndex++;
    }
  }

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

// Static briefing text mirrors what each Stage sets on itself. Kept here so the
// briefing screen can be shown without instantiating (and building) the stage.
const STAGE_META = [
  {
    number: 1,
    name: 'Steel & Paper',
    description:
      'A standard freestyle array. Engage every cardboard target with two rounds and drop all three steel poppers. Mind the white no-shoots.',
    parLines: [
      '5 paper targets — 2 rounds each (best 2 hits scored)',
      '3 steel poppers — must fall',
      '2 white no-shoots — do NOT hit (−10 each)',
      'Timer starts on the beep; press [F] when finished',
    ],
  },
  {
    number: 2,
    name: 'The Ranchero',
    description:
      'A hostile ranchero is holed up downrange and he is armed. Break his line of sight behind the barrels, neutralize the threat, and clear the paper — without hitting the hostage.',
    parLines: [
      'STOP THE THREAT — down the ranchero (he shoots back!)',
      '3 paper targets — 2 rounds each',
      '1 steel popper — must fall',
      'Hostage no-shoot present — do NOT hit (−10)',
      'Hold [Ctrl] to CROUCH behind the barrels — it breaks his line of sight',
      'Press [F] when finished',
    ],
  },
];
