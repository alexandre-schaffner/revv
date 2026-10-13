<script lang="ts" module>
import type { PrLabel } from "@revv/shared";

export interface PickerOption {
  /** Unique across the picker. */
  readonly value: string;
  readonly title: string;
  /** Rows group under their section's header, in first-seen order. */
  readonly section: string;
  readonly hint?: string | null;
  readonly avatar?: { readonly content: string | null };
  readonly team?: boolean;
  readonly label?: PrLabel;
}
</script>

<script lang="ts">
import GearSix from "phosphor-svelte/lib/GearSix";
import { untrack } from "svelte";
import { SvelteSet } from "svelte/reactivity";
import FilterOption from "$lib/components/shared/filter-popover/FilterOption.svelte";
import FilterOptionAvatar from "$lib/components/shared/filter-popover/FilterOptionAvatar.svelte";
import FilterPopoverContent from "$lib/components/shared/filter-popover/FilterPopoverContent.svelte";
import FilterSectionHeader from "$lib/components/shared/filter-popover/FilterSectionHeader.svelte";
import FilterStateRow from "$lib/components/shared/filter-popover/FilterStateRow.svelte";
import { Button } from "$lib/components/ui/button/index.js";
import * as Popover from "$lib/components/ui/popover";
import { labelHue } from "$lib/utils/label-colors";

// The sidebar's editor for a set (reviewers, assignees, labels), drawn with
// the same filter-popover parts as the sidebar's creator filter. A gear opens
// it; the edits apply when it closes, the way GitHub's sidebar does: one
// request per close, not one per click.

interface Props {
  /** Accessible name of the trigger, e.g. "Edit reviewers". */
  label: string;
  /** Popover heading, e.g. "Request reviews". */
  title: string;
  placeholder: string;
  /** Values selected right now. */
  selected: ReadonlySet<string>;
  /** Options for a query. Remote pickers re-ask as the search changes. */
  load: (query: string) => Promise<PickerOption[]>;
  /** Re-ask `load` per query; otherwise filter the first answer locally. */
  remote?: boolean;
  onapply: (added: string[], removed: string[]) => void;
  /** Bindable so a keyboard shortcut can open it. */
  open?: boolean;
}

let {
  label,
  title,
  placeholder,
  selected,
  load,
  remote = false,
  onapply,
  open = $bindable(false),
}: Props = $props();

let query = $state("");
let options = $state<PickerOption[]>([]);
let loading = $state(false);
let failed = $state(false);
let draft = $state(new SvelteSet<string>());
const collapsed = new SvelteSet<string>();
/** Options seen this session, so a ticked row stays listed across searches. */
const known = new Map<string, PickerOption>();
let requestSeq = 0;
let lastAsked: string | null = null;

async function fetchOptions(q: string): Promise<void> {
  const seq = ++requestSeq;
  lastAsked = q;
  loading = true;
  failed = false;
  try {
    const next = await load(q);
    if (seq !== requestSeq) return;
    options = next;
    for (const option of next) known.set(option.value, option);
  } catch {
    if (seq === requestSeq) failed = true;
  } finally {
    if (seq === requestSeq) loading = false;
  }
}

function begin(): void {
  draft = new SvelteSet(selected);
  query = "";
  void fetchOptions("");
}

function finish(): void {
  const added = [...draft].filter((v) => !selected.has(v));
  const removed = [...selected].filter((v) => !draft.has(v));
  if (added.length > 0 || removed.length > 0) onapply(added, removed);
}

// Open and close both go through `open`: a click on the gear and a keyboard
// shortcut setting the bound prop alike. bits-ui's `onOpenChange` only fires
// for the former, so the transition is read here instead.
let wasOpen = false;
$effect(() => {
  const isOpen = open;
  if (isOpen === wasOpen) return;
  wasOpen = isOpen;
  untrack(() => (isOpen ? begin() : finish()));
});

// Remote pickers ask GitHub for each search, debounced; `begin` has already
// asked for the empty one.
$effect(() => {
  const q = query;
  if (!remote || q === lastAsked || !untrack(() => open)) return;
  const timer = setTimeout(() => void fetchOptions(q), 180);
  return () => clearTimeout(timer);
});

function toggle(value: string): void {
  if (draft.has(value)) draft.delete(value);
  else draft.add(value);
}

function matches(option: PickerOption, q: string): boolean {
  const needle = q.trim().toLowerCase();
  return (
    !needle ||
    option.title.toLowerCase().includes(needle) ||
    (option.hint?.toLowerCase().includes(needle) ?? false)
  );
}

/**
 * Ticked rows the current answer doesn't list stay on top so they can be
 * unticked; then the answer, filtered locally unless GitHub already did.
 */
const sections = $derived.by(() => {
  const listed = new Set(options.map((o) => o.value));
  const pinned = [...draft]
    .filter((v) => !listed.has(v))
    .map((v) => known.get(v))
    .filter((o): o is PickerOption => o !== undefined && matches(o, query));
  const rows = [...pinned, ...options.filter((o) => remote || matches(o, query))];
  const grouped = new Map<string, PickerOption[]>();
  for (const row of rows) grouped.set(row.section, [...(grouped.get(row.section) ?? []), row]);
  return [...grouped].map(([name, items]) => ({ name, items }));
});

function toggleSection(name: string): void {
  if (collapsed.has(name)) collapsed.delete(name);
  else collapsed.add(name);
}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="icon-xs" aria-label={label} title={label}>
				<GearSix />
			</Button>
		{/snippet}
	</Popover.Trigger>

	<FilterPopoverContent
		{title}
		{placeholder}
		bind:query
		onclear={draft.size > 0 ? () => draft.clear() : undefined}
	>
		{#if failed}
			<FilterStateRow
				message="GitHub didn't answer"
				action={{ label: 'Retry', run: () => void fetchOptions(query) }}
			/>
		{:else if loading && sections.length === 0}
			<FilterStateRow message="Loading" loading />
		{:else if sections.length === 0}
			<FilterStateRow message="No matches" />
		{/if}

		{#each sections as section (section.name)}
			{#if sections.length > 1}
				<FilterSectionHeader
					label={section.name}
					count={section.items.length}
					collapsed={collapsed.has(section.name)}
					ontoggle={() => toggleSection(section.name)}
				/>
			{/if}
			{#if !collapsed.has(section.name)}
				<div class="picker-list">
					{#each section.items as option (option.value)}
						<FilterOption
							checked={draft.has(option.value)}
							label={option.title}
							title={option.hint ? `${option.title} · ${option.hint}` : option.title}
							onclick={() => toggle(option.value)}
						>
							{#snippet leading()}
								{#if option.label}
									{@const hue = labelHue(option.label.color)}
									<span
										class="swatch"
										style="--label-h: {hue.h}; --label-c: {hue.c}"
										aria-hidden="true"
									></span>
								{:else}
									<FilterOptionAvatar
										kind={option.team ? 'team' : 'user'}
										content={option.avatar?.content ?? null}
									/>
								{/if}
							{/snippet}
						</FilterOption>
					{/each}
				</div>
			{/if}
		{/each}
	</FilterPopoverContent>
</Popover.Root>

<style>
	.picker-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	/* A label's hue on LabelChip's ramp, as a dot in the avatar slot. */
	.swatch {
		width: 10px;
		height: 10px;
		border-radius: 999px;
		background: oklch(62% min(var(--label-c), 0.13) var(--label-h));
	}
</style>
