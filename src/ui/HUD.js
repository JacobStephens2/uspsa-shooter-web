// src/ui/HUD.js
//
// In-game heads-up display for "Practical Range".
//
// Self-contained: injects its own scoped <style> and DOM into the provided
// root element (#hud-root). All colors come from the shared :root CSS
// variables defined in styles/main.css. The whole overlay is
// pointer-events:none so it never intercepts mouse look / clicks.
//
// Public API:
//   new HUD(rootEl)
//   show() / hide()
//   showHitMarker(zone)   // flash color-coded hit marker on the crosshair
//   damageFlash()         // red screen-edge vignette pulse
//   setAmmo(current, mag) / setReloading(on)
//   setHealthVisible(on) / setHealth(hp, maxHp)
//   setTimer(seconds) / setStageInfo(name, targetsLeft, totalTargets)
//   setThreat(on)
//   toast(message, ms=1800)
//   reset()               // clear transient state between stages

const ROOT_CLASS = 'pr-hud';

// Map a shootable-entity zone to a hit-marker color role.
//   green  -> good hit (A / head / steel)
//   amber  -> ok hit   (C / torso)
//   grey   -> weak hit (D / limb)
//   red    -> penalty  (noshoot)
const ZONE_COLOR = {
  A: 'green',
  head: 'green',
  steel: 'green',
  C: 'amber',
  torso: 'amber',
  D: 'grey',
  limb: 'grey',
  noshoot: 'red',
};

export class HUD {
  /**
   * @param {HTMLElement} rootEl - the #hud-root element supplied by the game.
   */
  constructor(rootEl) {
    if (!rootEl) throw new Error('HUD requires a root element');
    this.root = rootEl;
    this.root.classList.add(ROOT_CLASS);

    // Timer handles for transient effects so we can cancel/reset cleanly.
    this._hitTimer = 0;
    this._toastTimer = 0;
    this._threatOn = false;

    this._injectStyle();
    this._buildDom();

    // Sensible defaults.
    this.setAmmo(0, 0);
    this.setReloading(false);
    this.setHealthVisible(false);
    this.setTimer(0);
    this.setStageInfo('', 0, 0);
    this.setThreat(false);
  }

  // ---------------------------------------------------------------------------
  // Style
  // ---------------------------------------------------------------------------

