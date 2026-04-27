import { query } from "@anthropic-ai/claude-agent-sdk";
import { AiGenerationError } from "../../domain/errors";
import { resolveCliBin } from "./cli-agent";

/**
 * Stream text from Claude Code via the agent SDK.
 * Returns a ReadableStream of text chunks (no tool use, single turn).
 */
export function streamViaClaudeCode(
  prompt: string,
  systemPrompt: string,
): ReadableStream<string> {
  // Only pass the absolute path when we actually resolved one — the bare
  // string 'claude' is the SDK's own default lookup path, which it handles
  // better without our intervention.
  const pinned = resolveCliBin("claude");
  const pathOption =
    pinned !== "claude" ? { pathToClaudeCodeExecutable: pinned } : {};

  return new ReadableStream<string>({
    async start(controller) {
      try {
        const q = query({
          prompt,
          options: {
            systemPrompt,
            allowedTools: [], // No tool use — just text generation
            maxTurns: 1, // Single response, no agentic loop
            ...pathOption,
          },
        });

        for await (const message of q) {
          // Extract text content from assistant messages
          if (message.type === "assistant") {
            const content = (
              message as {
                message: { content: Array<{ type: string; text?: string }> };
              }
            ).message.content;
            for (const block of content) {
              if (block.type === "text" && block.text) {
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
