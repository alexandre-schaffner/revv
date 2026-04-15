# PRD-03: AI Guided Walkthrough

## Priority: P1 (Core AI experience)
## Dependencies: PRD-02 (AiService, Anthropic SDK, SSE pattern, markdown rendering)
## Estimated: 5-6 days

---

## Objective

Build the AI-powered guided walkthrough (Tab 1). Claude analyzes a PR and presents it as a step-by-step guided presentation — breaking the changes into conceptual steps (not file-by-file), each with markdown explanations and embedded code blocks. The reviewer navigates steps like a presentation and can comment on any code block using the same system from PRD-01.

---

## Current State

The frontend already has:
- `FloatingTabs.svelte` — pill toggle between "Walkthrough" and "Diff" tabs
- `activeTab` state in `review.svelte.ts` (defaults to `"diff"`)
- Empty walkthrough area when Tab 1 is selected — nothing renders

From PRD-02 we'll have:
- `AiService` with Anthropic SDK integration
- SSE streaming pattern for AI responses
- Markdown rendering pipeline (marked + Shiki + DOMPurify)
- API key management and validation

---

## Data Model

### New Table

```sql
CREATE TABLE walkthroughs (
  id TEXT PRIMARY KEY,                          -- UUID
  review_session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
  pull_request_id TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,                        -- one-paragraph PR summary
  steps TEXT NOT NULL,                          -- JSON: WalkthroughStep[]
  risk_level TEXT NOT NULL DEFAULT 'low',       -- low | medium | high
  generated_at TEXT NOT NULL,
  model_used TEXT NOT NULL,
  token_usage TEXT NOT NULL,                    -- JSON: { input: number, output: number }
  pr_head_sha TEXT NOT NULL                     -- cache key — invalidate when PR gets new commits
);
```

### TypeScript Types (in `packages/shared`)

```typescript
interface WalkthroughStep {
  id: string;
  order: number;
  title: string;                                // "Token Validation Changes"
  stepType: 'overview' | 'file_analysis' | 'concern' | 'architecture';
  content: string;                              // Markdown body
  relatedFiles: string[];                       // file paths this step covers
  severity: 'info' | 'warning' | 'critical' | null;
  codeSnippets: EmbeddedSnippet[];
}

interface EmbeddedSnippet {
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  content: string;                              // actual code
  annotation: string | null;                    // AI's inline note
}

interface Walkthrough {
  id: string;
  reviewSessionId: string;
  pullRequestId: string;
  summary: string;
  steps: WalkthroughStep[];
  riskLevel: 'low' | 'medium' | 'high';
  generatedAt: string;
  modelUsed: string;
  tokenUsage: { input: number; output: number };
  prHeadSha: string;
}
```

---

## Technical Requirements

### AiService Extension

Add to the existing `AiService` from PRD-02:

```typescript
class AiService extends Context.Tag("AiService")<AiService, {
  // From PRD-02
  explainCode: (params: ExplainParams) => Stream<string, AiError>;
  isConfigured: () => Effect<boolean, never>;
  validateKey: () => Effect<void, AiError>;

  // New for PRD-03
  generateWalkthrough: (params: WalkthroughParams) => Stream<WalkthroughStreamEvent, AiError>;
  regenerateStep: (walkthrough: Walkthrough, stepIndex: number) => Effect<WalkthroughStep, AiError>;
}>() {}

interface WalkthroughParams {
  pr: PullRequest;
  diff: string;                               // full unified diff
  fileContents: Array<{ path: string; content: string }>;
}

type WalkthroughStreamEvent =
  | { type: 'summary'; data: { summary: string; riskLevel: string; totalSteps: number } }
  | { type: 'step'; data: WalkthroughStep }
  | { type: 'done'; data: { tokenUsage: { input: number; output: number } } };
```

### Walkthrough System Prompt

The prompt instructs Claude to analyze the PR holistically:

