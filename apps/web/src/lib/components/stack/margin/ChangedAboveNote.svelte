<script lang="ts">
/*
 * "Changed again above": upper layers of the stack change the file this
 * issue or chapter is about. A fix asked for here lands under their changes,
 * so the reader should look at them first.
 */
import PencilLine from "phosphor-svelte/lib/PencilLine";
import { plural } from "$lib/utils/plural";
import Joined from "./Joined.svelte";
import LayerChip from "./LayerChip.svelte";
import MarginNote from "./MarginNote.svelte";
import { baseName, type ChangedAbove, type StackPlace } from "./stack-margin";

interface Props {
  note: ChangedAbove;
  place: StackPlace;
  /** Beside an issue: the note says what that means for a fix. */
  forIssue?: boolean;
}

let { note, place, forIssue = false }: Props = $props();

/** Room for two names; the rest are counted. */
const SHOWN_FILES = 2;
type FileItem = { kind: "file"; path: string } | { kind: "more"; count: number };

const files = $derived.by((): FileItem[] => {
  const shown: FileItem[] = note.files
    .slice(0, SHOWN_FILES)
    .map((path) => ({ kind: "file", path }));
  const more = note.files.length - shown.length;
  return more > 0 ? [...shown, { kind: "more", count: more }] : shown;
});
</script>

<MarginNote icon={PencilLine} label="Changed again above">
	<p>
		<Joined items={note.layers} key={(layer) => layer.number}>{#snippet item(layer)}<LayerChip {layer} {place} />{/snippet}</Joined>
		{note.layers.length === 1 ? 'also changes' : 'also change'}
		<Joined items={files} key={(f) => (f.kind === 'file' ? f.path : '')}>{#snippet item(f)}{#if f.kind === 'file'}<code title={f.path}>{baseName(f.path)}</code>{:else}{plural(f.count, 'more file')}{/if}{/snippet}</Joined>.
		{#if forIssue}Look there before asking for a fix here.{/if}
	</p>
</MarginNote>
