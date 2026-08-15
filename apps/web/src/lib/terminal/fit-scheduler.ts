export interface TerminalFitSchedulerOptions {
  canFit: () => boolean;
  getDimensions: () => { width: number; height: number };
  fit: () => void;
  requestFrame: (callback: () => void) => void;
  stableFrames?: number;
}

export interface TerminalFitScheduler {
  schedule: () => void;
}

export function createTerminalFitScheduler({
  canFit,
  getDimensions,
  fit,
  requestFrame,
  stableFrames = 3,
}: TerminalFitSchedulerOptions): TerminalFitScheduler {
  let scheduled = false;
  let settledFrames = 0;
  let lastWidth = -1;
  let lastHeight = -1;

  function schedule(): void {
    if (!canFit()) return;

    // A new readiness, resize, or font signal makes the latest layout
    // authoritative, even when an older fit cycle is still running.
    settledFrames = 0;
    lastWidth = -1;
    lastHeight = -1;
    if (scheduled) return;

    scheduled = true;
    requestFrame(run);
  }

  function run(): void {
    if (!canFit()) {
      scheduled = false;
      return;
    }

    const { width, height } = getDimensions();
    if (width <= 0 || height <= 0) {
      scheduled = false;
      return;
    }

    fit();
    if (width === lastWidth && height === lastHeight) {
      settledFrames += 1;
    } else {
      settledFrames = 0;
      lastWidth = width;
      lastHeight = height;
    }

    if (settledFrames < stableFrames) {
      requestFrame(run);
    } else {
      scheduled = false;
    }
  }

  return { schedule };
}
