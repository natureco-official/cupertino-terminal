export function parseOsc7(value, platform = 'posix') {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return null;
    let pathname = decodeURIComponent(url.pathname || '');
    if (platform === 'win32' && /^\/[a-zA-Z]:\//.test(pathname)) pathname = pathname.slice(1);
    return pathname || null;
  } catch (_) { return null; }
}

export class ShellState {
  constructor(now = () => Date.now()) {
    this._now = now;
    this.cwd = null;
    this.atPrompt = false;
    this.running = false;
    this.startedAt = null;
    this.lastExitCode = null;
    this.lastDurationMs = null;
  }

  cwdChanged(cwd) {
    if (cwd) this.cwd = cwd;
    return this.snapshot();
  }

  osc133(payload) {
    const [marker, rawCode] = String(payload || '').split(';');
    if (marker === 'A') this.atPrompt = true;
    if (marker === 'B') this.atPrompt = true;
    if (marker === 'C') {
      this.atPrompt = false;
      this.running = true;
      this.startedAt = this._now();
    }
    if (marker === 'D') {
      this.atPrompt = true;
      this.running = false;
      this.lastExitCode = /^-?\d+$/.test(rawCode || '') ? Number(rawCode) : null;
      this.lastDurationMs = this.startedAt === null ? null : Math.max(0, this._now() - this.startedAt);
      this.startedAt = null;
    }
    return this.snapshot();
  }

  commandStarted() {
    if (!this.atPrompt || this.running) return this.snapshot();
    this.atPrompt = false;
    this.running = true;
    this.startedAt = this._now();
    return this.snapshot();
  }

  snapshot() {
    return {
      cwd: this.cwd,
      atPrompt: this.atPrompt,
      running: this.running,
      lastExitCode: this.lastExitCode,
      lastDurationMs: this.lastDurationMs,
    };
  }
}
