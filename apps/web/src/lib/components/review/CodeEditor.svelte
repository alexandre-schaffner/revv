<script lang="ts">
	// ── Tokenizer ────────────────────────────────────────────────────────────────

	type TokenType =
		| 'comment'
		| 'string'
		| 'keyword'
		| 'number'
		| 'type'
		| 'function'
		| 'operator'
		| 'plain';

	interface Token {
		type: TokenType;
		value: string;
	}

	const KEYWORDS = new Set([
		'const', 'let', 'var', 'function', 'class', 'if', 'else', 'return',
		'import', 'export', 'async', 'await', 'type', 'interface', 'extends',
		'implements', 'new', 'this', 'super', 'null', 'undefined', 'true',
		'false', 'void', 'never', 'from', 'of', 'in', 'for', 'while', 'do',
		'try', 'catch', 'finally', 'throw', 'switch', 'case', 'break',
		'continue', 'default', 'delete', 'typeof', 'instanceof', 'readonly',
		'public', 'private', 'protected', 'static', 'abstract', 'enum',
		'declare', 'as', 'any', 'string', 'number', 'boolean', 'require',
		'module', 'exports', 'Promise', 'Array', 'Object', 'Map', 'Set',
	]);

	const MULTI_OPS = ['=>', '===', '!==', '==', '!=', '&&', '||', '>=', '<=', '+=', '-=', '**'];

	function escHtml(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function tokenize(code: string): Token[] {
		const tokens: Token[] = [];
		let i = 0;
		const len = code.length;

		while (i < len) {
			const ch = code[i]!;

			// Line comment
			if (ch === '/' && code[i + 1] === '/') {
				let j = i;
				while (j < len && code[j] !== '\n') j++;
				tokens.push({ type: 'comment', value: code.slice(i, j) });
				i = j;
				continue;
			}

			// Block comment
			if (ch === '/' && code[i + 1] === '*') {
				let j = i + 2;
				while (j < len - 1 && !(code[j] === '*' && code[j + 1] === '/')) j++;
				j += 2;
				tokens.push({ type: 'comment', value: code.slice(i, j) });
				i = j;
				continue;
			}

			// Template literal
			if (ch === '`') {
				let j = i + 1;
				while (j < len && code[j] !== '`') {
					if (code[j] === '\\') j++;
					j++;
				}
				j++;
				tokens.push({ type: 'string', value: code.slice(i, j) });
				i = j;
				continue;
			}

			// String literals
			if (ch === '"' || ch === "'") {
				let j = i + 1;
				while (j < len && code[j] !== ch) {
					if (code[j] === '\\') j++;
					j++;
				}
				j++;
				tokens.push({ type: 'string', value: code.slice(i, j) });
				i = j;
				continue;
			}

			// Numbers
			if (/\d/.test(ch) && (i === 0 || /\W/.test(code[i - 1]!))) {
				let j = i;
				while (j < len && /[\d._xXa-fA-FnN]/.test(code[j]!)) j++;
				tokens.push({ type: 'number', value: code.slice(i, j) });
				i = j;
				continue;
			}

			// Identifiers
			if (/[a-zA-Z_$]/.test(ch)) {
				let j = i;
				while (j < len && /[a-zA-Z0-9_$]/.test(code[j]!)) j++;
				const word = code.slice(i, j);

				// Peek past whitespace to see if it's followed by '('
				let k = j;
				while (k < len && (code[k] === ' ' || code[k] === '\t')) k++;
				const nextCh = code[k];

				let type: TokenType = 'plain';
				if (KEYWORDS.has(word)) {
					type = 'keyword';
				} else if (nextCh === '(') {
					type = 'function';
				} else if (/^[A-Z]/.test(word)) {
					type = 'type';
				}
				tokens.push({ type, value: word });
				i = j;
				continue;
			}

			// Multi-char operators
			let opMatched = false;
			for (const op of MULTI_OPS) {
				if (code.startsWith(op, i)) {
					tokens.push({ type: 'operator', value: op });
					i += op.length;
					opMatched = true;
					break;
				}
			}
			if (opMatched) continue;

			// Plain char (punctuation, space, newline, etc.)
			tokens.push({ type: 'plain', value: ch });
			i++;
		}

		return tokens;
	}

	// VSCode Dark+ inspired palette
	const TOKEN_COLOR: Record<TokenType, string> = {
		comment:  '#6a9955',
		string:   '#ce9178',
		keyword:  '#569cd6',
		number:   '#b5cea8',
		type:     '#4ec9b0',
		function: '#dcdcaa',
		operator: '#d4d4d4',
		plain:    '#d4d4d8',
	};

	function highlight(code: string, lang: string): string {
		const supported = ['TypeScript', 'JavaScript', 'TSX', 'JSX', 'Svelte', 'Shell'];
		if (!supported.includes(lang)) return escHtml(code);

		return tokenize(code)
			.map((t) => {
				const esc = escHtml(t.value);
				if (t.type === 'plain') return esc;
				return `<span style="color:${TOKEN_COLOR[t.type]}">${esc}</span>`;
			})
			.join('');
	}

	// ── Component ─────────────────────────────────────────────────────────────

	interface Props {
		value: string;
		language?: string;
		minRows?: number;
		maxRows?: number;
		onchange?: (v: string) => void;
	}

	let { value = $bindable(), language = 'TypeScript', minRows = 6, maxRows = 14, onchange }: Props =
		$props();

	let textareaEl: HTMLTextAreaElement;
	let preEl: HTMLPreElement;

	const highlighted = $derived(highlight(value, language) + '\n');

	function syncScroll() {
		if (!preEl || !textareaEl) return;
		preEl.scrollTop = textareaEl.scrollTop;
		preEl.scrollLeft = textareaEl.scrollLeft;
	}

	function handleInput(e: Event) {
		const target = e.currentTarget as HTMLTextAreaElement;
		value = target.value;
		onchange?.(target.value);
		syncScroll();
	}

	// Tab key → insert two spaces instead of moving focus
	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Tab') {
			e.preventDefault();
			const ta = e.currentTarget as HTMLTextAreaElement;
			const start = ta.selectionStart;
			const end = ta.selectionEnd;
			const newVal = value.slice(0, start) + '  ' + value.slice(end);
			value = newVal;
			// Restore cursor after reactive update
			requestAnimationFrame(() => {
				ta.selectionStart = ta.selectionEnd = start + 2;
			});
		}
	}
