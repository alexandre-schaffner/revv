// ── Review-copy contracts ──────────────────────────────────────────────────
//
// The shape rules for the prose an agent writes — how long, in what order,
// leading with what. They are stated in two places that must agree: the system
// prompt (`walkthrough-system-common.md`, which teaches the rule) and the tool
// schemas' `.describe()` strings (which are what the model actually has in
// front of it at call time).
//
// Generation and chat-edit each have their own tool surface writing the same
// field, so a single rule was previously restated in up to four literals. They
// drifted the moment one was tightened and, since a `.describe()` is never
// type-checked against anything, nothing said so.
//
// These constants are the tool-schema half. The prompt still explains the rule
// at length with worked examples — that is teaching, not duplication — but the
// normative sentence lives here and is interpolated everywhere it is quoted.

/**
 * Appended to the `.describe()` of every field the UI renders as plain text:
 * chapter titles, issue titles, issue descriptions. Agents intermittently
 * HTML-escape these, and a plain-text field is escaped again on render, so
 * `Context &amp; design decisions` reaches the reader verbatim.
 *
 * `providers/agent-text.ts` decodes these on ingest regardless — this is the
 * cheaper half of the fix, stopping the entity from being written at all.
 */
export const PLAIN_TEXT_FIELD =
  "PLAIN TEXT, not markdown and not HTML: write `&`, `<` and `>` as themselves, never as " +
  "`&amp;`, `&lt;` or `&gt;`. This field is not markdown-rendered, so an entity here reaches " +
  "the reader as its literal characters.";

/**
 * Voice rules, appended to every prose-bearing `.describe()`. Adapted from the
 * MIT-licensed `no-ai-slop` skill. The length contracts below govern how much
 * the agent writes; this one governs how it sounds. The two fail independently,
 * so a 60-word sentiment can still be pure slop.
 *
 * Deliberately short. It is repeated on ~14 schema fields, so every token here
 * is paid 14 times per request. The full pattern table, with worked before /
 * after pairs, lives in the "Voice — no AI slop" section of
 * `walkthrough-system-common.md`; this is only the call-time reminder.
 */
export const PROSE_VOICE_CONTRACT =
  "VOICE (full rules in the system prompt's 'Voice — no AI slop'): every sentence must fail the " +
  "portability test — if it could be pasted unchanged into a review of a different PR, replace it " +
  "with a fact from this diff. Show the fact; never label it critical, subtle, or worth noting. " +
  "No binary contrast ('not just X, it's Y'), colon reveal, faux-insight setup, editorialising " +
  "-ing clause, metadiscourse, or 'best practice suggests' without a `path:line` citation. Banned " +
  "words include leverage, utilize, robust, seamless, crucial, comprehensive, intricate. One name " +
  "per thing. Direct verbs. `**bold**` only as a line-start label. At most one em-dash.";

/** `set_overview.summary` / `update_overview.summary`. */
export const SUMMARY_CONTRACT =
  "FOUR SHORT LINES, each on its own line — never one paragraph. The field is rendered " +
  "markdown and a single newline breaks the line, so write them as four lines. " +
  "Line 1 is the takeaway, unlabelled, one sentence, MAX 25 WORDS: what kind of attention this " +
  "PR needs (the headline risk, the one behavior that changes, or plainly that it is mechanical " +
  "and safe). Never the PR title restated. Lines 2-4 are labelled, one sentence each, MAX 20 " +
  "WORDS each, in this order: `**Why** — ` the problem being solved; `**What changed** — ` the " +
  "approach in terms of behavior; `**Watch** — ` where the reader should look hardest, or " +
  "`nothing — mechanical change`. Hard caps: 90 words total, 2 backticked identifiers per line, " +
  "one clause per sentence. Do NOT inventory files or count lines — the UI already lists every " +
  "changed file. If a line needs a semicolon or a second dash to fit, it is too long: cut it.";

/** `set_sentiment.markdown` / `update_sentiment.markdown`. */
export const SENTIMENT_CONTRACT =
  "THREE SHORT LINES, each on its own line — never one paragraph. Rendered markdown; a single " +
  "newline breaks the line. MAX 20 WORDS per line, 60 words total. " +
  "(1) `**Verdict** — ` merge, merge after fixes, rework, or split. First word, no hedging, no " +
  "wind-up, no restating what the PR does. Use split when the PR carries several unrelated " +
  "concerns, and name them ('split into 3: migration, rate limiter, lint fix'). " +
  "(2) `**Works now** — ` what this PR makes possible, in the reader's terms " +
  "('magic-link login works end to end'), so the reason it exists is not buried under its " +
  "defects. One clause even on a bad PR; omitted only when genuinely nothing works. " +
  "(3) `**Next** — ` the single smallest specific action the reader takes next " +
  "('add the audience check at `auth/middleware.ts:42`, then re-run `bun test auth`'). One " +
  "action, never a list, never 'address the findings above' — name the first one. Clean PR: 'merge it'.";

/** Short form for a tool-list blurb, where the full contract is too long. */
export const SENTIMENT_CONTRACT_SHORT =
  "Three labelled lines, ≤20 words each: **Verdict** (merge | merge after fixes | rework | " +
  "split), **Works now**, **Next** (one concrete action).";

/** `add_issue_comment.body`. */
export const ISSUE_COMMENT_CONTRACT =
  "Speak to the coder directly, in four moves and in this order: failure mode → why it " +
  "matters → the fix → the effort. Open with what breaks, never with a re-description of " +
  "the code. MAX 25 words per sentence and 80 words total before the fix steps. A fix taking " +
  "more than one action is a numbered list, one bounded action per step, never a paragraph. " +
  "Close with a concrete effort estimate in plain units (`~5 min`, `about an hour`, " +
  "`half a day if the fixture doesn't exist yet`) — 'non-trivial' is not an estimate, and " +
  "you estimate the fix, not the review.";
