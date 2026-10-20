// ── The GitHub call ledger ──────────────────────────────────────────────────
//
// One record per HTTP request Revv sends to GitHub, taken at `fetch` itself so
// no call site can slip past it: REST, GraphQL, OAuth, avatars, downloads.
// Records land in a ring buffer (what `/api/_debug/github` analyzes) and,
// when a path is configured, a JSONL file (what `bun run github:audit` reads
// after the fact). Dev-only by default; see `docs/github-ledger.md`.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { type Origin, originStore } from "./origin";

export interface GitHubCall {
  readonly id: number;
  /** Epoch ms. */
  readonly start: number;
  /** Until the response headers arrived. */
  ttfbMs: number | null;
  /** Until the body was fully read; null when nobody read it. */
  durationMs: number | null;
  readonly method: string;
  readonly host: string;
  /** Path and query, as sent. */
  readonly url: string;
  /** `GET /repos/{owner}/{repo}/pulls/{n}` or `graphql PrConversation`. */
  readonly op: string;
  /** A mutation: never a duplicate, never cacheable. */
  readonly write: boolean;
  /** Identical requests share it (method, URL, body, token). */
  readonly key: string;
  /** The pages of one read share it: `key` without `page=` or the GraphQL cursor. */
  readonly read: string;
  /** A page past the first: REST `page=` > 1, or a GraphQL cursor variable set. */
  readonly paged: boolean;
  /** Which token, hashed: two accounts asking the same thing aren't duplicates. */
  readonly account: string | null;
  /** Sent `If-None-Match` / `If-Modified-Since`. */
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
  /** Network failure, HTTP error, or GraphQL `errors[0]`. */
  error: string | null;
  readonly origin: { label: string; kind: Origin["kind"] | "none"; runId: string };
  /** GitHub requests already in flight when this one started. */
  readonly inflight: number;
  /** Of those, how many were background work. */
  readonly inflightBackground: number;
  /** The caller's frame outside the GitHub plumbing. */
  readonly site: string | null;
}

// ── Classifying a URL ───────────────────────────────────────────────────────

const extraHosts = new Set<string>();

/** Teach the ledger an Enterprise host (`api.<host>` and `<host>` both count). */
export function registerGitHubHost(host: string): void {
  extraHosts.add(host.toLowerCase());
}

export function isGitHubHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "github.com" || h.endsWith(".github.com")) return true;
  if (h.endsWith(".githubusercontent.com") || h.endsWith(".ghe.com")) return true;
  for (const extra of extraHosts) {
    if (h === extra || h.endsWith(`.${extra}`)) return true;
  }
  return false;
}

const SHA = /^[0-9a-f]{40}$/i;
const NUMBER = /^\d+$/;

/** A REST path with its identifiers folded, so one endpoint reads as one row. */
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
  /** The body with cursor variables dropped: what stays the same across pages. */
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
    // An unnamed query is named by where it reaches: `{repository.pullRequest}`.
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

// Frames from the plumbing every call goes through; the caller is below them.
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

// ── Storage ─────────────────────────────────────────────────────────────────

const RING = 5000;
const ring: GitHubCall[] = [];
let ringStart = 0;
let nextId = 1;
let inflight = 0;
let inflightBackground = 0;
let sink: { path: string; maxBytes: number; written: number } | null = null;

function remember(call: GitHubCall): void {
  if (ring.length < RING) ring.push(call);
  else {
    ring[ringStart] = call;
    ringStart = (ringStart + 1) % RING;
  }
}

/** Oldest first. */
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
    // One rotation keeps the file bounded without losing the last session.
    if (sink.written > sink.maxBytes) {
      renameSync(sink.path, `${sink.path}.1`);
      sink.written = 0;
    }
    const line = `${JSON.stringify(call)}\n`;
    appendFileSync(sink.path, line);
    sink.written += line.length;
  } catch {
    // The ledger must never cost a request.
  }
}

// ── The interceptor ─────────────────────────────────────────────────────────

/** Read the body on the side: how long the transfer took, its size, GraphQL errors. */
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

/**
 * Wrap `globalThis.fetch` so every GitHub request is recorded. Idempotent.
 * `path` adds the JSONL sink.
 */
export function installGitHubLedger(options: { path?: string | null } = {}): void {
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
    if (!isGitHubHost(url.hostname)) return original(input, init);

    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const body = bodyText(init?.body);
    const isGraphql = url.pathname.endsWith("/graphql");
    const auth = headerOf(init, "authorization") ?? request?.headers.get("authorization") ?? null;
    const page = Number(url.searchParams.get("page") ?? "1");
    const firstPage = new URL(url);
    firstPage.searchParams.delete("page");
    const origin = originStore.getStore();
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
