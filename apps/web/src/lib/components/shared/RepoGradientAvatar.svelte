<script lang="ts">
import {
  fallbackOwnerPalette,
  ownerPaletteFromAvatar,
  peekOwnerPalette,
  type OwnerPalette,
} from "$lib/utils/avatarPalette";
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

let resolvedOwnerPalette = $state<OwnerPalette | undefined>(undefined);
let hueRequestKey = "";

const fallbackPalette = $derived(fallbackOwnerPalette(fullName));
const ownerPalette = $derived(resolvedOwnerPalette ?? fallbackPalette);

$effect(() => {
  const cachedPalette = ownerAvatarUrl ? peekOwnerPalette(ownerAvatarUrl) : undefined;
  resolvedOwnerPalette = cachedPalette;

  if (!ownerAvatarUrl || cachedPalette !== undefined) return;

  const requestKey = `${ownerAvatarUrl}:${fullName}`;
  hueRequestKey = requestKey;
  void ownerPaletteFromAvatar(ownerAvatarUrl, fallbackPalette).then((palette) => {
    if (hueRequestKey === requestKey) resolvedOwnerPalette = palette;
  });
});

const grad = $derived(repoGradientDataUrl(fullName, ownerPalette));
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
    font-family: var(--font-sans);
    font-size: max(7px, calc(var(--rga-size) * 0.48));
    font-weight: 600;
    background: var(--rga-text-grad);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    text-transform: uppercase;
    line-height: 1;
    pointer-events: none;
    user-select: none;
  }
</style>
