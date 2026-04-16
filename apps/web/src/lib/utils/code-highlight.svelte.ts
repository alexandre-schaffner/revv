import { createHighlighter, type Highlighter } from 'shiki';

let highlighter: Highlighter | null = null;
let initPromise: Promise<Highlighter> | null = null;
let ready = $state(false);

const PRELOAD_LANGS = [
	'javascript',
	'typescript',
	'jsx',
	'tsx',
	'python',
	'ruby',
	'go',
	'rust',
	'java',
	'c',
	'cpp',
	'css',
	'scss',
	'html',
	'json',
	'yaml',
	'toml',
	'xml',
	'sql',
	'bash',
	'shellscript',
	'diff',
	'markdown',
	'swift',
	'kotlin',
	'php',
	'lua',
	'zig',
	'elixir',
	'haskell',
	'ocaml',
	'svelte',
	'vue',
	'dockerfile',
	'graphql',
	'proto',
];

export function isHighlighterReady(): boolean {
	return ready;
}

export async function initHighlighter(): Promise<void> {
	if (highlighter) return;
	if (!initPromise) {
		initPromise = createHighlighter({
			themes: ['github-dark', 'github-light'],
			langs: PRELOAD_LANGS,
		});
	}
	highlighter = await initPromise;
	ready = true;
}

export function highlightCode(code: string, lang: string): string | null {
	if (!highlighter) return null;

	try {
		const loaded = highlighter.getLoadedLanguages();
		const normalized = lang.toLowerCase();
		if (!loaded.includes(normalized)) return null;

		return highlighter.codeToHtml(code, {
			lang: normalized,
			themes: {
				light: 'github-light',
				dark: 'github-dark',
			},
		});
	} catch {
		return null;
	}
}
