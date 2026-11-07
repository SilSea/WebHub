/** Platform layer (DESIGN §21.1): everything OS-specific goes through this interface. */

export type PlatformErrorCode =
  | "PLATFORM_UNSUPPORTED"
  | "PLATFORM_TOOL"
  | "PORT_INVALID"
  | "PORT_EXHAUSTED"
  | "PROCESS_MISMATCH"
  | "PROCESS_KILL_FAILED"
  | "ELEVATION_INVALID"
  | "ELEVATION_DENIED"
  | "ELEVATION_FAILED";

/**
 * Errors of the platform layer. Kept separate from F-001's `WebhubError` codes so that the
 * done feature F-001 is not changed (R1); unifying them is a later CR. Same shape: code,
 * message, hint, details — never secret values.
 */
export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  readonly hint: string | undefined;
  readonly details: readonly string[];
  constructor(
    code: PlatformErrorCode,
    message: string,
    opts: { hint?: string; details?: readonly string[] } = {},
  ) {
    super(message);
    this.name = "PlatformError";
    this.code = code;
    this.hint = opts.hint;
    this.details = opts.details ?? [];
  }
}

export function isPlatformError(err: unknown, code?: PlatformErrorCode): err is PlatformError {
  return err instanceof PlatformError && (code === undefined || err.code === code);
}

export interface PortOwner {
  port: number;
  address: string;
  pid: number;
  family: 4 | 6;
}

export interface PortRange {
  start: number;
  end: number;
  /** Set by an administrator (`*` in netsh output). */
  administered: boolean;
}

export interface ProcInfo {
  pid: number;
  name: string;
  /** Undefined when the path cannot be read (other user / elevated process). */
  exe: string | undefined;
  startedAt: string;
  parentPid: number | undefined;
}

export interface Usage {
  cpuSeconds: number;
  workingSetBytes: number;
}

export interface Capabilities {
  resolvesLocalhostSubdomains: boolean;
  dockerTopology: "host-gateway" | "host-network";
}

export type BindHost = "127.0.0.1" | "0.0.0.0";

export interface Platform {
  readonly name: NodeJS.Platform;
  ports: {
    listening(): Promise<PortOwner[]>;
    reserved(): Promise<PortRange[]>;
    canBind(port: number, host?: BindHost): Promise<boolean>;
    findFree(range: readonly [number, number], avoid?: ReadonlySet<number>): Promise<number>;
  };
  process: {
    info(pid: number): Promise<ProcInfo | undefined>;
    /** Kills `pid` and its descendants, only if it is still the process that started at `expectStartedAt`. */
    killTree(pid: number, expectStartedAt: string): Promise<void>;
    usage(pids: readonly number[]): Promise<Map<number, Usage>>;
  };
  elevate(task: unknown): Promise<void>;
  /** Best effort: false when the notification could not be shown. Never throws. */
  notify(title: string, body: string): Promise<boolean>;
  capabilities(): Capabilities;
}
