<script lang="ts">
import { repoGradientDataUrl } from "$lib/repoGradient";

interface Props {
  fullName: string;
  size?: number;
  radius?: number;
  class?: string;
}

let { fullName, size = 30, radius = 7, class: className = "" }: Props = $props();

const letter = $derived((fullName.split("/")[1] ?? fullName).slice(0, 1).toUpperCase());
const url = $derived(repoGradientDataUrl(fullName));
</script>

<span
  class="repo-gradient-avatar {className}"
  style:width="{size}px"
  style:height="{size}px"
  style:border-radius="{radius}px"
  style:--rga-size="{size}px"
>
  <img src={url} alt="" class="repo-gradient-avatar-bg" />
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
    color: rgba(255, 255, 255, 0.95);
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.35);
    text-transform: uppercase;
    line-height: 1;
    pointer-events: none;
    user-select: none;
  }
</style>
