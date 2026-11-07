/**
 * Whether `name` (trimmed) may be pushed as a new branch: the server refuses
 * anything else, so the dialog offering the push checks the same rule.
 */
export function isValidBranchName(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 && !/\s/.test(trimmed) && !trimmed.includes("..") && !trimmed.startsWith("-")
  );
}
