/**
 * Substitute each `{{NAME}}` marker in `template` with `values[NAME]`, in one
 * pass, leaving markers with no value as they are. One pass, so a value that
 * itself contains a marker (a PR body quoting `{{BRANCH_NAME}}`) is inserted
 * verbatim; and through a replacer function, never a replacement string, so
 * the `$&`, `$'` and `` $` `` patterns in externally authored values (a PR
 * title, a branch name) stay literal.
 */
export function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replaceAll(
    /\{\{([A-Z_]+)\}\}/g,
    (marker, name: string) => values[name] ?? marker,
  );
}
