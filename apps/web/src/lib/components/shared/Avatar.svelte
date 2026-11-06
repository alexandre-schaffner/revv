<script lang="ts">
import Robot from "phosphor-svelte/lib/Robot";
import User from "phosphor-svelte/lib/User";
import UsersThree from "phosphor-svelte/lib/UsersThree";
import type { Snippet } from "svelte";
import { hash32 } from "$lib/utils/hash";

type Fallback = "initials" | "user" | "team" | "robot" | Snippet;

interface Props {
  /** Data URL or remote URL. GHE avatar URLs are signed and expire, so a
   *  failed load falls back rather than showing a broken image. */
  src: string | null | undefined;
  /** Login or display name: initials, swatch hue, default alt and title. */
  name?: string;
  alt?: string;
  size: number;
  radius?: string;
  fallback?: Fallback;
  /** Glyph size for the `user` / `team` / `robot` fallbacks. */
  glyphSize?: number;
  /** Applied to the image and to the built-in fallbacks. Use global classes. */
  class?: string;
}

let {
  src,
  name = "",
  alt,
  size,
  radius = "50%",
  fallback = "initials",
  glyphSize,
  class: className = "",
}: Props = $props();

let failedSrc = $state<string | null>(null);
const showImage = $derived(!!src && failedSrc !== src);

function swatchFor(handle: string): string {
  if (!handle) return "oklch(60% 0 0)";
  const hue = (hash32(handle) / 0xffffffff) * 360;
  // OKLCH keeps perceptual lightness flat across the hue wheel so off-white
  // initials stay legible on every swatch.
  return `oklch(52% 0.13 ${hue.toFixed(1)})`;
}

const glyph = $derived(glyphSize ?? Math.round(size * 0.55));
</script>

{#if showImage}
	<img
		class="pavatar pavatar-img {className}"
		{src}
		alt={alt ?? name}
		style:--avatar-size="{size}px"
		style:--avatar-radius={radius}
		loading="lazy"
		referrerpolicy="no-referrer"
		onerror={() => (failedSrc = src ?? null)}
	/>
{:else if typeof fallback === 'function'}
	{@render fallback()}
{:else if fallback === 'initials'}
	<span
		class="pavatar pavatar-initials {className}"
		style:--avatar-size="{size}px"
		style:--avatar-radius={radius}
		style:--avatar-swatch={swatchFor(name)}
		aria-hidden="true"
		title={name}
	>{(name.charAt(0) || "?").toUpperCase()}</span>
{:else}
	<span
		class="pavatar pavatar-glyph {className}"
		style:--avatar-size="{size}px"
		style:--avatar-radius={radius}
		title={name || undefined}
	>
		{#if fallback === 'team'}
			<UsersThree size={glyph} aria-hidden="true" />
		{:else if fallback === 'robot'}
			<Robot size={glyph} aria-hidden="true" />
		{:else}
			<User size={glyph} aria-hidden="true" />
		{/if}
	</span>
{/if}

<style>
	.pavatar {
		width: var(--avatar-size);
		height: var(--avatar-size);
		border-radius: var(--avatar-radius);
		flex-shrink: 0;
	}

	.pavatar-img {
		display: inline-block;
		object-fit: cover;
	}

	.pavatar-initials {
		display: inline-grid;
		place-items: center;
		font-size: calc(var(--avatar-size) * 0.5);
		font-weight: 600;
		color: oklch(98% 0.003 80);
		line-height: 1;
		letter-spacing: 0;
		user-select: none;
		background: var(--avatar-swatch);
	}

	.pavatar-glyph {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		background: var(--color-bg-elevated);
		color: var(--color-text-muted);
	}
</style>
