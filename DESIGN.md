---
name: Revv
description: A desktop watchtower and review surface for GitHub repositories.
colors:
  # Brand accent (the one distinctive move)
  deep-naval: "oklch(46% 0.11 225)"
  deep-naval-hover: "oklch(40% 0.1 225)"
  deep-naval-muted: "oklch(58% 0.09 225)"
  # Dark accent (lifted for midnight canvas)
  phosphor-naval: "oklch(71% 0.14 225)"
  phosphor-naval-hover: "oklch(65% 0.14 225)"
  phosphor-naval-muted: "oklch(80% 0.11 225)"

  # Warm-paper surface stack (light theme)
  warm-paper: "#faf9f6"
  warm-stone: "#f4f1eb"
  warm-ash: "#eae6de"
  warm-paper-edge: "#e4e0d8"
  warm-paper-edge-subtle: "#ece8e0"

  # Ink (text)
  ink-primary: "#2a2825"
  ink-secondary: "#5a5650"
  ink-muted: "#9a958c"

  # AI accent
  considered-violet: "#6d28d9"

  # Severity (deepened from stock Tailwind)
  workshop-amber: "#b45309"
  considered-green: "#15803d"
  considered-red: "#b91c1c"
  demands-attention: "#c2410c"

  # Dark theme surface stack (kept for parity)
  midnight-paper: "#0a0a0a"
  midnight-stone: "#111111"
  midnight-ash: "#1a1a1a"
  midnight-elevated: "#222222"
  midnight-edge: "#262626"
  midnight-ink-primary: "#e4e4e7"
  midnight-ink-secondary: "#a1a1aa"
  midnight-ink-muted: "#52525b"
  midnight-accent: "oklch(71% 0.14 225)"

typography:
  editorial-display:
    fontFamily: "Newsreader, Georgia, serif"
    fontSize: "2.75rem"
    fontWeight: 500
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  display:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.01em"
  headline:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.3
  title:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Inter, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: "0.01em"
  mono:
    fontFamily: "JetBrains Mono, Fira Code, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.5

rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"

spacing:
  island-half: "4px"
  island: "8px"
  inset: "12px"
  island-2x: "16px"

components:
  button-primary:
    backgroundColor: "{colors.deep-naval}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.deep-naval-hover}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
  button-outline:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  button-outline-hover:
    backgroundColor: "{colors.warm-stone}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-secondary}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  button-ghost-hover:
    backgroundColor: "{colors.warm-stone}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
  button-destructive:
    backgroundColor: "rgba(185, 28, 28, 0.10)"
    textColor: "{colors.considered-red}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "32px"
  input-default:
    backgroundColor: "{colors.warm-stone}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "32px"
  card-warm:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    padding: "16px"
  tab-active:
    backgroundColor: "{colors.warm-paper}"
    textColor: "{colors.ink-primary}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "28px"
  tab-inactive:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.md}"
    padding: "4px 12px"
    height: "28px"
---

# Design System: Revv

## 1. Overview

**Creative North Star: "The Reading Room"**

Revv is the reading room of code review: warm paper underfoot, considered ink, expert
silence, and exactly one accent worth lifting your eyes for. The canvas reads as a page,
not a screen. Reviewers come here to think, not to be sold to or coached. Chrome
recedes; code and conversation are the foreground.

The system rejects the noisy SaaS dashboard, the GitHub web UI's marketing chrome, and
the neon-on-black AI-tool aesthetic in equal measure. Where other code-review tools
ship stock Tailwind blue, Revv ships Deep Naval at low frequency. Where others stack
shadows for "depth," Revv layers warm tones and reserves shadows for things that
genuinely float. Where others make AI feel magical with sparkles and gradients, Revv
makes it feel collaborative with a single streaming character: the cursor.

**Key Characteristics:**

- Warm-paper background, never neutral gray, never `#fff`.
- One brand accent (Deep Naval `oklch(46% 0.11 225)`), used on ≤10% of any given screen.
- Hybrid elevation: tonal layering for chrome, soft shadows only for floating UI.
- Refined and restrained components: quiet at rest, precise on interaction.
- Icons-only iconography (`phosphor-svelte`); emoji prohibited.
- Reduced-motion is a contract, not a courtesy.

## 2. Colors: The Warm-Paper Palette

