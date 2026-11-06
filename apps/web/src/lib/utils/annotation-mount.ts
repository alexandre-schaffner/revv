/**
 * Svelte components mounted into the hosts a Pierre `renderAnnotation`
 * callback returns. Each viewer owns one registry, so tearing one viewer down
 * never unmounts another's annotations.
 */

import type { Component } from "svelte";
import { mount, unmount } from "svelte";

type MountedInstance = ReturnType<typeof mount>;

function unmountLogged(instance: MountedInstance): void {
  try {
    void unmount(instance);
  } catch (e) {
    console.warn("[annotation-mount] unmount failed:", e);
  }
}

export class AnnotationMounts {
  readonly #mounted = new Map<HTMLElement, MountedInstance>();

  /** Mount `Component` into `target`, replacing whatever was mounted there. */
  mount<Props extends Record<string, unknown>>(
    target: HTMLElement,
    Component: Component<Props>,
    props: Props,
  ): void {
    const existing = this.#mounted.get(target);
    if (existing) unmountLogged(existing);
    this.#mounted.set(target, mount(Component, { target, props }));
  }

  /**
   * Pierre drops the previous annotation hosts (`element.remove()`) on every
   * re-render without knowing what we mounted in them; unmount those so their
   * effects and listeners don't outlive them. Hosts still connected are kept.
   */
  pruneDetached(): void {
    for (const [target, instance] of this.#mounted) {
      if (target.isConnected) continue;
      unmountLogged(instance);
      this.#mounted.delete(target);
    }
  }

  /** Unmount everything; call before the Pierre instance is cleaned up. */
  clear(): void {
    for (const instance of this.#mounted.values()) unmountLogged(instance);
    this.#mounted.clear();
  }
}
