// ── stack headline ─────────────────────────────────────────────────────────
//
// One-shot, no-tools provider naming the feature a GitHub PR stack builds,
// for the homepage queue: a short headline ("Stacked-PR review") and a one-
// line gist. Same shape as `suggestions.ts`: a fresh ACP session with no MCP
// servers on the cheap suggestions model, one prompt, JSON back. It is a
// label over PR titles, not review content, so it never goes near the agent
// pipelines' MCP surface. Null on any failure; the caller falls back to a
// label derived from the titles.

import type { AcpAgentId, ThinkingEffort } from "@revv/shared";
import { debug, logError } from "../../logger";
import { getAcpConnection } from "../acp/acp-connection";
import { decodeAcpSessionUpdate, makeAcpDecodeState, withAgentTurn } from "../agent-stream";

const HEADLINE_TIMEOUT_MS = 30_000;
const MAX_HEADLINE_LENGTH = 48;
const MAX_GIST_LENGTH = 110;
const MAX_BODY_CHARS = 400;

export interface StackHeadlineInput {
  readonly base: string;
  /** Base first. */
  readonly layers: ReadonlyArray<{
    readonly number: number;
    readonly title: string;
    readonly body: string | null;
  }>;
  readonly acpAgentId: AcpAgentId;
  readonly cwd: string;
  readonly model: string;
  readonly thinkingEffort?: ThinkingEffort | undefined;
}

export interface GeneratedStackHeadline {
  readonly headline: string;
  readonly gist: string;
}

const SYSTEM_PROMPT = `A pull request stack is a chain of pull requests that \
together build one change, each layer on top of the one below. Name the change \
the whole stack delivers, for a reviewer skimming a queue of work.

Rules:
- "headline": the feature or change in 2 to 5 words, the way the team would \
name it out loud ("Stacked-PR review", "Billing retries", "SQLite migration \
runner"). Sentence case, no trailing period, no PR numbers, no "stack" unless \
it is the feature.
- "gist": one plain sentence of 16 words or fewer on what it adds or changes \
end to end, concrete, no praise, no hedging.
- Read every layer; the headline names the destination, not the first step.

Return JSON only, exactly this shape: {"headline": "…", "gist": "…"}`;

function buildUserMessage(input: StackHeadlineInput): string {
  const layers = input.layers.map((l, i) => {
    const body = (l.body ?? "").trim();
    const excerpt = body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}…` : body;
    return [`Layer ${i + 1} (#${l.number}): ${l.title}`, excerpt ? excerpt : null]
      .filter((s): s is string => s !== null)
      .join("\n");
  });
  return [`Stack onto \`${input.base}\`, base layer first:`, ...layers].join("\n\n");
}

function clean(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .trim()
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\.$/, "");
  if (text.length === 0) return null;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** The first JSON object in the model's text, fences and preamble tolerated. */
export function parseStackHeadline(raw: string): GeneratedStackHeadline | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as { headline?: unknown; gist?: unknown };
    const headline = clean(parsed.headline, MAX_HEADLINE_LENGTH);
    const gist = clean(parsed.gist, MAX_GIST_LENGTH);
    return headline && gist ? { headline, gist: `${gist}.` } : null;
  } catch {
    return null;
  }
}

async function generateViaAcp(input: StackHeadlineInput): Promise<GeneratedStackHeadline> {
  const h = await getAcpConnection(input.cwd, input.acpAgentId, {
    model: input.model,
    thinkingEffort: input.thinkingEffort,
  });

  let sessionId: string | null = null;
  let collected = "";
  try {
    await withAgentTurn<void>({
      hardTimeoutMs: HEADLINE_TIMEOUT_MS,
      jobStarted: async () => {
        h.jobStarted();
      },
      jobEnded: async () => {
        h.jobEnded();
      },
      debugLabel: "stack-headline-acp",
      abortSession: async () => {
        if (sessionId) await h.cancel(sessionId);
      },
      run: async () => {
        const created = await h.newSession([]);
        sessionId = created.sessionId;
        const decodeState = makeAcpDecodeState();
        h.setListener(sessionId, (update) => {
          for (const ev of decodeAcpSessionUpdate(update, decodeState)) {
            if (ev.kind === "text-delta") collected += ev.data;
          }
        });
        // ACP has no separate system-prompt channel.
        const promptText = `${SYSTEM_PROMPT}\n\n---\n\n${buildUserMessage(input)}`;
        await h.prompt(sessionId, [{ type: "text", text: promptText }]);
      },
    });
  } finally {
    if (sessionId) h.setListener(sessionId, null);
  }

  const parsed = parseStackHeadline(collected);
  if (!parsed) throw new Error(`unparseable output (len=${collected.length})`);
  return parsed;
}

export async function generateStackHeadline(
  input: StackHeadlineInput,
): Promise<GeneratedStackHeadline | null> {
  try {
    const result = await generateViaAcp(input);
    debug("stack-headline", `named a ${input.layers.length}-layer stack via ${input.model}`);
    return result;
  } catch (err) {
    logError("stack-headline", "falling back to titles:", err instanceof Error ? err.message : err);
    return null;
  }
}
