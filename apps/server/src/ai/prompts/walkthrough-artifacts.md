### Interactive artifacts (the craft bar)

An `artifact` block is a small interactive HTML island rendered inline in the walkthrough, in a sandboxed iframe that auto-sizes to the content. It exists for one reason: to let the reader **drive** a behaviour they would otherwise have to simulate in their head. Everything below is a hard requirement, not a style suggestion — an artifact that misses them is worse than the markdown list it replaced, because it costs the reader a click to learn nothing.

#### The bar — it must simulate, not reveal

Before writing any HTML, answer these three. If any answer is weak, drop the artifact and write a numbered markdown list instead.

These three are also checked when you submit the block, and a block that misses two of them is refused with the clauses that failed named. Treat a refusal as the answer to a question you should have asked yourself first: either find the state that actually changes and build the widget around varying it, or send the same content as `markdown`. Rewriting the same non-artifact with more HTML will be refused again.

1. **What state changes?** Name the concrete values the reader watches move: a permission set, a queue, a cursor, a lock, a cache entry, a flag, a row count. "The next line of the trace appears" is **not** state. An artifact whose only behaviour is un-dimming the next line of a list is a list — write it as one.
2. **What can the reader vary?** There must be at least one input that changes the outcome — the proposed guard on/off, the before/after implementation, the concurrent-vs-sequential ordering, the empty/typical/pathological input. A trace with a single possible path is a list.
3. **What is the payoff?** Running the interaction to the end must produce a conclusion the reader could not read off the code: where it breaks, which branch wins, what value is wrong. If the payoff is already stated in the annotation, the artifact adds nothing.

Strongest forms, in rough order of usefulness: **before/after toggle** on the same scenario (the proposed fix on/off) · **steppable trace with live state** · **input chooser** that re-runs a transformation over a handful of hand-picked inputs · **interleaving explorer** for a race (reader picks the order, sees the outcome) · **tiny chart** for a real measured quantity.

#### Anatomy — four parts, in this order

1. **Title line** — one short sentence naming what is being simulated ("Escalation attempt with `org_manage_groups` only"). The artifact must make sense with the annotation hidden, but must not restate the annotation verbatim.
2. **State panel — the payoff, and the visual anchor.** The values that change, always visible, each as `label: value` with the value in mono. When a value changes on a step, mark it (accent-colored value, or a `→` showing `old → new`) for that step only. This panel is the reason the artifact exists; give it the most visual weight. **An artifact with no state panel needs a very good excuse.**
3. **Trace / body** — the compact list of steps, rows, or panels. Dense, one line each.
4. **Verdict line** — one sentence in plain language, **present from the first render**: before the trace runs it states the pending outcome ("Not run yet — step to see where the request lands"), and once the outcome is determined it states it ("Blocked at step 3 — `strongestBundle(actor)` never contains the Admin bundle") in `--color-danger` when the bug reproduces, `--color-success` when the guard holds. **Never reserve an empty slot for it** — an always-populated line that changes text is right; a `min-height` placeholder is dead space. **No verdict = no payoff.**

Controls sit on one line directly under the title, or immediately above the verdict — never scattered.

#### Density budget

The artifact is inline prose furniture, not a dashboard.

- Target **≤ 320px tall at rest**, hard ceiling ~480px. The host clamps the frame between 160px and 1600px, so an oversized artifact simply eats the page.
- Trace rows are **lines, not cards**: `padding: 4px 8px`, `font-size: 12px`, separated by 1px `--color-border-subtle` hairlines. Never stack a rounded, padded, background-filled box per row.
- **Never reserve space for hidden content — this is the most visible defect there is.** No placeholder/`…` rows for steps not yet reached; either render all rows with pending styling, or grow the list as the trace advances. And **no `min-height`, no fixed `height`, no spacer element, no `flex: 1` filler** anywhere: a band of empty space at the bottom of an artifact reads as a rendering bug, and it is the single thing readers notice first. The frame auto-sizes to the content, so let it grow — a list that reflows as it fills is correct, and is not something to pre-pad against.
- **Every region is populated at first render.** Before the reader clicks anything, the title, state panel, first trace row and verdict line all contain real text. If a region is blank in the initial state, either seed it or delete it.
- At most **one** level of border inside the artifact. The host already draws the outer card, so the artifact's own root is transparent and unbordered — no outer frame of your own.
- No internal scrollbars and no fixed heights with `overflow`; the frame auto-sizes, so content that needs scrolling is content you should have cut.

