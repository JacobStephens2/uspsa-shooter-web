/*
  Menu.js — full-screen overlay screens for Practical Range.

  A single Menu instance owns every non-gameplay screen: the title, the stage
  briefing, the live countdown, the stage/match scorecards, the fail screen and
  the pause menu. All markup lives inside the provided #menu-root element; the
  Menu injects one scoped <style> block and builds the DOM up front, then simply
  toggles which screen is visible. Only one screen shows at a time.

  Visual language is shared with the rest of the game via the :root CSS custom
  properties and the .rng-btn / .rng-btn--primary classes defined in
  styles/main.css — gritty amber-on-dark, golden-hour range aesthetic.

  The Menu never touches pointer-lock, audio or game state directly. Buttons
  invoke the callbacks handed to each show*() method; the game wires the rest.
*/

export class Menu {
  /**
   * @param {HTMLElement} rootEl the #menu-root container
   */
  constructor(rootEl) {
    if (!rootEl) throw new Error('Menu: a root element is required');
    this.root = rootEl;

    // Settings handlers, wired lazily via setSettingsHandlers().
    this._onVolume = null;
    this._onMute = null;

    // Cache of screen wrappers keyed by name, populated in _build().
    this._screens = {};
    // Countdown element reference, filled in _build().
    this._countdownEl = null;
    this._countdownText = null;

    this._injectStyles();
    this._build();
    this.hideAll();
  }

  /* ----------------------------------------------------------------------- */
  /* Public API                                                              */
  /* ----------------------------------------------------------------------- */

  /** Hide every screen; leaves the live scene fully visible. */
  hideAll() {
    for (const key in this._screens) {
      this._screens[key].classList.add('hidden');
    }
    // The root becomes click-through when nothing is shown so the game (and
    // pointer-lock canvas beneath) receives input normally.
    this.root.style.pointerEvents = 'none';
  }

  /**
   * Title screen.
   * @param {Object} o
   * @param {Function} o.onStart  START MATCH clicked
   * @param {Function} [o.onHowTo] optional secondary "How To" button
   */
  showTitle({ onStart, onHowTo } = {}) {
    this._show('title');
    this._wire(this._els.startBtn, onStart);

    // The optional How-To button only appears when a handler is supplied.
    if (this._els.howToBtn) {
      if (onHowTo) {
        this._els.howToBtn.classList.remove('hidden');
        this._wire(this._els.howToBtn, onHowTo);
      } else {
        this._els.howToBtn.classList.add('hidden');
      }
    }

    // Reflect the current settings-handler wiring on the controls.
    this._syncSettingsControls();
  }

  /**
   * Stage briefing / course-of-fire screen.
   * @param {Object} o
   * @param {number} o.stageNumber
   * @param {string} o.stageName
   * @param {string} o.description
   * @param {string[]} o.parLines   bulleted course-of-fire lines
   * @param {Function} o.onBegin
   */
  showBriefing({ stageNumber, stageName, description, parLines, onBegin } = {}) {
    this._show('briefing');
    this._els.briefEyebrow.textContent = `Stage ${this._num(stageNumber)}`;
    this._els.briefTitle.textContent = stageName || 'Course of Fire';
    this._els.briefDesc.textContent = description || '';

    // Rebuild the bulleted par list.
    const list = this._els.briefList;
    list.textContent = '';
    const lines = Array.isArray(parLines) ? parLines : [];
    for (const line of lines) {
      const li = document.createElement('li');
      li.textContent = line;
      list.appendChild(li);
    }
    // Hide the list heading if there are no lines to show.
    this._els.briefListHead.classList.toggle('hidden', lines.length === 0);

    this._wire(this._els.beginBtn, onBegin);
  }

  /**
   * Live countdown overlay drawn over the running scene. Called repeatedly with
   * the current label. Pass '' (or call hideAll) to clear it.
   * @param {string|number} n  'STANDBY', 3, 2, 1, or '' to clear
   */
  showCountdown(n) {
    const val = n === undefined || n === null ? '' : String(n);
    if (val === '') {
      this._screens.countdown.classList.add('hidden');
      // Only release pointer-events if no other (blocking) screen is active.
      this._releaseIfIdle();
      return;
    }

    // The countdown is a non-blocking overlay: it must NOT eat pointer events,
    // because the scene is live (mouse locked) behind it. So we deliberately do
    // not enable root pointer-events here.
    this._screens.countdown.classList.remove('hidden');
    this._countdownText.textContent = val;

    // Re-trigger the pop animation each tick by reflowing the node.
    this._countdownText.classList.remove('countdown-pop');
    // Force reflow so the animation restarts even on the same class re-add.
    void this._countdownText.offsetWidth;
    this._countdownText.classList.add('countdown-pop');

    // "STANDBY" reads as a word, digits read as a big glyph — style hook.
    const isWord = /[a-z]/i.test(val);
    this._countdownText.classList.toggle('is-word', isWord);
  }

