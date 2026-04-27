import {
  createHeldKeys,
  formatForDisplay,
  parseHotkey,
} from "@tanstack/solid-hotkeys";
import { type Component, createMemo, type JSX } from "solid-js";
import { cn } from "../lib/utils";

interface KbdProps extends JSX.HTMLAttributes<HTMLSpanElement> {
  /** Hotkey string (e.g. "Mod+S") or array of display labels (e.g. ["⌘", "K"]). */
  keys: string | string[];
  /** Visual size. */
  size?: "sm" | "md";
}

export const Kbd: Component<KbdProps> = (props) => {
  const heldKeys = createHeldKeys();

  const isHotkeyString = createMemo(() => typeof props.keys === "string");
  const parsed = createMemo(() =>
    isHotkeyString() ? parseHotkey(props.keys as string) : null,
  );

  const displayParts = createMemo((): string[] => {
    if (!isHotkeyString()) return props.keys as string[];
    const formatted = formatForDisplay(props.keys as string);
    return formatted.split(/\s+/).filter(Boolean);
  });

  /** True when every key in the parsed hotkey is currently held. */
  const isActive = createMemo((): boolean => {
    const p = parsed();
    if (!p || typeof document === "undefined") return false;
    const held = new Set(heldKeys());
    for (const mod of p.modifiers) {
      if (!held.has(mod)) return false;
    }
    if (p.key && !held.has(p.key as string)) return false;
    return true;
  });

  return (
    <span
      class={cn("inline-flex items-center gap-[3px]", props.class)}
      data-active={isActive()}
      {...props}
    >
      {displayParts().map((part) => (
        <kbd
          class={cn(
            "inline-flex items-center justify-center rounded border font-mono leading-none transition-all select-none",
            /* sizing */
            props.size === "md"
              ? "min-w-[24px] h-6 px-1.5 text-[11px]"
              : "min-w-[20px] h-5 px-1 text-[10px]",
            /* idle */
            "bg-gray-100 text-gray-500 border-gray-200 shadow-[0_1px_0_rgba(0,0,0,0.06)]",
            /* pressed */
            isActive() &&
              "scale-[0.94] translate-y-px bg-gray-50 text-gray-600 shadow-none",
          )}
        >
          {part}
        </kbd>
      ))}
    </span>
  );
};