```
You are a senior code reviewer preparing a guided walkthrough of a pull request.

Analyze the PR as a whole — understand the intent, not just the individual files. Break your analysis into 3-8 conceptual steps, where each step focuses on a concept, pattern, or concern — not a single file.

Rules:
1. Step 1 is always "Overview" — summarize the PR's purpose, scope, and risk level
2. Group related changes across files into a single step
3. Include relevant code snippets with exact file paths and line numbers
4. Flag risks with severity: info, warning, or critical
5. For each code snippet, add a brief annotation explaining what the reviewer should notice
6. Be direct — reviewers are engineers, not beginners

Output format: JSON. Stream one step at a time.

Risk level guide:
- low: straightforward changes, good test coverage, limited blast radius
- medium: touches critical paths, some edge cases to verify, moderate complexity
- high: security-sensitive, breaking changes, missing tests for critical paths, concurrency concerns

Example step flow:
  Step 1: Overview — "Auth middleware refactor to support token refresh"
  Step 2: Token Validation Changes — shows new validator code, explains the logic
  Step 3: Middleware Integration — shows how routes now use the validator
  Step 4: Concern: Race Condition — flags concurrent refresh with code reference
  Step 5: Test Coverage — reviews what's tested and what's missing
```

### SSE Streaming Endpoint

```
GET /api/reviews/:id/walkthrough
```

**Happy path:**
1. Check cache: if walkthrough exists and `pr_head_sha` matches current PR head → return from cache as instant SSE burst
2. Otherwise: call Claude, stream events
3. Events: `summary` → `step` (repeated) → `done`
4. On completion, save to `walkthroughs` table

**Event format:**
```
event: summary
data: { "summary": "...", "riskLevel": "medium", "totalSteps": 5 }

event: step
data: { "id": "...", "order": 1, "title": "Overview", ... }

event: step
data: { "id": "...", "order": 2, "title": "Token Validation", ... }

event: done
data: { "tokenUsage": { "input": 12450, "output": 3200 } }
```

### Elysia Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/reviews/:id/walkthrough` | Stream walkthrough (SSE), serves from cache if valid |
| `POST` | `/api/reviews/:id/walkthrough/regenerate` | Force-regenerate entire walkthrough |
| `POST` | `/api/reviews/:id/walkthrough/steps/:index/regenerate` | Regenerate a single step |
| `GET` | `/api/prs/:id/meta` | Get PR head SHA (already exists via `getPrMeta`) |

### Frontend Components

| Component | Description |
|-----------|-------------|
| `GuidedWalkthrough.svelte` | Main container: manages SSE connection, step state, navigation |
| `StepCard.svelte` | Single step: title, severity badge, rendered markdown, code blocks |
| `StepNav.svelte` | Previous/Next buttons + step indicator dots + keyboard hint |
| `StepProgress.svelte` | Loading state — skeleton cards shimmer while steps stream in |
| `WalkthroughCodeBlock.svelte` | Shiki-highlighted code with file path header, line range, comment button, click-to-jump-to-diff |

### Walkthrough Store State

Add to `review.svelte.ts`:

```typescript
let walkthrough = $state<Walkthrough | null>(null);
let walkthroughSteps = $state<WalkthroughStep[]>([]);
let currentStepIndex = $state(0);
let isWalkthroughLoading = $state(false);
let walkthroughError = $state<string | null>(null);
let streamingStepCount = $state(0);    // how many steps received so far

export function getWalkthrough(): Walkthrough | null { return walkthrough; }
export function getWalkthroughSteps(): WalkthroughStep[] { return walkthroughSteps; }
export function getCurrentStepIndex(): number { return currentStepIndex; }
export function setCurrentStepIndex(idx: number): void { currentStepIndex = idx; }
export function getIsWalkthroughLoading(): boolean { return isWalkthroughLoading; }
// ... etc
```

### Code Block Interactions

Walkthrough code blocks are interactive:
- **Click a code block** → same popover as diff view: [Explain] / [Comment]
- **Explain** → right panel streams AI explanation (PRD-02 system)
- **Comment** → inline comment input below code block (PRD-01 system)
- **File path header is clickable** → switches to Diff tab and scrolls to that file/line

---

## UI Specification

### Walkthrough View (Tab 1 selected)

