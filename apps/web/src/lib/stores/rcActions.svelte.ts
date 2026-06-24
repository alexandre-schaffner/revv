/**
 * Shared reactive state for the Request Changes floating action bar.
 * RequestChanges.svelte writes here; AppShell.svelte reads and renders the pill.
 *
 * Using module-level $state so any component can read/write without prop drilling.
 */

type Action = "approve" | "request_changes" | "comment";

// ── Readable state ──────────────────────────────────────────────────────────

let _submitting = $state<Action | null>(null);
let _selectedCount = $state(0);
let _hasContent = $state(false);
// `canComment` is broader than `hasContent`: a plain COMMENT review can be
// posted with selected walkthrough issues OR pending line comments, whereas
// the Request-changes gate (`hasContent`) only counts selected issues.
let _canComment = $state(false);
let _approveBlockerSummary = $state("");

// ── Handlers ─────────────────────────────────────────────────────────────────

let _onGenerateChanges: () => void = () => {};
let _onSubmitReview: () => void = () => {};
let _onComment: () => void = () => {};
let _onApprove: () => void = () => {};

// ── Getters (read by AppShell) ────────────────────────────────────────────────

export function getRcSubmitting(): Action | null {
  return _submitting;
}

export function getRcSelectedCount(): number {
  return _selectedCount;
}

export function getRcHasContent(): boolean {
  return _hasContent;
}

export function getRcCanComment(): boolean {
  return _canComment;
}

export function getRcApproveBlockerSummary(): string {
  return _approveBlockerSummary;
}

export function getRcOnGenerateChanges(): () => void {
  return _onGenerateChanges;
}

export function getRcOnSubmitReview(): () => void {
  return _onSubmitReview;
}

export function getRcOnComment(): () => void {
  return _onComment;
}

export function getRcOnApprove(): () => void {
  return _onApprove;
}

// ── Setters (written by RequestChanges) ──────────────────────────────────────

export function setRcState(state: {
  submitting: Action | null;
  selectedCount: number;
  hasContent: boolean;
  canComment: boolean;
  approveBlockerSummary: string;
}): void {
  _submitting = state.submitting;
  _selectedCount = state.selectedCount;
  _hasContent = state.hasContent;
  _canComment = state.canComment;
  _approveBlockerSummary = state.approveBlockerSummary;
}

export function setRcHandlers(handlers: {
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

export function resetRcActions(): void {
  _submitting = null;
  _selectedCount = 0;
  _hasContent = false;
  _canComment = false;
  _approveBlockerSummary = "";
  _onGenerateChanges = () => {};
  _onSubmitReview = () => {};
  _onComment = () => {};
  _onApprove = () => {};
}
