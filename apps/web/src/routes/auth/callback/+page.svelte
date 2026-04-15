<script lang="ts">
	import { page } from '$app/state';
	import { setToken, loadUser } from '$lib/stores/auth.svelte';
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';

	let closing = $state(true);

	onMount(async () => {
		const token = page.url.searchParams.get('token');
		if (token) {
			setToken(token);
			await loadUser();
		}

		// Try to close this tab — works when opened via window.open() (browser dev mode).
		// The original tab/Tauri window picks up the token via polling.
		try { window.close(); } catch {}

		// If we're still here after a tick, the browser blocked window.close().
		// Show a message instead of navigating to the app (which would create a duplicate tab).
		await new Promise((r) => setTimeout(r, 300));
		closing = false;
	});
</script>

{#if closing}
	<div style="display:flex;height:100vh;align-items:center;justify-content:center;font-family:sans-serif;color:#888;font-size:13px;">
		Signing in…
	</div>
{:else}
	<div style="display:flex;height:100vh;align-items:center;justify-content:center;font-family:sans-serif;color:#888;font-size:13px;flex-direction:column;gap:6px;">
		<span>✓ Authenticated successfully</span>
		<span style="color:#aaa;font-size:12px;">You can close this tab and return to Rev.</span>
	</div>
{/if}
