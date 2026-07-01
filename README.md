# Practical Range — 3D USPSA Shooter

A browser-based 3D shooter that simulates a two-stage **USPSA** (United States
Practical Shooting Association) match. Draw down on cardboard targets and steel
poppers against the clock, then face a live-fire scenario where a hostile
**ranchero** shoots back. Built with [Three.js](https://threejs.org/) and fully
**procedural audio** (Web Audio API) — no asset files, works offline.

![range](https://img.shields.io/badge/engine-three.js-black) ![vite](https://img.shields.io/badge/build-vite-646cff)

## The match

| Stage | Name | Course of fire |
|------:|------|----------------|
| 1 | **Steel & Paper** | 5 cardboard targets (2 rounds each), 3 steel poppers, 2 white no-shoots. Pure marksmanship against the clock. |
| 2 | **The Ranchero** | Paper + steel **plus** an armed hostile who returns fire. Use the barrels for cover, break his line of sight, and stop the threat — without hitting the hostage. |

Stages are scored USPSA-style (minor power factor):

- **A** = 5, **C** = 3, **D** = 1 points (best 2 hits per paper target)
- **Miss** / **No-shoot** = −10 each; standing steel at the end counts as a miss
- **Hit factor** = `max(points, 0) / time`
- Your average hit factor across the match earns a classification grade (U → D → C → B → A → M → GM)

## Controls

| Action | Input |
|--------|-------|
| Move | `W` `A` `S` `D` |
| Sprint | `Shift` |
| Crouch (break line of sight behind cover) | `Ctrl` / `C` |
| Look / Aim | Mouse |
| Fire | Left click |
| Reload | `R` |
| Finish stage | `F` (or `Enter`) |
| Pause | `Esc` |

Click **START MATCH** and then **BEGIN** to lock the mouse; the timer starts on
the beep.

## Run it

```bash
npm install
npm run dev      # start the Vite dev server (prints a local URL)
```

Build a static bundle for deployment (GitHub Pages, itch.io, any static host):

```bash
npm run build    # outputs to dist/
npm run preview  # serve the production build locally
```

Requires a modern browser with **WebGL2** and the **Web Audio API**.

## Architecture

```
index.html            entry HTML (canvas, HUD/menu mount points, boot splash)
styles/main.css        palette tokens, layout, boot splash
src/
  main.js              bootstrap: WebGL probe → Game → title screen
  game/
    Game.js            orchestrator: state machine, main loop, shot resolution
    Player.js          first-person controller (look, move, collision, health)
    Weapon.js          pistol view-model, ammo/reload/recoil state machine
    Fx.js              pooled tracers, muzzle flashes, impact puffs
    Input.js           keyboard + mouse + pointer-lock
    Scoring.js         USPSA hit-factor scoring + classification
    Stage.js           base course-of-fire (neutralization, raycast lists, scoring)
    Stage1.js / Stage2.js   the two courses of fire
    entities/
      Target.js        USPSA cardboard target with printed scoring zones
      SteelPopper.js   falling steel popper
      Ranchero.js      stage-2 hostile AI (telegraph → fire, respects cover)
  world/
    Environment.js     ground, sky, golden-hour lighting, shooting-bay builder
  audio/
    AudioEngine.js     Web Audio context + master volume/mute
    Sfx.js             synthesized gunshots, steel dings, beeps, stings
    Music.js           scheduled ambient / gameplay music beds
  ui/
    HUD.js             crosshair, ammo, health, timer, hit markers
    Menu.js            title, briefing, countdown, results, pause screens
```

Every shootable entity exposes `root` (a `THREE.Object3D`), a `colliders` array
(each collider mesh tags `userData.entity`), and an `onHit(intersection)` method —
so the weapon can raycast a single flat list and dispatch hits polymorphically.

## Audio

All sound is synthesized at runtime with the Web Audio API — gunshots (noise
burst + body thump), steel dings (detuned ringing partials), the USPSA start
beep, and two music beds (calm for stage 1, driving percussion for stage 2).
Nothing is fetched, so the game runs with no network and no binary assets.
Audio starts on your first click (browser autoplay policy). Adjust volume or
mute from the title screen.
