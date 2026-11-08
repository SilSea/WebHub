// Preloaded with `node --import` before dist/daemon.js (F-003 tests, review-5 R4).
// Once auth.json exists (daemon ready): every server close() hangs (the listener never closes)
// and a ref'd timer holds the event loop — `main()` must still exit 1 after a stop.
import { existsSync } from "node:fs";
import { Server } from "node:net";
import { join } from "node:path";

const home = process.env.WEBHUB_HOME ?? "";
const timer = setInterval(() => {
  if (!existsSync(join(home, "data", "auth.json"))) return;
  clearInterval(timer);
  Server.prototype.close = function hang() {
    return this;
  };
  setInterval(() => {}, 1_000); // a handle a hung hook could hold
}, 50);
