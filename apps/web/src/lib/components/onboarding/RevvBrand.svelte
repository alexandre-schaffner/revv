<script lang="ts">
import { cn } from "$lib/utils";

interface Props {
  variant?: "app" | "onboarding";
  class?: string | undefined;
  "aria-hidden"?: boolean | "true" | "false" | undefined;
}

let { variant = "app", class: className, "aria-hidden": ariaHidden }: Props = $props();
</script>

<div class={cn("revv-brand", `revv-brand-${variant}`, className)} aria-hidden={ariaHidden}>
	<img src="/icon.svg" alt="" class="revv-brand-glyph" />
	<span class="revv-brand-word">Revv</span>
</div>

<style>
	.revv-brand {
		align-items: center;
		display: inline-flex;
		gap: 8px;
		min-width: 0;
	}

	.revv-brand-glyph {
		border-radius: 5px;
		display: block;
		height: 22px;
		width: 22px;
	}

	.revv-brand-word {
		line-height: 1;
	}

	.revv-brand-app .revv-brand-word {
		color: var(--color-text-primary);
		font-size: 12px;
		font-weight: 600;
	}

	.revv-brand-onboarding {
		gap: 10px;
	}

	.revv-brand-onboarding .revv-brand-word {
		color: var(--ob-text-italic);
		font-family: 'Newsreader', Georgia, serif;
		font-size: 17px;
		font-style: italic;
		font-weight: 500;
		letter-spacing: 0.01em;
	}
</style>
