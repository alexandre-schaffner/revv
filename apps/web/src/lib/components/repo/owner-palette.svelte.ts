import type { Repository } from "@revv/shared";
import { untrack } from "svelte";
import {
  fallbackOwnerPalette,
  type OwnerPalette,
  ownerPaletteFromAvatar,
  peekOwnerPalette,
} from "$lib/utils/avatarPalette";

/**
 * The palette a repo's homepage is printed in: the same one its owner's
 * avatar resolves, read off the avatar once it has loaded and a hue hashed
 * from the repo's name until then. The session cache means the second
 * extraction for an avatar is free. Call during component init.
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
