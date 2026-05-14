// ── OpencodeSupervisor ─────────────────────────────────────────────────────
//
// Lifecycle manager for the `opencode serve` HTTP daemon. Replaces the
// previous "spawn one `opencode run` subprocess per walkthrough job + stdio
// MCP server" model with a single long-lived daemon that Revv reuses across
// jobs. Per doctrine invariant #14 (agent-daemon lifecycle):
//
//   • Lazy-start: we only spin up `opencode serve` when the active agent is
//     'opencode' AND at least one job needs it (jobStarted() / jobEnded()
//     drive this). If the user is on Claude, the daemon never runs.
//   • Idle cooldown: after the last job ends, a 30s timer fires stopIfIdle()
//     to shed the process. If a new job arrives in the cooldown window the
//     timer cancels and the process stays up.
//   • Ephemeral credentials: OPENCODE_SERVER_PASSWORD is regenerated on every
//     start and lives only in this process's memory. The daemon binds to a
//     fresh OS-assigned port (--port 0) that we parse from its stdout. Never
//     persisted anywhere.
//   • Crash-loop cap: auto-restart up to 3 times inside a 60s window. After
//     that the service enters `unhealthy=true` and refuses to spawn again
//     until a successful manual `ensureRunning()` call (which resets the
//     counter).
//   • Settings-change stop: subscribes to SettingsService changes so moving
//     away from 'opencode' hard-stops the daemon (we observe the change by
//     polling settings on each jobStarted() — Settings doesn't yet expose a
//     change stream). The stop is a best-effort kill; credentials are wiped.
//
// All HTTP to opencode uses Bun's native fetch. Basic-auth password is sent
// on every request as `Authorization: Basic <base64(opencode:PASSWORD)>`.
// SSE event stream from `/event` is consumed via fetch + manual line
// buffering; see subscribeToEvents below.

import { resolve } from "node:path";
import { Context, Effect, Layer, Ref } from "effect";
import Opencode, { APIError } from "@opencode-ai/sdk";
import { debug, logError } from "../logger";
import { DbService } from "./Db";
import { SettingsService } from "./Settings";
import { withDb } from "../effects/with-db";
import { resolveCliBin } from "../ai/providers/cli-agent";
import { AiGenerationError, type AiError } from "../domain/errors";

// ── Public types ─────────────────────────────────────────────────────────────

export interface OpencodeEndpoint {
	readonly port: number;
	readonly hostname: string;
	readonly password: string;
}

export interface OpencodeMcpRegistration {
	readonly name: string;
	readonly directory?: string;
	readonly config: {
		readonly type: "remote";
		readonly url: string;
		readonly headers?: Record<string, string>;
	};
}

export interface OpencodeSessionCreate {
	readonly title?: string;
	readonly parentID?: string;
	readonly directory?: string;
}

export interface OpencodePostMessage {
	readonly sessionId: string;
	readonly model?: string;
	readonly agent?: string;
	readonly parts: unknown[];
	readonly tools?: unknown;
	readonly system?: string;
	readonly noReply?: boolean;
	readonly directory?: string;
	/**
	 * Abort signal threaded into the underlying fetch. Wired in by callers
	 * (the `withAgentTurn` harness) so a hard-timeout or external cancel
	 * tears down the HTTP call even if the daemon's `/abort` endpoint
	 * doesn't close the long-poll connection promptly.
	 */
	readonly signal?: AbortSignal;
}

export interface OpencodeSubscribe {
	readonly sessionId: string;
	readonly signal: AbortSignal;
	readonly onEvent: (ev: unknown) => void;
}

/**
 * Parsed response body from POST /session/:id/message. opencode 1.14.48+
 * returns the full agent turn synchronously — no SSE needed for content.
 */
export interface OpencodeMessageResponse {
	info: {
		/** AssistantMessage.id — used as the authoritative assistant message
		 * ID for filtering `response.parts` against user-message echoes. */
		id: string;
		sessionID: string;
		modelID?: string;
		finish?: string;
		tokens?: { total: number; input: number; output: number; reasoning: number };
		error?: unknown;
	};
	// `Part` per @opencode-ai/sdk types.gen.d.ts. The union covers
	// TextPart / ReasoningPart / ToolPart / StepStartPart / StepFinishPart /
	// FilePart / etc. — we type the shared fields permissively here and let
	// callers narrow with the `type` discriminator.
	parts: Array<{
		type: string;
		text?: string;
		tool?: string;
		state?: {
			input?: unknown;
			[key: string]: unknown;
		};
		synthetic?: boolean;
		ignored?: boolean;
		[key: string]: unknown;
	}>;
}

