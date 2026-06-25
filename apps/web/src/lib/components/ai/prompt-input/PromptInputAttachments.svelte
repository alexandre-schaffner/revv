<script lang="ts">
import { getContext } from "svelte";
import AttachmentChip from "$lib/components/ai/AttachmentChip.svelte";
import { gsapFadeY, tokens } from "$lib/motion";
import { PROMPT_INPUT_CTX_KEY, type PromptInputContext } from "./context.js";

const ctx = getContext<PromptInputContext>(PROMPT_INPUT_CTX_KEY);
</script>

{#if ctx.files.length > 0}
	<div class="flex flex-wrap gap-1.5 px-3 pt-2">
		{#each ctx.files as file, index (`${file.name}-${file.size}-${index}`)}
			<div
				in:gsapFadeY={{ y: 3, duration: tokens.quick }}
				out:gsapFadeY={{ y: -3, duration: tokens.snap }}
			>
				<AttachmentChip
					kind={file.type.startsWith("image/") ? "image" : "text"}
					name={file.name}
					size={file.size}
					onRemove={() => ctx.removeFile(index)}
				/>
			</div>
		{/each}
	</div>
{/if}