A warm-paper neutral stack tinted ~36° (paper, not gray) with one restrained accent
that does all the brand work. Severity colors are deepened a notch from stock Tailwind
so reds and greens read as considered, not alarming.

### Primary

- **Deep Naval** (`oklch(46% 0.11 225)`): the brand's one distinctive move. Used for the
  streaming AI cursor, active states in the file tree, marker dots on open threads,
  primary CTA fills, focus rings. Restricted to ≤10% of any given screen. Hover and
  active deepen to `oklch(40% 0.1 225)`. A muted variant (`oklch(58% 0.09 225)`) is
  reserved for archival states.

### Neutral (warm-paper stack, light theme)

- **Warm Paper** (`#faf9f6`): the canvas. Backgrounds, card faces, the visible page.
- **Warm Stone** (`#f4f1eb`): sidebars, panels, inputs, the diff canvas. The first
  layer up from the canvas.
- **Warm Ash** (`#eae6de`): tracks, hover states, separators between regions.
- **Paper Edge** (`#e4e0d8`): hairline borders. Subtle variant (`#ece8e0`) for
  inside-panel dividers.

### Ink (text)

- **Ink Primary** (`#2a2825`): all body text and headings on warm-paper backgrounds.
  Never `#000`.
- **Ink Secondary** (`#5a5650`): metadata, captions, secondary labels.
- **Ink Muted** (`#9a958c`): placeholder text, disabled labels, inactive tab text.

### AI Accent

- **Considered Violet** (`#6d28d9`): the AI accent. Used sparingly for AI-authored
  surfaces (walkthroughs, recap headers). Deliberately deeper than the lavender that
  ships with every AI tool. Not a brand color: a *role* color for AI presence.

### Severity

- **Considered Green** (`#15803d`): success states, pass scorecards, additions text.
- **Workshop Amber** (`#b45309`): pending state, concern scorecards, in-progress.
- **Considered Red** (`#b91c1c`): danger, destructive actions, blocker scorecards,
  deletions text.
- **Demands Attention** (`#c2410c`): the "your turn" marker on PR threads waiting on
  the user. Warm orange-700; deliberately warmer than the warning amber so the eye
  separates the two.

### Dark Theme

A parallel system on a near-black canvas (`#0a0a0a`) with stone-stack analogues
(`#111`, `#1a1a1a`, `#222`) and a brand-consistent accent: **Phosphor Naval**
(`oklch(71% 0.14 225)`). The dark theme keeps the deep-naval lineage and lifts it into
a luminous value that reads against `#0a0a0a` without becoming the stock-Tailwind blue
every other code review tool ships. Hover deepens to `oklch(65% 0.14 225)`; the muted
variant brightens to `oklch(80% 0.11 225)` for icons. Severity, AI accent, and the
neutral philosophy all carry over from light theme.

### Named Rules

**The One Voice Rule.** The brand accent (Deep Naval in light, Phosphor Naval in dark)
is used on ≤10% of any given screen. Its rarity is the point. If three olive elements
are competing on one surface, two are wrong.

**The No-Pure-Black Rule.** `#000` is prohibited in light theme, and the dark theme
canvas stops at `#0a0a0a`. Every neutral is tinted toward warm-paper or midnight-paper;
no element ever sits on pure black or pure white.

**The Deepened Severity Rule.** Reds, greens, ambers in this system are one step deeper
than the Tailwind defaults (red-700, green-700, amber-700 rather than 500). The intent
is "considered" rather than "alarming." Stock-bright severity reads as a prototype.

## 3. Typography

**Body + UI Font:** Inter (with `system-ui, sans-serif` fallback)
**Mono Font:** JetBrains Mono (with `Fira Code, monospace` fallback)
**Editorial Display Font:** Newsreader (with `Georgia, serif` fallback). Scoped — see
the Editorial-Display Carve-out below.

**Character:** A single warm humanist sans for the whole interface, paired with a clean
geometric mono for code and identifiers, and one editorial display serif reserved for
AI-authored long-form moments. Inter is used at restrained weights (400, 500, 600) and
modest sizes. The hierarchy is built from scale and weight contrast, not from six
display families competing for attention.

### Hierarchy

