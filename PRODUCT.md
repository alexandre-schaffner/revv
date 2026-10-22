# Product

## Register

product

## Users

Revv is for everyone who touches a pull request, but the interface adapts to who's there:

- **Code-review power user** living in the app all day. Keyboard-first, dense, no hand-holding.
- **Tech lead / reviewer-of-record** approving many PRs across multiple repos. Breadth, fast triage, low ceremony.
- **Solo / staff engineer** reviewing their own work pre-push or teammates' PRs deeply. One repo, deep context, no rush.
- **Indie / side-project dev** juggling several personal repos. Lightweight, exploratory.
- **PMs** skimming changes to understand what's shipping.

The same surface should respect all of these. Don't dumb down for the PM. Don't gate-keep the staff engineer.

Job-to-be-done: review proposed code changes (own pre-push, or teammates') and interact with an AI agent on the review itself — ask it to rewrite chapters, address issues, propose commits, push on a new branch, and create the PR. The user never tabs to GitHub.com to finish the job.

Context of use: two modes, often back-to-back, on the same surface.

- **Watchtower mode.** A glance across one or several repos to understand the state of ongoing work. Which PRs are stuck, what's been merged since yesterday, what still needs a decision. Morning coffee, end-of-day sweep, the "what did the team ship this week" check before standup. The desktop client and persistent WebSocket make this viable in a way a browser tab can't.
- **Review mode.** Deep, focused review of a specific PR. Walkthrough first, diff second, chat to clarify, comments to record, proposed commits to push fixes back.

## Product Purpose

A desktop-native code review tool where the AI does the legwork (walkthrough, issue surfacing, fix proposals) while the human stays in control. Replace the GitHub web UI for review: faster, denser, calmer, with an always-on agent that can rewrite the review or push commits on the user's behalf.

Success: the user opens Revv to review a PR and stays there through merge. No tabs to GitHub.com, no context switch to a terminal, no Slack to ask a teammate to explain the diff.

Future surfaces:
- Read-only shareable review links (web). When this lands, those pages move to a **brand** register; the desktop app stays product.

## Brand Personality

Three words: **clear, powerful, native.**

- **Clear.** Signal over noise. Every pixel earns its place. Information density without claustrophobia. No friendly empty-state illustrations, no "Welcome back!" greetings.
- **Powerful.** Doesn't hide depth behind progressive disclosure. The keyboard does everything. Power users feel respected; the surface meets them at their level.
- **Native.** Feels like a Mac app, not a webview. OS-aware: traffic lights, deep links, Cmd-shortcuts, window chrome. Micro-interactions are restrained but considered. The Tauri shell is invisible.

Voice: confident, terse, technically literate. No marketing speak. No friendliness performance. Linear's voice, not Notion's.

## Anti-references

What Revv should explicitly NOT look or feel like:

- **GitHub.com.** Bloated chrome, slow, gray-on-gray, hostile to actual review work. The thing we're replacing.
- **VS Code.** Heavy chrome, gutter-heavy IDE feel, dated panels-and-tabs aesthetic. Code review is not coding; don't borrow the IDE's furniture.
- **Notion.** "Everything is a card" SaaS-cream emptiness, friendly empty states, drag-handle decorations, page-as-document framing.
- **Heavy enterprise review tools.** Jira, Bitbucket, classic Crucible. Gray-on-gray density, form-heavy modals, modal-as-first-thought.
- **Generic AI products of 2024-26.** Lavender accents, glass cards, sparkle icons, "AI-shaped" gradients, chatbot-first framing.

Adjacent references (peers, not copies): **Linear** (dense product UI craft), **Conductor** (native Mac feel, parallel-work shell), **Family** (micro-interaction discipline, restrained delight).

## Design Principles

1. **Calm before fancy.** The user is in sustained focus on someone else's code. Design for hour-three of review, not for the first impression. Motion is purposeful; decoration is never.

2. **One surface, every persona.** A staff engineer's keyboard density and a PM's skim mode are the same UI with different affordances surfaced. Don't fork the design; let the same chrome serve both.

3. **The agent is a collaborator, not a chatbot.** Render it like a serious tool. It rewrites review chapters, addresses issues, proposes commits, force-with-leases to new branches. The chrome around it should look as serious as the work it does.

4. **Density that breathes.** Lots of information per screen, but rhythm in the spacing. Variable padding, not uniform padding. Cards only when there's no better affordance.

5. **Native-first, web second.** Use OS conventions: Cmd-P palette, Esc-to-dismiss, drag handles, traffic-light clearance, deep links. Don't reinvent. The browser exists only so the Tauri shell has a frontend; everything below the title bar should feel like a Mac binary.

## Accessibility & Inclusion

- **macOS-only.** Revv is a native Mac app; there are no Windows or Linux builds.
- **OS-default accessibility minimum**: keyboard reachable, focus states visible, contrast meets WCAG AA in light and dark themes.
- **Reduced motion is a hard requirement.** `prefersReducedMotion()` is the single arbiter across the app; every motion path respects it. The global `@media (prefers-reduced-motion: reduce)` block in `app.css` covers the surviving CSS animations.
- **Severity is never communicated by color alone.** Diff status, marker state, walkthrough scorecard, and queue indicators all pair color with shape, icon, or label.
- No explicit WCAG audit program; defer to OS conventions and review on a case-by-case basis for specific user needs that surface from early users.
