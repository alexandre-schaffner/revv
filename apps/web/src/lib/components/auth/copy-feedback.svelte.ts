/**
 * Clipboard copy with a transient "copied" flag. Call during component init:
 * the reset timer is cleared when the component is destroyed.
 */
export function copyFeedback(resetMs: number): {
  readonly copied: boolean;
  copy: (text: string) => Promise<void>;
} {
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => () => {
    if (timer) clearTimeout(timer);
  });

  return {
    get copied() {
      return copied;
    },
    async copy(text: string): Promise<void> {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // The clipboard API can be unavailable (no permission, unfocused webview).
        copied = false;
        return;
      }
      copied = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        copied = false;
        timer = null;
      }, resetMs);
    },
  };
}
