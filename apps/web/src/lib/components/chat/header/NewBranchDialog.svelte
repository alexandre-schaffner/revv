<script lang="ts">
// Push the agent's commits to a new branch instead of the PR's. If the remote
// already has that branch, the same dialog asks before force-pushing over it.
import GitBranch from "phosphor-svelte/lib/GitBranch";
import Spinner from "phosphor-svelte/lib/Spinner";
import Warning from "phosphor-svelte/lib/Warning";
import { tick } from "svelte";
import { isPushingProposed, pushProposed } from "$lib/chat/proposed.svelte";
import { Button } from "$lib/components/ui/button";
import * as Dialog from "$lib/components/ui/dialog";
import { Input } from "$lib/components/ui/input";

interface Props {
  prId: string;
  commitCount: number;
  /** The PR's branch; the suggested name builds on it. */
  sourceBranch: string | undefined;
  onPushed: () => void;
}

let { prId, commitCount, sourceBranch, onPushed }: Props = $props();

let open = $state(false);
let mode = $state<"input" | "confirm-overwrite">("input");
let name = $state("");
let inputEl: HTMLInputElement | null = $state(null);

const isPushing = $derived(isPushingProposed(prId));

function suggestedName(): string {
  const base = sourceBranch?.trim();
  return base && base.length > 0 ? `${base}-agent` : "agent-changes";
}

function isValidName(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.length > 0 && !/\s/.test(trimmed) && !trimmed.startsWith("-") && !trimmed.includes("..")
  );
}

export function show(): void {
  mode = "input";
  name = suggestedName();
  open = true;
  void tick().then(() => inputEl?.select());
}

async function submit(): Promise<void> {
  if (mode !== "input") return;
  const branch = name.trim();
  if (!isValidName(branch)) return;
  const result = await pushProposed(prId, { newBranchName: branch });
  if (result?.status === "ref-exists") {
    name = branch;
    mode = "confirm-overwrite";
    return;
  }
  if (result?.status === "pushed") onPushed();
  open = false;
}

async function overwrite(): Promise<void> {
  if (mode !== "confirm-overwrite") return;
  const result = await pushProposed(prId, { newBranchName: name, force: true });
  if (result?.status === "pushed") onPushed();
  open = false;
}
</script>

<Dialog.Root bind:open>
	<Dialog.Portal>
		<Dialog.Overlay />
		<Dialog.Content class="new-branch-dialog-content">
			<Dialog.Header>
				<Dialog.Title>
					<span class="title">
						{#if mode === "input"}
							<GitBranch size={16} />
							Push to a new branch
						{:else}
							<Warning size={16} weight="fill" class="title-warn" />
							Branch already exists
						{/if}
					</span>
				</Dialog.Title>
				<Dialog.Description>
					{#if mode === "input"}
						Push the agent's commits to a brand-new branch on the remote. The
						current PR is not modified.
					{:else}
						<code>{name}</code> already exists on the remote.
						Overwrite it with the agent's commits?
					{/if}
				</Dialog.Description>
			</Dialog.Header>

			{#if mode === "input"}
				<label class="field">
					<span class="label">Branch name</span>
					<Input
						bind:ref={inputEl}
						type="text"
						autocomplete="off"
						spellcheck={false}
						bind:value={name}
						placeholder={suggestedName()}
						disabled={isPushing}
						class="font-mono"
						onkeydown={(e: KeyboardEvent) => {
							if (e.key === "Enter" && isValidName(name)) {
								e.preventDefault();
								void submit();
							}
						}}
					/>
				</label>
				{#if name.length > 0 && !isValidName(name)}
					<p class="hint hint--error">
						Branch names can't be empty, contain spaces, start with
						<code>-</code>, or contain <code>..</code>.
					</p>
				{:else}
					<p class="hint">
						The branch will start at the PR's head SHA plus the
						{commitCount} agent commit{commitCount === 1 ? "" : "s"}.
					</p>
				{/if}
			{:else}
				<p class="hint">
					This force-pushes the new branch and will discard any commits on the
					existing remote ref.
				</p>
			{/if}

			<Dialog.Footer>
				<Button variant="outline" size="sm" onclick={() => (open = false)} disabled={isPushing}>
					Cancel
				</Button>
				{#if mode === "input"}
					<Button
						variant="default"
						size="sm"
						onclick={submit}
						disabled={isPushing || !isValidName(name)}
					>
						{#if isPushing}
							<Spinner size={12} class="motion-essential-spin" />
							Pushing…
						{:else}
							Push
						{/if}
					</Button>
				{:else}
					<Button variant="destructive" size="sm" onclick={overwrite} disabled={isPushing}>
						{#if isPushing}
							<Spinner size={12} class="motion-essential-spin" />
							Overwriting…
						{:else}
							Overwrite
						{/if}
					</Button>
				{/if}
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>

<style>
	:global(.new-branch-dialog-content) {
		max-width: 440px !important;
		width: 100%;
	}

	.title {
		display: inline-flex;
		align-items: center;
		gap: 8px;
	}

	.title :global(.title-warn) {
		color: var(--color-warning);
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: 4px;
	}

	.label {
		font-size: 11px;
		font-weight: 600;
		color: var(--color-text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.hint {
		margin: 0;
		font-size: 11px;
		color: var(--color-text-muted);
		line-height: 1.4;
	}

	.hint--error {
		color: var(--color-danger);
	}

	.hint code {
		font-family: var(--font-mono);
		font-size: 10.5px;
		background: var(--color-bg-tertiary);
		border-radius: 3px;
		padding: 1px 4px;
	}
</style>
