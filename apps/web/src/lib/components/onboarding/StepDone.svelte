<script lang="ts">
import { onMount } from "svelte";
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import { gsapEnter, tokens } from "$lib/motion";
import { completeOnboarding, endOnboardingReplay } from "$lib/stores/auth.svelte";

// Long enough to read the closing message; completing swaps the gate to the app.
const READ_DELAY_MS = 2200;

onMount(() => {
  const timer = setTimeout(() => {
    endOnboardingReplay();
    void completeOnboarding();
  }, READ_DELAY_MS);
  return () => clearTimeout(timer);
});
</script>

<div class="done" use:gsapEnter={{ y: 8, duration: tokens.ceremonialSlow }}>
	<div class="ornament">
		<Dotmatrix variant="square-14" />
	</div>

	<p class="lede">
		Walkthroughs and ratings will appear as your pull requests are read.
		The first one is preparing now.
	</p>

	<div class="footer-row" use:gsapEnter={{ duration: tokens.ceremonialSlow, delay: 0.6 }}>
		<span class="dash"></span>
		<span class="label">Fin</span>
		<span class="dash"></span>
	</div>
</div>

<style>
	.done {
		display: flex;
		flex-direction: column;
		gap: 32px;
		max-width: 520px;
	}

	.ornament {
		display: flex;
		justify-content: flex-start;
	}

	.lede {
		font-family: 'Newsreader', Georgia, serif;
		font-size: 18px;
		font-weight: 400;
		font-style: italic;
		line-height: 1.55;
		color: var(--ob-text-body);
		margin: 0;
	}

	.footer-row {
		display: flex;
		align-items: center;
		gap: 14px;
		padding-top: 16px;
	}

	.dash {
		flex: 0 0 28px;
		height: 1px;
		background: var(--ob-text-dimmed);
	}

	.label {
		font-family: 'Newsreader', Georgia, serif;
		font-style: italic;
		font-size: 14px;
		color: var(--ob-text-label);
		letter-spacing: 0.08em;
	}
</style>
