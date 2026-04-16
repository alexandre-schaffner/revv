import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { highlightCode } from './code-highlight.svelte';

marked.setOptions({
	breaks: true,
	gfm: true,
});

marked.use({
	renderer: {
		code({ text, lang }) {
			if (lang) {
				const highlighted = highlightCode(text, lang);
				if (highlighted) return highlighted;
			}
			const escaped = text
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;');
			const langClass = lang ? ` class="language-${lang}"` : '';
			return `<pre><code${langClass}>${escaped}</code></pre>`;
		},
	},
});

export function renderMarkdown(source: string): string {
	const raw = marked.parse(source, { async: false }) as string;
	return DOMPurify.sanitize(raw, {
		ADD_ATTR: ['style', 'class', 'tabindex'],
	});
}
