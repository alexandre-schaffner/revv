let open = $state(false);

export function getSettingsOpen(): boolean {
	return open;
}

export function openSettings(): void {
	open = true;
}

export function closeSettings(): void {
	open = false;
}

export function toggleSettings(): void {
	open = !open;
}