```
+--+----------------------------------------------------+--------+
|  | PR #142: Refactor auth   [Walkthrough][Diff] [>]   |        |
|S +----------------------------------------------------+  Right |
|I |                                                     |  Panel |
|D |  Risk: ⚠ Medium                                    |        |
|E |                                                     |        |
|B |  This PR extracts JWT validation from inline        |        |
|A |  middleware into a dedicated service, adding         |        |
|R |  transparent token refresh for expired sessions.    |        |
|  |                                                     |        |
|P |  ───────────────────────────────────────            |        |
|R |                                                     |        |
|  |  Step 2 of 5: Token Validation Changes              |        |
|L |                                                     |        |
|I |  The JWT validation logic moved from inline         |        |
|S |  middleware checks to a standalone service.          |        |
|T |                                                     |        |
|  |  ┌─ src/auth/validator.ts (lines 12-24) ──────┐    |        |
|  |  │  export async function validateToken(...) { │    |        |
|  |  │    const decoded = jwt.verify(token, SECRET)│    |        |
|  |  │    if (isExpired(decoded)) {                │    |        |
|  |  │      return refreshToken(decoded);          │    |        |
|  |  │    }                                        │    |        |
|  |  │    return decoded;                          │    |        |
|  |  │  }                           [💬 Comment]   │    |        |
|  |  └─────────────────────────────────────────────┘    |        |
|  |                                                     |        |
|  |  ⚠ The refresh logic doesn't guard against          |        |
|  |  concurrent requests for the same session.          |        |
|  |                                                     |        |
|  |            [← Prev]  ● ● ★ ○ ○  [Next →]          |        |
+--+-----------------------------------------------------+--------+
```

**No file tree in walkthrough mode** — the walkthrough content fills the entire main area.

### Step Indicator Dots

- `●` = completed step (clickable to jump)
- `★` = current step
- `○` = not yet streamed (shows as hollow during generation)
- During streaming, dots fill in as steps arrive

### Streaming Behavior

1. User opens PR or clicks Walkthrough tab → SSE connection starts
2. Summary + risk level appear first (within 2-3 seconds)
3. Step indicator shows total steps when `summary` event arrives
4. Steps populate one at a time — dots fill in progressively
5. User can navigate to completed steps while later ones stream
6. Incomplete steps show a subtle skeleton/shimmer placeholder

### Step Navigation

- `← Prev` / `Next →` buttons at bottom
- Arrow keys (`←` / `→`) when walkthrough tab is focused
- Click any completed dot to jump
- Step number displayed: "Step 2 of 5"

### Risk Level Badge

Shown at the top of the walkthrough:
- 🟢 **Low** — green badge
- 🟡 **Medium** — yellow badge  
- 🔴 **High** — red badge

### Regeneration

- **Regenerate all**: button in walkthrough header → confirms → clears cache → re-streams
- **Regenerate step**: small refresh icon on each step card → only re-generates that step → replaces in cache

---

## Acceptance Criteria

- [ ] Open a PR → walkthrough tab starts streaming, summary appears within 3s
- [ ] Steps appear one by one as they stream in
- [ ] Step navigation: Previous/Next buttons, arrow keys, dot clicks all work
- [ ] Each step renders markdown with syntax-highlighted code blocks (Shiki)
- [ ] Code blocks show file path + line range as clickable header
- [ ] Clicking file path header switches to Diff tab at that file
- [ ] Code blocks have a comment button → opens PRD-01 comment system
- [ ] Code blocks support "Explain" action → PRD-02 right panel
- [ ] Risk level badge shows correctly (low/medium/high with color)
- [ ] "Regenerate" re-runs the entire walkthrough (shows loading state)
- [ ] "Regenerate step" re-runs just one step
- [ ] Cached walkthrough loads instantly on revisit (no AI call)
- [ ] Cache invalidates when PR has new commits (different head SHA)
- [ ] Large PRs (30+ files) produce coherent 5-8 step walkthroughs
- [ ] Error states: missing API key → setup prompt, rate limit → countdown, failure → retry button
- [ ] `bun run typecheck` passes
