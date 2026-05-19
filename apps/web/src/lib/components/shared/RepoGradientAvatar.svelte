<script lang="ts">
import { getActiveTheme } from "$lib/stores/theme.svelte";
import { fallbackOwnerHue, ownerHueFromAvatar, repoGradient } from "$lib/utils/avatarPalette";

interface Props {
  fullName: string;
  ownerAvatarUrl?: string | null;
  size?: number;
  radius?: number;
  class?: string;
  label?: string;
}

let {
  fullName,
  ownerAvatarUrl = null,
  size = 30,
  radius = 7,
  class: className = "",
  label,
}: Props = $props();

const theme = $derived(getActiveTheme());

// Hash-based fallback renders immediately; $effect resolves the real hue
// from the locally-cached image (fast) or fetches from the network (first visit).
let ownerHue = $state(fallbackOwnerHue(fullName));

$effect(() => {
  ownerHue = fallbackOwnerHue(fullName);
  if (!ownerAvatarUrl) return;

  let stale = false;
  ownerHueFromAvatar(ownerAvatarUrl).then((hue) => {
    if (!stale) ownerHue = hue;
  });
  return () => {
    stale = true;
  };
});

const gradient = $derived(repoGradient(fullName, ownerHue, theme));
const letters = $derived(deriveLetters(fullName, size));

function deriveLetters(name: string, sz: number): string {
  const source = name.split("/")[1] ?? name;
  const stripped = source.replace(/^[^\p{L}\p{N}]+/u, "");
  if (stripped.length === 0) return "?";
  const chars = [...stripped];
  const first = chars[0] ?? "";
  const second = chars[1];
  if (sz < 22 || second === undefined) {
    return first.toLocaleUpperCase();
  }
  return first.toLocaleUpperCase() + second.toLocaleLowerCase();
}
</script>

<span
	class="rga {className}"
	role="img"
	aria-label={label ?? fullName}
	style:width="{size}px"
	style:height="{size}px"
	style:border-radius="{radius}px"
	style:background={gradient.background}
	style:--rga-size="{size}px"
	style:--rga-text-grad={gradient.textGradient}
>
	<span class="rga-letters" aria-hidden="true">{letters}</span>
</span>

<style>
	.rga {
		position: relative;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		overflow: hidden;
		flex-shrink: 0;
	}

	.rga-letters {
		font-family: var(--font-sans);
		font-weight: 650;
		font-size: clamp(8px, calc(var(--rga-size) * 0.44), 28px);
		letter-spacing: -0.035em;
		font-feature-settings: "case", "ss01", "calt";
		line-height: 1;
		background: var(--rga-text-grad);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
		filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.4));
		user-select: none;
		position: relative;
		z-index: 1;
	}

	@media (forced-colors: active) {
		.rga {
			background: Canvas !important;
			box-shadow: inset 0 0 0 1px CanvasText;
		}
		.rga-letters {
			background: none;
			-webkit-background-clip: unset;
			background-clip: unset;
			color: CanvasText;
			filter: none;
		}
	}
</style>