- **Editorial Display** (Newsreader, 500, 2.25–2.75rem, 1.05): scoped to AI-authored
  long-form heroes. Reading-room voice. See carve-out below.
- **Display** (Inter, 600, 1.5rem, 1.2): rare; reserved for page-level titles when one
  exists.
- **Headline** (Inter, 600, 1.125rem, 1.3): panel headers.
- **Title** (Inter, 600, 0.9375rem, 1.4): card titles, PR titles in the list.
- **Body** (Inter, 400, 0.875rem, 1.5): all running text. Body line length caps at 70ch
  in prose contexts (walkthrough markdown, recap text).
- **Label** (Inter, 500, 0.75rem, 0.01em letter-spacing): inline labels, metadata, tab
  text. Never uppercase by default; case is meaningful, not decorative.
- **Mono** (JetBrains Mono, 400, 0.8125rem): code in diffs, identifiers in prose,
  filenames in lists.

### Named Rules

**The Two-and-a-Half-Family Rule.** Inter is the only sans for UI and body. JetBrains
Mono is the only mono for code and identifiers. Newsreader is the only editorial
display serif, and only on AI-authored long-form heroes (see carve-out). No condensed
sans, no second body family, no display sans, no decorative serif elsewhere. The
half-family is half because Newsreader appears at most once per screen and never below
1.875rem.

**The Editorial-Display Carve-out.** Newsreader is permitted only on hero titles of
AI-authored long-form surfaces:

