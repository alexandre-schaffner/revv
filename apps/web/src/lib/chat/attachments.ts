// ── Chat attachment encoding ───────────────────────────────────────────────
//
// Pure client-side helpers for turning picked `File`s into the wire-level
// `ChatAttachment` shape the chat API expects. Extracted out of RightPanel so
// the encoding/validation logic lives in one testable module instead of inline
// in a 2k-line component. The size caps, byte math, and limit messages are
// imported from `@revv/shared` so client and server never drift.

import {
  attachmentsTotalTooLargeMessage,
  attachmentTooLargeMessage,
  type ChatAttachment,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENTS_TOTAL_BYTES,
} from "@revv/shared";

// Extensions we treat as text even when the browser reports no/binary MIME
// type — so source files attach as readable `text` blocks, not images.
const TEXT_LIKE_EXTENSIONS =
  /\.(md|mdx|txt|json|yaml|yml|xml|csv|tsv|ts|tsx|js|jsx|svelte|css|scss|html|rs|go|py|rb|java|kt|swift|c|cpp|h|hpp)$/i;

export function isTextLike(file: File): boolean {
  if (file.type.startsWith("text/")) return true;
  return TEXT_LIKE_EXTENSIONS.test(file.name);
}

export type AttachmentKind = "image" | "text" | "unsupported";

/**
 * The single source of truth for what kind of attachment a picked `File`
 * becomes. The composer chip preview and the encode path both consume this so
 * they can never disagree — otherwise a file could show an "attached" chip and
 * then be silently dropped at encode time (or vice-versa).
 */
export function classifyFile(file: File): AttachmentKind {
  if (file.type.startsWith("image/")) return "image";
  if (isTextLike(file)) return "text";
  return "unsupported";
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

/**
 * Encode picked files into `ChatAttachment`s, enforcing the shared per-file
 * and total caps. Files that are over the cap or of an unsupported type are
 * skipped (not fatal); `onSkip` is invoked with a user-facing message for each
 * so the caller can surface a toast. Hitting the total cap stops processing
 * the remaining files.
 */
export async function encodeAttachments(
  files: readonly File[],
  onSkip?: (message: string) => void,
): Promise<ChatAttachment[]> {
  if (files.length === 0) return [];
  let total = 0;
  const attachments: ChatAttachment[] = [];
  for (const file of files) {
    if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
      onSkip?.(attachmentTooLargeMessage(file.name));
      continue;
    }
    total += file.size;
    if (total > MAX_CHAT_ATTACHMENTS_TOTAL_BYTES) {
      onSkip?.(attachmentsTotalTooLargeMessage());
      break;
    }
    const kind = classifyFile(file);
    if (kind === "image") {
      const dataUrl = await readAsDataUrl(file);
      const [, data = ""] = dataUrl.split(",", 2);
      attachments.push({
        kind: "image",
        name: file.name,
        mimeType: file.type,
        data,
      });
    } else if (kind === "text") {
      attachments.push({
        kind: "text",
        name: file.name,
        mimeType: file.type || "text/plain",
        data: await file.text(),
      });
    } else {
      onSkip?.(`${file.name} is not a supported attachment type.`);
    }
  }
  return attachments;
}
