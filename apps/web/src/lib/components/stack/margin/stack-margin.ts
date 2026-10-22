import type { PrStackDetail, StackBrief, StackBriefLayer, StackLayer } from "@revv/shared";
import { layerOf, neighbourOf } from "$lib/stacks/locate";
import { RISK_LABEL, readableBrief } from "$lib/stacks/stack-layer-facts";
import { plural } from "$lib/utils/plural";

const ORDINALS = [
  "First",
  "Second",
  "Third",
  "Fourth",
  "Fifth",
  "Sixth",
  "Seventh",
  "Eighth",
  "Ninth",
  "Tenth",
  "Eleventh",
  "Twelfth",
  "Thirteenth",
  "Fourteenth",
  "Fifteenth",
  "Sixteenth",
  "Seventeenth",
  "Eighteenth",
  "Nineteenth",
  "Twentieth",
];

/** "Second of 18 layers", "Last of 3 layers", "Layer 23 of 30". */
export function placePhrase(position: number, total: number): string {
  if (position === total) return `Last of ${total} layers`;
  const word = ORDINALS[position - 1];
  return word ? `${word} of ${total} layers` : `Layer ${position} of ${total}`;
}

const CONVENTIONAL_RE = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*/i;

/** `feat(api)!: enforce workspace roles` → `Enforce workspace roles`. */
export function plainTitle(title: string): string {
  const stripped = String(title).replace(CONVENTIONAL_RE, "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/** `feat(api): …` → `api`; a title without a scope has none. */
export function conventionalScope(title: string): string | null {
  const scope = CONVENTIONAL_RE.exec(String(title))?.[2]?.trim();
  return scope ? scope : null;
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export type RichPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "layer"; readonly layer: StackLayer };

export function richText(text: string, layers: readonly StackLayer[]): RichPart[] {
  const byNumber = new Map(layers.map((l) => [l.number, l]));
  const parts: RichPart[] = [];
  for (const chunk of text.split(/(`[^`]+`)/)) {
    if (!chunk) continue;
    if (chunk.startsWith("`") && chunk.endsWith("`") && chunk.length > 1) {
      parts.push({ kind: "code", text: chunk.slice(1, -1) });
      continue;
    }
    let last = 0;
    for (const match of chunk.matchAll(/#(\d+)\b/g)) {
      const layer = byNumber.get(Number(match[1]));
      if (!layer) continue;
      if (match.index > last) parts.push({ kind: "text", text: chunk.slice(last, match.index) });
      parts.push({ kind: "layer", layer });
      last = match.index + match[0].length;
    }
    if (last < chunk.length) parts.push({ kind: "text", text: chunk.slice(last) });
  }
  return parts;
}

export interface StackChapter {
  /** The brief's chapter, else the shared conventional-commit scope; null for neither. */
  readonly name: string | null;
  readonly layers: readonly StackLayer[];
}

/**
 * The stack's chapters, base first. The brief's when it names one for every
 * layer; otherwise runs of the same conventional-commit scope (`feat(api)`).
 */
export function stackChapters(
  layers: readonly StackLayer[],
  brief: StackBrief | null,
): StackChapter[] {
  const fromBrief = new Map(brief?.layers.map((l) => [l.prNumber, l.chapter]));
  const useBrief = layers.length > 0 && layers.every((l) => fromBrief.get(l.number));
  const out: { name: string | null; layers: StackLayer[] }[] = [];
  for (const layer of layers) {
    const name = useBrief ? (fromBrief.get(layer.number) ?? null) : conventionalScope(layer.title);
    const last = out.at(-1);
    if (last && last.name === name) last.layers.push(layer);
    else out.push({ name, layers: [layer] });
  }
  return out;
}

export interface LayerLink {
  readonly layer: StackLayer;
  /** A noun phrase ("the explicit role model"); may carry `code` spans. */
  readonly uses: string;
}

export type BriefState = "none" | "failed" | "writing" | "stale" | "current";

export interface StackPlace {
  readonly prId: string;
  readonly stack: PrStackDetail;
  readonly here: StackLayer;
  readonly total: number;
  /** What the stack builds, from the brief or the cheap model; null when nameless. */
  readonly headline: string | null;
  /** The brief to read from, null when there is none worth reading. */
  readonly brief: StackBrief | null;
  readonly briefState: BriefState;
  readonly role: string | null;
  readonly buildsOn: readonly LayerLink[];
  /** Upper layers that stand on this one, nearest first. */
  readonly usedBy: readonly LayerLink[];
  readonly next: StackLayer | null;
  /** Base first. */
  readonly chapters: readonly StackChapter[];
}

function briefStateOf(brief: StackBrief | null): BriefState {
  if (!brief) return "none";
  if (brief.status === "error") return "failed";
  if (brief.status === "generating") return "writing";
  return brief.stale || brief.status === "superseded" ? "stale" : "current";
}

function briefLayer(brief: StackBrief | null, number: number): StackBriefLayer | null {
  return brief?.layers.find((l) => l.prNumber === number) ?? null;
}

/**
 * Where `prId` sits in `stack`, with what the page says about it. Null when
 * the PR isn't one of the stack's layers or the stack has a single layer.
 */
export function stackPlace(
  stack: PrStackDetail,
  prId: string,
  prNumber: number | null,
  headline: string | null,
): StackPlace | null {
  if (stack.layers.length < 2) return null;
  const here = layerOf(stack, prId, prNumber);
  if (!here) return null;
  const brief = readableBrief(stack.brief);
  const byNumber = new Map(stack.layers.map((l) => [l.number, l]));
  const link = (l: { number: number; uses: string }): LayerLink[] => {
    const layer = byNumber.get(l.number);
    return layer ? [{ layer, uses: l.uses.trim() }] : [];
  };
  const usedBy = brief
    ? stack.layers
        .filter((l) => l.position > here.position)
        .flatMap((l) => {
          const edge = briefLayer(brief, l.number)?.buildsOn.find((b) => b.number === here.number);
          return edge ? [{ layer: l, uses: edge.uses.trim() }] : [];
        })
    : [];
  return {
    prId,
    stack,
    here,
    total: stack.layers.length,
    headline: headline?.trim() || null,
    brief,
    briefState: briefStateOf(stack.brief),
    role: briefLayer(brief, here.number)?.role.trim() || null,
    buildsOn: (briefLayer(brief, here.number)?.buildsOn ?? []).flatMap(link),
    usedBy,
    next: neighbourOf(stack, here, "up"),
    chapters: stackChapters(stack.layers, brief),
  };
}

export interface ChangedAbove {
  /** Nearest first. */
  readonly layers: readonly StackLayer[];
  /** Shared paths, sorted. */
  readonly files: readonly string[];
}

export interface MarginNotes {
  /** Beside the issue card, by issue id. */
  readonly issues: ReadonlyMap<string, ChangedAbove>;
  /** Beside the chapter header, by semantic step index. */
  readonly chapters: ReadonlyMap<number, ChangedAbove>;
  readonly reliedOn: readonly LayerLink[];
}

function overlapsAbove(place: StackPlace): { layer: StackLayer; files: Set<string> }[] {
  const byNumber = new Map(place.stack.layers.map((l) => [l.number, l]));
  return place.stack.overlaps
    .filter((o) => o.position > place.here.position)
    .sort((a, b) => a.position - b.position)
    .flatMap((o) => {
      const layer = byNumber.get(o.number);
      return layer && o.files.length > 0 ? [{ layer, files: new Set(o.files) }] : [];
    });
}

function changedAbove(
  above: readonly { layer: StackLayer; files: Set<string> }[],
  files: readonly string[],
): ChangedAbove | null {
  const shared = new Set<string>();
  const layers: StackLayer[] = [];
  for (const o of above) {
    const hits = files.filter((f) => o.files.has(f));
    if (hits.length === 0) continue;
    layers.push(o.layer);
    for (const f of hits) shared.add(f);
  }
  return layers.length > 0 ? { layers, files: [...shared].sort() } : null;
}

/**
 * Where the margin speaks. Each shared file is noted once, at its first
 * spot on the page: an issue card about it, else the first chapter whose
 * blocks show it. `issues` and `chapters` come in page order.
 */
export function marginNotes(
  place: StackPlace,
  issues: readonly { readonly id: string; readonly filePath?: string | undefined }[],
  chapters: readonly { readonly index: number; readonly files: readonly string[] }[],
): MarginNotes {
  const above = overlapsAbove(place);
  const noted = new Set<string>();
  const issueNotes = new Map<string, ChangedAbove>();
  const chapterNotes = new Map<number, ChangedAbove>();
  if (above.length > 0) {
    for (const issue of issues) {
      if (!issue.filePath || noted.has(issue.filePath)) continue;
      const note = changedAbove(above, [issue.filePath]);
      if (!note) continue;
      issueNotes.set(issue.id, note);
      noted.add(issue.filePath);
    }
    for (const chapter of chapters) {
      const fresh = [...new Set(chapter.files)].filter((f) => !noted.has(f));
      const note = changedAbove(above, fresh);
      if (!note) continue;
      chapterNotes.set(chapter.index, note);
      for (const f of note.files) noted.add(f);
    }
  }
  return { issues: issueNotes, chapters: chapterNotes, reliedOn: place.usedBy };
}

export function layerHint(layer: StackLayer, here: StackLayer): string {
  if (layer.number === here.number) return "This layer";
  if (layer.status === "merged") return "Landed";
  if (layer.status === "closed") return "Closed";
  if (layer.restack.kind === "needs-rebase") return "Needs a rebase";
  const { review } = layer;
  if (review.kind === "generating") return "Reviewing";
  if (review.kind !== "complete") return "";
  const risk = review.riskLevel ? RISK_LABEL[review.riskLevel] : null;
  const issues = review.openIssues > 0 ? plural(review.openIssues, "issue") : null;
  return [risk, issues].filter(Boolean).join(" · ") || "Reviewed";
}
