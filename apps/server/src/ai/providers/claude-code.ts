import { query } from '@anthropic-ai/claude-agent-sdk';
import { AiGenerationError } from '../../domain/errors';

/**
 * Stream text from Claude Code via the agent SDK.
 * Returns a ReadableStream of text chunks (no tool use, single turn).
 */
export function streamViaClaudeCode(prompt: string, systemPrompt: string): ReadableStream<string> {
	return new ReadableStream<string>({
		async start(controller) {
			try {
				const q = query({
					prompt,
					options: {
						systemPrompt,
						allowedTools: [], // No tool use — just text generation
						maxTurns: 1, // Single response, no agentic loop
					},
				});

				for await (const message of q) {
					// Extract text content from assistant messages
					if (message.type === 'assistant') {
						const content = (message as { message: { content: Array<{ type: string; text?: string }> } }).message.content;
						for (const block of content) {
							if (block.type === 'text' && block.text) {
								controller.enqueue(block.text);
							}
						}
					}
				}
				controller.close();
			} catch (err) {
				controller.error(new AiGenerationError({ cause: err }));
			}
		},
	});
}
