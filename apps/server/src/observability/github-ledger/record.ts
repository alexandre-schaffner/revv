import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { currentOrigin, type Origin } from "./origin";

export interface GitHubCall {
  readonly id: number;
  readonly start: number;
  ttfbMs: number | null;
  durationMs: number | null;
  readonly method: string;
  readonly host: string;
  readonly url: string;
  readonly op: string;
  readonly write: boolean;
  readonly key: string;
  readonly read: string;
  readonly paged: boolean;
  readonly account: string | null;
  readonly conditional: boolean;
  status: number | null;
  bytes: number | null;
  rate: {
    resource: string;
    remaining: number;
    used: number;
    limit: number;
    /** `x-ratelimit-reset`, epoch seconds: which hour's budget `used` counts. */
    reset: number;
  } | null;
  error: string | null;
  readonly origin: { label: string; kind: Origin["kind"] | "none"; runId: string };
  readonly inflight: number;
  readonly inflightBackground: number;
  readonly site: string | null;
}

export function isGitHubHost(hostname: string, enterpriseHosts: () => Iterable<string>): boolean {
  const h = hostname.toLowerCase();
  if (h === "github.com" || h.endsWith(".github.com")) return true;
  if (h.endsWith(".githubusercontent.com") || h.endsWith(".ghe.com")) return true;
  for (const host of enterpriseHosts()) {
    if (h === host || h.endsWith(`.${host}`)) return true;
  }
  return false;
}

const SHA = /^[0-9a-f]{40}$/i;
const NUMBER = /^\d+$/;

export function templateOf(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    const prev = out[out.length - 1];
    if (prev === "repos" && i + 1 < parts.length) {
      out.push("{owner}", "{repo}");
      i++;
    } else if (prev === "users" || prev === "orgs" || prev === "teams") {
      out.push("{login}");
    } else if (prev === "contents" || prev === "branches" || prev === "ref" || prev === "refs") {
      out.push(prev === "contents" ? "{path}" : "{ref}");
      break;
    } else if (prev === "compare") {
      out.push("{range}");
    } else if (prev === "commits" || prev === "statuses" || prev === "check-runs") {
      out.push(NUMBER.test(part) ? "{n}" : SHA.test(part) ? "{sha}" : "{ref}");
    } else if (NUMBER.test(part)) {
      out.push("{n}");
    } else if (SHA.test(part)) {
      out.push("{sha}");
    } else {
      out.push(part);
    }
  }
  return `/${out.join("/")}`;
}

const CURSOR_VARIABLE = /^(after|before|cursor|.+Cursor)$/;

interface GraphqlRequest {
  readonly name: string;
  readonly mutation: boolean;
  readonly readBody: string;
  readonly paged: boolean;
}

function parseGraphql(body: string): GraphqlRequest {
  try {
    const { query, variables } = JSON.parse(body) as {
      query?: unknown;
      variables?: Record<string, unknown> | null;
    };
    const m = typeof query === "string" ? query.match(/(query|mutation)\s+(\w+)/) : null;
    const path =
      typeof query === "string"
        ? [...query.replace(/\([^)]*\)/g, "").matchAll(/(\w+)\s*\{/g)]
            .map((f) => f[1])
            .filter((f) => f !== "query" && f !== "mutation")
            .slice(0, 2)
            .join(".")
        : "";
    const rest: Record<string, unknown> = {};
    let paged = false;
    for (const [k, v] of Object.entries(variables ?? {})) {
      if (CURSOR_VARIABLE.test(k)) paged ||= v !== null && v !== undefined;
      else rest[k] = v;
    }
    return {
      name: m?.[2] ?? `{${path || "anonymous"}}`,
      mutation: m?.[1] === "mutation",
      readBody: `${String(query)} ${JSON.stringify(rest)}`,
      paged,
    };
  } catch {
    return { name: "anonymous", mutation: false, readBody: body, paged: false };
  }
}

function bodyText(body: RequestInit["body"]): string {
  return typeof body === "string" ? body : "";
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    return headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] ?? null;
  }
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name.toLowerCase()) return v;
  }
  return null;
}

const shortHash = (s: string) => Bun.hash(s).toString(36);

const PLUMBING = /github-ledger|github-rest\.ts|node:|native|\(unknown\)|<anonymous>/;

