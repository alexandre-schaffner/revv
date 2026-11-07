// The risk tiers, single-sourced: the orchestrator's job-start judgment asks
// Jev to pick one with these criteria, and the agent's system prompt
// (`{{RISK_TIERS}}`) tells it what each tier commits it to. Changing a tier
// here changes both.

import { RISK_LEVELS, type RiskLevel } from "@revv/shared";

interface RiskTier {
  readonly title: string;
  /** How the judgment opens the tier's criterion. */
  readonly headline: string;
  readonly criteria: string;
  readonly notFor?: string;
  /** Phase B chapters, overview excluded. */
  readonly chapters: readonly [number, number];
  readonly issues: readonly [number, number | `${number}+`];
  /** The verdict mix, as the judgment reads it. */
  readonly verdicts: string;
  readonly exploration: string;
  /** What fills the chapters, after their count. */
  readonly body: string;
  /** The verdict mix, as the agent rates against it. */
  readonly ratings: string;
}

const RISK_TIERS: Readonly<Record<RiskLevel, RiskTier>> = {
  low: {
    title: "quick tour",
    headline: "A quick tour is enough.",
    criteria:
      "Small diffs (under roughly 150 changed lines), documentation, renames, whitespace, test-only additions, isolated dependency bumps with no behavior change.",
    chapters: [2, 3],
    issues: [0, 2],
    verdicts: "mostly passing verdicts",
    exploration: "skim changed files + one or two callers.",
    body: "Each chapter typically holds 2–3 atomic blocks. Short annotations.",
    ratings: "mostly `pass`, at most 1 `concern`, no `blocker`.",
  },
  medium: {
    title: "standard review",
    headline: "A standard review.",
    criteria:
      "Moderate diffs, new business logic, API additions, configuration changes, non-trivial refactors.",
    chapters: [4, 6],
    issues: [1, 5],
    verdicts: "a mix of pass and concern",
    exploration: "changed files + direct callers + relevant tests.",
    body: "Each chapter typically holds 3–5 atomic blocks balanced between narrative and evidence.",
    ratings: "mix of `pass` and `concern`; `blocker` rare.",
  },
  high: {
    title: "deep audit",
    headline: "A deep audit.",
    criteria:
      "Security-sensitive code, concurrency, database migrations, breaking API changes, payments, cross-service contracts.",
    notFor:
      "Sheer line count alone. A 2000-line generated lockfile or a formatter-only reflow is not high risk.",
    chapters: [7, 11],
    issues: [3, "10+"],
    verdicts: "multiple concerns and possibly a blocker",
    exploration:
      "changed files + callers + tests + adjacent modules + relevant config + rollback path.",
    body: "Dedicated chapters for threat model, test coverage, observability/rollback, API/migration contract. Each chapter typically holds 3–6 atomic blocks.",
    ratings: "multiple `concern` + possibly `blocker`.",
  },
};

function range([from, to]: readonly [number, number | string], dash: string): string {
  return `${from}${dash}${to}`;
}

/** The tiers as the job-start judgment's choice criteria. */
export function riskCriteria(): Record<
  RiskLevel,
  { readonly what: string; readonly not_for?: string; readonly expect: string }
> {
  return Object.fromEntries(
    RISK_LEVELS.map((level) => {
      const tier = RISK_TIERS[level];
      return [
        level,
        {
          what: `${tier.headline} ${tier.criteria}`,
          ...(tier.notFor ? { not_for: tier.notFor } : {}),
          expect: `${range(tier.issues, "-")} issues, ${range(tier.chapters, "-")} chapters, ${tier.verdicts}.`,
        },
      ];
    }),
  ) as Record<
    RiskLevel,
    { readonly what: string; readonly not_for?: string; readonly expect: string }
  >;
}

/** The tiers as the agent's system prompt states them. */
export function renderRiskTiers(): string {
  return RISK_LEVELS.map((level) => {
    const tier = RISK_TIERS[level];
    const chapters = range(tier.chapters, "–");
    const issues = range(tier.issues, "–");
    return [
      `### ${level} — ${tier.title} (${chapters} Phase B chapters, ${issues} issues expected)`,
      "",
      `**Criteria**: ${tier.criteria}`,
      ...(tier.notFor ? [`**Not for**: ${tier.notFor}`] : []),
      `**Exploration**: ${tier.exploration}`,
      `**Body**: ${chapters} Phase B semantic steps. ${tier.body}`,
      `**Issues**: ${issues} typical.`,
      `**Ratings**: ${tier.ratings}`,
    ].join("\n");
  }).join("\n\n");
}
