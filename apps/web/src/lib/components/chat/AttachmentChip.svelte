<script lang="ts">
import { formatAttachmentSize } from "@revv/shared";
import File from "phosphor-svelte/lib/File";
import Image from "phosphor-svelte/lib/Image";
import X from "phosphor-svelte/lib/X";

interface Props {
  kind: "image" | "text";
  name: string;
  /** Size in bytes; rendered via the shared formatter. */
  size: number;
  /** `muted` for the composer, `accent` for the user-message transcript bubble. */
  tone?: "muted" | "accent";
  /** When provided, renders a remove button (composer only). */
  onRemove?: (() => void) | undefined;
}

let { kind, name, size, tone = "muted", onRemove }: Props = $props();
</script>

<div
	class={tone === "accent"
		? "flex min-w-0 items-center gap-1.5 rounded-md border border-accent/25 bg-accent/10 px-2 py-1 text-xs text-accent"
		: "flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-1 text-xs text-foreground"}
>
	{#if kind === "image"}
		<Image class={tone === "accent" ? "size-3.5 shrink-0" : "size-3.5 shrink-0 text-accent"} />
	{:else}
		<File
			class={tone === "accent" ? "size-3.5 shrink-0" : "size-3.5 shrink-0 text-muted-foreground"}
		/>
	{/if}
	<span class="min-w-0 truncate">{name}</span>
	<span class={tone === "accent" ? "shrink-0 opacity-70" : "shrink-0 text-muted-foreground"}>
		{formatAttachmentSize(size)}
	</span>
	{#if onRemove}
		<button
			type="button"
			class="ml-0.5 rounded-sm p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
			aria-label="Remove {name}"
			onclick={onRemove}
		>
			<X class="size-3" />
		</button>
	{/if}
</div>
