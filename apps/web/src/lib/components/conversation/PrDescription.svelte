<script lang="ts">
import { Editor } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import { onDestroy, onMount, untrack } from "svelte";
import { Button } from "$lib/components/ui/button/index.js";
import { renderUntrustedMarkdown } from "$lib/utils/markdown";
import { interceptExternalLinks, openExternal } from "$lib/utils/open-external";
import {
  DescriptionCodec,
  type DescriptionSource,
  descriptionExtensions,
  RawBlock,
} from "./description-doc";

// The PR description, editable where it's read: click into the text and
// type. It saves when the editor loses focus (Esc or ⌘↵ also finish), and
// only the blocks that changed are rewritten (see description-doc.ts). A
// failed save keeps the draft on screen until it lands or is discarded.

interface Props {
  body: string;
  /** Absent when the viewer can't edit the description. */
  onsave?: ((body: string) => Promise<boolean>) | undefined;
}

let { body, onsave }: Props = $props();

type SaveState = "idle" | "saving" | "failed";

const editable = $derived(!!onsave);

let element = $state<HTMLDivElement | null>(null);
let editor: Editor | null = null;
let source: DescriptionSource | null = null;
/** The markdown the editor was loaded from or last saved. */
let baseline = "";
let focused = $state(false);
let saveState = $state<SaveState>("idle");

// The verbatim blocks render through the same sanitizer as every other
// GitHub markdown surface, and stay out of the editable text.
const RawBlockView = RawBlock.extend({
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.className = "raw-block";
      dom.contentEditable = "false";
      dom.innerHTML = renderUntrustedMarkdown(String(node.attrs.raw ?? ""));
      // An HTML comment renders nothing; it rides along unseen.
      if (!dom.textContent?.trim() && !dom.querySelector("img, video, svg")) {
        dom.classList.add("raw-block--empty");
      }
      dom.addEventListener("click", interceptExternalLinks);
      return {
        dom,
        // `<details>` toggles and link clicks are the block's own business.
        stopEvent: (event) => event.type === "click" || event.type === "mousedown",
        ignoreMutation: () => true,
      };
    };
  },
});

const extensions = descriptionExtensions(RawBlockView);
const codec = new DescriptionCodec(extensions);

function current(): string | null {
  if (!editor || !source) return null;
  return codec.serialize(editor.getJSON(), source);
}

function load(markdown: string): void {
  if (!editor) return;
  const parsed = codec.parse(markdown);
  source = parsed.source;
  baseline = markdown;
  saveState = "idle";
  editor.commands.setContent(parsed.doc, { emitUpdate: false });
}

async function save(): Promise<void> {
  if (!onsave || saveState === "saving") return;
  const next = current();
  if (next === null || next === baseline) {
    if (saveState === "failed") saveState = "idle";
    return;
  }
  saveState = "saving";
  const landed = await onsave(next);
  if (!landed) {
    saveState = "failed";
    return;
  }
  baseline = next;
  saveState = "idle";
  // Changed while the save was in flight: typing lands on the next blur, a
  // task box ticked from outside the text lands now.
  if (!focused) void save();
}

function discard(): void {
  load(body);
}

onMount(() => {
  if (!element) return;
  const parsed = codec.parse(body);
  source = parsed.source;
  baseline = body;
  editor = new Editor({
    element,
    extensions: [
      ...extensions,
      Placeholder.configure({
        placeholder: () => (editable ? "Add a description" : "No description provided."),
        showOnlyWhenEditable: false,
      }),
    ],
    content: parsed.doc,
    editable,
    editorProps: {
      attributes: {
        class: "markdown-body prose prose-sm prose-dense description-doc",
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": "Pull request description",
      },
      // Links open in the browser, as they do in every read-only view.
      handleClick(_view, _pos, event) {
        const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
        if (!(anchor instanceof HTMLAnchorElement)) return false;
        event.preventDefault();
        void openExternal(anchor.href);
        return true;
      },
      handleKeyDown(view, event) {
        const finish =
          event.key === "Escape" || (event.key === "Enter" && (event.metaKey || event.ctrlKey));
        if (!finish) return false;
        event.preventDefault();
        event.stopPropagation();
        view.dom.blur();
        return true;
      },
    },
    onFocus: () => {
      focused = true;
    },
    onBlur: () => {
      focused = false;
      void save();
    },
    // A task box ticked without focusing the text still has to land.
    onUpdate: ({ editor: e }) => {
      if (!e.isFocused) void save();
    },
  });
});

