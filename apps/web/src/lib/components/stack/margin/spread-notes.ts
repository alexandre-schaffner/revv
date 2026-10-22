import type { Attachment } from "svelte/attachments";

const GAP_PX = 16;

function spread(root: HTMLElement): void {
  let floor = Number.NEGATIVE_INFINITY;
  for (const note of root.querySelectorAll<HTMLElement>("[data-rail-note]")) {
    note.style.translate = "";
    if (getComputedStyle(note).position !== "absolute") continue;
    const box = note.getBoundingClientRect();
    const shift = Math.max(0, floor - box.top);
    if (shift > 0) note.style.translate = `0 ${shift}px`;
    floor = box.bottom + shift + GAP_PX;
  }
}

export const spreadRailNotes: Attachment<HTMLElement> = (root) => {
  const resize = new ResizeObserver(() => spread(root));
  const watch = (): void => {
    resize.disconnect();
    resize.observe(root);
    for (const note of root.querySelectorAll("[data-rail-note]")) resize.observe(note);
  };
  const mutations = new MutationObserver(watch);
  mutations.observe(root, { childList: true, subtree: true });
  watch();
  return () => {
    mutations.disconnect();
    resize.disconnect();
  };
};
