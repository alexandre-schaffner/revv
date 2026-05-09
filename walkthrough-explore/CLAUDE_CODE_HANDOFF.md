# Walkthrough generating-state — implementation handoff

You are picking up a Svelte 5 / SvelteKit refactor of the **walkthrough generating UI** in `apps/web`. The new visual is already designed and prototyped in HTML/JSX under `walkthrough-explore/`. Your job is to port two specific pieces of that prototype into the real component, replacing the current generating-state markup with no behavioral changes.

---

## What to read first

1. **The two design files that define the target visual** (read in full):
   - `walkthrough-explore/v4-5-realstream.jsx` — the streaming layout (Overview text + Issues lane + queued Sentiment/Rated sections). This is the **body** of the generating state.
   - `walkthrough-explore/v4-5-realstream.jsx` lines 38–105 — the **Chapters stepper** (italic serif eyebrow, big serif title, blue top-rule on active, live mono file path under active). This was promoted from `stepper-options.jsx > ChapC1ActiveFile` (artboard `c1`). It is the new horizontal progress indicator at the top of the generating column.
2. The artboard hosting both is `v4_5` in `walkthrough-explore/app.jsx`. Open `walkthrough-explore/Walkthrough Generation.html` to see it live and focus that artboard.
3. The current implementation you are replacing:
   - `apps/web/src/lib/components/walkthrough/GuidedWalkthrough.svelte` — specifically the `{#if !summary && blocks.length === 0 && sentiment === null && ratings.length === 0 && isStreaming}` branch (around line 641) and its surrounding pipeline-phase / status-bar / exploration-feed markup (~ lines 493–710). This is the entire generating column.
   - Supporting state: `apps/web/src/lib/stores/walkthrough.svelte.ts` — note `getPhase()`, `getPhaseMessage()`, `getExplorationSteps()`, `getIsStreaming()`, `getStreamStartedAt()`, `getIssues()`, `getSentiment()`, `getRatings()`, `getSummary()`, `getBlocks()`, `getStreamError()`. Do not change any of these — only consume them.

---

## What you are changing

Replace the current generating-state column with two stacked pieces:

### Piece 1 — Chapters stepper (top of column)

Four cells in a CSS grid, equal columns, gap 16px. Each cell:

- A **2px top rule**: blue (`var(--revv-accent)`) on the active chapter, neutral grey (`#e5e5ea`) elsewhere.
- An **italic serif eyebrow** "Chapter 01"…"Chapter 04" (`Newsreader`, italic, 11.5px, 500 weight, accent color when active else muted).
- A **big serif title** (Newsreader, 18px, 500): "Overview", "Diff Analysis", "Sentiment", "Rating".
- **Body line, two states**:
  - **Active chapter** → braille-spinner + lowercase "reading" eyebrow (10px accent), then a single line of mono text showing the file the agent is currently reading (truncate with `…/` prefix). Source the file from the most recent `explorationStep` whose `tool` reads files; fall back to a static label if none yet.
  - **All other chapters** → a static one-line blurb (10.5px muted): "What changed and why" / "Hunk-by-hunk reasoning" / "Overall read on the PR" / "Across 9 axis".
- Chapters past index 1 get `opacity: 0.6` (further-out queued state).
- Active chapter is determined by `phase` from the store. Map: `connecting | overview` → 0, `diff` → 1, `sentiment` → 2, `rated | rating` → 3. Once `phase === 'rated'` is complete and `isStreaming === false`, the stepper is replaced by the real walkthrough body — do not render a "done" state for the stepper.

Exact pixel values, type styles, spinner animation, and accent color usage are all encoded in the JSX prototype — port them faithfully.

### Piece 2 — Streaming body

Direct port of `v4-5-realstream.jsx`'s body (the `<div style={{ maxWidth: 640 }}>` block, lines ~106 to end, **excluding** the stepper at the top which Piece 1 replaces):

