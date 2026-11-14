// Test entry used as `daemonJs` by the F-004 CLI tests (instead of dist/daemon.js).
// Behaviour by env WEBHUB_TEST_ENTRY:
//   "hang-close" — the real daemon whose server close() hangs once ready (stop timeout / --force)
//   "never-ready" — writes its PID to logs/never-ready.pid and idles (start timeout → killed)
//   "fail-2"     — prints a daemon-style error on stderr and exits 2
//   "report"     — writes env / argv / cwd / execArgv to logs/report.json and exits 1
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mode = process.env.WEBHUB_TEST_ENTRY ?? "";
const home = process.env.WEBHUB_HOME ?? "";
const dist = new URL("../../dist/daemon.js", import.meta.url);

if (mode === "hang-close") {
  await import(pathToFileURL(join(import.meta.dirname, "hang-close-daemon.mjs")).href);
  const { main } = await import(dist.href);
  process.exitCode = await main(process.argv.slice(2));
} else if (mode === "never-ready") {
  writeFileSync(join(home, "logs", "never-ready.pid"), String(process.pid));
  process.stderr.write("webhub daemon: still loading\n");
  setInterval(() => {}, 1_000);
} else if (mode === "fail-2") {
  // exactly what daemon.ts describe() prints
  process.stderr.write("webhub daemon: config is broken\n  - detail one\n  hint: fix the config\n");
  process.exit(2);
} else if (mode === "report") {
  writeFileSync(
    join(home, "logs", "report.json"),
    JSON.stringify({
      nodeOptions: process.env.NODE_OPTIONS ?? null,
      nodeDebug: process.env.NODE_DEBUG ?? null,
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      execArgv: process.execArgv,
    }),
  );
  process.exit(1);
} else {
  process.exit(9);
}