#### Styling contract (theme-aware by construction)

The host injects Revv's theme variables and a base stylesheet onto the artifact's root and **re-applies them on light/dark toggle**. **Style exclusively with these variables — never hardcode hex colors, `rgb()`/`hsl()`/`oklch()` literals, or font families.** A hardcoded color is the single most common artifact defect: it won't flip in dark mode.

- **Surfaces:** `--color-bg-primary`, `--color-bg-secondary`, `--color-bg-tertiary`, `--color-bg-elevated`
- **Lines:** `--color-border`, `--color-border-subtle`
- **Text:** `--color-text-primary`, `--color-text-secondary`, `--color-text-muted`
- **Accent (the one accent):** `--color-accent`, `--color-accent-hover`, `--color-accent-muted`
- **Status:** `--color-success`, `--color-warning`, `--color-danger`
- **Type:** `--font-sans`, `--font-mono`
- **Geometry:** `--radius-card`, `--radius-island`, `--spacing-island-half`, `--spacing-island`, `--spacing-inset`, `--spacing-island-2x`

**Design language:** calm and restrained. **No** gradients, glassmorphism, neon, purple "AI" styling, decorative shadows, or emoji. `data-theme` (`"light"`/`"dark"`) is on `<html>` if you genuinely need a theme-conditional branch, but prefer variables that already flip. The baseline neutralizes motion under `prefers-reduced-motion` — don't fight it; keep any transition ≤150ms and confined to color/opacity.

**Spend the accent on state, not on chrome.** The accent marks the current step and the value that just changed — the two things the reader is looking for. Buttons stay quiet: `--color-bg-secondary` fill, `--color-border` outline, `--color-text-primary` label. An artifact whose only accent is on its "Next" button has spent it on the least informative pixel on screen.

**Row states must be distinguishable at a glance** — three, always:

- **done** — `--color-text-secondary`, no fill
- **current** — `--color-text-primary`, `--color-bg-secondary` fill, 2px `--color-accent` left border
- **pending** — `--color-text-muted`, no fill

If everything renders muted-on-grey, the reader cannot tell state from decoration and the interaction is invisible.

#### Typography — the artifact reads SMALLER than the prose around it

The walkthrough's body prose is 16px. The artifact is a compact instrument panel beside it, so it must look visibly smaller and denser. The injected baseline already sets the root to **13px** `var(--font-sans)` with the app's colors, and gives buttons/selects/inputs the same type and quiet chrome — **inherit it.** Only ever set a size to go *down* (12px for trace rows and the state panel); **never declare a `font-size` above 13px**, and never set `font-family` on the root. If any text in your artifact is as big as the surrounding paragraph text, it's wrong.

**Sans for words, mono for code — not everything in mono.** A trace row like "browser attaches cookies for the admin origin" is a sentence: sans. Only the identifiers, paths, headers, and values inside it go mono, as inline `<code>`/`<span class="m">` spans (`getIdentityToken`, `Sec-Fetch-Site`, `SameSite=Lax`, `403`). A whole panel set in monospace reads as a terminal dump and loses the contrast that makes the code parts stand out.

#### Controls

- Real `<button>` and `<input type="checkbox">` elements — keyboard-reachable, with a visible `:focus-visible` ring (the baseline supplies it, along with their type and default chrome).
- **No `<select>`.** A native dropdown drags in platform chrome that can't be themed and hides the alternatives behind a click. With 2–4 options, render them as a segmented row of small buttons with `aria-pressed="true"` on the active one — the reader sees every scenario at once and switching is one click. A `<select>` is only acceptable above ~5 options, which is itself a sign the artifact is doing too much.
- **At most two control groups plus Step/Reset**: one scenario picker (a segmented row of 2–3 buttons) and one binary toggle (a checkbox — clearer than a pressed-button for on/off). More than that is a settings panel, not an explanation.
- **Label them for a human, not for the compiler.** `With the proposed guard` beats `refuseBundleGroup in AddUserGroupMember`. Name the symbol in the title line or the state panel instead, where it has room.
- Disable the primary action when the trace is finished (`disabled` + `--color-text-muted`), so it never dead-clicks. Reset returns to the initial state exactly.
- Start at a meaningful state — step 0 already shown with its state panel populated, never an empty shell waiting for a first click.

#### Sandbox and determinism

