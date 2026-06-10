import type { Action } from "svelte/action";

import { gsap, prefersReducedMotion, tokens } from "$lib/motion";
import { getResolvedTheme } from "$lib/stores/theme.svelte";
import { initMermaid, renderMermaid } from "$lib/utils/mermaid.svelte";

type ResolvedTheme = "light" | "dark";

const SELECTOR = ".mermaid-diagram[data-mermaid-src]";

function decodeSource(encoded: string): string | null {
  try {
    const binary = atob(encoded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function showFallback(container: HTMLElement, source: string, error: string): void {
  const note = document.createElement("div");
  note.className = "mermaid-error";
  note.textContent = error || "Diagram failed to render.";

  const pre = document.createElement("pre");
  pre.className = "mermaid-fallback-source";
  const code = document.createElement("code");
  code.textContent = source;
  pre.appendChild(code);

  container.replaceChildren(note, pre);
}

function reveal(container: HTMLElement): void {
  if (prefersReducedMotion()) return;
  gsap.fromTo(
    container,
    { autoAlpha: 0 },
    { autoAlpha: 1, duration: tokens.quick, ease: tokens.easeOutExpo },
  );
}

export const mermaidDiagrams: Action<HTMLElement, ResolvedTheme | undefined> = (node, theme) => {
  let currentTheme: ResolvedTheme = theme ?? getResolvedTheme();
  let destroyed = false;
  let scheduled = false;
  let rendering = false;
  let rerunAfterRender = false;

  const schedule = (): void => {
    if (destroyed) return;
    if (rendering) {
      rerunAfterRender = true;
      return;
    }
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      void renderAll();
    });
  };

  const renderAll = async (): Promise<void> => {
    rendering = true;
    const themeForRun = currentTheme;
    try {
      const containers = Array.from(node.querySelectorAll<HTMLElement>(SELECTOR));
      const pending = containers.filter(
        (container) => container.dataset.mermaidTheme !== themeForRun,
      );
      if (pending.length === 0) return;

      await initMermaid(themeForRun);

      for (const container of pending) {
        if (destroyed || !node.contains(container)) return;
        const encoded = container.dataset.mermaidSrc;
        if (!encoded) continue;

        const source = decodeSource(encoded);
        if (source === null) {
          showFallback(container, "", "Diagram source could not be decoded.");
          container.dataset.mermaidTheme = themeForRun;
          continue;
        }

        container.innerHTML = '<span class="mermaid-loading">Rendering diagram...</span>';

        const result = await renderMermaid(source);
        if (destroyed || !node.contains(container)) return;

        if ("svg" in result) {
          container.innerHTML = result.svg;
          reveal(container);
        } else {
          showFallback(container, source, result.error);
        }
        container.dataset.mermaidTheme = themeForRun;
      }
    } finally {
      rendering = false;
      if (rerunAfterRender) {
        rerunAfterRender = false;
        schedule();
      }
    }
  };

  const observer = new MutationObserver(schedule);
  observer.observe(node, { childList: true, subtree: true });
  schedule();

  return {
    update(nextTheme) {
      currentTheme = nextTheme ?? getResolvedTheme();
      schedule();
    },
    destroy() {
      destroyed = true;
      observer.disconnect();
    },
  };
};
