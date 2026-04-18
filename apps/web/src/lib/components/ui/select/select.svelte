<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";

	let { ...restProps }: SelectPrimitive.RootProps = $props();
</script>

<SelectPrimitive.Root {...restProps} />