export interface RevvOpencodeClient {
	registerMcp(params: OpencodeMcpRegistration): Promise<void>;
	isMcpRegistered(name: string): boolean;
	markMcpRegistered(name: string): void;
	createSession(params: OpencodeSessionCreate): Promise<{ id: string }>;
	postMessage(params: OpencodePostMessage): Promise<OpencodeMessageResponse>;
	abortSession(sessionId: string): Promise<void>;
	/**
	 * Open an SSE subscription to /event filtered by sessionId. Resolves when
	 * the server closes the stream (or signal aborts); `onEvent` is called
	 * once per JSON-parsed event. Non-matching events are skipped.
	 */
	subscribeToEvents(opts: OpencodeSubscribe): Promise<void>;
	/**
	 * `GET /agent` — list available agents. Used at daemon-startup to cache
	 * which named agents (e.g. `plan`) are configured. Returns an empty
	 * array on failure (best-effort; the chat-opencode driver gracefully
	 * degrades when `plan` is unavailable).
	 */
	listAgents(directory?: string): Promise<readonly string[]>;
}

export type OpencodeError = AiError;

/** @deprecated Renamed to RevvOpencodeClient — kept for backward compat */
export type OpencodeHttpClient = RevvOpencodeClient;

// ── Service tag ──────────────────────────────────────────────────────────────

export class OpencodeSupervisor extends Context.Tag("OpencodeSupervisor")<
	OpencodeSupervisor,
	{
		/**
		 * Ensure the daemon is running and reachable. Lazy-starts on first
		 * call; subsequent calls return the same endpoint until the daemon
		 * stops. Crash-looping daemons return an error; call `stopNow()` +
		 * `ensureRunning()` to attempt a recovery.
		 */
		readonly ensureRunning: () => Effect.Effect<
			OpencodeEndpoint,
			OpencodeError
		>;
		/**
		 * Decrement job count and schedule a stop if idle (30s cooldown).
		 * Idempotent — safe to call even with no active job.
		 */
		readonly stopIfIdle: () => Effect.Effect<void>;
		/** Immediately kill the daemon. */
		readonly stopNow: () => Effect.Effect<void>;
		/** Current HTTP client. Null when daemon is not running. */
		readonly client: () => Effect.Effect<RevvOpencodeClient | null>;
		readonly isHealthy: () => Effect.Effect<boolean>;
		/** Signal a job has started — bumps refcount, cancels any idle timer. */
		readonly jobStarted: () => Effect.Effect<void>;
		/** Signal a job has ended — may schedule cooldown stop. */
		readonly jobEnded: () => Effect.Effect<void>;
		/**
		 * Register a handler that fires whenever a running daemon process
		 * exits — crash, idle stop, settings-change kill, all of them.
		 * Returns an unsubscribe function so callers can clean up
		 * registrations across hot reloads. Used by AiService to invalidate
		 * stored opencode session ids in `chat_sessions` (per invariant #14:
		 * daemon-bound state is ephemeral).
		 */
		readonly onDaemonExit: (handler: () => void) => () => void;
		/**
		 * List the agents available on the running daemon. Cached at startup
		 * via `GET /agent`; re-probed on each daemon restart since
		 * `.opencode/opencode.toml` overrides can change between sessions.
		 * Returns an empty array when no daemon is running.
		 */
		readonly listAgents: () => Effect.Effect<readonly string[]>;
		/**
		 * Cheap check whether an agent by `name` is available. Reads the
		 * cached agent list. Returns `false` when the daemon isn't running
		 * (the chat-opencode driver should ensureDaemon() first).
		 */
		readonly hasAgent: (name: string) => Effect.Effect<boolean>;
	}
>() {}

// ── Internal state ───────────────────────────────────────────────────────────

interface RunningState {
	readonly port: number;
	readonly hostname: string;
	readonly password: string;
	readonly proc: ReturnType<typeof Bun.spawn>;
	readonly client: RevvOpencodeClient;
}

interface SupervisorState {
	readonly running: RunningState | null;
	readonly activeJobCount: number;
	readonly idleTimer: ReturnType<typeof setTimeout> | null;
	readonly restartTimestamps: readonly number[];
	readonly unhealthy: boolean;
	readonly lastSelectedAgent: string | null;
	/**
	 * Names of agents the running daemon exposes via `GET /agent`. Probed
	 * once per daemon start; null while not yet probed (or no daemon).
	 */
	readonly agentNames: readonly string[] | null;
}

const INITIAL_STATE: SupervisorState = {
	running: null,
	activeJobCount: 0,
	idleTimer: null,
	restartTimestamps: [],
	unhealthy: false,
	lastSelectedAgent: null,
	agentNames: null,
};

const IDLE_COOLDOWN_MS = 30_000;
const CRASH_LOOP_WINDOW_MS = 60_000;
const CRASH_LOOP_MAX = 3;
const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_POLL_TIMEOUT_MS = 15_000;

