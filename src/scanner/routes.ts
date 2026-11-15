/**
 * Scan as a background job (F-006 §3.5, Q4): `POST /api/v1/scan` starts one (one at a time),
 * `GET /api/v1/scan` gives progress + the last result, `DELETE /api/v1/scan` cancels. The
 * result is kept in `data/scan.json` (Q3). Closing the daemon aborts a running scan and waits
 * for it: nothing is written after the lock is released, and a cancelled scan writes nothing.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Paths } from "../config/home.js";
import { WebhubError } from "../errors.js";
import type { RouteRegistrar } from "../server/api.js";
import { readDoc, writeDoc } from "../store/json-store.js";
import type { Lock } from "../store/lock.js";
import { type ScanOptions, scan } from "./scan.js";
import { type ScanResult, scanSpec } from "./schema.js";

export const scanFile = (paths: Paths) => join(paths.data, "scan.json");

/** `p`, or a rejection as soon as `signal` aborts (cancel / close never wait on it). */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export interface ScanRouteOptions {
  /** Config at the time of the scan (it may change between scans). */
  config: () => Promise<Pick<ScanOptions, "scanRoots" | "maxDepth" | "ignore">>;
  scanOptions?: Omit<
    ScanOptions,
    "scanRoots" | "maxDepth" | "ignore" | "signal" | "onProgress" | "scanId"
  >;
}

interface Running {
  scanId: string;
  startedAt: string;
  folders: number;
  candidates: number;
  controller: AbortController;
  done: Promise<void>;
}

/** Error of the last scan: code + a fixed message (never paths or file content). */
interface LastError {
  scanId: string;
  code: string;
  message: string;
}

export function scanRoutes(paths: Paths, lock: Lock, opts: ScanRouteOptions): RouteRegistrar {
  let running: Running | undefined;
  let last: ScanResult | undefined;
  let lastLoaded = false;
  let lastError: LastError | undefined;
  let closing = false;

  const loadLast = async (): Promise<void> => {
    if (lastLoaded) return;
    lastLoaded = true;
    try {
      last = (await readDoc(scanFile(paths), scanSpec, { home: paths.home }))?.value;
    } catch {
      last = undefined; // a broken / newer file: shown as no result; the next scan replaces it
    }
  };

  const start = (): Running => {
    const controller = new AbortController();
    const job: Running = {
      scanId: randomBytes(8).toString("hex"),
      startedAt: new Date().toISOString(),
      folders: 0,
      candidates: 0,
      controller,
      done: Promise.resolve(),
    };
    job.done = (async () => {
      try {
        const result = await scan(paths, {
          ...opts.scanOptions,
          scanId: job.scanId,
          ...(await abortable(opts.config(), controller.signal)),
          signal: controller.signal,
          onProgress: (p) => {
            job.folders = p.folders;
            job.candidates = p.candidates;
          },
        });
        controller.signal.throwIfAborted();
        await writeDoc(lock, scanFile(paths), result, { keepBackup: false });
        last = result;
        lastLoaded = true;
        lastError = undefined;
      } catch (err) {
        if (controller.signal.aborted) return;
        lastError = {
          scanId: job.scanId,
          code: err instanceof WebhubError ? err.code : "SCAN_FAILED",
          message:
            err instanceof WebhubError && err.code === "FILE_TOO_LARGE"
              ? "the scan result is too large to save"
              : "the scan failed",
        };
      } finally {
        if (running === job) running = undefined;
      }
    })();
    return job;
  };

  return (app) => {
    app.addHook("onClose", async () => {
      closing = true;
      const job = running;
      job?.controller.abort();
      await job?.done;
    });

    app.post("/api/v1/scan", async (_req, reply) => {
      if (closing) {
        return reply
          .code(503)
          .send({ error: { code: "SHUTTING_DOWN", message: "the daemon is stopping" } });
      }
      if (running !== undefined) {
        return reply.code(409).send({
          error: { code: "SCAN_RUNNING", message: "a scan is already running" },
          scanId: running.scanId,
        });
      }
      running = start();
      return reply.code(202).send({ scanId: running.scanId });
    });

    app.get("/api/v1/scan", async () => {
      await loadLast();
      return {
        running:
          running === undefined
            ? null
            : {
                scanId: running.scanId,
                startedAt: running.startedAt,
                folders: running.folders,
                candidates: running.candidates,
              },
        last: last ?? null,
        lastError: lastError ?? null,
      };
    });

    app.delete("/api/v1/scan", async () => {
      const job = running;
      if (job === undefined) return { cancelled: false };
      job.controller.abort();
      await job.done;
      return { cancelled: true };
    });
  };
}
