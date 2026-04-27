// ── ChatMcpTokens ──────────────────────────────────────────────────────────
//
// In-memory bearer-token registry that lets the opencode chat agent reach
// the read-only chat MCP endpoint with PR-scoped authority.
//
//   Lifecycle: chat-opencode.ts mints a token via `issue(prId)` before
//   registering the MCP server with the daemon, sends the token in the
//   `Authorization: Bearer …` header on the registration, and revokes it via
//   `clear(token)` once the chat turn finishes.
//
// Mirrors the WalkthroughJobs.issueSessionToken / resolveSessionToken pattern
// (in-process, ephemeral — doctrine invariant #1: nothing here is durable).
// Tokens are crypto-random UUIDs; we do not hash them because the registry
// only lives in this process's memory.

import { Context, Effect, Layer, Ref } from "effect";

interface TokenEntry {
	readonly prId: string;
	readonly issuedAt: number;
}

export class ChatMcpTokens extends Context.Tag("ChatMcpTokens")<
	ChatMcpTokens,
	{
		/** Mint a fresh token bound to `prId`. Returns the bearer token. */
		readonly issue: (prId: string) => Effect.Effect<string>;
		/** Resolve a token back to its prId, or null if unknown / revoked. */
		readonly resolve: (token: string) => Effect.Effect<string | null>;
		/** Revoke a token (best-effort — silent if already gone). */
		readonly clear: (token: string) => Effect.Effect<void>;
	}
>() {}

export const ChatMcpTokensLive = Layer.effect(
	ChatMcpTokens,
	Effect.gen(function* () {
		const ref = yield* Ref.make(new Map<string, TokenEntry>());

		return {
			issue: (prId) =>
				Effect.gen(function* () {
					const token = crypto.randomUUID();
					yield* Ref.update(ref, (m) => {
						const next = new Map(m);
						next.set(token, { prId, issuedAt: Date.now() });
						return next;
					});
					return token;
				}),

			resolve: (token) =>
				Effect.gen(function* () {
					const m = yield* Ref.get(ref);
					return m.get(token)?.prId ?? null;
				}),

			clear: (token) =>
				Ref.update(ref, (m) => {
					if (!m.has(token)) return m;
					const next = new Map(m);
					next.delete(token);
					return next;
				}),
		};
	}),
);
