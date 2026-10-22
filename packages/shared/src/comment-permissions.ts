export interface CommentPermissionMessage {
  readonly authorRole: string;
  readonly authorLogin: string | null;
  readonly externalId: string | null;
}

export interface DraftReviewMessage extends CommentPermissionMessage {
  readonly body: string;
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

/**
 * A local draft can be edited or discarded by the signed-in user when Revv
 * authored it, or when its provider login matches the active account.
 * GitHub-backed messages are immutable in Revv and must be edited on GitHub.
 */
export function canUserModifyComment(
  message: CommentPermissionMessage,
  currentUserLogin: string | null,
): boolean {
  if (message.externalId !== null) return false;
  if (message.authorRole === "ai_agent") return true;
  if (!message.authorLogin || !currentUserLogin) return false;
  return normalizeLogin(message.authorLogin) === normalizeLogin(currentUserLogin);
}

/** A local human or Revv-authored draft that can be included in a GitHub review. */
export function isPublishableDraftComment(message: DraftReviewMessage): boolean {
  return (
    message.externalId === null &&
    (message.authorRole === "reviewer" || message.authorRole === "ai_agent") &&
    message.body.trim().length > 0
  );
}