function randomPassword(): string {
	// 32 bytes of cryptographically strong randomness, base64url-encoded.
	const buf = new Uint8Array(32);
	crypto.getRandomValues(buf);
	let binary = "";
	for (const b of buf) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function basicAuthHeader(password: string): string {
	return `Basic ${btoa(`opencode:${password}`)}`;
}

// ── HTTP client construction ─────────────────────────────────────────────────

function buildHttpClient(
	hostname: string,
	port: number,
	password: string,
): RevvOpencodeClient {
	const baseUrl = `http://${hostname}:${port}`;
	const authHeader = basicAuthHeader(password);
	// Tracks registered MCP servers — avoids redundant POST /mcp calls within a daemon instance.
	const registeredMcps = new Set<string>();

	// SDK client — handles sessions, messages, abort.
	// `timeout: false` is injected via fetchOptions to suppress Bun's 5-min idle
	// timeout. Basic Auth header matches the hand-rolled `rawRequest()` header.
	const sdkClient = new Opencode({
		baseURL: baseUrl,
		// Cast needed: MergedRequestInit excludes `body`/`headers`/`method`/`signal`
		// at the type level (they're overridden per-request), but we only set
		// `timeout` here which is a Bun-specific extension not in that exclusion.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		fetchOptions: { timeout: false } as any,
		defaultHeaders: {
			Authorization: authHeader,
		},
	});

	async function rawRequest(
		method: string,
		path: string,
		body?: unknown,
		extraHeaders?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<Response> {
		const headers: Record<string, string> = {
			Authorization: authHeader,
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
			...(extraHeaders ?? {}),
		};
		// `timeout: false` is a Bun-specific RequestInit extension. Bun's
		// fetch otherwise enforces a 5-minute idle timeout, which would kill
		// long-running `postMessage` calls (the agent loop can take 10+
		// minutes on complex PRs) and prematurely terminate the SSE event
		// subscription — leading to "no tool calls visible" and "timed out"
		// symptoms that don't reproduce against the opencode TUI (whose SDK
		// sets `req.timeout = false` internally). The 10-minute logical
		// timeout in `withAgentTurn` is the only timeout we want here.
		const init: RequestInit & { timeout?: boolean } = {
			method,
			headers,
			timeout: false,
			...(signal ? { signal } : {}),
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		};
		const res = await fetch(`${baseUrl}${path}`, init);
		return res;
	}

	return {
		isMcpRegistered(name) {
			return registeredMcps.has(name);
		},
		markMcpRegistered(name) {
			registeredMcps.add(name);
		},
		async registerMcp(params) {
			const cacheKey = `${params.name}::${params.directory ?? ""}`;
			if (registeredMcps.has(cacheKey)) return;
			// `mcp.add` per opencode 1.14.x OpenAPI: POST /mcp with body
			// { name, config }. Returns 200 with `{ [name]: MCPStatus }` whose
			// status is `connected`, `disabled`, `failed`, `needsAuth`, or
			// `needsClientRegistration`. Anything other than `connected` means
			// the daemon couldn't actually use the server — most commonly the
			// remote URL was unreachable or returned the wrong content type.
			//
			// We treat `failed` as a hard error here: the agent has no path to
			// our walkthrough/chat-context tools, and silently degrading would
			// leave the user staring at the keepalive's "waiting" rows with no
			// progress (the exact regression that motivated this check after
			// the route renamed from /mcp/register).
			//
			// opencode scopes MCP availability per project/directory. Pass the
			// worktree directory via `x-opencode-directory` so the MCP is
			// registered in the same project context the session will use.
			const extraHeaders = params.directory
				? { "x-opencode-directory": params.directory }
				: undefined;
			const res = await rawRequest(
				"POST",
				"/mcp",
				{ name: params.name, config: params.config },
				extraHeaders,
			);
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new Error(
					`opencode mcp register failed (${res.status}): ${text.slice(0, 400)}`,
				);
			}
			const contentType = res.headers.get("content-type") ?? "";
			if (!contentType.includes("application/json")) {
				// 200 + text/html means we hit the daemon's SPA fallback — the
				// route doesn't exist on this opencode version. Surface it
				// instead of letting registration silently no-op.
				const text = await res.text().catch(() => "");
				throw new Error(
					`opencode mcp register returned non-JSON (likely SPA fallback — route missing on this opencode version): ${text.slice(0, 200)}`,
				);
			}
			const status = (await res.json().catch(() => null)) as
				| Record<string, { status: string; error?: string }>
				| null;
			const entry = status?.[params.name];
			if (!entry) {
				throw new Error(
					`opencode mcp register returned no status for '${params.name}'`,
				);
			}
			if (entry.status !== "connected") {
				throw new Error(
					`opencode mcp register: '${params.name}' status=${entry.status}${
						entry.error ? ` — ${entry.error}` : ""
					}`,
				);
			}
			registeredMcps.add(cacheKey);
		},

		async createSession(params) {
			const { directory, ...body } = params;
			const extraHeaders = directory ? { "x-opencode-directory": directory } : undefined;
			const res = await rawRequest("POST", "/session", {
				...(body.title !== undefined ? { title: body.title } : {}),
				...(body.parentID !== undefined ? { parentID: body.parentID } : {}),
			}, extraHeaders);
			if (!res.ok) {
				const text = await res.text().catch(() => "");
				throw new Error(`opencode createSession failed (${res.status}): ${text.slice(0, 400)}`);
			}
			const json = (await res.json()) as { id?: string };
			if (!json.id) throw new Error("opencode createSession returned no id");
			return { id: json.id };
		},

		async postMessage(params) {
			const { sessionId, model, directory, signal, ...rest } = params;
			const wireModel = (() => {
				if (model === undefined) return undefined;
				const slash = model.indexOf("/");
				if (slash <= 0 || slash === model.length - 1) return undefined;
				return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
			})();
			const body = { ...rest, ...(wireModel !== undefined ? { model: wireModel } : {}) };
			const extraHeaders = directory ? { "x-opencode-directory": directory } : undefined;
			const res = await rawRequest("POST", `/session/${encodeURIComponent(sessionId)}/message`, body, extraHeaders, signal);
			const responseText = await res.text().catch(() => "");
			debug("opencode-supervisor", `postMessage response: status=${res.status} body=${responseText.slice(0, 500)}`);
			if (!res.ok) {
				throw new Error(`opencode postMessage failed (${res.status}): ${responseText.slice(0, 400)}`);
			}
			let parsed: OpencodeMessageResponse;
			try {
				parsed = JSON.parse(responseText) as OpencodeMessageResponse;
			} catch {
				return { info: { id: "", sessionID: sessionId }, parts: [] };
			}
			if (Array.isArray(parsed.parts)) {
				const typeHisto: Record<string, number> = {};
				const toolNames: string[] = [];
				for (const part of parsed.parts) {
					const t = String((part as { type?: unknown }).type ?? "?");
					typeHisto[t] = (typeHisto[t] ?? 0) + 1;
					if (t === "tool") {
						const toolName = (part as { tool?: unknown }).tool;
						if (typeof toolName === "string") toolNames.push(toolName);
					}
				}
				logError("opencode-supervisor", `postMessage parts summary: count=${parsed.parts.length} types=${JSON.stringify(typeHisto)} tools=${JSON.stringify(toolNames)}`);
			}
			const errObj = parsed.info?.error && typeof parsed.info.error === "object" ? (parsed.info.error as Record<string, unknown>) : null;
			if (errObj) {
				const data = errObj["data"] && typeof errObj["data"] === "object" ? (errObj["data"] as Record<string, unknown>) : null;
				const errMsg = (typeof data?.["message"] === "string" ? data["message"] : null) ?? (typeof errObj["name"] === "string" ? errObj["name"] : null) ?? "Unknown agent error";
				throw new Error(`opencode agent error: ${errMsg}`);
			}
			return parsed;
		},

		async abortSession(sessionId) {
			try {
				await sdkClient.session.abort(sessionId);
			} catch (err) {
				if (err instanceof APIError && err.status === 404) return;
				logError("opencode-supervisor", `abortSession failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		},

		async listAgents(directory) {
			const extraHeaders = directory
				? { "x-opencode-directory": directory }
				: undefined;
			try {
				const res = await rawRequest("GET", "/agent", undefined, extraHeaders);
				if (!res.ok) {
					debug(
						"opencode-supervisor",
						`listAgents non-ok ${res.status}`,
					);
					return [];
				}
				const body = (await res.json().catch(() => null)) as
					| Array<{ name?: unknown }>
					| null;
				if (!Array.isArray(body)) return [];
				const names: string[] = [];
				for (const entry of body) {
					if (entry && typeof entry === "object") {
						const name = (entry as { name?: unknown }).name;
						if (typeof name === "string" && name.length > 0) {
							names.push(name);
						}
					}
				}
				return names;
			} catch (err) {
				debug(
					"opencode-supervisor",
					"listAgents failed:",
					err instanceof Error ? err.message : String(err),
				);
				return [];
			}
		},

		async subscribeToEvents({ sessionId, signal, onEvent }) {
			// We subscribe to `/global/event`, NOT `/event`. The `/event`
			// endpoint sends a single `server.connected` event then terminates
			// the chunked response body — confirmed by raw TCP capture against
			// opencode 1.14.48. `/global/event` is the long-lived event stream
			// that emits every `message.part.updated`, `session.error`, etc.
			// across all sessions. We filter by sessionID client-side.
			//
			// Event envelope difference: `/global/event` wraps each event under
			// a `payload` field plus `directory` / `project` metadata:
			//   {directory, project, payload: {id, type, properties}}
			// Older shapes (and `/event`) put the event at the top level:
			//   {id, type, properties}
			// We unwrap `payload` here so the rest of the pipeline sees the
			// canonical `{type, properties}` shape regardless of which
			// endpoint we used.
			//
			// `timeout: false` is critical: Bun's default 5-minute idle
			// timeout would otherwise tear down the SSE connection mid-turn,
			// dropping `message.part.updated` events for any tool call
			// after the 5-minute mark. The opencode SDK does the same
			// (`req.timeout = false`).
			const sseInit: RequestInit & { timeout?: boolean } = {
				method: "GET",
				headers: {
					Authorization: authHeader,
					Accept: "text/event-stream",
				},
				signal,
				timeout: false,
			};
			const res = await fetch(`${baseUrl}/global/event`, sseInit);
			if (!res.ok) {
				throw new Error(
					`opencode /global/event subscribe failed (${res.status}): ${await res
						.text()
						.catch(() => "")}`,
				);
			}
			const body = res.body;
			if (!body) throw new Error("opencode /global/event returned empty body");
			const reader = body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let streamEndReason = "unknown";
			try {
				while (true) {
					if (signal.aborted) { streamEndReason = "aborted"; break; }
					const { done, value } = await reader.read();
					if (done) { streamEndReason = "stream-closed"; break; }
					buffer += decoder.decode(value, { stream: true });
					// SSE framing: events are separated by blank lines; each
					// event is one or more `<field>: <value>` lines. We only
					// care about `data:` lines; accumulate until blank-line.
					let sep = buffer.indexOf("\n\n");
					while (sep !== -1) {
						const frame = buffer.slice(0, sep);
						buffer = buffer.slice(sep + 2);
						const dataLines: string[] = [];
						for (const line of frame.split("\n")) {
							if (line.startsWith("data:")) {
								dataLines.push(line.slice(5).trimStart());
							}
						}
						if (dataLines.length > 0) {
							const payloadStr = dataLines.join("\n");
							try {
								const parsedRaw = JSON.parse(payloadStr);
								// Unwrap the `payload` field that `/global/event`
								// wraps events in. Fall back to the raw event for
								// any future shape that doesn't wrap.
								const parsed =
									parsedRaw &&
									typeof parsedRaw === "object" &&
									"payload" in parsedRaw &&
									typeof (parsedRaw as { payload?: unknown }).payload === "object"
										? (parsedRaw as { payload: unknown }).payload
										: parsedRaw;
								const sid = extractSessionId(parsed);
								const evType =
									parsed && typeof parsed === "object" && "type" in parsed
										? String((parsed as Record<string, unknown>)["type"])
										: "(unknown)";
								// Log ALL events before the session filter so mismatched
								// sessions and global events are visible in logs.
								debug(
									"opencode-supervisor",
									"sse event:",
									evType,
									"session:",
									sid ?? "(global)",
									sid !== null && sid !== sessionId ? "[filtered]" : "",
								);
								if (sid === null || sid === sessionId) {
									onEvent(parsed);
								}
							} catch {
								/* ignore non-JSON frames */
							}
						}
						sep = buffer.indexOf("\n\n");
					}
				}
				debug("opencode-supervisor", "sse stream ended:", streamEndReason);
			} finally {
				try {
					reader.releaseLock();
				} catch {
					/* ignore */
				}
			}
		},
	};
}

// Extracts the session ID from an event envelope. Opencode 1.14.x wraps event
// payloads under `properties` (e.g. `{type: "message.part.updated",
// properties: {part: {sessionID, ...}, delta}}`); older shapes used `data`.
// We probe both, and dig one level into `properties.part` for the
// `message.part.*` family.
function extractSessionId(ev: unknown): string | null {
	if (ev === null || typeof ev !== "object") return null;
	const obj = ev as Record<string, unknown>;
	const wrappers = ["properties", "data"];
	const candidates = ["sessionID", "sessionId", "session_id", "session"];
	for (const wrapper of wrappers) {
		const w = obj[wrapper];
		if (w && typeof w === "object") {
			const props = w as Record<string, unknown>;
			for (const key of candidates) {
				const v = props[key];
				if (typeof v === "string") return v;
			}
			// Nested `properties.part.sessionID` for message.part.* events.
			const part = props["part"];
			if (part && typeof part === "object") {
				const p = part as Record<string, unknown>;
				for (const key of candidates) {
					const v = p[key];
					if (typeof v === "string") return v;
				}
			}
		}
	}
	for (const key of candidates) {
		const v = obj[key];
		if (typeof v === "string") return v;
	}
	return null;
}

// ── Live implementation ──────────────────────────────────────────────────────

export const OpencodeSupervisorLive = Layer.effect(
	OpencodeSupervisor,
	Effect.gen(function* () {
		const { db } = yield* DbService;
		const settingsService = yield* SettingsService;
		const stateRef = yield* Ref.make<SupervisorState>(INITIAL_STATE);
		// Semaphore(1) serializes ensureRunning — prevents two concurrent fibers
		// from both seeing running=null and spawning duplicate daemons.
		const startLock = yield* Effect.makeSemaphore(1);

		// Lives outside Effect state — handlers are plain JS callbacks (no
		// effectful semantics) and we want to fire them synchronously inside
		// `proc.exited.then()` without round-tripping through Ref.
		const exitHandlers = new Set<() => void>();
		const fireExitHandlers = (): void => {
			for (const h of exitHandlers) {
				try {
					h();
				} catch (err) {
					logError(
						"opencode-supervisor",
						"daemon-exit handler threw:",
						err instanceof Error ? err.message : String(err),
					);
				}
			}
		};

		const resolveAgentName = (): Effect.Effect<string> =>
			withDb(db, settingsService.getSettings()).pipe(
				Effect.map((s) => s.aiAgent ?? "opencode"),
				Effect.catchAll(() => Effect.succeed("opencode")),
			);

		const clearIdleTimer = (): Effect.Effect<void> =>
			Ref.update(stateRef, (s) => {
				if (s.idleTimer !== null) {
					try {
						clearTimeout(s.idleTimer);
					} catch {
						/* ignore */
					}
				}
				return { ...s, idleTimer: null };
			});

		const killRunning = (running: RunningState): void => {
			try {
				running.proc.kill();
			} catch {
				/* already dead */
			}
		};

	const waitForHealth = async (
		hostname: string,
		port: number,
		password: string,
		timeoutMs: number = HEALTH_POLL_TIMEOUT_MS,
	): Promise<void> => {
		const deadline = Date.now() + timeoutMs;
		const authHeader = basicAuthHeader(password);
		while (Date.now() < deadline) {
			try {
				const res = await fetch(`http://${hostname}:${port}/`, {
					headers: { Authorization: authHeader },
				});
				if (res.ok || res.status === 404) {
					// 404 is fine — it just means there's no root route, but
					// the server is up and responding.
					return;
				}
			} catch {
				/* connection refused — daemon still starting */
			}
			await new Promise((r) => setTimeout(r, HEALTH_POLL_INTERVAL_MS));
		}
		throw new Error(
			`opencode serve did not become healthy within ${timeoutMs}ms`,
		);
	};

		const parsePortFromLog = (chunk: string): number | null => {
			// opencode logs its bound address when it starts. We match several
			// known formats. The latest opencode emits exactly:
			//   "opencode server listening on http://127.0.0.1:<port>"
			// which is matched by both pattern [2] and pattern [3] below.
			const patterns = [
				/listening on [^\s:]+:(\d+)/i,
				/listening on port (\d+)/i,
				/opencode server listening on .*:(\d+)/i, // matches latest format
				/http:\/\/[^\s:]+:(\d+)/i,               // also matches latest format
			];
			for (const p of patterns) {
				const m = p.exec(chunk);
				if (m && m[1]) {
					const n = Number.parseInt(m[1], 10);
					if (!Number.isNaN(n) && n > 0) return n;
				}
			}
			return null;
		};

		const spawnDaemon = async (): Promise<RunningState> => {
			const password = randomPassword();
			const hostname = "127.0.0.1";
			const bin = resolveCliBin("opencode");
			debug("opencode-supervisor", "spawning", bin, "serve");
		// Spawn with cwd set to the monorepo root so opencode's project
		// detection finds .git there instead of reporting "No .git found at
		// apps/server". import.meta.dir = apps/server/src/services → ../../../..
		const monorepoRoot = resolve(import.meta.dir, "../../../..");
		const proc = Bun.spawn([bin, "serve", "--port", "0", "--hostname", hostname], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			cwd: monorepoRoot,
			env: {
				...process.env,
				OPENCODE_SERVER_PASSWORD: password,
			},
		});

			// Parse the port out of stdout (opencode prints it at start). Also
			// tee stderr for debug logs so operators can see any daemon noise.
			const stdoutLines: string[] = [];
			const stderrLines: string[] = [];

			let resolvedPort: number | null = null;
			const portWaiters: Array<(p: number) => void> = [];

			const readStream = (
				stream: ReadableStream<Uint8Array>,
				sink: string[],
				tag: string,
				captureFn: (line: string) => void,
			): void => {
				void (async () => {
					const decoder = new TextDecoder();
					let buf = "";
					try {
						for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
							buf += decoder.decode(chunk, { stream: true });
							let nl = buf.indexOf("\n");
							while (nl !== -1) {
								const line = buf.slice(0, nl);
								buf = buf.slice(nl + 1);
								if (line.trim()) {
									sink.push(line);
									debug("opencode-supervisor", tag, line.trim().slice(0, 300));
									captureFn(line);
								}
								nl = buf.indexOf("\n");
							}
						}
						if (buf.trim()) {
							sink.push(buf);
							captureFn(buf);
						}
					} catch (err) {
						debug(
							"opencode-supervisor",
							`${tag} read error:`,
							err instanceof Error ? err.message : String(err),
						);
					}
				})();
			};

			readStream(proc.stdout as unknown as ReadableStream<Uint8Array>, stdoutLines, "stdout", (line) => {
				if (resolvedPort === null) {
					const p = parsePortFromLog(line);
					if (p !== null) {
						resolvedPort = p;
						for (const w of portWaiters) w(p);
						portWaiters.length = 0;
					}
				}
			});
			readStream(proc.stderr as unknown as ReadableStream<Uint8Array>, stderrLines, "stderr", (line) => {
				if (resolvedPort === null) {
					const p = parsePortFromLog(line);
					if (p !== null) {
						resolvedPort = p;
						for (const w of portWaiters) w(p);
						portWaiters.length = 0;
					}
				}
			});

			// Wait for the port to show up in the log stream. Abort on timeout
			// or if the process exits early.
			const portPromise = new Promise<number>((resolve, reject) => {
				const timeout = setTimeout(() => {
					reject(
						new Error(
							`opencode serve did not log its port within ${HEALTH_POLL_TIMEOUT_MS}ms`,
						),
					);
				}, HEALTH_POLL_TIMEOUT_MS);
				portWaiters.push((p) => {
					clearTimeout(timeout);
					resolve(p);
				});
				proc.exited.then((code) => {
					if (resolvedPort === null) {
						clearTimeout(timeout);
						const tail = [...stdoutLines, ...stderrLines].slice(-5).join("\n");
						reject(
							new Error(
								`opencode serve exited with code ${code} before logging its port. Last output:\n${tail}`,
							),
						);
					}
				});
			});

		const port = await portPromise;
		// Port appeared in the daemon's log output — the HTTP server is already
		// bound. Do a single quick health check (2s) as a sanity gate rather than
		// the full 15s polling loop.
		await waitForHealth(hostname, port, password, 5_000);

			const client = buildHttpClient(hostname, port, password);
			const running: RunningState = { hostname, port, password, proc, client };

			// Wire exit handler so we know when the daemon dies unexpectedly and
			// can update state (and consider auto-restart).
			void proc.exited.then((code) => {
				// Fire registered exit handlers eagerly — every daemon death
				// (crash, idle stop, explicit stop, settings change) leaves
				// any cached session ids referring to a process that's gone.
				// Consumers (AiService → ChatSessionService) invalidate stored
				// state here. Fires exactly once per spawn since proc.exited
				// resolves once. Outside the `s.running !== running` guard on
				// purpose: the guard exists to skip duplicate ref-clears when
				// `stopNow()`/`stopIfIdle()` already cleared state, but exit
				// handlers must still run in those paths.
				fireExitHandlers();
				void Effect.runPromise(
					Effect.gen(function* () {
						const s = yield* Ref.get(stateRef);
						if (s.running !== running) return; // already replaced
						debug(
							"opencode-supervisor",
							`daemon exited (code=${code}) — clearing running state`,
						);
						yield* Ref.update(stateRef, (st) => ({
							...st,
							running: null,
						}));
						if (s.activeJobCount > 0 && !s.unhealthy) {
							// Unexpected crash while work is in flight — record a
							// restart timestamp for crash-loop accounting. The next
							// ensureRunning() call performs the actual respawn.
							const now = Date.now();
							const recent = s.restartTimestamps.filter(
								(t) => now - t < CRASH_LOOP_WINDOW_MS,
							);
							const nextCount = recent.length + 1;
							const nextStamps = [...recent, now];
							const unhealthy = nextCount >= CRASH_LOOP_MAX;
							yield* Ref.update(stateRef, (st) => ({
								...st,
								restartTimestamps: nextStamps,
								unhealthy,
							}));
							if (unhealthy) {
								logError(
									"opencode-supervisor",
									`crash loop detected (${nextCount} restarts in <${CRASH_LOOP_WINDOW_MS}ms) — marking unhealthy`,
								);
							}
						}
					}),
				);
			});

			return running;
		};

		const ensureRunning = (): Effect.Effect<OpencodeEndpoint, OpencodeError> =>
			startLock.withPermits(1)(
			Effect.gen(function* () {
				// Cancel any pending idle stop — someone wants the daemon.
				yield* clearIdleTimer();

				const snapshot = yield* Ref.get(stateRef);

				// Detect agent-change and stop if we're no longer 'opencode'.
				const agent = yield* resolveAgentName();
				if (agent !== "opencode") {
					yield* stopNow();
					return yield* Effect.fail(
						new AiGenerationError({
							cause: new Error(`selected agent is '${agent}', not 'opencode'`),
							message: `OpencodeSupervisor.ensureRunning() called while selected agent is '${agent}'`,
						}),
					);
				}

				if (snapshot.unhealthy) {
					return yield* Effect.fail(
						new AiGenerationError({
							cause: new Error("opencode daemon marked unhealthy (crash loop)"),
							message:
								"opencode daemon is unhealthy after repeated crashes — inspect logs and restart Revv",
						}),
					);
				}

				if (snapshot.running) {
					return {
						port: snapshot.running.port,
						hostname: snapshot.running.hostname,
						password: snapshot.running.password,
					};
				}

				const running = yield* Effect.tryPromise({
					try: () => spawnDaemon(),
					catch: (err) => {
						debug(
							"opencode-supervisor",
							"spawn failed:",
							err instanceof Error ? err.message : String(err),
						);
						return new AiGenerationError({
							cause: err,
							message:
								err instanceof Error ? err.message : String(err),
						});
					},
				});

				yield* Ref.update(stateRef, (s) => ({
					...s,
					running,
					lastSelectedAgent: agent,
					// Successful start resets the crash-loop counter.
					restartTimestamps: [],
					unhealthy: false,
					// Reset cached agent list — probe again below.
					agentNames: null,
				}));

				// Probe available agents. Failures are best-effort: the
				// chat-opencode driver checks `hasAgent('plan')` before
				// requesting plan mode and degrades gracefully when missing.
				const names = yield* Effect.tryPromise({
					try: () => running.client.listAgents(),
					catch: (err) => {
						debug(
							"opencode-supervisor",
							"agent probe failed:",
							err instanceof Error ? err.message : String(err),
						);
						return new Error("agent probe failed");
					},
				}).pipe(Effect.orElseSucceed(() => [] as readonly string[]));
				yield* Ref.update(stateRef, (s) => ({ ...s, agentNames: names }));
				debug(
					"opencode-supervisor",
					`agent probe ok: ${names.join(", ")}`,
				);

				return {
					port: running.port,
					hostname: running.hostname,
					password: running.password,
				};
			}));

		const stopNow = (): Effect.Effect<void> =>
			Effect.gen(function* () {
				yield* clearIdleTimer();
				const s = yield* Ref.get(stateRef);
				if (s.running) {
					debug("opencode-supervisor", "stopNow — killing daemon");
					killRunning(s.running);
				}
				yield* Ref.update(stateRef, (st) => ({
					...st,
					running: null,
					activeJobCount: 0,
					agentNames: null,
				}));
			});

		const scheduleIdleStop = (): Effect.Effect<void> =>
			Effect.sync(() => {
				void Effect.runPromise(
					Effect.gen(function* () {
						const s = yield* Ref.get(stateRef);
						if (s.idleTimer !== null) return;
						const timer = setTimeout(() => {
							void Effect.runPromise(stopIfIdle());
						}, IDLE_COOLDOWN_MS);
						yield* Ref.update(stateRef, (st) => ({ ...st, idleTimer: timer }));
					}),
				);
			});

		const stopIfIdle = (): Effect.Effect<void> =>
			Effect.gen(function* () {
				const s = yield* Ref.get(stateRef);
				if (s.activeJobCount > 0) return;
				if (!s.running) {
					yield* clearIdleTimer();
					return;
				}
				debug("opencode-supervisor", "idle cooldown elapsed — stopping daemon");
				killRunning(s.running);
				yield* Ref.update(stateRef, (st) => ({
					...st,
					running: null,
					idleTimer: null,
					agentNames: null,
				}));
			});

		const client = (): Effect.Effect<RevvOpencodeClient | null> =>
			Effect.gen(function* () {
				const s = yield* Ref.get(stateRef);
				return s.running ? s.running.client : null;
			});

		const isHealthy = (): Effect.Effect<boolean> =>
			Effect.gen(function* () {
				const s = yield* Ref.get(stateRef);
				return s.running !== null && !s.unhealthy;
			});

		const jobStarted = (): Effect.Effect<void> =>
			Effect.gen(function* () {
				// Detect settings-change: if the selected agent moved away from
				// opencode while a running daemon exists, kill it.
				const agent = yield* resolveAgentName();
				const s0 = yield* Ref.get(stateRef);
				if (agent !== "opencode" && s0.running) {
					debug(
						"opencode-supervisor",
						`selected agent changed to '${agent}' — stopping daemon`,
					);
					yield* stopNow();
				}
				yield* clearIdleTimer();
				yield* Ref.update(stateRef, (s) => ({
					...s,
					activeJobCount: s.activeJobCount + 1,
					lastSelectedAgent: agent,
				}));
				// Pre-warm: kick off daemon spawn in the background so it's ready
				// by the time the job calls ensureRunning(). Fire-and-forget — if
				// spawn fails, ensureRunning() will surface the error when called.
			// Pre-warm: kick off daemon spawn in the background so it's ready
			// by the time the job calls ensureRunning(). Relies on ensureRunning's
			// own startPromise coalescing to safely handle concurrent calls.
			if (agent === "opencode") {
				void Effect.runPromise(
					ensureRunning().pipe(Effect.catchAll(() => Effect.void)),
				);
			}
			});

		const jobEnded = (): Effect.Effect<void> =>
			Effect.gen(function* () {
				yield* Ref.update(stateRef, (s) => ({
					...s,
					activeJobCount: Math.max(0, s.activeJobCount - 1),
				}));
				const s = yield* Ref.get(stateRef);
				if (s.activeJobCount === 0 && s.running) {
					yield* scheduleIdleStop();
				}
			});

		const onDaemonExit = (handler: () => void): (() => void) => {
			exitHandlers.add(handler);
			return () => {
				exitHandlers.delete(handler);
			};
		};

		const listAgents = (): Effect.Effect<readonly string[]> =>
			Effect.gen(function* () {
				const s = yield* Ref.get(stateRef);
				return s.agentNames ?? [];
			});

		const hasAgent = (name: string): Effect.Effect<boolean> =>
			Effect.gen(function* () {
				const s = yield* Ref.get(stateRef);
				const names = s.agentNames;
				if (!names) return false;
				return names.includes(name);
			});

		return {
			ensureRunning,
			stopIfIdle,
			stopNow,
			client,
			isHealthy,
			jobStarted,
			jobEnded,
			onDaemonExit,
			listAgents,
			hasAgent,
		};
	}),
);
