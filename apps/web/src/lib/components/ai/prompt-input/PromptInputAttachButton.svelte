<script lang="ts">
import Paperclip from "phosphor-svelte/lib/Paperclip";
import { getContext } from "svelte";
import { PROMPT_INPUT_CTX_KEY, type PromptInputContext } from "./context.js";
import PromptInputButton from "./PromptInputButton.svelte";

const ctx = getContext<PromptInputContext>(PROMPT_INPUT_CTX_KEY);
let inputEl: HTMLInputElement | null = $state(null);

function openPicker() {
  inputEl?.click();
}

function handleChange(e: Event) {
  const target = e.currentTarget as HTMLInputElement;
  ctx.addFiles(Array.from(target.files ?? []));
  target.value = "";
}
</script>

<PromptInputButton tooltip="Attach files" onclick={openPicker} aria-label="Attach files">
	<Paperclip class="size-3.5" />
</PromptInputButton>
<input
	bind:this={inputEl}
	type="file"
	multiple
	class="sr-only"
	tabindex="-1"
	onchange={handleChange}
/>
