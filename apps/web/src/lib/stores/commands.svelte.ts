import { setThemePreference, setDiffThemePreference } from './theme.svelte';
import { collapseAllRepoGroups, toggleSidebar, toggleRightPanel, openAddRepoDialog } from './sidebar.svelte';

export interface Command {
	id: string;
	label: string;
	category?: string;
	shortcut?: string;
	keywords?: string[];
	action: () => void;
}

let commands = $state<Command[]>([
	{
		id: 'theme:light',
		label: 'Theme: Light',
		category: 'Theme',
		keywords: ['appearance', 'light mode'],
		action: () => setThemePreference('light'),
	},
	{
		id: 'theme:dark',
		label: 'Theme: Dark',
		category: 'Theme',
		keywords: ['appearance', 'dark mode'],
		action: () => setThemePreference('dark'),
	},
	{
		id: 'theme:system',
		label: 'Theme: System',
		category: 'Theme',
		keywords: ['appearance', 'auto', 'os'],
		action: () => setThemePreference('system'),
	},
	{
		id: 'diff-theme:sync',
		label: 'Diff Theme: Sync with App',
		category: 'Diff Theme',
		keywords: ['diff', 'code', 'syntax', 'match', 'follow'],
		action: () => setDiffThemePreference('sync'),
	},
	{
		id: 'diff-theme:light',
		label: 'Diff Theme: Light',
		category: 'Diff Theme',
		keywords: ['diff', 'code', 'syntax', 'light mode'],
		action: () => setDiffThemePreference('light'),
	},
	{
		id: 'diff-theme:dark',
		label: 'Diff Theme: Dark',
		category: 'Diff Theme',
		keywords: ['diff', 'code', 'syntax', 'dark mode'],
		action: () => setDiffThemePreference('dark'),
	},
	{
		id: 'sidebar:collapse-all',
		label: 'Collapse All Repositories',
		category: 'Sidebar',
		keywords: ['fold', 'minimize', 'repos'],
		action: () => collapseAllRepoGroups(),
	},
	{
		id: 'sidebar:toggle',
		label: 'Toggle Sidebar',
		category: 'Sidebar',
		shortcut: '\u2318B / \u2318S',
		keywords: ['left', 'panel', 'hide', 'show'],
		action: () => toggleSidebar(),
	},
	{
		id: 'panel:toggle',
		label: 'Toggle Context Panel',
		category: 'Panel',
		shortcut: '\u2318R',
		keywords: ['right', 'panel', 'hide', 'show', 'context'],
		action: () => toggleRightPanel(),
	},
	{
		id: 'repo:add',
		label: 'Add Repository',
		category: 'Repository',
		keywords: ['repo', 'new', 'track', 'github', 'import'],
		action: () => openAddRepoDialog(),
	},
]);

let query = $state('');

// ── Fuzzy matching ───────────────────────────────────────

/** Score how well `query` matches `text` (higher = better, -1 = no match). */
export function fuzzyScore(q: string, text: string): number {
	if (q.length === 0) return 0;

	const lq = q.toLowerCase();
	const lt = text.toLowerCase();

	// Exact substring match — best score
	const idx = lt.indexOf(lq);
	if (idx !== -1) {
		// Boost for matching at word boundary or start
		return 100 + (idx === 0 ? 50 : 0);
	}

	// Sequential character match (fuzzy)
	let qi = 0;
	let score = 0;
	for (let ti = 0; ti < lt.length && qi < lq.length; ti++) {
		if (lt[ti] === lq[qi]) {
			// Bonus for matching at word start (after space/separator)
			if (ti === 0 || /[\s\-_/]/.test(lt[ti - 1]!)) score += 10;
			score += 5;
			qi++;
		}
	}

	return qi === lq.length ? score : -1;
}

function scoreCommand(cmd: Command, q: string): number {
	let best = fuzzyScore(q, cmd.label);

	if (cmd.keywords) {
		for (const kw of cmd.keywords) {
			best = Math.max(best, fuzzyScore(q, kw));
		}
	}

	if (cmd.category) {
		best = Math.max(best, fuzzyScore(q, cmd.category));
	}

	return best;
}

let filteredCommands = $derived.by(() => {
	const q = query.trim();
	if (q.length === 0) return commands;

	return commands
		.map((cmd) => ({ cmd, score: scoreCommand(cmd, q) }))
		.filter((r) => r.score >= 0)
		.sort((a, b) => b.score - a.score)
		.map((r) => r.cmd);
});

// ── Exports ──────────────────────────────────────────────

export function getFilteredCommands(): Command[] {
	return filteredCommands;
}

export function getQuery(): string {
	return query;
}

export function setQuery(q: string): void {
	query = q;
}

export function resetQuery(): void {
	query = '';
}

export function registerCommand(cmd: Command): () => void {
	commands = [...commands, cmd];
	return () => {
		commands = commands.filter((c) => c.id !== cmd.id);
	};
}
