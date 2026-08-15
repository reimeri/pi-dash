import { createReadStream, fstatSync } from "node:fs";

const DESKTOP_OWNER_FD_ENV = "PI_DASH_DESKTOP_OWNER_FD";

export function desktopOwnerFileDescriptor(
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = env[DESKTOP_OWNER_FD_ENV];
  if (raw === undefined) return undefined;
  if (!/^[0-9]+$/u.test(raw)) {
    throw new Error(`${DESKTOP_OWNER_FD_ENV} must be a file descriptor`);
  }
  const descriptor = Number(raw);
  if (!Number.isSafeInteger(descriptor) || descriptor < 3) {
    throw new Error(`${DESKTOP_OWNER_FD_ENV} must be a private descriptor`);
  }
  let metadata;
  try {
    metadata = fstatSync(descriptor);
  } catch {
    throw new Error(`${DESKTOP_OWNER_FD_ENV} is not open`);
  }
  if (!metadata.isFIFO() && !metadata.isSocket()) {
    throw new Error(`${DESKTOP_OWNER_FD_ENV} must refer to a pipe or socket`);
  }
  return descriptor;
}

export function watchDesktopOwner(
  descriptor: number,
  onLost: () => void,
): () => void {
  const stream = createReadStream("", {
    fd: descriptor,
    autoClose: false,
  });
  let active = true;
  const lost = () => {
    if (!active) return;
    active = false;
    onLost();
  };
  stream.once("end", lost);
  stream.once("error", lost);
  stream.resume();
  return () => {
    if (!active) return;
    active = false;
    stream.destroy();
  };
}
