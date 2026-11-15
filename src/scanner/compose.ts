/**
 * Compose files of a project, read as data (F-006 §3.3 step 5, Q6). Same safe YAML settings
 * as F-005 profiles, except that compose files commonly use anchors / merge keys (`<<: *x`):
 * those are allowed, at most MAX_ALIASES aliases and MAX_NODES nodes, so an alias bomb cannot
 * expand. Never runs `docker compose config`. Keeps names, images, ports and the shape of
 * volumes only — never environment values (they may be secrets).
 */
import { isAlias, isMap, isPair, isScalar, parseDocument, visit } from "yaml";

export const COMPOSE_FILES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
  "compose.override.yaml",
  "compose.override.yml",
  "docker-compose.override.yaml",
  "docker-compose.override.yml",
] as const;

export const MAX_ALIASES = 100;
const PWD = ["$", "{PWD}"].join("");
export const MAX_NODES = 20_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Images that are infrastructure (DB, cache, queue, mail, tools), not the app. */
const INFRA_IMAGE =
  /^(?:[a-z0-9.-]+(?::\d+)?\/)?(?:[a-z0-9._-]+\/)?(postgres|postgis|mysql|mariadb|mongo|redis|valkey|memcached|rabbitmq|elasticsearch|opensearch|minio|mailpit|mailhog|adminer|pgadmin4?|phpmyadmin|redis-commander|redisinsight|kafka|zookeeper|nats|clickhouse(?:-server)?|cockroach|neo4j|cassandra|influxdb|localstack|keycloak|mssql-server|dpage\/pgadmin4)(?:[:@].*)?$/;

export interface ComposeService {
  name: string;
  build: boolean;
  image?: string;
  infra: boolean;
  mountsSource: boolean;
  /** Container ports the service publishes: `{ target, published?, text }`. */
  ports: { target: number; published?: number; text: string }[];
}

export interface ComposeSummary {
  services: ComposeService[];
}

export class ComposeError extends Error {}

const portNum = (s: string): number | undefined => {
  if (!/^\d{1,5}$/.test(s)) return undefined;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : undefined;
};

/** `${VAR:-3000}` / `${VAR-3000}` → 3000; plain numbers as they are. */
const resolveVar = (s: string): string =>
  s.replace(/\$\{[A-Za-z_][A-Za-z0-9_]{0,63}:?-([0-9]{1,5})\}/g, "$1");

function parsePort(v: unknown): ComposeService["ports"][number] | undefined {
  if (typeof v === "number") {
    const t = portNum(String(v));
    return t === undefined ? undefined : { target: t, text: String(t) };
  }
  if (typeof v === "string") {
    const clean = resolveVar(v.slice(0, 100)).replace(/\/(tcp|udp)$/, "");
    // [ip:]published:target  |  target ; ranges are skipped
    const parts = clean.startsWith("[")
      ? clean.slice(clean.indexOf("]") + 2).split(":")
      : clean.split(":");
    const target = portNum(parts[parts.length - 1] ?? "");
    if (target === undefined) return undefined;
    const published = parts.length >= 2 ? portNum(parts[parts.length - 2] ?? "") : undefined;
    // text rebuilt from the numbers: the raw string may hold env defaults or control
    // characters (security-1 S5)
    const text = published === undefined ? String(target) : `${published}:${target}`;
    return { target, ...(published === undefined ? {} : { published }), text };
  }
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const target = portNum(resolveVar(String(o.target ?? "")));
    if (target === undefined) return undefined;
    const published = portNum(resolveVar(String(o.published ?? "")));
    return {
      target,
      ...(published === undefined ? {} : { published }),
      text: published === undefined ? String(target) : `${published}:${target}`,
    };
  }
  return undefined;
}

/** A bind mount of the project itself (`.:/app`, `./src:/app/src`, `${PWD}:/app`). */
function mountsSource(volumes: unknown): boolean {
  if (!Array.isArray(volumes)) return false;
  return volumes.some((v) => {
    const src =
      typeof v === "string"
        ? v.split(":")[0]
        : typeof v === "object" && v !== null && (v as { type?: unknown }).type === "bind"
          ? String((v as { source?: unknown }).source ?? "")
          : undefined;
    return (
      typeof src === "string" &&
      (src === "." || src.startsWith("./") || src.startsWith(".\\") || src.startsWith(PWD))
    );
  });
}

/** Summary of one compose file; throws ComposeError (code + line only, never content). */
export function parseCompose(text: string): ComposeSummary {
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(text, {
      schema: "core",
      merge: true,
      uniqueKeys: false,
      strict: false,
      prettyErrors: false,
      version: "1.2",
    });
  } catch {
    throw new ComposeError("not valid YAML");
  }
  if (doc.errors.length > 0) {
    const e = doc.errors[0];
    throw new ComposeError(`not valid YAML (${e?.code ?? "error"})`);
  }
  let nodes = 0;
  let aliases = 0;
  let bad: string | undefined;
  visit(doc, {
    Node(_k, node) {
      if (++nodes > MAX_NODES) {
        bad = `more than ${MAX_NODES} YAML nodes`;
        return visit.BREAK;
      }
      if (isAlias(node) && ++aliases > MAX_ALIASES) {
        bad = `more than ${MAX_ALIASES} aliases`;
        return visit.BREAK;
      }
      if (isMap(node)) {
        for (const pair of node.items) {
          if (isPair(pair) && isScalar(pair.key) && FORBIDDEN_KEYS.has(String(pair.key.value))) {
            bad = "forbidden key";
            return visit.BREAK;
          }
        }
      }
    },
  });
  if (bad !== undefined) throw new ComposeError(bad);
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: MAX_ALIASES });
  } catch {
    throw new ComposeError("aliases expand too much");
  }
  const services: ComposeService[] = [];
  const table =
    typeof raw === "object" && raw !== null ? (raw as { services?: unknown }).services : undefined;
  if (typeof table !== "object" || table === null || Array.isArray(table)) return { services };
  for (const [name, def] of Object.entries(table).slice(0, 200)) {
    if (
      typeof def !== "object" ||
      def === null ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(name)
    ) {
      continue;
    }
    const d = def as Record<string, unknown>;
    const image =
      typeof d.image === "string" && /^[\x21-\x7e]{1,200}$/.test(d.image) ? d.image : undefined;
    const build = d.build !== undefined && d.build !== null;
    services.push({
      name,
      build,
      ...(image === undefined ? {} : { image }),
      infra: !build && image !== undefined && INFRA_IMAGE.test(image.toLowerCase()),
      mountsSource: mountsSource(d.volumes),
      ports: (Array.isArray(d.ports) ? d.ports.slice(0, 50) : [])
        .map(parsePort)
        .filter((p): p is ComposeService["ports"][number] => p !== undefined),
    });
  }
  return { services };
}

/**
 * Runner from the compose services (DESIGN §9): an app built from source and not mounted →
 * `compose`; app mounted from source, or infra only → `hybrid`.
 */
export function composeRunner(all: readonly ComposeService[]): "compose" | "hybrid" | undefined {
  if (all.length === 0) return undefined;
  const apps = all.filter((s) => !s.infra);
  if (apps.length === 0) return "hybrid";
  return apps.some((s) => s.mountsSource) ? "hybrid" : "compose";
}
