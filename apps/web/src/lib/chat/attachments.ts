// Picked files become chat attachments in two steps: `admitAttachments` decides,
// when a file is added to the composer, whether it may be sent at all (type,
// per-file size, total size, count), and `encodeAttachments` turns what was
// admitted into the wire shape on submit. The caps and their messages come from
// `@revv/shared`, which the server enforces too.

import {
  attachmentsTotalTooLargeMessage,
  attachmentTooLargeMessage,
  type ChatAttachment,
  MAX_CHAT_ATTACHMENT_BYTES,
  MAX_CHAT_ATTACHMENTS_COUNT,
  MAX_CHAT_ATTACHMENTS_TOTAL_BYTES,
} from "@revv/shared";

// Browsers report no (or a binary) MIME type for most source files.
const TEXT_LIKE_EXTENSIONS =
  /\.(md|mdx|txt|json|yaml|yml|xml|csv|tsv|ts|tsx|js|jsx|svelte|css|scss|html|rs|go|py|rb|java|kt|swift|c|cpp|h|hpp)$/i;

export type AttachmentKind = "image" | "text";

export interface PendingAttachment {
  readonly file: File;
  readonly kind: AttachmentKind;
}

function classifyFile(file: File): AttachmentKind | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("text/") || TEXT_LIKE_EXTENSIONS.test(file.name)) return "text";
  return null;
}

export interface Admission {
  readonly admitted: PendingAttachment[];
  /** One user-facing message per reason a file was turned away. */
  readonly rejections: string[];
}

/** Which of `incoming` may join the attachments already in the composer. */
export function admitAttachments(
  current: readonly PendingAttachment[],
  incoming: readonly File[],
): Admission {
  const admitted: PendingAttachment[] = [];
  const rejections: string[] = [];
  const unsupported: string[] = [];
  let count = current.length;
  let total = current.reduce((sum, a) => sum + a.file.size, 0);
  let overTotal = false;
  let overCount = false;

  for (const file of incoming) {
    const kind = classifyFile(file);
    if (kind === null) {
      unsupported.push(file.name);
      continue;
    }
    if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
      rejections.push(attachmentTooLargeMessage(file.name));
      continue;
    }
    if (total + file.size > MAX_CHAT_ATTACHMENTS_TOTAL_BYTES) {
      overTotal = true;
      continue;
    }
    if (count >= MAX_CHAT_ATTACHMENTS_COUNT) {
      overCount = true;
      continue;
    }
    admitted.push({ file, kind });
    total += file.size;
    count += 1;
  }

  if (unsupported.length === 1) {
    rejections.unshift(`${unsupported[0]} is not a supported attachment type.`);
  } else if (unsupported.length > 1) {
    rejections.unshift(`${unsupported.length} files are not supported attachment types.`);
  }
  if (overTotal) rejections.push(attachmentsTotalTooLargeMessage());
  if (overCount) {
    rejections.push(`A message can carry at most ${MAX_CHAT_ATTACHMENTS_COUNT} attachments.`);
  }
  return { admitted, rejections };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(file);
  });
}

export async function encodeAttachments(
  attachments: readonly PendingAttachment[],
): Promise<ChatAttachment[]> {
  return Promise.all(
    attachments.map(async ({ file, kind }): Promise<ChatAttachment> => {
      if (kind === "image") {
        const [, data = ""] = (await readAsDataUrl(file)).split(",", 2);
        return { kind: "image", name: file.name, mimeType: file.type, data };
      }
      return {
        kind: "text",
        name: file.name,
        mimeType: file.type || "text/plain",
        data: await file.text(),
      };
    }),
  );
}