function callSite(): string | null {
  const stack = new Error().stack?.split("\n").slice(2) ?? [];
  for (const frame of stack) {
    if (PLUMBING.test(frame)) continue;
    const m = frame.match(/(?:at\s+)?(?:(\S+)\s+\()?.*?\/src\/(.+?:\d+)/);
    if (m) return m[1] ? `${m[1]} ${m[2]}` : (m[2] ?? null);
  }
  return null;
}

const RING = 5000;
const ring: GitHubCall[] = [];
let ringStart = 0;
let nextId = 1;
let inflight = 0;
let inflightBackground = 0;
let sink: { path: string; maxBytes: number; written: number } | null = null;
let ledgerEnterpriseHosts: () => Iterable<string> = () => [];

function remember(call: GitHubCall): void {
  if (ring.length < RING) ring.push(call);
  else {
    ring[ringStart] = call;
    ringStart = (ringStart + 1) % RING;
  }
}

export function readCalls(): GitHubCall[] {
  return [...ring.slice(ringStart), ...ring.slice(0, ringStart)];
}

export function clearCalls(): void {
  ring.length = 0;
  ringStart = 0;
}

function persist(call: GitHubCall): void {
  if (!sink) return;
  try {
    if (sink.written > sink.maxBytes) {
      renameSync(sink.path, `${sink.path}.1`);
      sink.written = 0;
    }
    const line = `${JSON.stringify(call)}\n`;
    appendFileSync(sink.path, line);
    sink.written += line.length;
  } catch {}
}

async function observeBody(call: GitHubCall, res: Response, isGraphql: boolean): Promise<void> {
  if (!res.body) {
    call.bytes = 0;
    call.durationMs = Date.now() - call.start;
    return;
  }
  const buffer = await res.arrayBuffer();
  call.bytes = buffer.byteLength;
  call.durationMs = Date.now() - call.start;
  if (!isGraphql) return;
  const text = new TextDecoder().decode(buffer);
  if (text.includes('"errors"')) {
    try {
      const errors = (JSON.parse(text) as { errors?: { message?: string }[] }).errors;
      const message = errors?.[0]?.message;
      if (message) call.error = message.slice(0, 240);
    } catch {}
  }
}

type Fetch = typeof fetch;

export function installGitHubLedger(options: {
  readonly path?: string | null;
  /** Lowercase web hosts of the GitHub Enterprise servers to record, read on each non-GitHub.com request. */
  readonly enterpriseHosts: () => Iterable<string>;
}): void {
  ledgerEnterpriseHosts = options.enterpriseHosts;
  if (options.path) {
    mkdirSync(dirname(options.path), { recursive: true });
    sink = {
      path: options.path,
      maxBytes: 50 * 1024 * 1024,
      written: statSync(options.path, { throwIfNoEntry: false })?.size ?? 0,
    };
  }
  const current = globalThis.fetch as Fetch & { __githubLedger?: true };
  if (current.__githubLedger) return;
  const original = current;

  const ledgered = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    let url: URL;
    try {
      url = new URL(request ? request.url : String(input));
    } catch {
      return original(input, init);
    }
    if (!isGitHubHost(url.hostname, ledgerEnterpriseHosts)) return original(input, init);

    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const body = bodyText(init?.body);
    const isGraphql = url.pathname.endsWith("/graphql");
    const auth = headerOf(init, "authorization") ?? request?.headers.get("authorization") ?? null;
    const page = Number(url.searchParams.get("page") ?? "1");
    const firstPage = new URL(url);
    firstPage.searchParams.delete("page");
    const origin = currentOrigin();
    const gql = isGraphql ? parseGraphql(body) : null;
    const background = origin?.kind !== "request";
    const call: GitHubCall = {
      id: nextId++,
      start: Date.now(),
      ttfbMs: null,
      durationMs: null,
      method,
      host: url.hostname,
      url: url.pathname + url.search,
      op: gql ? `graphql ${gql.name}` : `${method} ${templateOf(url.pathname)}`,
      write: gql ? gql.mutation : method !== "GET" && method !== "HEAD",
      key: shortHash(`${method} ${url.href} ${body} ${auth ?? ""}`),
      read: gql
        ? shortHash(`${url.href} ${gql.readBody} ${auth ?? ""}`)
        : shortHash(`${method} ${firstPage.href} ${body} ${auth ?? ""}`),
      paged: gql ? gql.paged : page > 1,
      account: auth ? shortHash(auth) : null,
      conditional:
        headerOf(init, "if-none-match") !== null || headerOf(init, "if-modified-since") !== null,
      status: null,
      bytes: null,
      rate: null,
      error: null,
      origin: origin
        ? { label: origin.label, kind: origin.kind, runId: origin.runId }
        : { label: "unattributed", kind: "none", runId: "-" },
      inflight,
      inflightBackground,
      site: callSite(),
    };
    remember(call);
    inflight++;
    if (background) inflightBackground++;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      inflight--;
      if (background) inflightBackground--;
      persist(call);
    };

    try {
      const res = await original(input, init);
      call.ttfbMs = Date.now() - call.start;
      call.status = res.status;
      const resource = res.headers.get("x-ratelimit-resource");
      if (resource) {
        call.rate = {
          resource,
          remaining: Number(res.headers.get("x-ratelimit-remaining") ?? Number.NaN),
          used: Number(res.headers.get("x-ratelimit-used") ?? Number.NaN),
          limit: Number(res.headers.get("x-ratelimit-limit") ?? Number.NaN),
          reset: Number(res.headers.get("x-ratelimit-reset") ?? Number.NaN),
        };
      }
      if (res.status >= 400) call.error = `HTTP ${res.status}`;
      void observeBody(call, res.clone(), isGraphql).finally(settle);
      return res;
    } catch (e) {
      call.ttfbMs = Date.now() - call.start;
      call.error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      settle();
      throw e;
    }
  }) as Fetch & { __githubLedger?: true };
  ledgered.__githubLedger = true;
  globalThis.fetch = Object.assign(ledgered, { preconnect: original.preconnect });
}
