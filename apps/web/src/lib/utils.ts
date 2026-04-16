import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { Snippet } from 'svelte';

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

export type WithElementRef<T, E extends Element = HTMLElement> = T & {
	ref?: E | null;
};

// Utility types used by shadcn-svelte components.
// We keep children accessible internally (components use {@render children?.()})
// but make it optional so consumers aren't required to pass it.
export type WithoutChild<T> = Omit<T, 'children'> & { children?: Snippet };

export type WithoutChildrenOrChild<T> = Omit<T, 'children'> & { children?: Snippet };