</script>

<div class="editor">
	<!-- Syntax-highlighted backdrop -->
	<pre
		bind:this={preEl}
		class="highlight-layer"
		aria-hidden="true"
	>{@html highlighted}</pre>

	<!-- Transparent editable textarea on top -->
	<textarea
		bind:this={textareaEl}
		class="edit-layer"
		{value}
		rows={minRows}
		style="min-height: {minRows * 20}px; max-height: {maxRows * 20}px;"
		spellcheck="false"
		autocomplete="off"
		autocapitalize="off"
		oninput={handleInput}
		onscroll={syncScroll}
		onkeydown={handleKeydown}
	></textarea>
</div>

<style>
	.editor {
		position: relative;
		background: var(--color-diff-bg);
		overflow: hidden;
	}

	/* Shared metrics — must be pixel-identical between pre and textarea */
	.highlight-layer,
	.edit-layer {
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 20px; /* fixed px so math is deterministic */
		padding: 10px 12px;
		tab-size: 2;
		white-space: pre;
		word-wrap: normal;
		overflow: auto;
		width: 100%;
		box-sizing: border-box;
		border: none;
		margin: 0;
	}

	/* Highlight layer: static, behind the textarea */
	.highlight-layer {
		position: absolute;
		inset: 0;
		pointer-events: none;
		user-select: none;
		color: var(--color-text-primary);
		overflow: hidden; /* scroll driven by textarea */
		z-index: 0;
		/* Match textarea's min/max height reactively via CSS */
		min-height: inherit;
		max-height: inherit;
	}

	/* Edit layer: transparent text so the pre shows through */
	.edit-layer {
		position: relative;
		z-index: 1;
		background: transparent;
		color: transparent;
		caret-color: var(--color-text-primary);
		outline: none;
		resize: none;
		/* Inherit the height bounds set via inline style */
		min-height: inherit;
		max-height: inherit;
		overflow-y: auto;
		overflow-x: auto;
	}

	/* Selection highlight shows through transparent text */
	.edit-layer::selection {
		background: var(--color-input-focus-ring);
		color: transparent;
	}
</style>
