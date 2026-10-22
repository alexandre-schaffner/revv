import type { AcpAgentId, ThinkingEffort } from "@revv/shared";
import { debug, logError } from "../../logger";
import { promptOnce } from "./prompt-once";

const HEADLINE_TIMEOUT_MS = 30_000;
const MAX_HEADLINE_LENGTH = 48;
const MAX_GIST_LENGTH = 110;
const MAX_BODY_CHARS = 400;

export interface StackHeadlineInput {
  readonly base: string;
  readonly layersBaseFirst: ReadonlyArray<{
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
  const layers = input.layersBaseFirst.map((l, i) => {
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
  const collected = await promptOnce({
    cwd: input.cwd,
    agent: input.acpAgentId,
    model: input.model,
    effort: input.thinkingEffort,
    timeoutMs: HEADLINE_TIMEOUT_MS,
    text: `${SYSTEM_PROMPT}\n\n---\n\n${buildUserMessage(input)}`,
    debugLabel: "stack-headline-acp",
  });
  const parsed = parseStackHeadline(collected);
  if (!parsed) throw new Error(`unparseable output (len=${collected.length})`);
  return parsed;
}

export async function generateStackHeadline(
  input: StackHeadlineInput,
): Promise<GeneratedStackHeadline | null> {
  try {
    const result = await generateViaAcp(input);
    debug(
      "stack-headline",
      `named a ${input.layersBaseFirst.length}-layer stack via ${input.model}`,
    );
    return result;
  } catch (err) {
    logError("stack-headline", "falling back to titles:", err instanceof Error ? err.message : err);
    return null;
  }
}
