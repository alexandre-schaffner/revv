import { Kbd } from "@rev/ui/components/ui/kbd";
import {
  useActiveMode,
  useModeShortcuts,
  formatKeys,
  formatKeysString,
  type ShortcutDef,
} from "../lib/shortcuts";

/**
 * Shows a floating hint bar when a mode is active.
 * Automatically pulls available shortcuts for the mode from the registry.
 *
 * Place this inside the block that owns the mode — it only renders
 * when `mode` matches the currently active mode.
 */
export function ModeIndicator({ mode }: { mode: string }) {
  const active = useActiveMode();
  const shortcuts = useModeShortcuts(mode);

  if (active !== mode || shortcuts.length === 0) return null;

  return (
    <div className="flex items-center gap-3 px-3 py-1 bg-primary/10 border-b border-primary/20 animate-in fade-in slide-in-from-top-1 duration-150">
      {shortcuts.map((def) => (
        <span
          key={def.id}
          className="flex items-center gap-1 text-[10px] text-primary"
        >
          <Kbd className="h-4 min-w-4 text-[9px] bg-primary/15 text-primary border-primary/25">
            {formatKeysString(def.keys)}
          </Kbd>
          <span>{def.label}</span>
        </span>
      ))}
      <span className="flex items-center gap-1 text-[10px] text-muted-foreground ml-auto">
        <Kbd className="h-4 min-w-4 text-[9px]">Esc</Kbd>
        <span>exit</span>
      </span>
    </div>
  );
}
