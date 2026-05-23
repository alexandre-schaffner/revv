# Product

## Register

product

## Users

Serious code reviewers across the full cross-section: indie maintainers, senior
engineers on GitHub Enterprise, and team leads who treat review as a craft, not a
checkbox. No single cohort is the priority; the through-line is people who care enough
about both the *output* of a repo (what's shipping, what's stuck, what's next) and the
*review* of that work to leave GitHub's UI for a dedicated desktop client.

Context of use: extended focused sessions on a real workstation. Two distinct modes,
often back-to-back:

- **Watchtower mode.** A glance across one or several repos to understand the state of
  ongoing work. Which PRs are stuck. What's been merged since yesterday. What still
  needs a decision. A morning coffee, an end-of-day sweep, a "what did the team do this
  week" check before standup.
- **Review mode.** Deep, focused review of a specific PR. Walkthrough first, diff
  second, chat to clarify, comments to record, proposed commits to push fixes back.

Both modes share the same surface. The desktop client and persistent WebSocket make the
watchtower viable in a way a browser tab can't match.

## Product Purpose

Revv is a desktop watchtower and review surface for GitHub repositories. It does two
jobs the web UI does badly:

1. **Surface what's happening across repos.** PRs sync in real time across every
   watched repo and account. The user can see at a glance what's open, what's stuck,
   what just merged, who is waiting on whom, without tab-juggling between repo
   dashboards or refreshing the same page.

2. **Review with depth GitHub can't offer.** When a reviewer drops into a specific PR,
   they get AI walkthroughs that explain the change before the diff, a chat agent that
   can answer "why did this file change" and propose actual commits, and conflict
   resolution that doesn't break flow.

Success looks like: a reviewer opens Revv in the morning, sees the queue change
overnight, picks the two PRs that actually need them, spends real time on each, and
ships substantive review. The depth and the awareness are both the point; neither
alone justifies leaving GitHub.

## Brand Personality

Calm, precise, expert.

- **Calm.** Stillness is the baseline. The UI does not flash, bounce, or interrupt.
  Motion is reserved for state that genuinely changes (streaming AI cursor, panel
  slides). Reduced-motion is a contract, not a courtesy.
- **Precise.** Every value in the design system is considered. "Teal-700 because the
  generic Tailwind blue ships in every other dashboard" is not a quip in `app.css`,
  it's the working philosophy. Anti-references are encoded inline next to the tokens
  they replace.
- **Expert.** Defaults trust the user. No onboarding theatre, no tooltips explaining
  obvious affordances, no progressive disclosure for the sake of it. The user knows
  what a PR is. The first-run onboarding that exists earns its keep by setting up
  accounts and watched repos, not by teaching the product.

Voice in copy and microcopy: direct, considered, never cute. No exclamation marks. No
filler ("Awesome!", "Just a moment..."). When the system has nothing useful to say, it
says nothing.

## Anti-references

The visual system in `apps/web/src/app.css` already encodes some of these by name; this
section makes them strategic, not just chromatic.

- **GitHub's own web UI.** Busy, ad-laden, marketing chrome stitched onto a code review
  tool. Revv is the opposite: chrome recedes, code and conversation are foreground.
- **Generic SaaS dashboards.** Stock-Tailwind blue accent, identical card grids,
  hero-metric template at the top of every page. Revv has one distinctive accent
  (deep teal `#0f766e`) and no card grid as the default container, even in
  watchtower mode.
- **The AI-tool aesthetic du jour.** Neon-on-black, purple gradients, glassmorphism
  panels, "magical sparkle" iconography. Revv's AI surfaces are warm paper with a
  considered violet accent (`#6d28d9`), not lavender or neon.
- **Heavy enterprise review tools** (Jira / Bitbucket / classic Crucible).
  Gray-on-gray density, form-heavy modals, modal-as-first-thought. Revv is text-first
  and inline-first; modals are rare.

## Design Principles

1. **Calm by default.** Stillness is the baseline. Motion is reserved for state that
   genuinely changes. Reduced-motion is honored as a contract; meaningful motion opts
   back in with explicit `.motion-essential-*` classes.

2. **One distinctive move per surface.** The teal accent, the warm-paper background,
   the persistent right-panel chat: each surface has one signature element, not three
   competing accents.

3. **Expert defaults.** Trust the user. The install flow assumes terminal fluency. The
   chat agent has plan mode for serious work. There is no first-run wizard explaining
   what a PR is.

4. **Text-first, chrome-last.** Code, diffs, and prose are the heroes. Navigation,
   sidebars, and tabs recede into warm-gray backgrounds. The tab track is the same
   color as the sidebar; the chrome is allowed to be quiet.

5. **AI is a collaborator, not a feature shelf.** AI surfaces (walkthroughs, chat,
   recaps) live inline with the work, not in a separate "AI" tab. The streaming cursor
   is the most prominent AI affordance: a single character that says "thinking now."

## Accessibility & Inclusion

Currently best-effort, leaning toward WCAG 2.1 AA. Specific contracts already in place:

- **Reduced-motion.** A global `@media (prefers-reduced-motion: reduce)` block in
  `app.css` collapses every transition to ~1ms. Motion that carries meaning (e.g., the
  streaming AI cursor) opts back in via `.motion-essential-*` utility classes. Don't
  bypass the global rule with `!important`.
- **Color contrast.** Warm-paper foregrounds (`#2a2825` on `#faf9f6`) and the teal
  accent against warm-paper meet AA at body sizes. Dark theme contrast is similarly
  intentional, not transplanted from a default Tailwind palette.
- **Icons only, no emoji.** `phosphor-svelte` is the standard icon library; inline SVG
  only when no phosphor equivalent fits. Emoji in rendered UI is prohibited (this is
  both an accessibility and a register decision).
- **Color blindness.** Severity is never communicated by color alone: diff status,
  marker state, and scorecard outcome all pair color with shape, icon, or label.

No formal audit target yet. When one is set, it will be WCAG 2.2 AA (current default).
