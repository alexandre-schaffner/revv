import { Kbd } from "@revv/solid-ui/components/kbd";
import type { Component } from "solid-js";

interface KeyboardShortcutHintProps {
  keys: string;
  class?: string;
}

export const KeyboardShortcutHint: Component<KeyboardShortcutHintProps> = (
  props,
) => {
  return <Kbd keys={props.keys} class={props.class} size="sm" />;
};
