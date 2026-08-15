import {
  desktopOwnerFileDescriptor,
  watchDesktopOwner,
} from "../src/desktop-owner.js";

const descriptor = desktopOwnerFileDescriptor();
if (descriptor === undefined)
  throw new Error("Desktop owner descriptor missing");
const keepAlive = setInterval(() => undefined, 60_000);
watchDesktopOwner(descriptor, () => {
  clearInterval(keepAlive);
  process.stdout.write("owner-lost\n");
});
process.stdout.write("ready\n");
