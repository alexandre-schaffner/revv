// ── Review file type (for @pierre/diffs integration) ────────────────────────

/** A file in the review, with the git patch for @pierre/diffs to render. */
export interface ReviewFile {
	path: string;
	oldPath?: string;
	/** Unified diff (patch) string from the GitHub API, or null for binary files. */
	patch: string | null;
	additions: number;
	deletions: number;
	isNew?: boolean;
	isDeleted?: boolean;
	isBinary?: boolean;
}

// ── File tree entry (lightweight, no patch payload) ─────────────────────────

/** Shape consumed by DiffFileTree — metadata only, no file content. */
export interface FileTreeEntry {
	path: string;
	oldPath?: string;
	additions: number;
	deletions: number;
	isNew?: boolean;
	isDeleted?: boolean;
}

/** Map ReviewFile[] → FileTreeEntry[] (strips content, respects exactOptionalPropertyTypes). */
export function toFileTreeEntries(files: ReviewFile[]): FileTreeEntry[] {
	return files.map((f) => ({
		path: f.path,
		...(f.oldPath ? { oldPath: f.oldPath } : {}),
		additions: f.additions,
		deletions: f.deletions,
		...(f.isNew ? { isNew: f.isNew } : {}),
		...(f.isDeleted ? { isDeleted: f.isDeleted } : {}),
	}));
}

// ── Comment / Thread types (re-exported from @rev/shared) ────────────────────

export type {
	ThreadStatus,
	AuthorRole,
	MessageType,
	CommentThread,
	ThreadMessage,
	ReviewSession,
	HunkDecision,
	HunkDecisionType,
	SessionStatus,
} from '@rev/shared';

/** Detect language from file extension for badge display */
export function detectLanguage(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	const map: Record<string, string> = {
		ts: 'TypeScript',
		tsx: 'TSX',
		js: 'JavaScript',
		jsx: 'JSX',
		svelte: 'Svelte',
		py: 'Python',
		go: 'Go',
		rs: 'Rust',
		java: 'Java',
		kt: 'Kotlin',
		swift: 'Swift',
		css: 'CSS',
		html: 'HTML',
		json: 'JSON',
		yaml: 'YAML',
		yml: 'YAML',
		md: 'Markdown',
		sh: 'Shell',
		sql: 'SQL'
	};
	return map[ext] ?? (ext.toUpperCase() || 'Text');
}
