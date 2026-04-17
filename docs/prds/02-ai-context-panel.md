# PRD-02: AI Context Panel

## Priority: P0 (First AI integration)

## Dependencies: PRD-01 (persisted sessions needed for context)

## Estimated: 3-4 days

---

## Objective

Wire the existing right panel to a Claude-powered explanation service. When a reviewer clicks "Explain" on a diff line (or walkthrough code block later), the right panel streams a contextual AI explanation — what changed, why it matters, what depends on it, and what could go wrong.

This is Revv's first AI integration point. It establishes the Anthropic SDK wiring, API key management, and streaming SSE pattern that PRD-03 and PRD-05 will reuse.

---

## Current State

The frontend already has:

- `RightPanel.svelte` — toggleable panel (320px, `Cmd+R` to toggle)
- `ExplanationEntry` type in `review.svelte.ts` — `{ filePath, lineRange, codeSnippet, content, isStreaming }`
- `startExplanation()` / `appendExplanationChunk()` / `finishExplanation()` — streaming state management in the store
- `requestPanelOpen()` — signal to auto-open right panel when explanation starts
- Line click interaction in the diff viewer that can trigger an "Explain" action

The server has:

- `userSettings.aiProvider` (default: `"anthropic"`) and `userSettings.aiModel` (default: `"claude-sonnet-4-20250514"`) in the database
- No actual AI SDK integration, no API key storage, no streaming endpoint

---

## Technical Requirements

### API Key Management

The Anthropic API key needs secure handling:

1. **Frontend**: Settings page gets an "Anthropic API Key" input field (password-masked)
2. **Server**: `PUT /api/settings` accepts `aiApiKey` — the server stores it encrypted or in a secure config, and saves a reference in `userSettings.aiApiKeyRef`
3. **Runtime**: The `AiService` reads the API key from server-side config (never sent to frontend after initial setup)
4. **Validation**: On key save, make a lightweight Claude API call (e.g., count tokens) to verify the key works

For v1 simplicity: store the key in a separate file (`~/.revv/ai-key` or in the SQLite DB as an encrypted column). The `aiApiKeyRef` column tracks whether a key is configured (`"configured"` | `null`).

### Effect Service: AiService

```typescript
class AiService extends Context.Tag("AiService")<
  AiService,
  {
    explainCode: (params: ExplainParams) => Stream<string, AiError>;
    isConfigured: () => Effect<boolean, never>;
    validateKey: () => Effect<void, AiError>;
  }
>() {}

interface ExplainParams {
  filePath: string;
  lineRange: [number, number];
  codeSnippet: string;
  fullFileContent: string; // from fileContentCache
  prTitle: string;
  prBody: string | null;
  diff: string; // relevant file's unified diff
}

// Tagged errors
class AiRateLimitError extends Data.TaggedError("AiRateLimitError")<{
  retryAfter: number;
}> {}
class AiAuthError extends Data.TaggedError("AiAuthError")<{
  message: string;
}> {}
class AiGenerationError extends Data.TaggedError("AiGenerationError")<{
  cause: unknown;
}> {}
class AiNotConfiguredError extends Data.TaggedError(
  "AiNotConfiguredError",
)<{}> {}
type AiError =
  | AiRateLimitError
  | AiAuthError
  | AiGenerationError
  | AiNotConfiguredError;
```

### Anthropic SDK Integration

```typescript
import Anthropic from "@anthropic-ai/sdk";

// Inside AiServiceLive implementation
const client = new Anthropic({ apiKey });

const stream = client.messages.stream({
  model: settings.aiModel,
  max_tokens: 1024,
  system: EXPLAIN_SYSTEM_PROMPT,
  messages: [{ role: "user", content: buildExplainPrompt(params) }],
});

// Yield text chunks as they arrive
for await (const event of stream) {
  if (
    event.type === "content_block_delta" &&
    event.delta.type === "text_delta"
  ) {
    yield event.delta.text;
  }
}
```

### Explain Prompt Design

The system prompt instructs Claude to provide a concise, reviewer-focused explanation:

```
You are a code review assistant. The reviewer has selected a code range in a pull request diff and wants to understand it.

Provide a clear, concise explanation covering:
1. **What this code does** — functionality in plain language
2. **What changed** — if this is modified code, what's different from before
3. **Dependencies** — what other code this interacts with
4. **Risks** — anything the reviewer should watch for (edge cases, races, security)

Format as markdown. Keep it under 300 words. Use code references with backticks.
Do not repeat the code back — the reviewer can already see it.
```

The user message includes: file path, line range, the code snippet, the full file for context, the PR title/body, and the relevant file diff.

### SSE Streaming Endpoint

```
GET /api/explain?filePath=...&startLine=...&endLine=...&prId=...
```

