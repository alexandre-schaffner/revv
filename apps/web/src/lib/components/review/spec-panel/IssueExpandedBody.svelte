<script lang="ts">
/** An open issue row, like a rustc diagnostic: the description, its resolution, then references. */
import {
  EXTERNAL_AGENT_PROVIDER_NAMES,
  type WalkthroughBlock,
  type WalkthroughIssue,
} from "@revv/shared";
import FileBadge from "$lib/components/ui/FileBadge.svelte";
import SpecExpandedBody from "./SpecExpandedBody.svelte";
import SpecReferences from "./SpecReferences.svelte";
import SpecSection from "./SpecSection.svelte";
import SpecStepLinks, { resolveStepLinks } from "./SpecStepLinks.svelte";

interface Props {
  issue: WalkthroughIssue;
  blocks: WalkthroughBlock[];
  onFileClick?: ((filePath: string, line: number) => void) | undefined;
  /** Step chips render only when this is supplied. */
  onBlockJump?: ((blockId: string) => void) | undefined;
}

let { issue, blocks, onFileClick, onBlockJump }: Props = $props();

const stepLinks = $derived(onBlockJump ? resolveStepLinks(issue.blockIds, blocks) : []);
</script>

<SpecExpandedBody>
    <SpecSection label="diagnostic" lead>
        <p class="description">{issue.description}</p>
    </SpecSection>

    {#if issue.resolutionStatus === 'addressed' || issue.resolutionStatus === 'wont_fix'}
        <SpecSection label="resolution">
            <div class="resolution">
                <p class="resolution-head">
                    <strong>{issue.resolutionStatus === 'addressed' ? 'Addressed' : "Won't fix"}</strong>
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

    {#if issue.filePath || (stepLinks.length > 0 && onBlockJump)}
        <SpecSection label="references">
            {#if issue.filePath}
                {@const filePath = issue.filePath}
                <SpecReferences>
                    <li>
                        <FileBadge
                            {filePath}
                            startLine={issue.startLine}
                            endLine={issue.endLine}
                            onclick={onFileClick
                                ? () => onFileClick(filePath, issue.startLine ?? 1)
                                : undefined}
                        />
                    </li>
                </SpecReferences>
            {/if}
            {#if stepLinks.length > 0 && onBlockJump}
                <SpecStepLinks links={stepLinks} onJump={onBlockJump} tone="row" />
            {/if}
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