  _injectStyle() {
    // Only inject once per document even if multiple HUDs are created.
    if (document.getElementById('pr-hud-style')) return;

    const css = `
.${ROOT_CLASS} {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  font-family: var(--font-stack);
  color: var(--range-text);
  user-select: none;
  -webkit-user-select: none;
  z-index: 5;
}
.${ROOT_CLASS}.pr-hidden { display: none; }

/* --- Color roles for hit markers --- */
.${ROOT_CLASS} .pr-c-green { color: var(--range-green); }
.${ROOT_CLASS} .pr-c-amber { color: var(--range-amber); }
.${ROOT_CLASS} .pr-c-grey  { color: var(--range-steel); }
.${ROOT_CLASS} .pr-c-red   { color: var(--range-red); }

/* --- Crosshair --- */
.${ROOT_CLASS} .pr-crosshair {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 44px;
  height: 44px;
  transform: translate(-50%, -50%);
}
.${ROOT_CLASS} .pr-cross-dot {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 3px;
  height: 3px;
  margin: -1.5px 0 0 -1.5px;
  background: var(--range-text);
  border-radius: 50%;
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.9);
}
.${ROOT_CLASS} .pr-cross-tick {
  position: absolute;
  left: 50%;
  top: 50%;
  background: var(--range-text);
  box-shadow: 0 0 3px rgba(0, 0, 0, 0.9);
}
/* Vertical ticks: 2px wide, 8px tall, offset 8px from center. */
.${ROOT_CLASS} .pr-tick-up    { width: 2px; height: 8px; margin-left: -1px; transform: translateY(-16px); }
.${ROOT_CLASS} .pr-tick-down  { width: 2px; height: 8px; margin-left: -1px; transform: translateY(8px); }
.${ROOT_CLASS} .pr-tick-left  { width: 8px; height: 2px; margin-top: -1px;  transform: translateX(-16px); }
.${ROOT_CLASS} .pr-tick-right { width: 8px; height: 2px; margin-top: -1px;  transform: translateX(8px); }

/* --- Hit marker: rotated X that flashes on hit --- */
.${ROOT_CLASS} .pr-hitmarker {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 26px;
  height: 26px;
  transform: translate(-50%, -50%) rotate(45deg) scale(1.4);
  opacity: 0;
}
.${ROOT_CLASS} .pr-hitmarker span {
  position: absolute;
  left: 50%;
  top: 50%;
  background: currentColor;
  box-shadow: 0 0 4px rgba(0, 0, 0, 0.9);
}
/* Four short arms of the X (already rotated by the container). */
.${ROOT_CLASS} .pr-hm-a { width: 2px; height: 9px; margin: -13px 0 0 -1px; }
.${ROOT_CLASS} .pr-hm-b { width: 2px; height: 9px; margin: 4px 0 0 -1px; }
.${ROOT_CLASS} .pr-hm-c { width: 9px; height: 2px; margin: -1px 0 0 -13px; }
.${ROOT_CLASS} .pr-hm-d { width: 9px; height: 2px; margin: -1px 0 0 4px; }
.${ROOT_CLASS} .pr-hitmarker.pr-hm-show {
  animation: pr-hitmarker-flash 260ms ease-out forwards;
}
@keyframes pr-hitmarker-flash {
  0%   { opacity: 0;   transform: translate(-50%, -50%) rotate(45deg) scale(1.9); }
  25%  { opacity: 1;   transform: translate(-50%, -50%) rotate(45deg) scale(1.15); }
  100% { opacity: 0;   transform: translate(-50%, -50%) rotate(45deg) scale(1.0); }
}

/* --- Damage vignette --- */
.${ROOT_CLASS} .pr-damage {
  position: absolute;
  inset: 0;
  opacity: 0;
  background: radial-gradient(ellipse at center,
              rgba(226, 69, 58, 0) 45%,
              rgba(226, 69, 58, 0.55) 100%);
}
.${ROOT_CLASS} .pr-damage.pr-dmg-show {
  animation: pr-damage-pulse 420ms ease-out forwards;
}
@keyframes pr-damage-pulse {
  0%   { opacity: 0; }
  20%  { opacity: 1; }
  100% { opacity: 0; }
}

/* --- Generic panel look --- */
.${ROOT_CLASS} .pr-panel {
  position: absolute;
  background: var(--range-panel);
  border: 1px solid var(--range-line);
  border-radius: 4px;
  padding: 8px 12px;
  backdrop-filter: blur(2px);
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.5);
}

/* --- Ammo (bottom-right) --- */
.${ROOT_CLASS} .pr-ammo {
  right: 22px;
  bottom: 22px;
  text-align: right;
  min-width: 118px;
}
.${ROOT_CLASS} .pr-ammo-count {
  font-family: var(--font-mono);
  font-weight: 700;
  line-height: 1;
  font-size: 46px;
  letter-spacing: 1px;
  transition: color 120ms ease;
}
.${ROOT_CLASS} .pr-ammo-mag {
  font-family: var(--font-mono);
  font-size: 15px;
  color: var(--range-dim);
  margin-top: 2px;
  letter-spacing: 1px;
}
.${ROOT_CLASS} .pr-ammo-count.pr-empty { color: var(--range-red); }
.${ROOT_CLASS} .pr-reload {
  margin-top: 6px;
  display: none;
}
.${ROOT_CLASS} .pr-reload.pr-on { display: block; }
.${ROOT_CLASS} .pr-reload-label {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 3px;
  color: var(--range-amber);
  text-transform: uppercase;
}
.${ROOT_CLASS} .pr-reload-track {
  margin-top: 4px;
  height: 4px;
  width: 100%;
  background: rgba(255, 255, 255, 0.12);
  border-radius: 2px;
  overflow: hidden;
}
.${ROOT_CLASS} .pr-reload-fill {
  height: 100%;
  width: 0%;
  background: var(--range-amber);
  transition: width 60ms linear;
}

/* --- Health (bottom-left) --- */
.${ROOT_CLASS} .pr-health {
  left: 22px;
  bottom: 22px;
  min-width: 200px;
  display: none;
}
.${ROOT_CLASS} .pr-health.pr-on { display: block; }
.${ROOT_CLASS} .pr-health-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
.${ROOT_CLASS} .pr-health-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 3px;
  color: var(--range-dim);
  text-transform: uppercase;
}
.${ROOT_CLASS} .pr-health-num {
  font-family: var(--font-mono);
  font-size: 22px;
  font-weight: 700;
  line-height: 1;
}
.${ROOT_CLASS} .pr-health-track {
  margin-top: 6px;
  height: 8px;
  width: 100%;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  overflow: hidden;
  border: 1px solid rgba(0, 0, 0, 0.35);
}
.${ROOT_CLASS} .pr-health-fill {
  height: 100%;
  width: 100%;
  background: var(--range-green);
  transition: width 160ms ease, background-color 200ms ease;
}

/* --- Top-center: timer + stage info --- */
.${ROOT_CLASS} .pr-top {
  position: absolute;
  left: 50%;
  top: 16px;
  transform: translateX(-50%);
  text-align: center;
  min-width: 220px;
}
.${ROOT_CLASS} .pr-timer {
  font-family: var(--font-mono);
  font-size: 34px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: 2px;
  color: var(--range-amber);
  text-shadow: 0 0 10px rgba(224, 176, 64, 0.25);
}
.${ROOT_CLASS} .pr-stage {
  margin-top: 4px;
  font-size: 13px;
  letter-spacing: 2px;
  color: var(--range-text);
  text-transform: uppercase;
}
.${ROOT_CLASS} .pr-stage-name { font-weight: 600; }
.${ROOT_CLASS} .pr-stage-count {
  font-family: var(--font-mono);
  color: var(--range-dim);
  margin-left: 8px;
}
.${ROOT_CLASS} .pr-threat {
  margin-top: 6px;
  display: none;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 4px;
  color: var(--range-red);
  text-transform: uppercase;
}
.${ROOT_CLASS} .pr-threat.pr-on {
  display: block;
  animation: pr-threat-pulse 900ms ease-in-out infinite;
}
@keyframes pr-threat-pulse {
  0%, 100% { opacity: 0.35; text-shadow: 0 0 4px rgba(226, 69, 58, 0.3); }
  50%      { opacity: 1;    text-shadow: 0 0 14px rgba(226, 69, 58, 0.85); }
}

/* --- Toast (transient, centered-top under the stage block) --- */
.${ROOT_CLASS} .pr-toast {
  position: absolute;
  left: 50%;
  top: 116px;
  transform: translateX(-50%) translateY(-6px);
  background: var(--range-panel);
  border: 1px solid var(--range-line);
  border-radius: 4px;
  padding: 8px 18px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 1.5px;
  text-align: center;
  color: var(--range-text);
  opacity: 0;
  box-shadow: 0 6px 22px rgba(0, 0, 0, 0.55);
  transition: opacity 160ms ease, transform 160ms ease;
  white-space: nowrap;
}
.${ROOT_CLASS} .pr-toast.pr-on {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
`;

    const style = document.createElement('style');
    style.id = 'pr-hud-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------

  _buildDom() {
    // Clear any prior content (defensive on re-init).
    this.root.innerHTML = '';

    // Crosshair with dot + 4 ticks + hit marker.
    const cross = this._el('div', 'pr-crosshair');
    cross.appendChild(this._el('div', 'pr-cross-dot'));
    cross.appendChild(this._el('div', 'pr-cross-tick pr-tick-up'));
    cross.appendChild(this._el('div', 'pr-cross-tick pr-tick-down'));
    cross.appendChild(this._el('div', 'pr-cross-tick pr-tick-left'));
    cross.appendChild(this._el('div', 'pr-cross-tick pr-tick-right'));

    this.hitMarker = this._el('div', 'pr-hitmarker');
    this.hitMarker.appendChild(this._el('span', 'pr-hm-a'));
    this.hitMarker.appendChild(this._el('span', 'pr-hm-b'));
    this.hitMarker.appendChild(this._el('span', 'pr-hm-c'));
    this.hitMarker.appendChild(this._el('span', 'pr-hm-d'));
    cross.appendChild(this.hitMarker);
    this.root.appendChild(cross);

    // Damage vignette.
    this.damage = this._el('div', 'pr-damage');
    this.root.appendChild(this.damage);

    // Ammo panel (bottom-right).
    const ammo = this._el('div', 'pr-panel pr-ammo');
    this.ammoCount = this._el('div', 'pr-ammo-count');
    this.ammoCount.textContent = '0';
    this.ammoMag = this._el('div', 'pr-ammo-mag');
    this.ammoMag.textContent = '/ 0';
    this.reloadWrap = this._el('div', 'pr-reload');
    this.reloadWrap.appendChild(this._el('div', 'pr-reload-label', 'Reloading'));
    const reloadTrack = this._el('div', 'pr-reload-track');
    this.reloadFill = this._el('div', 'pr-reload-fill');
    reloadTrack.appendChild(this.reloadFill);
    this.reloadWrap.appendChild(reloadTrack);
    ammo.appendChild(this.ammoCount);
    ammo.appendChild(this.ammoMag);
    ammo.appendChild(this.reloadWrap);
    this.root.appendChild(ammo);

    // Health panel (bottom-left).
    this.health = this._el('div', 'pr-panel pr-health');
    const hRow = this._el('div', 'pr-health-row');
    hRow.appendChild(this._el('div', 'pr-health-label', 'Health'));
    this.healthNum = this._el('div', 'pr-health-num');
    this.healthNum.textContent = '100';
    hRow.appendChild(this.healthNum);
    this.health.appendChild(hRow);
    const hTrack = this._el('div', 'pr-health-track');
    this.healthFill = this._el('div', 'pr-health-fill');
    hTrack.appendChild(this.healthFill);
    this.health.appendChild(hTrack);
    this.root.appendChild(this.health);

    // Top-center: timer + stage info + threat.
    const top = this._el('div', 'pr-top');
    this.timer = this._el('div', 'pr-timer');
    this.timer.textContent = '0.00';
    const stage = this._el('div', 'pr-stage');
    this.stageName = this._el('span', 'pr-stage-name');
    this.stageCount = this._el('span', 'pr-stage-count');
    stage.appendChild(this.stageName);
    stage.appendChild(this.stageCount);
    this.threat = this._el('div', 'pr-threat', 'Threat');
    top.appendChild(this.timer);
    top.appendChild(stage);
    top.appendChild(this.threat);
    this.root.appendChild(top);

    // Toast.
    this.toastEl = this._el('div', 'pr-toast');
    this.root.appendChild(this.toastEl);
  }

  _el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ---------------------------------------------------------------------------
  // Visibility
  // ---------------------------------------------------------------------------

  show() {
    this.root.classList.remove('pr-hidden');
  }

  hide() {
    this.root.classList.add('pr-hidden');
  }

  // ---------------------------------------------------------------------------
  // Crosshair effects
  // ---------------------------------------------------------------------------

  /**
   * Briefly flash an angled hit marker, color-coded by zone.
   * @param {'A'|'C'|'D'|'head'|'torso'|'limb'|'steel'|'noshoot'} zone
   */
  showHitMarker(zone) {
    const role = ZONE_COLOR[zone] || 'grey';
    const marker = this.hitMarker;

    // Reset color classes, then apply the one for this zone.
    marker.classList.remove('pr-c-green', 'pr-c-amber', 'pr-c-grey', 'pr-c-red');
    marker.classList.add('pr-c-' + role);

    // Restart the CSS animation reliably by toggling the class off,
    // forcing a reflow, then on again.
    marker.classList.remove('pr-hm-show');
    // Force reflow so the removed animation is committed before re-adding.
    void marker.offsetWidth;
    marker.classList.add('pr-hm-show');

    // Clear the show class after the animation so it doesn't linger.
    clearTimeout(this._hitTimer);
    this._hitTimer = setTimeout(() => {
      marker.classList.remove('pr-hm-show');
    }, 300);
  }

  /** Red screen-edge vignette pulse (took damage). */
  damageFlash() {
    const dmg = this.damage;
    dmg.classList.remove('pr-dmg-show');
    void dmg.offsetWidth; // restart animation
    dmg.classList.add('pr-dmg-show');
  }

  // ---------------------------------------------------------------------------
  // Ammo
  // ---------------------------------------------------------------------------

  /**
   * @param {number} current - rounds in the chamber/mag.
   * @param {number} mag     - total mag capacity (reserve display).
   */
  setAmmo(current, mag) {
    const cur = Math.max(0, Math.floor(current || 0));
    const cap = Math.max(0, Math.floor(mag || 0));
    this.ammoCount.textContent = String(cur);
    this.ammoMag.textContent = '/ ' + cap;
    this.ammoCount.classList.toggle('pr-empty', cur === 0);
  }

  /**
   * Show/hide the RELOADING indicator.
   * @param {boolean} on
   * @param {number} [progress] - optional 0..1 progress for the bar.
   */
  setReloading(on, progress) {
    this.reloadWrap.classList.toggle('pr-on', !!on);
    if (typeof progress === 'number') {
      const pct = Math.max(0, Math.min(1, progress)) * 100;
      this.reloadFill.style.width = pct + '%';
    } else if (!on) {
      this.reloadFill.style.width = '0%';
    }
  }

  // ---------------------------------------------------------------------------
  // Health
  // ---------------------------------------------------------------------------

  /** @param {boolean} on */
  setHealthVisible(on) {
    this.health.classList.toggle('pr-on', !!on);
  }

  /**
   * @param {number} hp
   * @param {number} maxHp
   */
  setHealth(hp, maxHp) {
    const max = Math.max(1, maxHp || 1);
    const cur = Math.max(0, Math.min(max, hp || 0));
    const frac = cur / max;

    this.healthNum.textContent = String(Math.round(cur));
    this.healthFill.style.width = (frac * 100) + '%';

    // Green -> amber -> red as health drops.
    let color;
    if (frac > 0.5) color = 'var(--range-green)';
    else if (frac > 0.25) color = 'var(--range-amber)';
    else color = 'var(--range-red)';
    this.healthFill.style.background = color;
    this.healthNum.style.color = color;
  }

  // ---------------------------------------------------------------------------
  // Timer + stage info
  // ---------------------------------------------------------------------------

  /** @param {number} seconds - elapsed stage time, shown as SS.CC */
  setTimer(seconds) {
    const s = Math.max(0, seconds || 0);
    this.timer.textContent = s.toFixed(2);
  }

  /**
   * @param {string} name          - stage name.
   * @param {number} targetsLeft   - targets remaining.
   * @param {number} totalTargets  - total targets in the stage.
   */
  setStageInfo(name, targetsLeft, totalTargets) {
    this.stageName.textContent = name || '';
    const left = Math.max(0, Math.floor(targetsLeft || 0));
    const total = Math.max(0, Math.floor(totalTargets || 0));
    const hit = Math.max(0, total - left);
    this.stageCount.textContent = total > 0 ? `${hit} / ${total}` : '';
  }

  /** @param {boolean} on - pulsing THREAT indicator. */
  setThreat(on) {
    this._threatOn = !!on;
    this.threat.classList.toggle('pr-on', this._threatOn);
  }

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------

  /**
   * Transient centered-top message.
   * @param {string} message
   * @param {number} [ms=1800]
   */
  toast(message, ms = 1800) {
    this.toastEl.textContent = message == null ? '' : String(message);
    this.toastEl.classList.add('pr-on');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this.toastEl.classList.remove('pr-on');
    }, Math.max(0, ms));
  }

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  /** Clear transient state between stages. */
  reset() {
    clearTimeout(this._hitTimer);
    clearTimeout(this._toastTimer);
    this._hitTimer = 0;
    this._toastTimer = 0;

    // Hide transient overlays.
    this.hitMarker.classList.remove('pr-hm-show');
    this.damage.classList.remove('pr-dmg-show');
    this.toastEl.classList.remove('pr-on');
    this.toastEl.textContent = '';

    // Reset gameplay indicators to a neutral start-of-stage state.
    this.setReloading(false);
    this.setThreat(false);
    this.setTimer(0);
    this.setStageInfo('', 0, 0);
  }
}
