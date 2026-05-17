<script lang="ts">
	import type { Snippet } from "svelte";
	import type { HTMLButtonAttributes } from "svelte/elements";
	import "./glass-pill.css";

	interface Props extends HTMLButtonAttributes {
		variant?: "default" | "danger" | "accent" | "success" | "muted";
		icon?: boolean;
		class?: string;
		children: Snippet;
	}

	let {
		variant = "default",
		icon = false,
		class: extraClass = "",
		children,
		...rest
	}: Props = $props();

	const variantClass = $derived(variant === "default" ? "" : `glass-pill--${variant}`);
	const iconClass = $derived(icon ? "glass-pill--icon" : "");
</script>

<button
	type="button"
	class="glass-pill {variantClass} {iconClass} {extraClass}"
	{...rest}
>
	{@render children()}
</button>
