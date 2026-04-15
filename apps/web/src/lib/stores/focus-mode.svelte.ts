// ── Focus-mode store ────────────────────────────────────────
//
// Tracks which panel currently owns keyboard focus so that
// keydown handlers can scope their bindings accordingly.
//
// Modes:
//   'sidebar' — vim-like sidebar navigation is active (default)
//   'diff'    — the diff/code viewer is focused for scrolling
//
// Transitions:
//   sidebar → diff   :  press `e` or `i`
//   diff → sidebar   :  press `Escape`

export type FocusPanel = "sidebar" | "diff";

let activePanel = $state<FocusPanel>("sidebar");

// ── Getters / Setters ───────────────────────────────────────

export function getActivePanel(): FocusPanel {
	return activePanel;
}

export function setActivePanel(panel: FocusPanel): void {
	activePanel = panel;
}

// ── Convenience helpers ─────────────────────────────────────

/**
 * Enter diff/code viewer mode.
 * Focuses the `.diff-scroll` container so j/k can scroll it.
 */
export function enterDiffMode(): void {
	activePanel = "diff";

	// Give the diff scroll container native focus so that it becomes the
	// scroll target for keyboard-driven scrolling.
	requestAnimationFrame(() => {
		const diffScroll = document.querySelector<HTMLElement>(".diff-scroll");
		if (diffScroll) {
			// Ensure the element is focusable
			if (!diffScroll.getAttribute("tabindex")) {
				diffScroll.setAttribute("tabindex", "-1");
			}
			diffScroll.focus({ preventScroll: true });
		}
	});
}

/**
 * Return to sidebar navigation mode.
 * Blurs the diff container so scrolling keys don't double-fire.
 */
export function enterSidebarMode(): void {
	activePanel = "sidebar";

	// Remove focus from the diff container
	const active = document.activeElement;
	if (
		active instanceof HTMLElement &&
		active.classList.contains("diff-scroll")
	) {
		active.blur();
	}
}
