import { Game } from './game/Game.js';

/*
  Boot the game. We keep the boot splash up until the first frame is ready,
  then reveal the title screen.
*/

function hideSplash() {
  const splash = document.getElementById('boot-splash');
  if (!splash) return;
  splash.classList.add('fade');
  setTimeout(() => splash.remove(), 550);
}

function fatal(message) {
  const splash = document.getElementById('boot-splash');
  if (splash) {
    splash.innerHTML = `<div class="boot-inner"><div class="boot-title" style="color:#e2453a">ERROR</div><div class="boot-sub">${message}</div></div>`;
  }
  console.error(message);
}

try {
  // Fail early with a friendly message if WebGL is unavailable.
  const probe = document.createElement('canvas');
  const gl = probe.getContext('webgl2') || probe.getContext('webgl');
  if (!gl) {
    fatal('WebGL is not available in this browser.');
  } else {
    const game = new Game();
    // expose for debugging in the console
    window.__RANGE__ = game;
    // let the first render settle, then reveal the menu
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        game.showTitle();
        hideSplash();
      });
    });
  }
} catch (err) {
  fatal((err && err.message) || 'Failed to start the game.');
  throw err;
}
