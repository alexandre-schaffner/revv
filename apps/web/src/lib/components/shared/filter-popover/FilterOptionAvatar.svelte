<script lang="ts">
import Avatar from "$lib/components/shared/Avatar.svelte";

/** The 18px leading mark of a person or team row in a filter popover. */
interface Props {
  kind: "user" | "team";
  /** Avatar data URL; a person without one gets the generic glyph. */
  content?: string | null;
}

let { kind, content = null }: Props = $props();
</script>

<Avatar
	src={kind === 'user' ? content : null}
	size={18}
	fallback={kind}
	glyphSize={kind === 'team' ? 11 : 10}
/>