  /**
   * Stage results scorecard.
   * @param {Object} o
   * @param {number} o.stageNumber
   * @param {string} o.stageName
   * @param {Object} o.summary  { alpha, charlie, delta, misses, noShoots,
   *                              penalties, points, time, hitFactor, passed }
   * @param {string} o.nextLabel button label
   * @param {Function} o.onNext
   */
  showStageResults({ stageNumber, stageName, summary, nextLabel, onNext } = {}) {
    this._show('stageResults');
    const s = summary || {};

    this._els.srEyebrow.textContent = `Stage ${this._num(stageNumber)} — Complete`;
    this._els.srTitle.textContent = stageName || 'Stage';

    // Scorecard rows.
    this._els.srAlpha.textContent = this._int(s.alpha);
    this._els.srCharlie.textContent = this._int(s.charlie);
    this._els.srDelta.textContent = this._int(s.delta);
    this._els.srMiss.textContent = this._int(s.misses);
    this._els.srNoShoot.textContent = this._int(s.noShoots);
    this._els.srPenalty.textContent = this._int(s.penalties);
    this._els.srPoints.textContent = this._int(s.points);
    this._els.srTime.textContent = `${this._time(s.time)}s`;

    // Big hit factor + pass/fail badge.
    this._els.srHitFactor.textContent = this._hf(s.hitFactor);
    const passed = s.passed !== false;
    this._els.srBadge.textContent = passed ? 'STAGE PASSED' : 'STAGE FAILED';
    this._els.srBadge.classList.toggle('is-pass', passed);
    this._els.srBadge.classList.toggle('is-fail', !passed);

    this._els.nextBtn.textContent = nextLabel || 'NEXT STAGE';
    this._wire(this._els.nextBtn, onNext);
  }

  /**
   * Failure screen (e.g. player neutralized / DQ).
   * @param {Object} o
   * @param {string} o.stageName
   * @param {string} o.reason
   * @param {Function} o.onRetry
   * @param {Function} o.onQuit
   */
  showFailed({ stageName, reason, onRetry, onQuit } = {}) {
    this._show('failed');
    this._els.failStage.textContent = stageName || '';
    this._els.failReason.textContent = reason || 'Run stopped.';
    this._wire(this._els.retryBtn, onRetry);
    this._wire(this._els.failQuitBtn, onQuit);
  }

  /**
   * Final match results.
   * @param {Object} o
   * @param {Array} o.stages  [{ stageNumber, stageName, hitFactor, points, time }]
   * @param {number} o.totalPoints
   * @param {string} o.grade  classification letter (GM/M/A/B/C/D/U)
   * @param {Function} o.onReplay
   */
  showMatchResults({ stages, totalPoints, grade, onReplay } = {}) {
    this._show('matchResults');
    this._els.mrGrade.textContent = grade || 'U';
    this._els.mrTotal.textContent = this._int(totalPoints);

    // Rebuild the per-stage rows.
    const body = this._els.mrBody;
    body.textContent = '';
    const rows = Array.isArray(stages) ? stages : [];
    for (const st of rows) {
      const tr = document.createElement('tr');
      tr.appendChild(this._cell(`${this._num(st.stageNumber)}`, 'mr-cell mr-cell--num'));
      tr.appendChild(this._cell(st.stageName || '—', 'mr-cell mr-cell--name'));
      tr.appendChild(this._cell(this._hf(st.hitFactor), 'mr-cell mr-cell--hf'));
      tr.appendChild(this._cell(this._int(st.points), 'mr-cell mr-cell--num'));
      tr.appendChild(this._cell(`${this._time(st.time)}s`, 'mr-cell mr-cell--num'));
      body.appendChild(tr);
    }
    this._els.mrEmpty.classList.toggle('hidden', rows.length > 0);

    this._wire(this._els.replayBtn, onReplay);
  }

  /**
   * Pause menu.
   * @param {Object} o
   * @param {Function} o.onResume
   * @param {Function} o.onRestart
   * @param {Function} o.onQuit
   */
  showPause({ onResume, onRestart, onQuit } = {}) {
    this._show('pause');
    this._wire(this._els.resumeBtn, onResume);
    this._wire(this._els.restartBtn, onRestart);
    this._wire(this._els.pauseQuitBtn, onQuit);
  }

  /**
   * Wire the title-screen settings controls.
   * @param {Object} o
   * @param {Function} o.onVolume  (v: 0..1) => void
   * @param {Function} o.onMute    (muted: boolean) => void
   */
  setSettingsHandlers({ onVolume, onMute } = {}) {
    this._onVolume = typeof onVolume === 'function' ? onVolume : null;
    this._onMute = typeof onMute === 'function' ? onMute : null;
    this._syncSettingsControls();
  }

  /* ----------------------------------------------------------------------- */
  /* Internal helpers                                                        */
  /* ----------------------------------------------------------------------- */

  /** Show one screen exclusively; enable blocking pointer events on the root. */
  _show(name) {
    for (const key in this._screens) {
      this._screens[key].classList.toggle('hidden', key !== name);
    }
    // Every "real" screen is modal — capture input over the dimmed backdrop.
    this.root.style.pointerEvents = 'auto';
  }

  /** Release root pointer-events when only the (non-modal) countdown remains. */
  _releaseIfIdle() {
    let anyModal = false;
    for (const key in this._screens) {
      if (key === 'countdown') continue;
      if (!this._screens[key].classList.contains('hidden')) {
        anyModal = true;
        break;
      }
    }
    if (!anyModal) this.root.style.pointerEvents = 'none';
  }

