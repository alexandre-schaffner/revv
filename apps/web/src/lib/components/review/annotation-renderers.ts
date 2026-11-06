// The hosts a diff's `renderAnnotation` returns: a comment thread, or the
// new-comment input.

import type { AnnotationMounts } from "$lib/utils/annotation-mount";
import AnnotationCommentInput from "./AnnotationCommentInput.svelte";
import AnnotationThread from "./AnnotationThread.svelte";
import type { ThreadMeta } from "./pierre-diff-adapter";
import type { ThreadAnnotations } from "./thread-annotations.svelte";

const ANNOTATION_HOST_STYLE = "display:block;max-width:720px;margin:8px 0 8px 16px;";

export function renderThreadAnnotation(
  mounts: AnnotationMounts,
  controller: ThreadAnnotations,
  meta: ThreadMeta,
): HTMLElement {
  const host = document.createElement("div");
  host.style.cssText = ANNOTATION_HOST_STYLE;

  if (meta.isInputActive) {
    mounts.mount(host, AnnotationCommentInput, {
      onSubmit: (body: string) => void controller.submitComment(body),
      onDismiss: () => controller.dismissInput(),
    });
    return host;
  }

  const id = meta.threadId;
  const thread = controller.threadById[id];
  if (!thread) return host;
  mounts.mount(host, AnnotationThread, {
    thread,
    messages: controller.threadMessages[id] ?? [],
    isReplying: meta.isReplying,
    isPending: meta.isPending,
    onReply: () => controller.toggleReply(id),
    onResolve: () => void controller.resolve(id),
    onReopen: () => void controller.reopen(id),
    onDiscard: () => void controller.discard(id),
    onDiscardReply: (messageId: string) => void controller.discardReply(id, messageId),
    onApplySuggestion: (suggestion: string) => void controller.applySuggestion(id, suggestion),
    onReplySubmit: (body: string) => void controller.submitReply(id, body),
    onReplyDismiss: () => controller.toggleReply(id),
    onEditMessage: (messageId: string, body: string) =>
      void controller.editMessage(id, messageId, body),
    onPush: async () => {
      await controller.push(id);
    },
  });
  return host;
}