- Auth required (bearer token)
- Streams text chunks as SSE `data:` events
- Final event: `data: [DONE]`
- Error events: `event: error\ndata: { "code": "...", "message": "..." }`
- If AI is not configured, returns 400 with clear error message

### Elysia Routes

| Method   | Path                      | Description                                   |
| -------- | ------------------------- | --------------------------------------------- |
| `GET`    | `/api/explain`            | SSE stream — AI explanation for selected code |
| `POST`   | `/api/settings/ai-key`    | Save Anthropic API key (validates first)      |
| `DELETE` | `/api/settings/ai-key`    | Remove API key                                |
| `GET`    | `/api/settings/ai-status` | Check if AI is configured and key is valid    |

### Frontend Changes

**Right panel content (`RightPanel.svelte`):**

- Show explanation history (list of past explanations in this session)
- Active explanation streams in with a typing indicator
- Each entry shows: file path, line range, explanation text
- Click an old entry to re-display it
- "Not configured" state with link to settings when API key is missing

**Diff viewer integration:**

- The existing line click → "Explain" action now calls the SSE endpoint
- `startExplanation()` opens the panel and creates a new entry
- Chunks from SSE are appended via `appendExplanationChunk()`
- On stream end, `finishExplanation()` marks it complete

**Settings page:**

- New section: "AI Configuration"
- API key input (password field) with "Save" button
- Validation indicator: checking → valid ✓ / invalid ✗
- Model selector dropdown (default: claude-sonnet-4-20250514)
- "Remove key" button

### Markdown Rendering

Explanation content is markdown. Render with:

1. `marked` for markdown → HTML
2. `DOMPurify` for sanitization
3. Svelte `{@html}` for display
4. Code spans and blocks get syntax highlighting via Shiki (already available from @pierre/diffs setup)

---

## UI Specification

### Right Panel — Explanation Streaming

```
+── Context Panel ──────────────────────+
|                                       |
|  src/auth/validator.ts:44-46          |
|  ─────────────────────────────────    |
|                                       |
|  ## Token Refresh Logic               |
|                                       |
|  This code replaces the previous      |
|  hard-fail behavior when a JWT        |
|  expires. Instead of throwing, it     |
|  calls `refreshToken()` to attempt    |
|  a transparent session renewal.       |
|                                       |
|  **What changed**: The `if` block     |
|  at line 44 is new — previously       |
|  `isExpired()` was not checked.       |
|                                       |
|  **Dependencies**: `refreshToken()`   |
|  is defined in `src/auth/refresh.ts`  |
|  and calls the OAuth provider's       |
|  token endpoint.                      |
|                                       |
|  **Risk**: No concurrency guard —     |
|  multiple requests hitting an         |
|  expired token simultaneously will    |
|  each trigger a refresh. █            |
|  (streaming...)                       |
|                                       |
+── ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ──+
|  Previous explanations:               |
|  · src/auth/refresh.ts:12-18         |
|  · src/middleware/auth.ts:30-35       |
+───────────────────────────────────────+
```

### Settings — AI Configuration

```
+── AI Configuration ───────────────────+
|                                       |
|  Provider: Anthropic                  |
|                                       |
|  API Key:                             |
|  [••••••••••••••••••••] [Save]        |
|  ✓ Key validated successfully         |
|                                       |
|  Model:                               |
|  [claude-sonnet-4-20250514    ▾]      |
|                                       |
|  [Remove Key]                         |
|                                       |
+───────────────────────────────────────+
```

### Error States

| State                 | UI                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------- |
| No API key configured | Panel shows "Set up your Anthropic API key in Settings to get AI explanations" with link |
| Invalid API key       | Toast error + settings shows "Key is invalid"                                            |
| Rate limited          | Panel shows "Rate limited — retry in Xs" with countdown                                  |
| Generation failure    | Panel shows error message with "Retry" button                                            |
| Network error         | Panel shows "Connection error" with retry                                                |

---

## Acceptance Criteria

- [ ] Click "Explain" on a diff line → right panel opens, AI streams explanation
- [ ] Explanation covers: what the code does, what changed, dependencies, risks
- [ ] Streaming is visible — text appears incrementally, not all at once
- [ ] Previous explanations are accessible in the panel (click to revisit)
- [ ] Settings page: save API key → validates → shows success/failure
- [ ] Settings page: model selector works
- [ ] No API key → panel shows setup prompt instead of erroring silently
- [ ] Rate limit → panel shows countdown, auto-retries
- [ ] Large code selections (50+ lines) produce coherent explanations
- [ ] Explanation uses full file content + PR diff for context (not just the snippet)
- [ ] `bun run typecheck` passes
- [ ] API key never appears in frontend code, localStorage, or network responses after initial save
