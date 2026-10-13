/**
 * Shared reactive state for the Conversation tab's floating review action bar.
 * YourReview.svelte writes here; AppShell.svelte shows ReviewActionBar, which
 * reads it.
 *
 * Using module-level $state so any component can read/write without prop drilling.
 */

type Action = "approve" | "request_changes" | "comment";

// ── Readable state ──────────────────────────────────────────────────────────

let _submitting = $state<Action | null>(null);
let _selectedCount = $state(0);
// `canComment` is true when there's anything to submit — selected walkthrough
// issues OR pending line comments. Gates both review-posting actions (Comment,
// Request changes) behind the single "Submit review" trigger.
let _canComment = $state(false);
let _approveBlockerSummary = $state("");

// ── Handlers ─────────────────────────────────────────────────────────────────

let _onGenerateChanges: () => void = () => {};
let _onSubmitReview: () => void = () => {};
let _onComment: () => void = () => {};
let _onApprove: () => void = () => {};

// ── Getters (read by AppShell) ────────────────────────────────────────────────

export function getReviewBarSubmitting(): Action | null {
  return _submitting;
}

export function getReviewBarSelectedCount(): number {
  return _selectedCount;
}

export function getReviewBarCanComment(): boolean {
  return _canComment;
}

export function getReviewBarApproveBlockerSummary(): string {
  return _approveBlockerSummary;
}

export function getReviewBarOnGenerateChanges(): () => void {
  return _onGenerateChanges;
}

export function getReviewBarOnSubmitReview(): () => void {
  return _onSubmitReview;
}

export function getReviewBarOnComment(): () => void {
  return _onComment;
}

export function getReviewBarOnApprove(): () => void {
  return _onApprove;
}

// ── Setters (written by YourReview) ──────────────────────────────────────

export function setReviewBarState(state: {
  submitting: Action | null;
  selectedCount: number;
  canComment: boolean;
  approveBlockerSummary: string;
}): void {
  _submitting = state.submitting;
  _selectedCount = state.selectedCount;
  _canComment = state.canComment;
  _approveBlockerSummary = state.approveBlockerSummary;
}

export function setReviewBarHandlers(handlers: {
  onGenerateChanges: () => void;
  onSubmitReview: () => void;
  onComment: () => void;
  onApprove: () => void;
}): void {
  _onGenerateChanges = handlers.onGenerateChanges;
  _onSubmitReview = handlers.onSubmitReview;
  _onComment = handlers.onComment;
  _onApprove = handlers.onApprove;
}

export function resetReviewBar(): void {
  _submitting = null;
  _selectedCount = 0;
  _canComment = false;
  _approveBlockerSummary = "";
  _onGenerateChanges = () => {};
  _onSubmitReview = () => {};
  _onComment = () => {};
  _onApprove = () => {};
}
