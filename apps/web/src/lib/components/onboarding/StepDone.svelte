<script lang="ts">
import { onMount } from "svelte";
import { Dotmatrix } from "$lib/components/ui/dotmatrix";
import { completeOnboarding, getIsOnboarded } from "$lib/stores/auth.svelte";

interface Props {
  onFinish: () => void;
}

let { onFinish }: Props = $props();

onMount(() => {
  let attempts = 0;
  const maxAttempts = 5;

  async function tryComplete() {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem("revv-onboarding-replay");
    }
    try {
      await completeOnboarding();
    } catch {
      // Retry below will handle it
    }
    if (getIsOnboarded()) {
      onFinish();
      return;
    }
    // Retry if not yet onboarded (token/user may not be ready)
    attempts++;
    if (attempts < maxAttempts) {
      retryTimer = setTimeout(tryComplete, 1000);
    } else {
      // Force finish after max retries — the gate will handle it
      onFinish();
    }
  }

  // Initial delay for the user to read the closing message
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const initialTimer = setTimeout(tryComplete, 2200);

  return () => {
    clearTimeout(initialTimer);
    if (retryTimer) clearTimeout(retryTimer);
  };
});
</script>

<div class="done">
	<div class="ornament">
		<Dotmatrix variant="square-14" />
	</div>

	<p class="lede">
		Walkthroughs and ratings will appear as your pull requests are read.
		The first one is preparing now.
	</p>

	<div class="footer-row">
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
		animation: scene-in var(--duration-ceremonial-slow) var(--ease-out-expo) backwards;
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
		animation: fin-in var(--duration-ceremonial-slow) var(--ease-out-expo) 600ms backwards;
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

	@keyframes scene-in {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@keyframes fin-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.done,
		.footer-row {
			animation: none;
		}
	}
</style>
