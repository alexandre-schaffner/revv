// The theme variables the artifact host injects into a walkthrough artifact,
// and the only ones the agent is told to style with. One list, so renaming a
// token can't leave artifacts styled with a variable the host stops injecting.

export const ARTIFACT_THEME_TOKEN_GROUPS = [
  {
    label: "Surfaces",
    tokens: [
      "--color-bg-primary",
      "--color-bg-secondary",
      "--color-bg-tertiary",
      "--color-bg-elevated",
    ],
  },
  { label: "Lines", tokens: ["--color-border", "--color-border-subtle"] },
  {
    label: "Text",
    tokens: ["--color-text-primary", "--color-text-secondary", "--color-text-muted"],
  },
  {
    label: "Accent (the one accent)",
    tokens: ["--color-accent", "--color-accent-hover", "--color-accent-muted"],
  },
  { label: "Status", tokens: ["--color-success", "--color-warning", "--color-danger"] },
  { label: "Type", tokens: ["--font-sans", "--font-mono"] },
  {
    label: "Geometry",
    tokens: [
      "--radius-card",
      "--radius-island",
      "--spacing-island-half",
      "--spacing-island",
      "--spacing-inset",
      "--spacing-island-2x",
    ],
  },
] as const;

export const ARTIFACT_THEME_TOKENS: readonly string[] = ARTIFACT_THEME_TOKEN_GROUPS.flatMap(
  (group) => group.tokens,
);
