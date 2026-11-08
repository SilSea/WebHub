// Preloaded with `node --import` before dist/daemon.js (F-003 tests, review-3 M4 / J6).
// Once auth.json exists (daemon ready), throws what WEBHUB_TEST_CRASH asks for:
//   "twice" → two Errors with a secret message, "null" → `throw null`.
import { existsSync } from "node:fs";
import { join } from "node:path";

const home = process.env.WEBHUB_HOME ?? "";
const mode = process.env.WEBHUB_TEST_CRASH;
const timer = setInterval(() => {
  if (!existsSync(join(home, "data", "auth.json"))) return;
  clearInterval(timer);
  setTimeout(() => {
    if (mode === "null") throw null;
    setTimeout(() => {
      throw new Error("SECRET-MESSAGE twice");
    }, 10);
    throw new Error("SECRET-MESSAGE once");
  }, 300);
}, 50);
