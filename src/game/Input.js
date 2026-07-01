/*
  Keyboard + mouse + pointer-lock input.

  - Movement keys are polled (isDown).
  - Mouse look accumulates a delta while pointer-locked; the game consumes it once per frame.
  - Discrete actions (fire, reload, key presses, lock changes) are delivered through a tiny emitter.
*/

export class Input {
  /** @param {HTMLElement} lockElement element that requests pointer lock (the canvas). */
  constructor(lockElement) {
    this.lockElement = lockElement;
    this._keys = new Set();
    this._mouseDX = 0;
    this._mouseDY = 0;
    this._firing = false;
    this._listeners = new Map();
    this.enabled = true;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onLockChange = this._onLockChange.bind(this);
    this._onContextMenu = (e) => e.preventDefault();

    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('mousedown', this._onMouseDown);
    window.addEventListener('mouseup', this._onMouseUp);
    window.addEventListener('contextmenu', this._onContextMenu);
    document.addEventListener('pointerlockchange', this._onLockChange);
  }

  /* --- event emitter --------------------------------------------------- */
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    return () => this._listeners.get(event)?.delete(cb);
  }

  _emit(event, payload) {
    const set = this._listeners.get(event);
    if (set) for (const cb of set) cb(payload);
  }

  /* --- pointer lock ---------------------------------------------------- */
  requestLock() {
    const el = this.lockElement;
    if (el && document.pointerLockElement !== el && el.requestPointerLock) {
      const p = el.requestPointerLock();
      // Some browsers return a promise that rejects if called too soon; ignore.
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
  }

  exitLock() {
    if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
  }

  get isLocked() {
    return document.pointerLockElement === this.lockElement;
  }

  _onLockChange() {
    const locked = this.isLocked;
    if (!locked) this._firing = false;
    this._emit('lockchange', locked);
  }

  /* --- keyboard -------------------------------------------------------- */
  _onKeyDown(e) {
    if (e.repeat) return;
    this._keys.add(e.code);
    if (!this.enabled) return;
    this._emit('keydown', e.code);
    if (e.code === 'KeyR') this._emit('reload');
  }

  _onKeyUp(e) {
    this._keys.delete(e.code);
    if (!this.enabled) return;
    this._emit('keyup', e.code);
  }

  isDown(code) {
    return this._keys.has(code);
  }

  clearKeys() {
    this._keys.clear();
    this._firing = false;
  }

  /* --- mouse ----------------------------------------------------------- */
  _onMouseMove(e) {
    if (!this.isLocked) return;
    this._mouseDX += e.movementX || 0;
    this._mouseDY += e.movementY || 0;
  }

  _onMouseDown(e) {
    if (!this.enabled) return;
    if (e.button === 0) {
      if (this.isLocked) {
        this._firing = true;
        this._emit('firedown');
      }
    }
  }

  _onMouseUp(e) {
    if (e.button === 0) {
      this._firing = false;
      this._emit('fireup');
    }
  }

  get isFiring() {
    return this._firing && this.isLocked;
  }

  /** Returns accumulated mouse delta since last call and resets it. */
  consumeMouseDelta() {
    const d = { x: this._mouseDX, y: this._mouseDY };
    this._mouseDX = 0;
    this._mouseDY = 0;
    return d;
  }

  dispose() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('mousedown', this._onMouseDown);
    window.removeEventListener('mouseup', this._onMouseUp);
    window.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('pointerlockchange', this._onLockChange);
    this._listeners.clear();
  }
}
