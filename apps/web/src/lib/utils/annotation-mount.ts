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