- **Overview** heading + streaming markdown paragraph with a blinking caret while `phase === 'overview'`. Inline code spans use the existing `inlineCodeS` styling pattern.
- **"Building walkthrough — reading `<file>`"** status line under Overview (braille spinner + accent text). Reuse the same exploration-step source as Piece 1.
- **Issues lane** (`<IssueCard>` per issue from `getIssues()`) — these stream in as the agent finds them. Use the existing `IssueCard.svelte` component as-is.
- **Queued ghost sections** for Diff Analysis (file chips), Sentiment (3 horizontal bars), and Rated (4 metric pills). All at `opacity: 0.55`. Use the same `SectionGhost` / `SectionHead` shape from the prototype.

Do not implement these as new Svelte components per ghost — inline them in the generating-state branch of `GuidedWalkthrough.svelte`. They are pure visual placeholders.

---

## Constraints and non-goals

- **No new state, no new store fields, no new SSE events.** Everything you need is already in `walkthrough.svelte.ts`. If you find yourself wanting to add a field, stop and ask.
- **No behavior changes.** Stream lifecycle, error handling, the `pollCloneUntilResolved` flow, the `walkthrough-sse.ts` service, the `streamWalkthrough` / `regenerate` / `hydrateFromCache` paths — all stay exactly as they are.
- **Type/CSS tokens.** Use existing CSS custom properties: `--revv-accent`, `--revv-text-primary`, `--revv-text-secondary`, `--revv-text-muted`, `--revv-border-subtle`, `--mono`. The serif (`Newsreader`) needs to be added to the existing `<svelte:head>` / global font load if it isn't already — check `apps/web/src/app.html` and the global CSS first; if Newsreader isn't loaded, add it the same way the existing serif is loaded (Google Fonts link with `ital,wght@0,400;0,500;1,500`).
- **Animations.** Port the `braille-spinner`, `blink-cursor`, `pulse-dot`, and `fade-up` keyframes from the prototype's `<style>` blocks into the component's `<style>` block (or into the global stylesheet if any are reused).
- **No console errors. No layout shift when a chapter transitions from active → queued.** The cell heights should be stable — pin the body row to a fixed min-height so swapping "reading + path" for the static blurb doesn't reflow.
- **Width.** The generating column is 640px max-width, matching the existing walkthrough column. Keep that.
- **Dark mode.** The prototype is light-only. The real app has a dark theme — check `getDiffThemeType()` usage in the existing component and ensure the new markup respects the existing dark-theme tokens. If a token doesn't exist for something you need (e.g. the `#e5e5ea` neutral rule), introduce a new one in the same place existing tokens are defined, not inline.

---

## Order of work

1. Read `v4-5-realstream.jsx` end-to-end. Read the existing generating branch in `GuidedWalkthrough.svelte` end-to-end. Write a 5-bullet plan and confirm.
2. Add Newsreader to the font load if missing.
3. Replace the generating branch with Piece 1 + Piece 2. Keep the `streamError`, `hydrating`, `showGenerateButton` branches untouched.
4. Run the app locally, trigger a walkthrough generation, verify:
   - Chapters stepper renders with Overview active and the live file path updating as `explorationSteps` arrive.
   - Overview text streams with a caret. Issues land in the Issues lane as they stream.
   - Queued ghost sections sit at the bottom at 55% opacity.
   - When `phase` advances, the active chapter advances; the previous chapter does **not** show a "done" state — it just stops being active (its top rule goes neutral, eyebrow goes muted, body switches to static blurb).
   - When streaming completes, the generating column is replaced by the real walkthrough body (existing behavior — do not touch).
5. Dark-theme pass. Smoke-test error and supersede states (they should still render their existing UIs unchanged).

---

## Files you will likely touch

- `apps/web/src/lib/components/walkthrough/GuidedWalkthrough.svelte` (primary)
- `apps/web/src/app.html` or the global CSS, **only** if Newsreader needs adding

## Files you should not touch

- `apps/web/src/lib/stores/walkthrough.svelte.ts`
- `apps/web/src/lib/services/walkthrough-sse.ts`
- `apps/web/src/lib/components/walkthrough/IssueCard.svelte`
- Anything under `walkthrough-explore/` — that's the design source of truth, read-only for this task.

If anything in the prototype conflicts with an existing pattern in the codebase, ask before deviating.
