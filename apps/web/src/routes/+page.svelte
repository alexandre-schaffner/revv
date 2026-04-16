<script lang="ts">
	import AuthGuard from '$lib/components/auth/AuthGuard.svelte';
</script>

<AuthGuard>
	<div class="flex h-full items-center justify-center">
		<div class="text-center">
			<h1 class="text-4xl font-bold tracking-tight text-text-primary">Rev</h1>
			<p class="mt-2 text-sm text-text-secondary">AI-powered code review</p>
			<p class="mt-4 text-xs text-text-muted">Select a PR from the sidebar to begin</p>
		</div>
	</div>
</AuthGuard>
