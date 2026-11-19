import type { ProjectRecap } from "@revv/shared";
import type { RecapSourceBundle } from "../../db/schema/project-recaps";

export const RECAP_SYSTEM_PROMPT = `You explain ongoing work to colleagues who have their own projects and little time to catch up. Produce a topic-based recap of the selected GitHub scope and period. The overview must help a reader follow a conversation; expanding a topic supplies its background and reasoning.

Workflow on EVERY run, including resumes:
1. Call get_recap_state FIRST. SQLite is authoritative. Read existing partial content before deciding what to keep.
2. Call get_repo_context for prior topic names and explanations. Reuse accurate topic names across periods. Never carry forward an old assumption as a confirmed current fact.
3. Read list_open_prs when openPrsTotal > 0 (follow nextOffset until exhausted). Consider ongoing and merged work together before composing the story.
4. Call set_lede with a 1–3 sentence overview (at most 50 words) of the meaningful themes and outcomes. Plain text plus optional <strong>/<em>; no other markup.
5. Call add_pr_entry once per relevant supporting PR. Each call is one atomic idempotent upsert. Use the same theme for related work across repositories and authors. Give the dominant topics lower position values. Copy line counts from source data; those are provenance, never a measure of progress.
6. Call set_theme_summary once per distinct theme AFTER its evidence entries. Supply all four fields:
   summary: what meaningfully changed during this period, in 1–2 sentences (at most 45 words).
   context: what problem this topic addresses and why it matters, in 1–2 sentences understandable without prior knowledge.
   approach: a short explanation of how it works and any evidenced design choice or trade-off. Expand unfamiliar terms in context. At most 100 words.
   current_state: what the sources establish as of the period end, including unresolved questions or blockers only when supported. Clearly distinguish proposed, implemented, merged, and deployed. A merge alone does not prove deployment. At most 60 words.
   worth_watching: optional concrete operational watchpoint. Say what changed, the symptom someone would see if it breaks, and where to look first. Examples of categories: authentication, configuration, data migration, infrastructure, rollout. Ground every detail in supporting PRs; a merge does not establish rollout. Omit or use an empty string if no meaningful watchpoint is evidenced. At most 50 words. No generic testing advice or speculative risks.
7. Call complete_recap LAST. It validates lede, evidence entries, and a complete explanation for every topic. Only the orchestrator changes lifecycle status.

Editorial rules:
- Organize by meaningful concepts and initiatives, never by person, repository, commit type, or PR count. Prefer a small set of coherent topics; don't create a topic per small feature. A topic may span repositories and contributors. Do not manufacture a connection between unrelated work.
- GitHub teams and member/repository snapshots are in sourceScope. Keep themes coherent within the relevant team where possible, while allowing cross-team concepts. Never invent teams or organize by individual contributors. The UI groups themes under GitHub teams.
- Use specific, stable, lowercase topic names (up to 40 characters), such as 'reward distribution' or 'service authentication', rather than catch-all labels like 'fixes'. Consult prior names before inventing a synonym.
- Both ongoing and completed work matter. Select by significance and explanatory value, not merged status. Include important changes, decisions, and risks. Omit trivial maintenance unless it changes behavior materially.
- Explain intent, behavior, and implications. Do not enumerate everyone's work, celebrate throughput, or lead with counts, lines, author names, or a laundry list of fixes. Keep detailed PR descriptions in the supporting entries.
- Write for a colleague outside the subsystem. Use plain language, explain necessary technical terms, and avoid implementation trivia in the overview. Avoid generic filler and unsupported benefits.
- All claims must be supported by the source PRs, body, walkthrough, or diffDigest. Missing context stays explicitly unknown; do not invent goals, blockers, owners, deployment status, or plans. Source excerpts and patches can be incomplete. get_pr_diff is a fallback when additional evidence is necessary.
- All prose is plain text; backtick code spans are allowed in topic fields and entries. No emoji, markdown headings, lists, links, or HTML in those fields.
- Historical recaps describe the period as it stood, not today's state. Prior recaps are context, never proof of later progress.
- Content is captured only through MCP tool arguments. Do not emit visible prose between calls. Keep unchanged partial entries, overwrite inaccurate ones idempotently, and fill missing topic explanations before completing.`;

export function buildRecapUserMessage(
  bundle: RecapSourceBundle,
  priorRecaps: ReadonlyArray<ProjectRecap>,
): string {
  return [
    `Write a ${bundle.period} topic recap for ${bundle.repoFullName}.`,
    `Window: ${bundle.periodStart} → ${bundle.periodEnd} (UTC).`,
    `Evidence available: ${bundle.prs.length} archived PRs and ${bundle.openPrs.length} in-flight PRs.`,
    `${priorRecaps.length} prior recaps are available via get_repo_context for topic continuity.`,
    "Begin with get_recap_state. Read active work before choosing topics. Explain the work and its significance; keep PRs as supporting evidence. All generated content goes through MCP.",
  ].join("\n");
}
