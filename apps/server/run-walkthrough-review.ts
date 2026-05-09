/**
 * run-walkthrough-review.ts
 *
 * Executes the full 4-phase walkthrough pipeline for walkthrough ID:
 *   d4e60b01-1610-4907-9b75-5a2ecc053c81
 *
 * Run with: bun run-walkthrough-review.ts
 */

import { createDb } from "./src/db/index";
import {
  getWalkthroughStateHandler,
  setOverviewHandler,
  addDiffStepHandler,
  flagIssueHandler,
  addIssueCommentHandler,
  setSentimentHandler,
  rateAxisHandler,
  completeWalkthroughHandler,
} from "./src/ai/providers/walkthrough-tools";
import type { WalkthroughToolContext } from "./src/ai/providers/walkthrough-tool-spec";
import type { WalkthroughStreamEvent, WsServerMessage } from "@revv/shared";

// ── Config ───────────────────────────────────────────────────────────────────

const WALKTHROUGH_ID = "d4e60b01-1610-4907-9b75-5a2ecc053c81";
const DB_PATH = "./revv.db";

// ── DB + context ─────────────────────────────────────────────────────────────

const db = createDb(DB_PATH);

const ctx: WalkthroughToolContext = {
  db,
  walkthroughId: WALKTHROUGH_ID,
  emit: (event: WalkthroughStreamEvent) => {
    console.log("[emit]", JSON.stringify(event, null, 2));
  },
  broadcastThreadEvent: (msg: WsServerMessage) => {
    console.log("[broadcastThreadEvent]", JSON.stringify(msg, null, 2));
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function logResult(label: string, result: Awaited<ReturnType<typeof getWalkthroughStateHandler>>) {
  const ok = !result.isError;
  const text = result.content.map((c) => c.text).join("\n");
  console.log(`\n${"─".repeat(60)}`);
  console.log(`[${ok ? "OK" : "ERROR"}] ${label}`);
  console.log(text);
  if (!ok) {
    throw new Error(`Handler failed: ${label}\n${text}`);
  }
  return text;
}

function extractIssueId(resultText: string): string {
  const match = resultText.match(/issue_id[:\s]+"?([a-f0-9]{64})"?/i)
    ?? resultText.match(/id[:\s]+"?([a-f0-9]{64})"?/i);
  if (!match?.[1]) throw new Error(`Could not extract issue_id from: ${resultText}`);
  return match[1];
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("Walkthrough pipeline runner");
  console.log(`Walkthrough ID: ${WALKTHROUGH_ID}`);
  console.log("=".repeat(60));

  // ── Step 0: get_walkthrough_state ─────────────────────────────────────────
  const stateResult = await getWalkthroughStateHandler(ctx, {});
  const stateText = logResult("get_walkthrough_state", stateResult);

  const alreadyComplete = stateText.includes('"status": "complete"')
    || stateText.includes("status: complete")
    || stateText.includes('"lastCompletedPhase":"D"')
    || stateText.includes('"lastCompletedPhase": "D"');
  if (alreadyComplete) {
    console.log("\n✓ Walkthrough already at phase D (or complete) — skipping pipeline.");
    // Still run the DB verification below
  } else {

  // ── Phase A: set_overview ─────────────────────────────────────────────────
  logResult(
    "set_overview",
    await setOverviewHandler(ctx, {
      summary:
        "This PR adds a comprehensive developer guide (`docs/todos/ADD_NEW_CHAIN_CHECKLIST.md`) documenting how to integrate a new blockchain chain into the Merkl frontend. Using Solana (SVM) as the worked example, it covers the full integration surface: enums, wallet connector hooks, interaction files, chain config, and testing. No runtime code is changed — this is documentation only.",
      risk_level: "low",
    }),
  );

  // ── Phase B: add_diff_steps ───────────────────────────────────────────────

  // Step 0 — Overview markdown
  logResult(
    "add_diff_step[0] overview markdown",
    await addDiffStepHandler(ctx, {
      step_index: 0,
      markdown: {
        content: `## Overview

This PR adds \`docs/todos/ADD_NEW_CHAIN_CHECKLIST.md\` — a 608-line developer runbook for integrating a new blockchain into the Merkl frontend. It uses **Solana (SVM)** as the worked example throughout.

The guide is structured as **7 phases**:

1. **Phase 0** — Prerequisite Setup (verify backend readiness)
2. **Phase 1** — Core Enums & Types (\`ChainId\`, \`ChainType\`, chain config schema)
3. **Phase 2** — Wallet Connector Hook (new \`use[ChainName]WalletConnector.tsx\`)
4. **Phase 3** — Register Wallet Connector (\`useWalletConnector.tsx\` updates)
5. **Phase 4** — Chain Configuration & Display (icons, \`merkl.config.tsx\`)
6. **Phase 5** — Transactions & Interactions (chain-specific interaction files)
7. **Phase 6** — API Endpoints & Backend Integration
8. **Phase 7** — Testing & Validation checklists`,
      },
    }),
  );

  // Step 1 — ChainId assignment (code)
  logResult(
    "add_diff_step[1] ChainId code block",
    await addDiffStepHandler(ctx, {
      step_index: 1,
      code: {
        file_path: "docs/todos/ADD_NEW_CHAIN_CHECKLIST.md",
        start_line: 24,
        end_line: 31,
        language: "typescript",
        content: `export enum ChainId {\n  // ... existing chains\n  SOLANA = 3,  // Using deprecated testnet ID as placeholder\n}`,
        annotation:
          "The guide assigns `ChainId.SOLANA = 3`, explicitly noting this reuses a deprecated testnet ID as a placeholder. This numeric collision risk is called out in a comment but not resolved — a concrete non-colliding value or a forward reference to the backend's authoritative enum would be safer.",
        annotation_position: "right",
      },
    }),
  );

  // Step 2 — Wallet connector hook pattern (markdown)
  logResult(
    "add_diff_step[2] wallet connector markdown",
    await addDiffStepHandler(ctx, {
      step_index: 2,
      markdown: {
        content: `## Wallet Connector Hook Pattern

The guide's most substantial section describes the \`use[ChainName]WalletConnector\` hook template — the integration point between a chain's wallet SDK and Merkl's \`WalletContextValue\` shape.

### Key interface requirements the hook must satisfy

- \`connect(connectorId, chainType)\` — triggers wallet connection
- \`disconnect(connectorId, chainType)\` — cleans up session
- \`interact(tx, interactionId, id?, interactionArgs?)\` — signs and broadcasts transactions, updates the interaction store, shows toasts
- \`signMessage(message)\` — returns hex-encoded signature
- \`[chainTypeContextKey]\` — chain-specific RPC/signing context (e.g., \`svmContext\`, \`stellarContext\`)

The template correctly calls out \`switchChain: () => {}\` as a no-op for non-EVM chains.`,
      },
    }),
  );

  // Step 3 — interact callback (code with warning annotation)
  logResult(
    "add_diff_step[3] interact callback code",
    await addDiffStepHandler(ctx, {
      step_index: 3,
      code: {
        file_path: "docs/todos/ADD_NEW_CHAIN_CHECKLIST.md",
        start_line: 116,
        end_line: 128,
        language: "typescript",
        content: `  const interact = useCallback(\n    async <Tx extends InteractionManual<ChainType.SVM>[number]>(\n      tx: Tx,\n      interactionId: string,\n      id?: string,\n      interactionArgs?: unknown,\n    ) => {\n      // Sign and send transaction, track state, show toasts\n      // See useStellarWalletConnector.tsx for full implementation pattern\n    },\n    [],\n  );`,
        annotation:
          "The `interact` callback template uses an empty dependency array `[]`. In a real implementation, this would be a stale-closure bug — `interact` likely needs to close over wallet adapter state (address, connection, etc.). The guide should flag this explicitly and show the correct deps.",
        annotation_position: "left",
      },
    }),
  );

  // Step 4 — Phase 3 & 4 registration (markdown)
  logResult(
    "add_diff_step[4] registration markdown",
    await addDiffStepHandler(ctx, {
      step_index: 4,
      markdown: {
        content: `## Phase 3 & 4: Registration & Configuration

### \`useWalletConnector.tsx\` integration

The guide shows the exact pattern for wiring a new connector into the aggregator hook — the \`connectorMap\`, \`contextExtrasMap\`, \`connectors\` memo, and \`accounts\` memo all need updating in lockstep. The template brackets \`[ChainName]\`, \`[YOUR_TYPE]\`, and \`[contextKey]\` are consistent and make the pattern clear.

### \`CHAIN_TYPE_WORDING\` and \`merkl.config.tsx\`

Phase 4 covers adding the chain's icon and display name, plus enabling it in the app config. One thing missing from this section: the guide doesn't mention that the icon SVG or URL needs to be imported/available before the wording object is updated — a first-time integrator could hit a missing-asset error.`,
      },
    }),
  );

  // Step 5 — interaction generate stub (code)
  logResult(
    "add_diff_step[5] interaction generate stub",
    await addDiffStepHandler(ctx, {
      step_index: 5,
      code: {
        file_path: "docs/todos/ADD_NEW_CHAIN_CHECKLIST.md",
        start_line: 302,
        end_line: 320,
        language: "typescript",
        content: `export const createCampaignSvm = new Interaction({\n  id: "createCampaign",\n  chainType: ChainType.SVM,\n  name: "Create Campaign",\n  args: {\n    distributorAddress: AddressSchema.fork({ title: "Distributor Address" }),\n    rewardTokenAddress: AddressSchema.fork({ title: "Reward Token Address" }),\n    amount: NumericSchema.fork({ title: "Total Amount" }),\n    chain: ChainIdSchema.fork(),\n    payload: Type.String({ title: "Encoded Payload" }),\n    count: Type.Number({ title: "Number of campaigns" }),\n  },\n  generate: ({ distributorAddress, rewardTokenAddress, amount, chain, payload, count }) => [\n    // Generate transaction(s) specific to your chain\n    // ...\n  ],\n});`,
        annotation:
          "The `generate` function body is intentionally left empty — the comment defers to the EVM and Stellar examples. This is acceptable for a template, but the guide could benefit from at least one concrete line showing what a Solana instruction object looks like, since the transaction format is very different from EVM calldata.",
        annotation_position: "right",
      },
    }),
  );

  // Step 6 — API endpoint integration (markdown)
  logResult(
    "add_diff_step[6] API endpoint markdown",
    await addDiffStepHandler(ctx, {
      step_index: 6,
      markdown: {
        content: `## Phase 6: API Endpoint Integration

The guide draws a clear line between **chain-agnostic** endpoints (campaigns list, rewards, tokens) and **chain-specific** ones (payload generation for campaign creation, claim transaction format). The flow diagram shows:

\`\`\`
Frontend → POST /api/v4/campaigns/create
         ↓ backend generates payload
Frontend receives payload + metadata
         ↓
interact() → wallet signs → RPC submit → confirmation toast
\`\`\`

The API checklist (\`- [ ] Frontend receives payload as a **string** (not deserialized)\`) is a critical reminder — passing a deserialized object would break the signing step.

One gap: the guide doesn't address **error handling on the API side** — what happens if the backend returns a 4xx for an unsupported chain? The frontend interaction handler should map that to a user-friendly message.`,
      },
    }),
  );

  // Step 7 — Common pitfalls & final checklist (markdown)
  logResult(
    "add_diff_step[7] common pitfalls markdown",
    await addDiffStepHandler(ctx, {
      step_index: 7,
      markdown: {
        content: `## Common Pitfalls & Final Checklist

The "Common Pitfalls" section is the most immediately useful part of this document for a developer mid-integration. It covers:

- Forgetting \`connectorMap\` / \`contextExtrasMap\` → runtime error when connecting
- Payload string vs. object confusion → signing failure
- Missing interaction state tracking → silent UI failures
- Missing chain icon → broken wallet selector UI
- Non-chain-aware API endpoints → wrong payload format
- Transaction format mismatch → unsigned/invalid transaction submission

The complete **Solana integration checklist** at the end is a useful final verification gate — it mirrors the 7 phases and can be checked off as a PR description when adding a new chain.`,
      },
    }),
  );

  // Step 8 — Minor issues summary (markdown)
  logResult(
    "add_diff_step[8] minor issues markdown",
    await addDiffStepHandler(ctx, {
      step_index: 8,
      markdown: {
        content: `## Minor Issues Found

Two items worth addressing before this guide is used as the canonical reference:

1. **\`ChainId.SOLANA = 3\` placeholder** — the comment acknowledges this reuses a deprecated testnet ID. The guide should either defer to the backend enum as the authoritative source or provide a non-colliding value. Leaving a placeholder value in a reference doc risks cargo-culting a bad ID into real integrations.

2. **\`interact\` empty dependency array** — the hook template shows \`useCallback(async (...) => { ... }, [])\` with no deps. Any real implementation will need to close over wallet adapter state. The guide should note this explicitly and suggest the likely deps list.`,
      },
    }),
  );

  // ── flag_issue: ChainId placeholder ──────────────────────────────────────
  const flagIssue1Result = await flagIssueHandler(ctx, {
    severity: "warning",
    title: "ChainId.SOLANA = 3 reuses a deprecated testnet ID",
    description: "Placeholder value risks cargo-culting a bad chain ID into real integrations",
    block_orders: [1],
    file_path: "docs/todos/ADD_NEW_CHAIN_CHECKLIST.md",
    start_line: 28,
    end_line: 28,
  });
  const flagIssue1Text = logResult("flag_issue[1] ChainId placeholder", flagIssue1Result);
  const issue1Id = extractIssueId(flagIssue1Text);
  console.log(`  → issue_id: ${issue1Id}`);

  // ── flag_issue: interact empty dep array ─────────────────────────────────
  const flagIssue2Result = await flagIssueHandler(ctx, {
    severity: "warning",
    title: "interact useCallback has empty dependency array",
    description: "Hook template uses [] deps — real implementations will have stale closure bugs",
    block_orders: [3],
    file_path: "docs/todos/ADD_NEW_CHAIN_CHECKLIST.md",
    start_line: 116,
    end_line: 128,
  });
  const flagIssue2Text = logResult("flag_issue[2] interact empty deps", flagIssue2Result);
  const issue2Id = extractIssueId(flagIssue2Text);
  console.log(`  → issue_id: ${issue2Id}`);

  // ── add_issue_comment for Issue 1 ────────────────────────────────────────
  logResult(
    "add_issue_comment[issue1] ChainId",
    await addIssueCommentHandler(ctx, {
      issue_id: issue1Id,
      file_path: "docs/todos/ADD_NEW_CHAIN_CHECKLIST.md",
      start_line: 28,
      end_line: 28,
      diff_side: "new",
      body: "This example assigns `SOLANA = 3` and acknowledges it's a deprecated testnet ID placeholder. A developer reading this guide may copy the value verbatim into production code, creating a chain ID collision. Consider replacing with: (a) `// Use the value from the backend's ChainId enum — do not invent your own`, or (b) a non-standard placeholder like `99999` that is obviously not a real chain ID. The canonical source should always be the backend's enum; the frontend guide should defer to it rather than proposing a value.",
    }),
  );

  // ── add_issue_comment for Issue 2 ────────────────────────────────────────
  logResult(
    "add_issue_comment[issue2] interact deps",
    await addIssueCommentHandler(ctx, {
      issue_id: issue2Id,
      file_path: "docs/todos/ADD_NEW_CHAIN_CHECKLIST.md",
      start_line: 116,
      end_line: 128,
      diff_side: "new",
      body: "The template shows `useCallback(async (...) => { ... }, [])` with an empty dependency array. Any real `interact` implementation will need to close over wallet adapter state — at minimum the connected wallet instance, the RPC connection, and likely `address`. An empty dep array will silently return a stale version of `interact` that uses the initial (disconnected) wallet state. The guide should show something like `[wallet, connection, address]` as the typical deps, or at least add a comment: `// deps: fill in wallet adapter state captured in this hook`.",
    }),
  );

  // ── Phase C: set_sentiment ────────────────────────────────────────────────
  logResult(
    "set_sentiment",
    await setSentimentHandler(ctx, {
      markdown:
        "This is a well-structured developer runbook that will save significant time for anyone integrating a new chain. The guide is factually accurate, well-organized, and mirrors the existing Stellar integration pattern correctly. Two minor warnings (ChainId placeholder value and hook dependency array) should be addressed before this is used as the canonical reference. **Approve with minor fixes requested.**",
    }),
  );

  // ── Phase D: rate_axis (9 axes) ───────────────────────────────────────────

  logResult(
    "rate_axis: correctness",
    await rateAxisHandler(ctx, {
      axis: "correctness",
      verdict: "pass",
      confidence: "high",
      rationale: "n/a for this PR — documentation only, no executable code changed.",
      details:
        "No runtime code was added or modified. All code snippets in the guide are illustrative templates — they are not executed by the application. There are no logic errors, off-by-ones, or unhandled error paths to assess in the diff.",
      citations: [],
      block_orders: [],
    }),
  );

  logResult(
    "rate_axis: scope",
    await rateAxisHandler(ctx, {
      axis: "scope",
      verdict: "pass",
      confidence: "high",
      rationale: "Single file addition, focused on one topic. No scope creep.",
      details:
        "The PR adds exactly one file (`docs/todos/ADD_NEW_CHAIN_CHECKLIST.md`) covering a single coherent topic — how to integrate a new chain. No unrelated formatting changes, dependency bumps, or refactors are included. The scope is appropriately tight.",
      citations: [],
      block_orders: [0],
    }),
  );

  logResult(
    "rate_axis: tests",
    await rateAxisHandler(ctx, {
      axis: "tests",
      verdict: "pass",
      confidence: "high",
      rationale: "n/a for this PR — docs-only change, no testable behavior.",
      details:
        "No application logic was added or changed, so no test coverage is required. The guide itself includes a Phase 7 testing checklist for human verification, which is appropriate for documentation of this kind.",
      citations: [],
      block_orders: [7],
    }),
  );

  logResult(
    "rate_axis: clarity",
    await rateAxisHandler(ctx, {
      axis: "clarity",
      verdict: "concern",
      confidence: "medium",
      rationale:
        "The `ChainId.SOLANA = 3` placeholder value and the empty `interact` dependency array in the hook template are both misleading patterns that could be cargo-culted into real code. These are doc clarity issues, not code bugs.",
      details:
        "Two specific clarity concerns:\n\n1. **`ChainId.SOLANA = 3`** (line 28) — the comment acknowledges this is a deprecated testnet ID used as a placeholder. A developer copying this value without reading the note risks a chain ID collision in production. The guide should defer to the backend enum rather than proposing any numeric value.\n\n2. **`interact` empty dep array** (lines 116–128) — `useCallback(async (...) => { ... }, [])` with no dependencies is a stale-closure anti-pattern. The guide should note the expected deps or at minimum add an inline comment warning the reader to fill them in.",
      citations: [
        {
          file_path: "docs/todos/ADD_NEW_CHAIN_CHECKLIST.md",
          start_line: 28,
          end_line: 28,
          note: "Deprecated testnet ID used as placeholder for ChainId.SOLANA",
        },
      ],
      block_orders: [1, 3],
    }),
  );

  logResult(
    "rate_axis: safety",
    await rateAxisHandler(ctx, {
      axis: "safety",
      verdict: "pass",
      confidence: "high",
      rationale: "n/a for this PR — no auth, payments, migrations, or public API changes.",
      details:
        "This PR touches no auth flows, payment processing, database migrations, or externally-facing API contracts. It adds a documentation file only. There is no security surface to evaluate.",
      citations: [],
      block_orders: [],
    }),
  );

  logResult(
    "rate_axis: consistency",
    await rateAxisHandler(ctx, {
      axis: "consistency",
      verdict: "pass",
      confidence: "medium",
      rationale:
        "Follows existing Stellar pattern as the reference; consistent with the codebase's multi-chain architecture.",
      details:
        "The guide explicitly mirrors the Stellar connector (`useStellarWalletConnector.tsx`) as its reference implementation, using the same hook shape, the same `WalletContextValue` interface, and the same `Interaction` class pattern. The phase structure aligns with how the Stellar integration was built. Consistency with existing practice is good.",
      citations: [],
      block_orders: [2, 4],
    }),
  );

  logResult(
    "rate_axis: api_changes",
    await rateAxisHandler(ctx, {
      axis: "api_changes",
      verdict: "pass",
      confidence: "high",
      rationale: "n/a for this PR — no API routes, schemas, or exported types changed.",
      details:
        "The diff is a single documentation file addition. No Elysia routes, Zod schemas, TypeScript exported types, or WebSocket event payloads were modified. There are no breaking changes to assess.",
      citations: [],
      block_orders: [],
    }),
  );

  logResult(
    "rate_axis: performance",
    await rateAxisHandler(ctx, {
      axis: "performance",
      verdict: "pass",
      confidence: "high",
      rationale: "n/a for this PR — documentation only.",
      details:
        "No runtime code was changed. There are no database queries, loops, or hot-path operations to evaluate. Performance impact of this PR is zero.",
      citations: [],
      block_orders: [],
    }),
  );

  logResult(
    "rate_axis: description",
    await rateAxisHandler(ctx, {
      axis: "description",
      verdict: "concern",
      confidence: "medium",
      rationale:
        "PR title 'feat: checklist for adding new chains types in the frontend' has a grammatical error ('chains types'). The description field should explain why this guide is being added now and link to the Solana integration work it supports.",
      details:
        "The PR title contains a grammatical error: **'chains types'** should be **'chain types'** or simply **'new chain types'**. More substantively, the PR description (not visible in the diff) should:\n\n- Explain *why* this guide is being added now (presumably in support of an in-progress Solana integration)\n- Link to the related Solana integration PR or issue\n- Note that Phase 7 testing is manual and describe what was validated\n\nWithout this context, reviewers have to infer the motivation from the file content alone.",
      citations: [
        {
          file_path: "docs/todos/ADD_NEW_CHAIN_CHECKLIST.md",
          start_line: 1,
          end_line: 5,
          note: "Document title / header — PR title should match and be grammatically correct",
        },
      ],
      block_orders: [0],
    }),
  );

  // ── Finish: complete_walkthrough ──────────────────────────────────────────
  logResult(
    "complete_walkthrough",
    await completeWalkthroughHandler(ctx, {}),
  );

  } // end else (pipeline not yet at phase D)

  console.log("\n" + "=".repeat(60));
  console.log("✓ Pipeline complete. Verifying DB state...");
  console.log("=".repeat(60));

  // ── DB verification ───────────────────────────────────────────────────────
  const { Database } = await import("bun:sqlite");
  const sqlite = new Database(DB_PATH, { readonly: true });

  const row = sqlite
    .query(
      `SELECT id, status, last_completed_phase, summary, sentiment
       FROM walkthroughs
       WHERE id = ?`,
    )
    .get(WALKTHROUGH_ID) as Record<string, unknown> | null;

  console.log("\nwalkthrough row:");
  console.log(JSON.stringify(row, null, 2));

  const blocks = sqlite
    .query(`SELECT COUNT(*) as cnt FROM walkthrough_blocks WHERE walkthrough_id = ?`)
    .get(WALKTHROUGH_ID) as { cnt: number };

  const issues = sqlite
    .query(`SELECT COUNT(*) as cnt FROM walkthrough_issues WHERE walkthrough_id = ?`)
    .get(WALKTHROUGH_ID) as { cnt: number };

  const ratings = sqlite
    .query(`SELECT COUNT(*) as cnt FROM walkthrough_ratings WHERE walkthrough_id = ?`)
    .get(WALKTHROUGH_ID) as { cnt: number };

  // comment_threads links via walkthrough_issue_id → walkthrough_issues.id
  const threads = sqlite
    .query(
      `SELECT COUNT(*) as cnt FROM comment_threads ct
       JOIN walkthrough_issues wi ON ct.walkthrough_issue_id = wi.id
       WHERE wi.walkthrough_id = ?`,
    )
    .get(WALKTHROUGH_ID) as { cnt: number } | null;

  console.log(`\nblocks  count: ${blocks.cnt}  (expected > 0)`);
  console.log(`issues  count: ${issues.cnt}  (expected > 0)`);
  console.log(`ratings count: ${ratings.cnt}  (expected 9)`);
  if (threads) console.log(`threads count: ${threads.cnt}  (expected > 0)`);

  // status stays 'generating' here — the orchestrator (WalkthroughJobs) is
  // responsible for the final status → 'complete' transition. The MCP tool
  // complete_walkthrough is a validation gate only (doctrine invariant #12).
  const allGood =
    row?.last_completed_phase === "D" &&
    blocks.cnt > 0 &&
    issues.cnt > 0 &&
    ratings.cnt === 9;

  if (allGood) {
    console.log("\n✅ All checks passed — walkthrough is complete and verified.");
  } else {
    console.error("\n❌ Verification failed — see above for details.");
    process.exit(1);
  }

  sqlite.close();
}

main().catch((err) => {
  console.error("\n💥 Fatal error:", err);
  process.exit(1);
});
