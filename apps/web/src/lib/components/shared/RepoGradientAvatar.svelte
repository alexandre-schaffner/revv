<script lang="ts">
import { fallbackOwnerHue, ownerHueFromAvatar } from "$lib/utils/avatarPalette";
import { repoGradientDataUrl } from "$lib/utils/repoGradient";

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

const grad = $derived(repoGradientDataUrl(fullName, ownerHue));
const letter = $derived((fullName.split("/")[1] ?? fullName).slice(0, 1).toUpperCase());
</script>

<span
  class="repo-gradient-avatar {className}"
  role="img"
  aria-label={label ?? fullName}
  style:width="{size}px"
  style:height="{size}px"
  style:border-radius="{radius}px"
  style:--rga-size="{size}px"
  style:--rga-text-grad={grad.textGradient}
>
  <img src={grad.url} alt="" class="repo-gradient-avatar-bg" />
  <span class="repo-gradient-avatar-letter" aria-hidden="true">{letter}</span>
</span>

<style>
  .repo-gradient-avatar {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    flex-shrink: 0;
    background: var(--color-bg-elevated);
  }

  .repo-gradient-avatar-bg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .repo-gradient-avatar-letter {
    position: relative;
    z-index: 1;
    font-size: max(7px, calc(var(--rga-size) * 0.48));
    font-weight: 700;
    background: var(--rga-text-grad);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    filter: drop-shadow(0 1px 3px rgba(0, 0, 0, 0.55));
    text-transform: uppercase;
    line-height: 1;
    pointer-events: none;
    user-select: none;
  }
</style>
