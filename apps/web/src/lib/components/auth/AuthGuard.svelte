<script lang="ts">
// Legacy guard. The unauthenticated welcome UI moved into
// `OnboardingGate` + `OnboardingFlow`, which wraps the entire app shell
// at the layout level. Keep this component as a pass-through so existing
// imports (e.g. `+page.svelte`) don't need updating in this change.
let { children } = $props();
</script>

{@render children()}
