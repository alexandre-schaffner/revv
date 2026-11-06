import type { ReviewDecision, ReviewVerdict } from "@revv/shared";

/** A review's verdict, as a status. */
export const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  approved: "Approved",
  changes_requested: "Requested changes",
  commented: "Commented",
  dismissed: "Dismissed",
};

/** A review's verdict, as what its author did ("alice approved these changes"). */
export const VERDICT_VERB: Record<ReviewVerdict, string> = {
  approved: "approved these changes",
  changes_requested: "requested changes",
  commented: "reviewed",
  dismissed: "reviewed (dismissed)",
};

/** The viewer's own verdict. */
export const VIEWER_VERDICT_LABEL: Record<ReviewVerdict, string> = {
  approved: "You approved",
  changes_requested: "You requested changes",
  commented: "You commented",
  dismissed: "Your review was dismissed",
};

export const VERDICT_TONE: Record<ReviewVerdict, "success" | "danger" | "subtle"> = {
  approved: "success",
  changes_requested: "danger",
  commented: "subtle",
  dismissed: "subtle",
};

export const REVIEW_DECISION_LABEL: Record<ReviewDecision, string> = {
  approved: "Approved",
  changes_requested: "Changes requested",
  review_required: "An approving review is required",
};