  /** Reflect the presence of settings handlers on the title controls. */
  _syncSettingsControls() {
    const vol = this._els && this._els.volSlider;
    const mute = this._els && this._els.muteChk;
    if (vol) vol.disabled = !this._onVolume;
    if (mute) mute.disabled = !this._onMute;
  }

  /** Bind a click handler to a button, replacing any previous one. */
  _wire(el, fn) {
    if (!el) return;
    el.onclick = typeof fn === 'function' ? (e) => { e.preventDefault(); fn(); } : null;
  }

  /* Small formatting helpers -------------------------------------------- */

  _num(n) {
    const v = Number(n);
    return Number.isFinite(v) ? String(v) : '—';
  }

  _int(n) {
    const v = Number(n);
    return Number.isFinite(v) ? String(Math.round(v)) : '0';
  }

  _time(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v.toFixed(2) : '0.00';
  }

  _hf(n) {
    const v = Number(n);
    return Number.isFinite(v) ? v.toFixed(4) : '0.0000';
  }

  _cell(text, className) {
    const td = document.createElement('td');
    td.className = className;
    td.textContent = text;
    return td;
  }

  /* ----------------------------------------------------------------------- */
  /* DOM construction                                                        */
  /* ----------------------------------------------------------------------- */

  _build() {
    // A collection of element references used by the public API.
    this._els = {};

    this.root.innerHTML = '';

    this._screens.title = this._buildTitle();
    this._screens.briefing = this._buildBriefing();
    this._screens.countdown = this._buildCountdown();
    this._screens.stageResults = this._buildStageResults();
    this._screens.failed = this._buildFailed();
    this._screens.matchResults = this._buildMatchResults();
    this._screens.pause = this._buildPause();

    for (const key in this._screens) {
      this.root.appendChild(this._screens[key]);
    }
  }

  /** Build a dimmed backdrop wrapper hosting a centred panel. */
  _screen(name, { blur = true } = {}) {
    const wrap = document.createElement('div');
    wrap.className = `menu-screen${blur ? '' : ' menu-screen--clear'}`;
    wrap.dataset.screen = name;
    return wrap;
  }

  _panel(extra = '') {
    const p = document.createElement('div');
    p.className = `menu-panel${extra ? ' ' + extra : ''}`;
    return p;
  }