- Recap hero (`RecapHeroBig.date`, `RecapSidebar.date`).
- Walkthrough section heads (`GuidedWalkthrough`, `WalkthroughSection`).
- Onboarding hero copy (the welcome / agent / sign-in / repo / host / done step
  titles, plus the onboarding shell's frame headings).
- Settings page section titles where they carry a reading-room voice.

These are the surfaces where an agent is talking *to* the reader at length, so the
serif earns the reading-room association the brand wants. Newsreader is never used
for product chrome (buttons, tabs, sidebars, dialogs), never for body prose, and never
below 1.875rem. If a new surface wants Newsreader, ask whether it's AI-authored
long-form first; if not, use Inter.

**The Earned-Uppercase Rule.** Uppercase is prohibited as a decorative style. Use
sentence case for everything except technical identifiers that are uppercase by
convention (HTTP verbs, env var names, type names). The mono eyebrow pattern
(0.6875rem mono, 0.18em letter-spacing, uppercase) is exempt — it's a structural
section marker, not decoration.

**The 65–75ch Rule.** Body prose in walkthrough markdown, recap content, and chat
messages caps at 70ch (`max-w-prose` in Tailwind). The diff is exempt; code wraps to
the panel width.

## 4. Elevation: Hybrid

Depth in this system is mostly tonal, with shadows reserved for things that genuinely
float. Chrome (sidebars, panels, tabs, headers) gets no shadows: it sits on the
warm-paper canvas via warm-stone and warm-ash tone steps. Anything that escapes the
flow (floating pills, popovers, tooltips, dialogs, the stream cursor's glow) earns a
shadow.

### Shadow Vocabulary

- **Indicator** (`0 1px 3px rgba(42,40,37,0.08), 0 2px 8px rgba(42,40,37,0.06), 0 0 0 0.5px rgba(42,40,37,0.04)`):
  a very soft ambient ring under the smallest floating elements (marker glows, status
  dots).
- **Small** (`0 2px 6px rgba(42,40,37,0.08)`): glass pills at rest, chip stacks.
- **Medium** (`0 4px 16px rgba(42,40,37,0.10)`): popovers, tooltips, the line-action
  floating pill above a diff line.
- **Large** (`0 8px 24px rgba(42,40,37,0.12), 0 2px 8px rgba(42,40,37,0.06)`): sheets,
  the chat panel when it floats above the diff.
- **XL** (`0 16px 48px rgba(42,40,37,0.18), 0 4px 12px rgba(42,40,37,0.10)`): dialogs,
  modals, the command palette.

Dark theme shadows mirror these but use `rgba(0,0,0,...)` at 2–3× the alpha to read
against the midnight-paper canvas.

### Named Rules

**The Hybrid Rule.** Chrome layers via warm tones (paper → stone → ash). Floating UI
layers via shadows. The two languages do not cross: a sidebar never gets a drop shadow,
and a tooltip never relies on a tone step to read as "above."

**The No-Heavy-Shadows Rule.** Shadow alpha caps at 0.18 (XL) in light theme. If a
shadow needs to be heavier than XL to read, the elevation language is wrong: either the
underlying surface contrast is off or the element should not be floating at all.

## 5. Components

For each component, lead with the character, then specify shape, color assignment,
states, and any distinctive behavior.

### Buttons

Refined and restrained at rest, tactile on press. Six variants
(default / outline / secondary / ghost / destructive / link) and five sizes
(xs / sm / default / lg / icon).

- **Shape:** rounded (`rounded-lg`, 8px). Small variants use a `min(--radius-md, 10–12px)`
  clamp so they don't out-radius the height.
- **Default (Primary):** Deep Naval fill (`oklch(46% 0.11 225)`), white text, no border. Height
  32px, horizontal padding 10px, font-size 0.875rem, weight 500.
- **Outline:** warm-paper background, ink-primary text, paper-edge border (1px).
  Hover lifts to warm-stone.
- **Ghost:** transparent at rest, ink-secondary text. Hover lifts to warm-stone fill,
  ink-primary text. The default chrome button.
- **Secondary:** warm-stone fill, ink-primary text. Hover deepens 20%.
- **Destructive:** Considered Red at 10% alpha, Considered Red text. Hover lifts to
  20% alpha. Never a solid red fill: the warning is in the color, not in the volume.
- **Link:** Deep Naval text, no fill, underline on hover.

**The Tactile Press.** All buttons translate down 1px on `:active` (excluding popover
triggers). The 1px press is deliberate; it makes interaction feel tangible against the
paper canvas.

**Focus:** 3px outer ring at `var(--ring)` (Deep Naval in light, Phosphor Naval in
dark). Border shifts in on aria-invalid.

### Inputs / Fields

- **Style:** warm-stone fill, ink-primary text, paper-edge hairline border, 8px
  radius. Height 32px, padding 8px 12px.
- **Focus:** focus ring at `color-mix(in srgb, var(--color-accent) 40%, transparent)`,
  no border color change. The glow is the affordance.
- **Disabled:** ink-muted text, 50% opacity, no border change.

### Tabs (PR tabs in the chrome track)

The signature navigation pattern. A pill-track of inactive tabs in ink-muted on a
`rgba(42,40,37,0.06)` track, with the active tab fill stepping up to warm-paper. No
borders. The track is the same warm-stone family as the sidebar, allowing the chrome
to read as one continuous element.

- **Active:** warm-paper fill, ink-primary text, soft Indicator shadow.
- **Inactive:** transparent fill, ink-muted text (`#7a756c`).
- **Hover (inactive):** warm-ash tint, ink-primary text.

### Cards / Containers

- **Corner Style:** 8px (cards), 12px (islands).
- **Background:** warm-paper for default cards; warm-stone for embedded cards (e.g.,
  inside a warm-paper panel). Nested cards beyond two levels are prohibited.
- **Shadow Strategy:** none at rest. Cards are tonal; the warm-stone-on-warm-paper
  contrast is the elevation. Hover may add a Small shadow for a single tier of lift,
  but only when the card is genuinely actionable.
- **Border:** 1px paper-edge hairline by default; omitted on warm-paper-over-warm-paper
  cases where the border would be invisible anyway.
- **Internal Padding:** 16px (`island-2x`) for content cards, 12px (`inset`) for
  list-row cards.

### Glass Pill

A distinctive component used for chrome elements that float above the canvas: the
line-action pill, mode toggles, ambient status. Warm-paper at 78% alpha, paper-edge at
9% alpha, backdrop-blur 6px, Small shadow. Glass is a *role*, not a default style: use
it only for floating chrome on the canvas, never for content surfaces.

### File Tree Row

- **Style:** transparent at rest, ink-secondary text, mono font for filenames at
  0.8125rem.
- **Hover:** warm-ash fill.
- **Active:** Deep Naval at 10% alpha fill, deeper Deep Naval text
  (`oklch(40% 0.1 225)`). The brand accent is *tinted* into the active state, not used
  directly: the row is whispering the brand, not shouting it.

### Diff Canvas

The most distinctive surface in the product. A warm-stone canvas with a slightly cooler
gutter (`#edeae3`), gutter border (`#e4e0d8`), and a full vocabulary of addition /
deletion / context states with hover variants. Additions and deletions use deepened
severity greens and reds at low alpha (4–8%) so the diff reads as a calm document, not
a Tailwind-tutorial color explosion.

- **Selection:** Deep Naval at 8% alpha. The same accent appears in the file tree's
  active state and the marker dots; selection feels like "I'm working here" in the
  brand voice.

### Streaming AI Cursor

A 1ch-wide vertical bar in Deep Naval that blinks while the AI is producing tokens.
Single character. Its glow uses the Indicator shadow at low alpha. The cursor is
opt-back-in to motion under `prefers-reduced-motion` via `.motion-essential-blink`: if
motion is disabled globally, the cursor still blinks so the user can tell the system
is alive.

## 6. Do's and Don'ts

### Do:

- **Do** use Deep Naval sparingly. ≤10% of any given screen. The streaming cursor,
  the active file row, the primary CTA, the focus ring. Not all four at once on the
  same surface.
- **Do** use warm-paper as the canvas in light theme and warm-stone as the secondary
  surface. Tone steps carry chrome elevation.
- **Do** use `phosphor-svelte` for every icon. Inline SVG only when no phosphor
  equivalent fits.
- **Do** deepen severity colors one step from stock Tailwind (700 weight rather than
  500) so reds and greens read as considered, not bright.
- **Do** translate buttons 1px down on `:active`. The press is tactile and on
  purpose.
- **Do** cap body prose at 70ch (Tailwind's `max-w-prose`). The diff is exempt.
- **Do** reach for Newsreader on AI-authored long-form hero titles (recap hero,
  walkthrough section heads, onboarding hero copy). Inter everywhere else.
- **Do** honor `prefers-reduced-motion` as a contract. Opt back in only for motion
  that carries meaning, using `.motion-essential-*` classes.
- **Do** use motion tokens from the `@theme` block: `duration-snap`,
  `duration-quick`, `duration-smooth`, `ease-out-expo`, `ease-soft`. No hand-typed
  durations.

### Don't:

- **Don't** use emoji in rendered UI, ever. Not in buttons, not in fallback avatars,
  not in toast messages, not in placeholders. Use a phosphor icon or nothing.
- **Don't** use stock Tailwind blue (`blue-500`, `#3b82f6`) as a brand accent in light
  theme. That is the color every other dashboard ships. Deep Naval is the move.
- **Don't** use side-stripe borders (`border-left > 1px` as a colored accent on cards,
  list items, callouts). Use a full hairline border, a background tint, or a leading
  icon instead.
- **Don't** use gradient text (`background-clip: text` on a gradient). Decorative
  always, meaningful never. Emphasis comes from weight and size.
- **Don't** use glassmorphism as a default surface style. The Glass Pill is the
  exception, not the rule.
- **Don't** ship the hero-metric template (big number, small label, supporting stats,
  gradient accent). Watchtower mode does not need a SaaS-dashboard pastiche.
- **Don't** stack identical card grids. If three cards in a row do not differ in
  weight or content, the grid is the lazy answer.
- **Don't** reach for a modal as the first thought. Inline expansion, progressive
  disclosure, and side panels exhaust before a modal is justified.
- **Don't** use Newsreader for product chrome, body prose, or any heading below
  1.875rem. The serif is reserved for AI-authored long-form heroes; using it anywhere
  else dilutes the carve-out into a decorative second body family.
- **Don't** animate CSS layout properties. Translate, scale, opacity, and color only.
- **Don't** use heavy purple gradients or neon accents to signal "AI." Revv's AI
  surfaces are warm paper with a single Considered Violet accent and a streaming
  cursor; that is the entire AI vocabulary.
- **Don't** use `#000` or `#fff`. Every neutral is tinted: warm-paper toward 36° in
  light, midnight-paper toward neutral in dark. Pure values read as "untouched
  default."
- **Don't** use bright stock severity colors. `red-500`, `green-500`, `amber-500` all
  read as prototype-bright. Use the deepened 700-weight equivalents already in the
  palette.
- **Don't** add a "Layout Principles" or "Motion" or "Responsive Behavior" section
  to this file. The system has six sections; layout and motion live inline with
  Overview and Components.
