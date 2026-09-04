// Visual identity for span triage categories. Calm, low-frequency dots — these
// are functional state markers (product register allows accent for state), not
// decoration, so they stay small.

interface CategoryMeta {
  label: string;
  color: string;
}

const META: Record<string, CategoryMeta> = {
  github: { label: "github", color: "var(--ink-2)" },
  agent: { label: "agent", color: "var(--violet)" },
  git: { label: "git", color: "var(--warning)" },
  sync: { label: "sync", color: "var(--accent)" },
  http: { label: "http", color: "var(--ink-muted)" },
  rum: { label: "rum", color: "var(--success)" },
  internal: { label: "internal", color: "var(--ink-muted)" },
};

export function categoryMeta(category: string): CategoryMeta {
  return META[category] ?? { label: category, color: "var(--ink-muted)" };
}
