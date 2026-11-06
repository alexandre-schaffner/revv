import type { Repository } from "@revv/shared";
import { untrack } from "svelte";
import {
  fallbackOwnerPalette,
  type OwnerPalette,
  ownerPaletteFromAvatar,
  peekOwnerPalette,
} from "./avatar-palette";

/**
 * A repo's owner palette (its homepage and gradient avatar are printed in
 * it): read off the owner's avatar once it has loaded, a hue hashed from the
 * repo's name until then. The session cache makes a second extraction for
 * the same avatar free. Call during component init.
 */
export function ownerPalette(repo: () => Pick<Repository, "fullName" | "avatarUrl">): {
  readonly current: OwnerPalette;
} {
  let resolved = $state<OwnerPalette | undefined>(undefined);
  const current = $derived(resolved ?? fallbackOwnerPalette(repo().fullName));

  $effect(() => {
    const { avatarUrl: src, fullName } = repo();
    const fallback = fallbackOwnerPalette(fullName);
    return untrack(() => {
      const cached = src ? peekOwnerPalette(src) : undefined;
      resolved = cached;
      if (!src || cached !== undefined) return;
      let cancelled = false;
      void ownerPaletteFromAvatar(src, fallback).then((p) => {
        if (!cancelled) resolved = p;
      });
      return () => {
        cancelled = true;
      };
    });
  });

  return {
    get current() {
      return current;
    },
  };
}
