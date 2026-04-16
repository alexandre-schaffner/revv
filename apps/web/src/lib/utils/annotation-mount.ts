/**
 * Utility for mounting Svelte 5 components into HTMLElements that are returned
 * from @pierre/diffs renderAnnotation callbacks. Maintains a cleanup registry
 * so all mounted instances can be destroyed before instance.cleanUp() fires.
 */
import { mount, unmount } from 'svelte';
import type { Component } from 'svelte';

type MountedInstance = ReturnType<typeof mount>;

// Registry: target element → mounted Svelte component instance
const registry = new Map<HTMLElement, MountedInstance>();

/**
 * Mount a Svelte component into a target HTMLElement.
 * If the target already has a mounted component, it is unmounted first.
 */
export function mountInto<Props extends Record<string, unknown>>(
	target: HTMLElement,
	Component: Component<Props>,
	props: Props
): void {
	const existing = registry.get(target);
	if (existing) {
		try {
			unmount(existing);
		} catch {
			// ignore unmount errors
		}
		registry.delete(target);
	}
	const instance = mount(Component, { target, props });
	registry.set(target, instance);
}

/**
 * Unmount the Svelte component mounted into a target element, if any.
 */
export function unmountFrom(target: HTMLElement): void {
	const instance = registry.get(target);
	if (!instance) return;
	try {
		unmount(instance);
	} catch {
		// ignore unmount errors
	}
	registry.delete(target);
}

/**
 * Unmount ALL mounted Svelte components. Call this before instance.cleanUp()
 * to prevent orphaned Svelte state when the diff container is destroyed.
 */
export function cleanupAllMounted(): void {
	for (const [target, instance] of registry) {
		try {
			unmount(instance);
		} catch {
			// ignore unmount errors
		}
		registry.delete(target);
	}
}

// ── Scoped annotation registry ───────────────────────────────────────────────
// Use when multiple components independently mount annotations and need
// isolated cleanup (e.g. walkthrough blocks alongside DiffViewerInner).

export interface AnnotationScope {
	mountInto<Props extends Record<string, unknown>>(
		target: HTMLElement,
		Comp: Component<Props>,
		props: Props,
	): void;
	cleanupAll(): void;
}

/**
 * Create an isolated annotation mount scope. Each scope tracks its own set
 * of mounted Svelte components and can clean them up independently without
 * affecting other scopes or the global registry.
 */
export function createAnnotationScope(): AnnotationScope {
	const scopeRegistry = new Map<HTMLElement, MountedInstance>();

	return {
		mountInto<Props extends Record<string, unknown>>(
			target: HTMLElement,
			Comp: Component<Props>,
			props: Props,
		): void {
			const existing = scopeRegistry.get(target);
			if (existing) {
				try { unmount(existing); } catch { /* ignore */ }
				scopeRegistry.delete(target);
			}
			const instance = mount(Comp, { target, props });
			scopeRegistry.set(target, instance);
		},

		cleanupAll(): void {
			for (const [, instance] of scopeRegistry) {
				try { unmount(instance); } catch { /* ignore */ }
			}
			scopeRegistry.clear();
		},
	};
}
