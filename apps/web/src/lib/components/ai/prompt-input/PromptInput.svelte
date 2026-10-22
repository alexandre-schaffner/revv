<script lang="ts" module>
import type { HTMLFormAttributes } from "svelte/elements";
import type { PromptInputMessage, PromptInputStatus } from "./context.js";

export type PromptInputProps = Omit<HTMLFormAttributes, "onsubmit"> & {
  /** Two-way bound text value. Shared with PromptInputTextarea via bind:value on both. */
  value?: string;
  /** Handler called when the form is submitted with message text. */
  onsubmit?: (message: PromptInputMessage) => void;
  /** Current chat status. */
  status?: PromptInputStatus;
  /** Handler called when a stop is requested. */
  onstop?: () => void;
};
</script>

<script lang="ts">
	import { setContext } from "svelte";
	import { toast } from "svelte-sonner";
	import { classifyFile } from "$lib/chat/attachments.js";
	import { cn } from "$lib/utils.js";
	import { PROMPT_INPUT_CTX_KEY, type PromptInputContext } from "./context.js";

	let {
		value = $bindable(""),
		onsubmit: onSubmit,
		onstop: onStop,
		status = "ready",
		children,
		class: className,
		...restProps
	}: PromptInputProps = $props();

	let files = $state<File[]>([]);
	let dragActive = $state(false);

	function addFiles(nextFiles: readonly File[]): number {
		if (nextFiles.length === 0) return 0;
		// Reject unsupported types here, at the single entry point, so the
		// composer never shows a chip for a file the encoder would silently drop
		// on submit. The chip preview and encode path agree by construction.
		const accepted: File[] = [];
		const rejected: string[] = [];
		for (const file of nextFiles) {
			if (classifyFile(file) === "unsupported") rejected.push(file.name);
			else accepted.push(file);
		}
		if (rejected.length > 0) {
			toast.error(
				rejected.length === 1
					? `${rejected[0]} is not a supported attachment type.`
					: `${rejected.length} files are not supported attachment types.`,
			);
		}
		if (accepted.length === 0) return 0;
		files = [...files, ...accepted];
		return accepted.length;
	}

	function removeFile(index: number) {
		files = files.filter((_, i) => i !== index);
	}

	function submit() {
		const trimmed = value.trim();
		if (!trimmed && files.length === 0) return;
		onSubmit?.({ text: trimmed, files });
		value = "";
		files = [];
	}

	function stop() {
		onStop?.();
	}

	function handleFormSubmit(e: SubmitEvent) {
		e.preventDefault();
		if (status === "streaming" || status === "submitted") {
			stop();
		} else {
			submit();
		}
	}

	function handlePaste(e: ClipboardEvent) {
		const pasted = Array.from(e.clipboardData?.files ?? []);
		if (pasted.length === 0) return;
		addFiles(pasted);
	}

	function handleDragOver(e: DragEvent) {
		if (!e.dataTransfer || Array.from(e.dataTransfer.items).every((item) => item.kind !== "file")) {
			return;
		}
		e.preventDefault();
		dragActive = true;
	}

	function handleDragLeave(e: DragEvent) {
		if (e.currentTarget === e.target) dragActive = false;
	}

	function handleDrop(e: DragEvent) {
		const dropped = Array.from(e.dataTransfer?.files ?? []);
		if (dropped.length === 0) return;
		e.preventDefault();
		dragActive = false;
		const added = addFiles(dropped);
		if (added > 0) toast.message(added === 1 ? "Attached file" : "Attached files");
	}

	const ctx: PromptInputContext = {
		get status() { return status; },
		get value() { return value; },
		get files() { return files; },
		setValue(v: string) { value = v; },
		addFiles,
		removeFile,
		submit,
		stop,
	};
	setContext(PROMPT_INPUT_CTX_KEY, ctx);
</script>

<form
	data-slot="prompt-input"
	class={cn(
		"relative flex flex-col rounded-xl border border-border bg-background shadow-xs",
		dragActive && "border-accent shadow-sm shadow-accent/20",
		className,
	)}
	onsubmit={handleFormSubmit}
	onpaste={handlePaste}
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
	{...restProps}
>
	{@render children?.()}
</form>
