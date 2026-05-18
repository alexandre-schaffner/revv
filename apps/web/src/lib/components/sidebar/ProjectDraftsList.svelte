<script lang="ts">
// Active new-PR draft sessions for the selected repo. Renders nothing
// until the new-PR backend lands (PRD follow-up). When sessions exist,
// each row links to /repo/{repoId}/new-pr/{sessionId}.
//
// Kept as a separate component so wiring the new-PR store later is a
// drop-in: the parent column already reserves the slot.

interface Props {
  repoId: string;
}

let { repoId }: Props = $props();

// Placeholder — list is empty by definition until backend persists
// sessions. The `repoId` prop is read in the void below so the param
// isn't flagged as unused; once the store lands, this is replaced by
// a per-repo derived against new-pr-sessions.svelte.ts.
const sessions = $derived<{ id: string; title: string }[]>(
  (() => {
    void repoId;
    return [];
  })(),
);
</script>

{#if sessions.length > 0}
	<div class="drafts-section select-none">
		<div class="drafts-label">Drafts</div>
		{#each sessions as session (session.id)}
			<a class="draft-row" href="#new-pr-{session.id}">{session.title}</a>
		{/each}
	</div>
{/if}

<style>
	.drafts-section {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 6px 4px;
		border-bottom: 1px solid var(--color-border-subtle, var(--color-border));
	}

	.drafts-label {
		padding: 4px 8px 2px;
		font-size: 10px;
		font-family: var(--font-mono, monospace);
		color: var(--color-text-muted);
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.draft-row {
		padding: 6px 8px;
		border-radius: 5px;
		font-size: 12px;
		color: var(--color-text-secondary);
		text-decoration: none;
		transition: background-color var(--duration-snap), color var(--duration-snap);
	}

	.draft-row:hover {
		background: var(--color-bg-tertiary);
		color: var(--color-text-primary);
	}
</style>
