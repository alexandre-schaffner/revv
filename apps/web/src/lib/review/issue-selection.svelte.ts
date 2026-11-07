// Which walkthrough issues the reviewer has ticked for the next submit. An
// issue can be ticked while it is open and not yet posted; one resolved or
// posted meanwhile (an external agent, another submit) drops out of the
// selection on its own.

import { isIssueResolved, type WalkthroughIssue } from "@revv/shared";

export function isIssueSubmitted(issue: WalkthroughIssue): boolean {
  return issue.submittedAt != null;
}

export function isIssueSelectable(issue: WalkthroughIssue): boolean {
  return !isIssueResolved(issue) && !isIssueSubmitted(issue);
}

export class IssueSelection {
  readonly #issues: () => readonly WalkthroughIssue[];
  #ticked = $state<ReadonlySet<string>>(new Set());

  constructor(issues: () => readonly WalkthroughIssue[]) {
    this.#issues = issues;
  }

  readonly #selectable: readonly WalkthroughIssue[] = $derived.by(() =>
    this.#issues().filter(isIssueSelectable),
  );

  /** The ticked issues a submit would post, in list order. */
  readonly selected: readonly WalkthroughIssue[] = $derived.by(() =>
    this.#selectable.filter((issue) => this.#ticked.has(issue.id)),
  );

  readonly selectableCount: number = $derived(this.#selectable.length);

  readonly allSelected: boolean = $derived(
    this.#selectable.length > 0 && this.selected.length === this.#selectable.length,
  );

  has(issueId: string): boolean {
    return this.selected.some((issue) => issue.id === issueId);
  }

  toggle(issueId: string): void {
    if (!this.#selectable.some((issue) => issue.id === issueId)) return;
    const next = new Set(this.#ticked);
    if (next.has(issueId)) next.delete(issueId);
    else next.add(issueId);
    this.#ticked = next;
  }

  toggleAll(): void {
    this.#ticked = this.allSelected
      ? new Set()
      : new Set(this.#selectable.map((issue) => issue.id));
  }

  clear(): void {
    this.#ticked = new Set();
  }
}