  _button(label, primary = false) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `rng-btn${primary ? ' rng-btn--primary' : ''}`;
    b.textContent = label;
    return b;
  }

  // --- Title -------------------------------------------------------------
  _buildTitle() {
    const s = this._screen('title');
    const panel = this._panel('menu-panel--title');

    const title = document.createElement('h1');
    title.className = 'menu-title';
    title.textContent = 'PRACTICAL RANGE';

    const sub = document.createElement('div');
    sub.className = 'menu-subtitle';
    sub.textContent = 'USPSA Match Simulator';

    const start = this._button('Start Match', true);
    start.classList.add('menu-cta');
    this._els.startBtn = start;

    const howTo = this._button('How To Play');
    howTo.classList.add('menu-howto', 'hidden');
    this._els.howToBtn = howTo;

    const ctaRow = document.createElement('div');
    ctaRow.className = 'menu-cta-row';
    ctaRow.appendChild(start);
    ctaRow.appendChild(howTo);

    // Controls blurb.
    const controls = document.createElement('div');
    controls.className = 'menu-controls';
    const controlsHead = document.createElement('div');
    controlsHead.className = 'menu-controls-head';
    controlsHead.textContent = 'Controls';
    controls.appendChild(controlsHead);

    const controlsGrid = document.createElement('div');
    controlsGrid.className = 'menu-controls-grid';
    const bindings = [
      ['WASD', 'Move'],
      ['Mouse', 'Aim'],
      ['Click', 'Shoot'],
      ['R', 'Reload'],
      ['Shift', 'Sprint'],
      ['Ctrl', 'Crouch'],
      ['F', 'Finish stage'],
      ['Esc', 'Pause'],
    ];
    for (const [key, action] of bindings) {
      const kb = document.createElement('kbd');
      kb.className = 'menu-key';
      kb.textContent = key;
      const act = document.createElement('span');
      act.className = 'menu-key-action';
      act.textContent = action;
      controlsGrid.appendChild(kb);
      controlsGrid.appendChild(act);
    }
    controls.appendChild(controlsGrid);

    // Settings row: volume slider + mute checkbox.
    const settings = document.createElement('div');
    settings.className = 'menu-settings';

    const volWrap = document.createElement('label');
    volWrap.className = 'menu-setting';
    const volText = document.createElement('span');
    volText.className = 'menu-setting-label';
    volText.textContent = 'Volume';
    const vol = document.createElement('input');
    vol.type = 'range';
    vol.min = '0';
    vol.max = '1';
    vol.step = '0.01';
    vol.value = '0.8';
    vol.className = 'menu-slider';
    vol.addEventListener('input', () => {
      if (this._onVolume) this._onVolume(Number(vol.value));
    });
    this._els.volSlider = vol;
    volWrap.appendChild(volText);
    volWrap.appendChild(vol);

    const muteWrap = document.createElement('label');
    muteWrap.className = 'menu-setting menu-setting--check';
    const mute = document.createElement('input');
    mute.type = 'checkbox';
    mute.className = 'menu-check';
    mute.addEventListener('change', () => {
      if (this._onMute) this._onMute(mute.checked);
    });
    this._els.muteChk = mute;
    const muteText = document.createElement('span');
    muteText.className = 'menu-setting-label';
    muteText.textContent = 'Mute';
    muteWrap.appendChild(mute);
    muteWrap.appendChild(muteText);

    settings.appendChild(volWrap);
    settings.appendChild(muteWrap);

    panel.appendChild(title);
    panel.appendChild(sub);
    panel.appendChild(ctaRow);
    panel.appendChild(controls);
    panel.appendChild(settings);
    s.appendChild(panel);
    return s;
  }

  // --- Briefing ----------------------------------------------------------
  _buildBriefing() {
    const s = this._screen('briefing');
    const panel = this._panel('menu-panel--briefing');

    const eyebrow = document.createElement('div');
    eyebrow.className = 'menu-eyebrow';
    this._els.briefEyebrow = eyebrow;

    const title = document.createElement('h2');
    title.className = 'menu-heading';
    this._els.briefTitle = title;

    const desc = document.createElement('p');
    desc.className = 'menu-desc';
    this._els.briefDesc = desc;

    const listHead = document.createElement('div');
    listHead.className = 'menu-subhead';
    listHead.textContent = 'Course of Fire';
    this._els.briefListHead = listHead;

    const list = document.createElement('ul');
    list.className = 'menu-list';
    this._els.briefList = list;

    const begin = this._button('Begin — Load & Make Ready', true);
    begin.classList.add('menu-cta');
    this._els.beginBtn = begin;

    const note = document.createElement('div');
    note.className = 'menu-note';
    note.textContent =
      'Clicking Begin locks the mouse, then runs a countdown and start beep.';

    panel.appendChild(eyebrow);
    panel.appendChild(title);
    panel.appendChild(desc);
    panel.appendChild(listHead);
    panel.appendChild(list);
    panel.appendChild(begin);
    panel.appendChild(note);
    s.appendChild(panel);
    return s;
  }

  // --- Countdown (non-modal overlay) ------------------------------------
  _buildCountdown() {
    // Transparent, non-blurred, pointer-transparent overlay over the scene.
    const s = this._screen('countdown', { blur: false });
    s.classList.add('menu-screen--overlay');

    const box = document.createElement('div');
    box.className = 'menu-countdown';
    const text = document.createElement('div');
    text.className = 'menu-countdown-num';
    box.appendChild(text);
    s.appendChild(box);

    this._countdownEl = box;
    this._countdownText = text;
    return s;
  }

  // --- Stage Results -----------------------------------------------------
  _buildStageResults() {
    const s = this._screen('stageResults');
    const panel = this._panel('menu-panel--results');

    const eyebrow = document.createElement('div');
    eyebrow.className = 'menu-eyebrow';
    this._els.srEyebrow = eyebrow;

    const title = document.createElement('h2');
    title.className = 'menu-heading';
    this._els.srTitle = title;

    // Scorecard grid of labelled stat cells.
    const card = document.createElement('div');
    card.className = 'menu-scorecard';
    const stat = (label, cls) => {
      const cell = document.createElement('div');
      cell.className = `sc-stat${cls ? ' ' + cls : ''}`;
      const val = document.createElement('div');
      val.className = 'sc-val';
      val.textContent = '0';
      const lab = document.createElement('div');
      lab.className = 'sc-label';
      lab.textContent = label;
      cell.appendChild(val);
      cell.appendChild(lab);
      return { cell, val };
    };

    const a = stat('Alpha', 'sc-good');
    const c = stat('Charlie');
    const d = stat('Delta');
    const m = stat('Misses', 'sc-bad');
    const ns = stat('No-Shoots', 'sc-bad');
    const pen = stat('Penalties', 'sc-bad');
    const pts = stat('Raw Points');
    const tm = stat('Time');

    this._els.srAlpha = a.val;
    this._els.srCharlie = c.val;
    this._els.srDelta = d.val;
    this._els.srMiss = m.val;
    this._els.srNoShoot = ns.val;
    this._els.srPenalty = pen.val;
    this._els.srPoints = pts.val;
    this._els.srTime = tm.val;

    for (const item of [a, c, d, m, ns, pen, pts, tm]) card.appendChild(item.cell);

    // Big hit-factor block + pass/fail badge.
    const hfBlock = document.createElement('div');
    hfBlock.className = 'menu-hf';
    const hfLabel = document.createElement('div');
    hfLabel.className = 'menu-hf-label';
    hfLabel.textContent = 'Hit Factor';
    const hfVal = document.createElement('div');
    hfVal.className = 'menu-hf-val';
    hfVal.textContent = '0.0000';
    this._els.srHitFactor = hfVal;
    const badge = document.createElement('div');
    badge.className = 'menu-badge';
    badge.textContent = 'STAGE PASSED';
    this._els.srBadge = badge;
    hfBlock.appendChild(hfLabel);
    hfBlock.appendChild(hfVal);
    hfBlock.appendChild(badge);

    const next = this._button('Next Stage', true);
    next.classList.add('menu-cta');
    this._els.nextBtn = next;

    panel.appendChild(eyebrow);
    panel.appendChild(title);
    panel.appendChild(hfBlock);
    panel.appendChild(card);
    panel.appendChild(next);
    s.appendChild(panel);
    return s;
  }

  // --- Failed ------------------------------------------------------------
  _buildFailed() {
    const s = this._screen('failed');
    const panel = this._panel('menu-panel--failed');

    const eyebrow = document.createElement('div');
    eyebrow.className = 'menu-eyebrow menu-eyebrow--fail';
    eyebrow.textContent = 'Run Stopped';

    const title = document.createElement('h2');
    title.className = 'menu-heading menu-heading--fail';
    title.textContent = 'STAGE FAILED';

    const stage = document.createElement('div');
    stage.className = 'menu-fail-stage';
    this._els.failStage = stage;

    const reason = document.createElement('p');
    reason.className = 'menu-desc';
    this._els.failReason = reason;

    const retry = this._button('Retry Stage', true);
    retry.classList.add('menu-cta');
    this._els.retryBtn = retry;

    const quit = this._button('Quit To Menu');
    this._els.failQuitBtn = quit;

    const row = document.createElement('div');
    row.className = 'menu-btn-row';
    row.appendChild(retry);
    row.appendChild(quit);

    panel.appendChild(eyebrow);
    panel.appendChild(title);
    panel.appendChild(stage);
    panel.appendChild(reason);
    panel.appendChild(row);
    s.appendChild(panel);
    return s;
  }

  // --- Match Results -----------------------------------------------------
  _buildMatchResults() {
    const s = this._screen('matchResults');
    const panel = this._panel('menu-panel--match');

    const eyebrow = document.createElement('div');
    eyebrow.className = 'menu-eyebrow';
    eyebrow.textContent = 'Match Complete';

    const title = document.createElement('h2');
    title.className = 'menu-heading';
    title.textContent = 'FINAL RESULTS';

    // Grade block.
    const gradeBlock = document.createElement('div');
    gradeBlock.className = 'menu-grade';
    const gradeLabel = document.createElement('div');
    gradeLabel.className = 'menu-grade-label';
    gradeLabel.textContent = 'Classification';
    const gradeVal = document.createElement('div');
    gradeVal.className = 'menu-grade-val';
    gradeVal.textContent = 'U';
    this._els.mrGrade = gradeVal;
    gradeBlock.appendChild(gradeLabel);
    gradeBlock.appendChild(gradeVal);

    // Per-stage table.
    const table = document.createElement('table');
    table.className = 'menu-table';
    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    for (const h of ['#', 'Stage', 'Hit Factor', 'Points', 'Time']) {
      const th = document.createElement('th');
      th.textContent = h;
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    const tbody = document.createElement('tbody');
    this._els.mrBody = tbody;
    table.appendChild(thead);
    table.appendChild(tbody);

    const empty = document.createElement('div');
    empty.className = 'menu-empty hidden';
    empty.textContent = 'No stages recorded.';
    this._els.mrEmpty = empty;

    // Total row.
    const total = document.createElement('div');
    total.className = 'menu-total';
    const totalLabel = document.createElement('span');
    totalLabel.className = 'menu-total-label';
    totalLabel.textContent = 'Total Points';
    const totalVal = document.createElement('span');
    totalVal.className = 'menu-total-val';
    totalVal.textContent = '0';
    this._els.mrTotal = totalVal;
    total.appendChild(totalLabel);
    total.appendChild(totalVal);

    const replay = this._button('Play Again', true);
    replay.classList.add('menu-cta');
    this._els.replayBtn = replay;

    panel.appendChild(eyebrow);
    panel.appendChild(title);
    panel.appendChild(gradeBlock);
    panel.appendChild(table);
    panel.appendChild(empty);
    panel.appendChild(total);
    panel.appendChild(replay);
    s.appendChild(panel);
    return s;
  }

  // --- Pause -------------------------------------------------------------
  _buildPause() {
    const s = this._screen('pause');
    const panel = this._panel('menu-panel--pause');

    const eyebrow = document.createElement('div');
    eyebrow.className = 'menu-eyebrow';
    eyebrow.textContent = 'Range Cold';

    const title = document.createElement('h2');
    title.className = 'menu-heading';
    title.textContent = 'PAUSED';

    const resume = this._button('Resume', true);
    resume.classList.add('menu-cta');
    this._els.resumeBtn = resume;

    const restart = this._button('Restart Stage');
    this._els.restartBtn = restart;

    const quit = this._button('Quit To Menu');
    this._els.pauseQuitBtn = quit;

    const col = document.createElement('div');
    col.className = 'menu-btn-col';
    col.appendChild(resume);
    col.appendChild(restart);
    col.appendChild(quit);

    panel.appendChild(eyebrow);
    panel.appendChild(title);
    panel.appendChild(col);
    s.appendChild(panel);
    return s;
  }

  /* ----------------------------------------------------------------------- */
  /* Scoped styles                                                           */
  /* ----------------------------------------------------------------------- */

  _injectStyles() {
    // Guard: only inject once even if multiple Menus are ever constructed.
    if (document.getElementById('menu-styles')) return;

    const css = `
    /* Practical Range — Menu overlay styles (scoped under #menu-root) */
    #menu-root .menu-screen {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 4vh 4vw;
      background:
        radial-gradient(circle at 50% 32%, rgba(30, 22, 8, 0.55), rgba(5, 7, 5, 0.9)),
        linear-gradient(180deg, rgba(5, 7, 5, 0.82), rgba(5, 7, 5, 0.92));
      backdrop-filter: blur(3px);
      -webkit-backdrop-filter: blur(3px);
      pointer-events: auto;
      animation: menu-fade 0.22s ease both;
    }
    #menu-root .menu-screen--clear {
      background: none;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
    }
    #menu-root .menu-screen--overlay {
      pointer-events: none;
      animation: none;
    }

    @keyframes menu-fade {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    /* Panels -------------------------------------------------------------- */
    #menu-root .menu-panel {
      position: relative;
      width: min(640px, 92vw);
      max-height: 92vh;
      overflow-y: auto;
      padding: clamp(1.4rem, 3.5vw, 2.6rem);
      background: var(--range-panel);
      border: 1px solid var(--range-line);
      border-radius: 8px;
      box-shadow: var(--range-shadow), inset 0 1px 0 rgba(255, 255, 255, 0.04);
      text-align: center;
      animation: menu-rise 0.26s cubic-bezier(0.2, 0.7, 0.2, 1) both;
    }
    /* A subtle amber top-edge accent, like a lit range bay. */
    #menu-root .menu-panel::before {
      content: "";
      position: absolute;
      inset: 0 0 auto 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--range-amber), transparent);
      opacity: 0.7;
    }
    #menu-root .menu-panel--results,
    #menu-root .menu-panel--match { width: min(720px, 94vw); }

    @keyframes menu-rise {
      from { opacity: 0; transform: translateY(14px) scale(0.985); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    /* Scrollbar tint */
    #menu-root .menu-panel::-webkit-scrollbar { width: 8px; }
    #menu-root .menu-panel::-webkit-scrollbar-thumb {
      background: var(--range-line); border-radius: 8px;
    }

    /* Titles -------------------------------------------------------------- */
    #menu-root .menu-title {
      margin: 0;
      font-size: clamp(2.2rem, 7vw, 4.2rem);
      font-weight: 700;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--range-amber);
      text-shadow: 0 0 30px rgba(224, 176, 64, 0.4), 0 2px 0 rgba(0, 0, 0, 0.4);
      line-height: 1.02;
    }
    #menu-root .menu-subtitle {
      margin-top: 0.6rem;
      color: var(--range-dim);
      letter-spacing: 0.34em;
      text-transform: uppercase;
      font-size: clamp(0.72rem, 1.6vw, 0.95rem);
    }
    #menu-root .menu-heading {
      margin: 0.1rem 0 0;
      font-size: clamp(1.5rem, 4vw, 2.3rem);
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--range-text);
    }
    #menu-root .menu-heading--fail { color: var(--range-red-bright); }
    #menu-root .menu-eyebrow {
      color: var(--range-amber);
      letter-spacing: 0.28em;
      text-transform: uppercase;
      font-size: 0.72rem;
      font-weight: 600;
      margin-bottom: 0.4rem;
    }
    #menu-root .menu-eyebrow--fail { color: var(--range-red-bright); }
    #menu-root .menu-subhead {
      margin-top: 1.4rem;
      color: var(--range-amber);
      letter-spacing: 0.2em;
      text-transform: uppercase;
      font-size: 0.72rem;
      font-weight: 600;
      text-align: left;
      border-bottom: 1px solid var(--range-line);
      padding-bottom: 0.35rem;
    }
    #menu-root .menu-desc {
      margin: 0.8rem 0 0;
      color: var(--range-text);
      opacity: 0.92;
      line-height: 1.5;
      font-size: clamp(0.9rem, 1.8vw, 1.02rem);
      text-align: center;
    }
    #menu-root .menu-note {
      margin-top: 1rem;
      color: var(--range-dim);
      font-size: 0.78rem;
      letter-spacing: 0.03em;
      font-style: italic;
    }

    /* CTA rows / buttons -------------------------------------------------- */
    #menu-root .menu-cta { margin-top: 1.6rem; font-size: 1.06rem; }
    #menu-root .menu-cta-row {
      display: flex; gap: 0.8rem; justify-content: center; flex-wrap: wrap;
      margin-top: 1.6rem;
    }
    #menu-root .menu-cta-row .menu-cta { margin-top: 0; }
    #menu-root .menu-btn-row {
      display: flex; gap: 0.8rem; justify-content: center; flex-wrap: wrap;
      margin-top: 1.7rem;
    }
    #menu-root .menu-btn-row .menu-cta { margin-top: 0; }
    #menu-root .menu-btn-col {
      display: flex; flex-direction: column; gap: 0.7rem;
      max-width: 320px; margin: 1.8rem auto 0;
    }
    #menu-root .menu-btn-col .rng-btn { width: 100%; margin-top: 0; }

    /* Controls blurb ------------------------------------------------------ */
    #menu-root .menu-controls {
      margin-top: 1.8rem;
      padding-top: 1.2rem;
      border-top: 1px solid var(--range-line);
    }
    #menu-root .menu-controls-head {
      color: var(--range-dim);
      letter-spacing: 0.24em;
      text-transform: uppercase;
      font-size: 0.68rem;
      margin-bottom: 0.8rem;
    }
    #menu-root .menu-controls-grid {
      display: grid;
      grid-template-columns: repeat(3, auto);
      gap: 0.55rem 1.4rem;
      justify-content: center;
      align-items: center;
    }
    #menu-root .menu-key {
      font-family: var(--font-mono);
      font-size: 0.74rem;
      color: var(--range-amber-bright);
      background: rgba(224, 176, 64, 0.08);
      border: 1px solid var(--range-line);
      border-bottom-width: 2px;
      border-radius: 4px;
      padding: 0.2em 0.55em;
      min-width: 2.2em;
      text-align: center;
      justify-self: end;
    }
    #menu-root .menu-key-action {
      color: var(--range-text);
      font-size: 0.82rem;
      letter-spacing: 0.04em;
      justify-self: start;
      text-align: left;
    }

    /* Settings row -------------------------------------------------------- */
    #menu-root .menu-settings {
      margin-top: 1.4rem;
      padding-top: 1.1rem;
      border-top: 1px solid var(--range-line);
      display: flex;
      gap: 1.6rem;
      justify-content: center;
      align-items: center;
      flex-wrap: wrap;
    }
    #menu-root .menu-setting {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      cursor: pointer;
    }
    #menu-root .menu-setting-label {
      color: var(--range-dim);
      letter-spacing: 0.14em;
      text-transform: uppercase;
      font-size: 0.72rem;
    }
    #menu-root .menu-slider {
      -webkit-appearance: none;
      appearance: none;
      width: 160px;
      height: 4px;
      border-radius: 3px;
      background: linear-gradient(90deg, var(--range-amber) 0%, rgba(255,255,255,0.12) 0%);
      background: rgba(255, 255, 255, 0.12);
      outline: none;
      cursor: pointer;
    }
    #menu-root .menu-slider::-webkit-slider-thumb {
      -webkit-appearance: none;
      appearance: none;
      width: 16px; height: 16px;
      border-radius: 50%;
      background: var(--range-amber);
      border: 2px solid var(--range-amber-bright);
      box-shadow: 0 0 8px rgba(224, 176, 64, 0.5);
      cursor: pointer;
    }
    #menu-root .menu-slider::-moz-range-thumb {
      width: 16px; height: 16px;
      border-radius: 50%;
      background: var(--range-amber);
      border: 2px solid var(--range-amber-bright);
      cursor: pointer;
    }
    #menu-root .menu-slider:disabled { opacity: 0.4; cursor: not-allowed; }
    #menu-root .menu-check {
      -webkit-appearance: none;
      appearance: none;
      width: 18px; height: 18px;
      border: 1px solid var(--range-line);
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.3);
      cursor: pointer;
      position: relative;
      display: inline-block;
      vertical-align: middle;
    }
    #menu-root .menu-check:checked {
      background: var(--range-amber);
      border-color: var(--range-amber-bright);
    }
    #menu-root .menu-check:checked::after {
      content: "";
      position: absolute;
      left: 5px; top: 1px;
      width: 5px; height: 10px;
      border: solid #1a1405;
      border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }
    #menu-root .menu-check:disabled { opacity: 0.4; cursor: not-allowed; }
    #menu-root .menu-setting--check { cursor: pointer; }

    /* Briefing list ------------------------------------------------------- */
    #menu-root .menu-list {
      list-style: none;
      margin: 0.8rem 0 0;
      padding: 0;
      text-align: left;
    }
    #menu-root .menu-list li {
      position: relative;
      padding: 0.4rem 0 0.4rem 1.5rem;
      color: var(--range-text);
      font-size: clamp(0.88rem, 1.7vw, 1rem);
      line-height: 1.4;
      border-bottom: 1px solid rgba(224, 176, 64, 0.1);
    }
    #menu-root .menu-list li::before {
      content: "";
      position: absolute;
      left: 0.15rem; top: 0.95em;
      width: 7px; height: 7px;
      background: var(--range-amber);
      transform: rotate(45deg);
    }

    /* Scorecard ----------------------------------------------------------- */
    #menu-root .menu-scorecard {
      margin-top: 1.4rem;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 0.6rem;
    }
    #menu-root .sc-stat {
      background: rgba(0, 0, 0, 0.28);
      border: 1px solid var(--range-line);
      border-radius: 6px;
      padding: 0.7rem 0.4rem 0.55rem;
    }
    #menu-root .sc-val {
      font-family: var(--font-mono);
      font-size: clamp(1.2rem, 3vw, 1.7rem);
      font-weight: 700;
      color: var(--range-text);
      line-height: 1;
    }
    #menu-root .sc-label {
      margin-top: 0.35rem;
      color: var(--range-dim);
      text-transform: uppercase;
      letter-spacing: 0.1em;
      font-size: 0.62rem;
    }
    #menu-root .sc-good .sc-val { color: var(--range-green); }
    #menu-root .sc-bad .sc-val { color: var(--range-red-bright); }

    /* Hit-factor block ---------------------------------------------------- */
    #menu-root .menu-hf {
      margin-top: 1.5rem;
      padding: 1.1rem;
      background: linear-gradient(180deg, rgba(224, 176, 64, 0.12), rgba(224, 176, 64, 0.02));
      border: 1px solid var(--range-line);
      border-radius: 8px;
    }
    #menu-root .menu-hf-label,
    #menu-root .menu-grade-label {
      color: var(--range-dim);
      text-transform: uppercase;
      letter-spacing: 0.24em;
      font-size: 0.7rem;
    }
    #menu-root .menu-hf-val {
      font-family: var(--font-mono);
      font-size: clamp(2.4rem, 8vw, 4rem);
      font-weight: 700;
      color: var(--range-amber-bright);
      line-height: 1.05;
      text-shadow: 0 0 26px rgba(224, 176, 64, 0.4);
    }
    #menu-root .menu-badge {
      display: inline-block;
      margin-top: 0.6rem;
      padding: 0.28em 1em;
      border-radius: 20px;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      border: 1px solid transparent;
    }
    #menu-root .menu-badge.is-pass {
      color: var(--range-green);
      background: rgba(70, 196, 106, 0.12);
      border-color: var(--range-green-dim);
    }
    #menu-root .menu-badge.is-fail {
      color: var(--range-red-bright);
      background: rgba(226, 69, 58, 0.12);
      border-color: var(--range-red);
    }

    /* Grade block --------------------------------------------------------- */
    #menu-root .menu-grade { margin-top: 1.4rem; }
    #menu-root .menu-grade-val {
      font-size: clamp(4rem, 14vw, 7rem);
      font-weight: 700;
      line-height: 1;
      color: var(--range-amber-bright);
      letter-spacing: 0.04em;
      text-shadow: 0 0 40px rgba(224, 176, 64, 0.45);
    }

    /* Match table --------------------------------------------------------- */
    #menu-root .menu-table {
      width: 100%;
      margin-top: 1.4rem;
      border-collapse: collapse;
      font-size: clamp(0.82rem, 1.7vw, 0.96rem);
    }
    #menu-root .menu-table th {
      color: var(--range-dim);
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 0.64rem;
      font-weight: 600;
      text-align: right;
      padding: 0.4rem 0.5rem;
      border-bottom: 1px solid var(--range-line);
    }
    #menu-root .menu-table th:nth-child(1) { text-align: center; }
    #menu-root .menu-table th:nth-child(2) { text-align: left; }
    #menu-root .menu-table td { padding: 0.5rem; }
    #menu-root .menu-table tbody tr {
      border-bottom: 1px solid rgba(224, 176, 64, 0.08);
    }
    #menu-root .mr-cell { text-align: right; font-family: var(--font-mono); }
    #menu-root .mr-cell--num { text-align: right; }
    #menu-root .mr-cell--name {
      text-align: left; font-family: var(--font-stack); color: var(--range-text);
    }
    #menu-root .mr-cell--hf { color: var(--range-amber-bright); font-weight: 700; }
    #menu-root .menu-empty {
      margin-top: 1rem; color: var(--range-dim); font-size: 0.85rem;
    }
    #menu-root .menu-total {
      margin-top: 1.2rem;
      padding-top: 1rem;
      border-top: 1px solid var(--range-line);
      display: flex;
      justify-content: space-between;
      align-items: baseline;
    }
    #menu-root .menu-total-label {
      color: var(--range-dim);
      text-transform: uppercase;
      letter-spacing: 0.16em;
      font-size: 0.78rem;
    }
    #menu-root .menu-total-val {
      font-family: var(--font-mono);
      font-size: clamp(1.4rem, 4vw, 2rem);
      font-weight: 700;
      color: var(--range-amber-bright);
    }

    /* Fail-specific ------------------------------------------------------- */
    #menu-root .menu-fail-stage {
      margin-top: 0.5rem;
      color: var(--range-dim);
      text-transform: uppercase;
      letter-spacing: 0.16em;
      font-size: 0.8rem;
    }

    /* Countdown ----------------------------------------------------------- */
    #menu-root .menu-countdown {
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
    }
    #menu-root .menu-countdown-num {
      font-weight: 700;
      color: var(--range-amber-bright);
      text-shadow: 0 0 40px rgba(224, 176, 64, 0.55), 0 6px 24px rgba(0, 0, 0, 0.6);
      line-height: 1;
      font-size: clamp(6rem, 26vw, 16rem);
      letter-spacing: 0.02em;
    }
    #menu-root .menu-countdown-num.is-word {
      font-size: clamp(2.2rem, 12vw, 6rem);
      letter-spacing: 0.28em;
      text-transform: uppercase;
      color: var(--range-amber);
    }
    #menu-root .menu-countdown-num.countdown-pop {
      animation: countdown-pop 0.5s cubic-bezier(0.2, 0.8, 0.25, 1) both;
    }
    @keyframes countdown-pop {
      0%   { opacity: 0; transform: scale(1.5); }
      18%  { opacity: 1; transform: scale(1); }
      100% { opacity: 0.85; transform: scale(1); }
    }

    /* Reduced-motion respect */
    @media (prefers-reduced-motion: reduce) {
      #menu-root .menu-screen,
      #menu-root .menu-panel,
      #menu-root .menu-countdown-num.countdown-pop { animation: none; }
    }
    `;

    const style = document.createElement('style');
    style.id = 'menu-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }
}
