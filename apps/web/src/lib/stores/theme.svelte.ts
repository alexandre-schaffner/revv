import { untrack } from 'svelte';

export type ThemePreference = 'system' | 'light' | 'dark';
type DiffThemePreference = 'sync' | 'light' | 'dark';

const THEME_KEY = 'revv-theme';
const DIFF_THEME_KEY = 'revv-diff-theme';

// ── State ────────────────────────────────────────────────────────────────────

let preference = $state<ThemePreference>(readStored(THEME_KEY, 'system'));
let diffPreference = $state<DiffThemePreference>(readStored(DIFF_THEME_KEY, 'sync'));

function readStored<T extends string>(key: string, fallback: T): T {
	if (typeof window === 'undefined') return fallback;
	const v = localStorage.getItem(key);
	return v === 'light' || v === 'dark' ? (v as T) : fallback;
}

// ── DOM ──────────────────────────────────────────────────────────────────────

function apply(pref: ThemePreference): void {
	const isDark =
		pref === 'dark' ||
		(pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
	document.documentElement.classList.toggle('dark', isDark);
	document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
}

/** Sync the data-diff-theme attribute on <html> so the CSS rules in app.css
 *  can force Pierre's color-scheme for explicit light/dark overrides.
 *  When 'sync', the attribute is removed and Pierre inherits from the document. */
function applyDiffTheme(pref: DiffThemePreference): void {
	if (pref === 'sync') {
		delete document.documentElement.dataset.diffTheme;
	} else {
		document.documentElement.dataset.diffTheme = pref;
	}
}

/** Apply a theme change with a smooth crossfade using the View Transition API.
 *  The browser captures a screenshot of the old state, applies the new theme
 *  in the callback, then crossfades the two at the compositor level — one
 *  uniform fade, no per-element timing issues.
 *  Falls back to instant switch on browsers without support (Safari <18). */
function swap(pref: ThemePreference): void {
	if (!document.startViewTransition) {
		apply(pref);
		return;
	}
	document.startViewTransition(() => apply(pref));
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Call once from root layout. Returns cleanup. Untracked — must never re-run. */
export function initTheme(): () => void {
	untrack(() => {
		apply(preference);
		applyDiffTheme(diffPreference);
	});

	const mq = matchMedia('(prefers-color-scheme: dark)');
	const onChange = () =>
		untrack(() => {
			if (preference === 'system') {
				swap('system');
			}
		});
	mq.addEventListener('change', onChange);
	return () => mq.removeEventListener('change', onChange);
}

export function getThemePreference(): ThemePreference {
	return preference;
}

export function setThemePreference(pref: ThemePreference): void {
	preference = pref;
	localStorage.setItem(THEME_KEY, pref);
	swap(pref);
}

export function setDiffThemePreference(pref: DiffThemePreference): void {
	diffPreference = pref;
	localStorage.setItem(DIFF_THEME_KEY, pref);
	applyDiffTheme(pref);
}