`html` is a **single complete self-contained HTML document** with inline `<style>` and `<script>`, vanilla JS only, no external/CDN imports, no `localStorage`/`sessionStorage` (they throw: opaque origin). Parent DOM and cookies are unreachable. No network, no timers-as-animation, no `setInterval` autoplay, no `Math.random()`, no `Date.now()` — every state must be reachable deterministically by clicking, and identical on every render. Keep it under ~250 lines; if it needs more, the scope is too big for one block.

#### Skeleton (adapt, don't copy verbatim)

This is a real artifact, rendered and checked. Note what it does NOT do: no `font-family` on the root, no
size above 13px, no `padding` on `body`, no `min-height` or fixed `height` anywhere, no `<select>`, no
monospace on whole sentences, and no `font-size` re-declared on `code` (the baseline already drops inline
code to 0.92em, which is what makes a mono span sit level with the sans around it).

```html
<!doctype html>
<html>
  <head>
    <style>
      .wrap { display: grid; gap: 8px; }
      .title { color: var(--color-text-secondary); }
      .controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 12px; }
      .seg { display: flex; gap: 4px; }
      button { font-size: 12px; padding: 3px 9px; }
      button[aria-pressed="true"] { border-color: var(--color-accent); color: var(--color-accent); }
      .tog { display: inline-flex; gap: 5px; align-items: center; cursor: pointer;
             color: var(--color-text-secondary); }
      .state { display: flex; gap: 14px; flex-wrap: wrap; padding: 6px 10px; font-size: 12px;
               border: 1px solid var(--color-border); border-radius: var(--radius-card);
               background: var(--color-bg-secondary); }
      .state span { color: var(--color-text-muted); }
      .state .v { color: var(--color-text-primary); font-family: var(--font-mono); }
      .state .v.changed { color: var(--color-accent); }
      .row { display: flex; gap: 8px; padding: 2px 8px; font-size: 12px; line-height: 1.5;
             border-bottom: 1px solid var(--color-border-subtle); color: var(--color-text-muted); }
      .row .n { width: 14px; flex: none; font-variant-numeric: tabular-nums; }
      .row[data-state="done"] { color: var(--color-text-secondary); }
      .row[data-state="current"] { color: var(--color-text-primary);
             background: var(--color-bg-secondary); box-shadow: inset 2px 0 0 var(--color-accent); }
      .verdict { font-size: 12px; color: var(--color-text-muted); }
      .verdict[data-kind="fail"] { color: var(--color-danger); }
      .verdict[data-kind="pass"] { color: var(--color-success); }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="title">A request reaching <code>/api/backoffice/v4/internal/apr/native/&lt;key&gt;</code></div>
      <div class="controls">
        <div class="seg" id="origin">
          <button data-k="same" aria-pressed="true">Admin tab</button>
          <button data-k="link" aria-pressed="false">Third-party link</button>
          <button data-k="form" aria-pressed="false">Third-party form</button>
        </div>
        <label class="tog"><input type="checkbox" id="guard" /> With the proposed Sec-Fetch-Site check</label>
        <button id="step">Step</button>
        <button id="reset">Reset</button>
      </div>
      <div class="state" id="state"></div>
      <div id="trace"></div>
      <div class="verdict" id="verdict" data-kind="idle">Not run yet — step through to see where this request lands.</div>
    </div>
    <script>
      /* One pure render(scenario, guardOn, i) writes all three regions:
         - state: `<span>label <b class="v">value</b></span>`, adding `.changed` to the
           values this scenario/step actually moved
         - trace: rows up to the outcome step, each `data-state` done|current|pending, the
           sentence in sans with only identifiers wrapped in <code>
         - verdict: never empty — pending text before the outcome, the conclusion after,
           with data-kind flipped to pass|fail
         Step is `disabled` once the outcome is reached. No timers, no randomness. */
    </script>
  </body>
</html>
```

#### Anti-patterns (each of these has shipped — do not repeat)

- A list of steps that only fades in one line at a time, with no state panel and no verdict.
- A `…` placeholder row standing in for content the reader can't see yet.
- Four 48px-tall grey cards for four single lines of text.
- The accent used only on the primary button while every row renders in muted grey.
- Code identifiers set in the sans face — and its twin, whole English sentences set in monospace.
- A checkbox whose label is a raw symbol name with no explanation of what toggling it means.
- An artifact restating its annotation, so the reader reads the same sentence twice.
- A 130px band of empty space under the last row, reserved for a verdict that hasn't rendered yet.
- Type as large as the surrounding 16px prose — usually a native `<button>`/`<select>` left to the platform font, or a `font-size` set upward instead of down.
- A native `<select>` hiding the two scenarios that are the whole point of the artifact.
