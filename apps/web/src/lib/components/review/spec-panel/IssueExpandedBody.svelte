<script lang="ts">
/** An open issue row, like a rustc diagnostic: the description, its resolution, then references. */
import {
  EXTERNAL_AGENT_PROVIDER_NAMES,
  issueResolutionLabel,
  type WalkthroughIssue,
} from "@revv/shared";
import FileBadge from "$lib/components/ui/FileBadge.svelte";
import { openInDiff } from "$lib/stores/review-nav.svelte";
import { getStepLabel } from "$lib/walkthrough/store.svelte";
import SpecExpandedBody from "./SpecExpandedBody.svelte";
import SpecReferences from "./SpecReferences.svelte";
import SpecSection from "./SpecSection.svelte";
import SpecStepLinks from "./SpecStepLinks.svelte";

interface Props {
  prId: string;
  issue: WalkthroughIssue;
}

let { prId, issue }: Props = $props();

const resolutionLabel = $derived(issueResolutionLabel(issue.resolutionStatus));
const hasStepLinks = $derived(issue.blockIds.some((id) => getStepLabel(prId, id) !== null));
</script>

<SpecExpandedBody>
    <SpecSection label="diagnostic" lead>
        <p class="description">{issue.description}</p>
    </SpecSection>

    {#if resolutionLabel}
        <SpecSection label="resolution">
            <div class="resolution">
                <p class="resolution-head">
                    <strong>{resolutionLabel}</strong>
                    {#if issue.resolvedBy}
                        <span class="resolution-agent"
                            >by {EXTERNAL_AGENT_PROVIDER_NAMES[issue.resolvedBy]}</span
                        >
                    {/if}
                </p>
                {#if issue.resolutionExplanation}
                    <p>{issue.resolutionExplanation}</p>
                {/if}
                {#if issue.resolvingCommitSha}
                    <code>commit {issue.resolvingCommitSha.slice(0, 12)}</code>
                {/if}
                {#if issue.resolutionEvidence?.length}
                    <ul>
                        {#each issue.resolutionEvidence as evidence (evidence)}
                            <li>{evidence}</li>
                        {/each}
                    </ul>
                {/if}
            </div>
        </SpecSection>
    {/if}

    {#if issue.filePath || hasStepLinks}
        <SpecSection label="references">
            {#if issue.filePath}
                {@const filePath = issue.filePath}
                <SpecReferences>
                    <li>
                        <FileBadge
                            {filePath}
                            startLine={issue.startLine}
                            endLine={issue.endLine}
                            onclick={() => openInDiff(prId, filePath, issue.startLine ?? 1)}
                        />
                    </li>
                </SpecReferences>
            {/if}
            <SpecStepLinks {prId} blockIds={issue.blockIds} tone="row" />
        </SpecSection>
    {/if}
</SpecExpandedBody>

<style>
    .description {
        font-family: var(--font-sans);
        font-size: 13px;
        line-height: 1.55;
        color: var(--color-text-primary);
        margin: 0;
        max-width: 65ch;
    }

    .resolution {
        display: flex;
        flex-direction: column;
        gap: 6px;
        color: var(--color-text-secondary);
    }

    .resolution-head {
        display: flex;
        align-items: baseline;
        gap: 6px;
    }

    .resolution strong {
        color: var(--color-success);
        font-family: var(--font-sans);
        font-size: 13px;
    }

    .resolution-agent {
        color: var(--color-text-muted);
        font-size: 12px;
    }

    .resolution p,
    .resolution ul {
        margin: 0;
    }

    .resolution ul {
        padding-left: 18px;
    }

    .resolution code {
        width: fit-content;
        color: var(--color-text-muted);
    }
</style>
