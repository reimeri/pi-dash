import pino from "pino";
import { createDaemon } from "../src/daemon.js";

const root = process.argv[2];
if (!root) throw new Error("Temporary root argument is required");

const daemon = await createDaemon({
  args: [
    "--data-dir",
    `${root}/data`,
    "--config-dir",
    `${root}/config`,
    "--runtime-dir",
    `${root}/runtime`,
    "--port",
    "4398",
  ],
  env: { NODE_ENV: "test" },
  logger: pino({ level: "silent" }),
});
process.stdout.write("locked\n");

const keepAlive = setInterval(() => undefined, 1_000);
const stop = async () => {
  clearInterval(keepAlive);
  await daemon.shutdown();
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
