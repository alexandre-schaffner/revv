<script lang="ts">
interface Props {
  handle: string;
  /** Base64 data URL or remote URL of the avatar image. */
  avatarContent?: string | null;
  size?: number;
}

let { handle, avatarContent = null, size = 22 }: Props = $props();

let imgFailed = $state(false);

$effect(() => {
  avatarContent;
  imgFailed = false;
});

// Stable hue from the handle — used only when the real avatar image is
// unavailable. Avatars are cross-recap so we don't use the per-recap palette
// distribution that themes use.
function swatchFor(handle: string): string {
  if (!handle) return "oklch(60% 0 0)";
  let hash = 0x811c9dc5;
  for (let i = 0; i < handle.length; i++) {
    hash ^= handle.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  const hue = (hash / 0xffffffff) * 360;
  // Lightness 52% with chroma 0.13 gives enough saturation to read as
  // identity-coded, while OKLCH keeps perceptual lightness flat across the
  // hue wheel so off-white initials stay legible on every swatch.
  return `oklch(52% 0.13 ${hue.toFixed(1)})`;
}

const initial = $derived((handle?.charAt(0) ?? "?").toUpperCase());
const swatch = $derived(swatchFor(handle ?? ""));
const showImage = $derived(!!avatarContent && !imgFailed);
</script>

{#if showImage}
  <img
    class="avatar avatar-img"
    src={avatarContent}
    alt={handle}
    style="--avatar-size: {size}px"
    loading="lazy"
    referrerpolicy="no-referrer"
    onerror={() => (imgFailed = true)}
  />
{:else}
  <span
    class="avatar"
    style="--avatar-size: {size}px; --avatar-swatch: {swatch}"
    aria-hidden="true"
    title={handle}
  >{initial}</span>
{/if}

<style>
.avatar {
  display: inline-grid;
  place-items: center;
  width: var(--avatar-size);
  height: var(--avatar-size);
  border-radius: 50%;
  font-size: calc(var(--avatar-size) * 0.5);
  font-weight: 600;
  color: oklch(98% 0.003 80);
  line-height: 1;
  letter-spacing: 0;
  user-select: none;
  background: var(--avatar-swatch, var(--color-text-muted));
}

.avatar-img {
  object-fit: cover;
  background: transparent;
  display: inline-block;
}
</style>
