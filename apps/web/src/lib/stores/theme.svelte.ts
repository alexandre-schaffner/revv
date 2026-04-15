export type ThemePreference = 'system' | 'light' | 'dark';
export type DiffThemePreference = 'sync' | 'light' | 'dark';

const STORAGE_KEY = 'rev-theme';
const DIFF_STORAGE_KEY = 'rev-diff-theme';

let preference = $state<ThemePreference>(getStoredPreference());
let diffPreference = $state<DiffThemePreference>(getStoredDiffPreference());

function getStoredPreference(): ThemePreference {
	if (typeof window === 'undefined') return 'system';
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === 'light' || stored === 'dark') return stored;
	return 'system';
}

function getStoredDiffPreference(): DiffThemePreference {
	if (typeof window === 'undefined') return 'sync';
	const stored = localStorage.getItem(DIFF_STORAGE_KEY);
	if (stored === 'light' || stored === 'dark') return stored;
	return 'sync';
}

function applyTheme(pref: ThemePreference): void {
	const isDark =
		pref === 'dark' ||
		(pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

	document.documentElement.classList.toggle('dark', isDark);
	document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
}

/** Call once from the root layout's $effect. Returns a cleanup function. */
export function initTheme(): () => void {
	applyTheme(preference);

	const mq = window.matchMedia('(prefers-color-scheme: dark)');
	const handler = () => {
		if (preference === 'system') applyTheme('system');
	};
	mq.addEventListener('change', handler);

	return () => mq.removeEventListener('change', handler);
}

export function setThemePreference(pref: ThemePreference): void {
	preference = pref;
	localStorage.setItem(STORAGE_KEY, pref);
	applyTheme(pref);
}

export function getThemePreference(): ThemePreference {
	return preference;
}

export function setDiffThemePreference(pref: DiffThemePreference): void {
	diffPreference = pref;
	localStorage.setItem(DIFF_STORAGE_KEY, pref);
}

export function getDiffThemePreference(): DiffThemePreference {
	return diffPreference;
}

/** Resolved diff theme type: when diff preference is 'sync', follows the app theme. */
export function getDiffThemeType(): 'light' | 'dark' | 'system' {
	if (diffPreference !== 'sync') return diffPreference;
	if (preference === 'light') return 'light';
	if (preference === 'dark') return 'dark';
	return 'system';
}