// No save on teardown: by then the page may already be showing another PR,
// and blur has saved whatever was typed before focus left.
onDestroy(() => {
  editor?.destroy();
  editor = null;
});

$effect(() => {
  const next = editable;
  untrack(() => editor?.setEditable(next, false));
});

// A newer description from GitHub replaces what's shown, unless the viewer
// is mid-edit or holding an unsaved draft.
$effect(() => {
  const next = body;
  untrack(() => {
    if (!editor || focused || saveState !== "idle" || next === baseline) return;
    if (current() !== baseline) return;
    load(next);
  });
});
</script>

<section class="description" aria-label="Description">
	<!-- Floats in the gap above the text, so focusing doesn't shift it. -->
	<div class="description-status" role="status">
		{#if saveState === 'saving'}
			<span class="description-note">Saving</span>
		{:else if saveState === 'failed'}
			<span class="description-note description-note--failed">Not saved</span>
			<Button variant="ghost" size="xs" onclick={() => void save()}>Retry</Button>
			<Button variant="ghost" size="xs" onclick={discard}>Discard</Button>
		{:else if focused}
			<span class="description-note">Saves when you click away</span>
		{/if}
	</div>

	<div class="description-body" class:description-body--editable={editable} bind:this={element}></div>
</section>

<style>
	.description {
		position: relative;
		min-width: 0;
		padding-top: 12px;
	}

	.description-status {
		position: absolute;
		top: -14px;
		right: 0;
		display: flex;
		align-items: center;
		gap: 2px;
		height: 24px;
	}

	.description-note {
		padding-right: 4px;
		font-size: 0.75rem;
		color: var(--color-text-muted);
	}

	.description-note--failed {
		color: var(--color-danger);
	}

	.description-body :global(.description-doc) {
		max-width: none;
		min-height: 1.5em;
		overflow-wrap: anywhere;
		outline: none;
	}

	.description-body--editable :global(.description-doc) {
		cursor: text;
		caret-color: var(--color-accent);
	}

	.description-body :global(.is-editor-empty:first-child::before) {
		content: attr(data-placeholder);
		float: left;
		height: 0;
		pointer-events: none;
		font-style: italic;
		color: var(--color-text-muted);
	}

	/* ProseMirror wraps every list item's text in a paragraph; marked's
	   tight lists don't, and the read-only views render those. */
	.description-body :global(li > p) {
		margin-top: 0;
		margin-bottom: 0;
	}

	.description-body :global(.ProseMirror-selectednode) {
		outline: 2px solid var(--color-accent);
		outline-offset: 2px;
		border-radius: 4px;
	}

	.description-body :global(.raw-block--empty) {
		display: none;
	}

	.description-body :global(.tableWrapper) {
		overflow-x: auto;
	}

	.description-body :global(ul[data-type='taskList']) {
		padding-left: 0;
		list-style: none;
	}

	.description-body :global(ul[data-type='taskList'] li) {
		display: flex;
		align-items: baseline;
		gap: 8px;
		padding-left: 0;
	}

	.description-body :global(ul[data-type='taskList'] li::before) {
		content: none;
	}

	.description-body :global(ul[data-type='taskList'] li > label) {
		flex-shrink: 0;
		user-select: none;
	}

	.description-body :global(ul[data-type='taskList'] li > div) {
		flex: 1;
		min-width: 0;
	}

	.description-body :global(ul[data-type='taskList'] li > div > p) {
		margin: 0;
	}
</style>
