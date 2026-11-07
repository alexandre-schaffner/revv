<script lang="ts">
/** The one glyph per issue severity; it takes its colour from the parent. */
import type { IssueSeverity } from "@revv/shared";
import Info from "phosphor-svelte/lib/Info";
import Warning from "phosphor-svelte/lib/Warning";
import WarningOctagon from "phosphor-svelte/lib/WarningOctagon";

interface Props {
  severity: IssueSeverity;
  size: number;
}

let { severity, size }: Props = $props();

const ICON = {
  critical: { glyph: WarningOctagon, weight: "fill" },
  warning: { glyph: Warning, weight: "fill" },
  info: { glyph: Info, weight: "regular" },
} as const;

const Glyph = $derived(ICON[severity].glyph);
</script>

<Glyph {size} weight={ICON[severity].weight} />
