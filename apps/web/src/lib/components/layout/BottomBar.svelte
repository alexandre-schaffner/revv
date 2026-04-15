<div class="flex h-full items-center justify-between bg-bg-primary px-4">
	<!-- Left: model info -->
	<div class="flex items-center gap-3">
		<div class="flex items-center gap-1.5 rounded-md bg-bg-secondary px-2 py-1">
			<div class="h-1.5 w-1.5 rounded-full bg-success"></div>
			<span class="text-xs text-text-secondary">Claude Sonnet</span>
		</div>
		<span class="text-xs text-text-muted">High</span>
	</div>

	<!-- Right: action buttons -->
	<div class="flex items-center gap-2">
		<button
			class="rounded-md px-2.5 py-1 text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-secondary"
		>
			Build
		</button>
		<button
			class="rounded-md px-2.5 py-1 text-xs text-text-muted transition-colors hover:bg-bg-tertiary hover:text-text-secondary"
		>
			Lint
		</button>
		<button
			class="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-white transition-colors hover:bg-accent-hover"
			aria-label="Submit"
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				width="12"
				height="12"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="m5 12 7-7 7 7" />
				<path d="M12 19V5" />
			</svg>
		</button>
	</div>
</div>
