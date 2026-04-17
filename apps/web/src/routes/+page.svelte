<script lang="ts">
	import AuthGuard from '$lib/components/auth/AuthGuard.svelte';
</script>

<AuthGuard>
	<div class="flex h-full items-center justify-center">
		<div class="text-center">
			<h1 class="text-4xl font-bold tracking-tight text-text-primary">Revv</h1>
			<p class="mt-2 text-sm text-text-secondary">AI-powered code review</p>
			<p class="mt-4 flex flex-col items-center gap-1.5 text-xs text-text-muted">
  <span class="flex items-center gap-1"><kbd class="inline-flex items-center gap-0.5 rounded border border-border-subtle bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">⌘</kbd><span class="text-text-muted">+</span><kbd class="inline-flex items-center gap-0.5 rounded border border-border-subtle bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">P</kbd> to open a pull request</span>
  <span class="flex items-center gap-1"><kbd class="inline-flex items-center gap-0.5 rounded border border-border-subtle bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">⌘</kbd><span class="text-text-muted">+</span><kbd class="inline-flex items-center gap-0.5 rounded border border-border-subtle bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">⇧</kbd><span class="text-text-muted">+</span><kbd class="inline-flex items-center gap-0.5 rounded border border-border-subtle bg-bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-text-secondary">P</kbd> to open the command palette</span>
</p>
		</div>
	</div>
</AuthGuard>
