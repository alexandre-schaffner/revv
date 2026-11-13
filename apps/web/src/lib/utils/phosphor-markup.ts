// `@pierre/diff`'s header callbacks must return hand-built light-DOM
// `Element`s, so they can't render a `phosphor-svelte` component. Paths are
// copied verbatim from `phosphor-svelte/lib/<Icon>.svelte` so the app keeps one
// icon geometry. Add a glyph here only when a component genuinely can't be
// used.

type Weight = "regular" | "fill";

const PATHS: Record<string, Record<Weight, string>> = {
  Rows: {
    regular:
      "M208,136H48a16,16,0,0,0-16,16v40a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V152A16,16,0,0,0,208,136Zm0,56H48V152H208v40Zm0-144H48A16,16,0,0,0,32,64v40a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V64A16,16,0,0,0,208,48Zm0,56H48V64H208v40Z",
    fill: "M224,152v40a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V152a16,16,0,0,1,16-16H208A16,16,0,0,1,224,152ZM208,48H48A16,16,0,0,0,32,64v40a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V64A16,16,0,0,0,208,48Z",
  },
  Columns: {
    regular:
      "M104,32H64A16,16,0,0,0,48,48V208a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V48A16,16,0,0,0,104,32Zm0,176H64V48h40ZM192,32H152a16,16,0,0,0-16,16V208a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V48A16,16,0,0,0,192,32Zm0,176H152V48h40Z",
    fill: "M120,48V208a16,16,0,0,1-16,16H64a16,16,0,0,1-16-16V48A16,16,0,0,1,64,32h40A16,16,0,0,1,120,48Zm72-16H152a16,16,0,0,0-16,16V208a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V48A16,16,0,0,0,192,32Z",
  },
};

/**
 * `aria-hidden` mirrors the app-wide `IconContext` default in
 * `routes/+layout.svelte`: these are decorative, and the button that holds
 * them carries the `aria-label`.
 */
export function phosphorMarkup(
  name: keyof typeof PATHS,
  { size = 14, weight = "regular" }: { size?: number; weight?: Weight } = {},
): string {
  const path = PATHS[name]?.[weight];
  if (!path) throw new Error(`phosphorMarkup: unknown icon ${name}/${weight}`);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">` +
    `<rect width="256" height="256" fill="none"/><path d="${path}"/></svg>`
  );
}
