import { Kbd } from "@rev/ui/components/ui/kbd";
import { useShortcut, useShortcutPressed, formatKeysString } from "../lib/shortcuts";

interface ShortcutKbdProps {
  /** Shortcut ID from the registry */
  shortcut: string;
  /** Override the displayed text (defaults to formatted keys) */
  children?: React.ReactNode;
  className?: string;
}

/**
 * A Kbd that is wired to the shortcut system.
 * Automatically shows the right keys and animates on press.
 *
 * Usage:
 *   <ShortcutKbd shortcut="sidebar:files" />
 *   <ShortcutKbd shortcut="approval:accept" className="bg-primary-foreground/20 text-primary-foreground" />
 */
export function ShortcutKbd({ shortcut, children, className = "" }: ShortcutKbdProps) {
  const def = useShortcut(shortcut);
  const pressed = useShortcutPressed(shortcut);

  if (!def) return null;

  return (
    <Kbd
      className={`transition-all duration-100 ${pressed ? "translate-y-px scale-95 brightness-90" : ""} ${className}`}
    >
      {children ?? formatKeysString(def.keys)}
    </Kbd>
  );
}
