const MAX_AGENT_ERROR_CHARS = 200;

/**
 * The agent's own error, without the guidance the server appends after it
 * (separated by a blank line).
 */
function agentErrorHead(message: string): string {
  const head = message.split(/\n\s*\n/)[0]?.trim() ?? "";
  return head.length > MAX_AGENT_ERROR_CHARS
    ? `${head.slice(0, MAX_AGENT_ERROR_CHARS - 1)}…`
    : head;
}

export function agentAuthRecoveryDescription(message: string): string {
  const hint =
    "Reconnect the agent in Settings. If it is already connected, run the agent test there to see what fails.";
  // Keep the raw error visible: the same advice covers several unrelated
  // failures, and without it a report can't tell which one happened.
  const head = agentErrorHead(message);
  return head ? `${hint} Agent error: ${head}` : hint;
}
