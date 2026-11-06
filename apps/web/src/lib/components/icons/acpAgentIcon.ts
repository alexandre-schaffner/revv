// Brand marks where we have them, a generic glyph otherwise, so an agent added
// to the shared registry renders everywhere without icon work.

import type { AcpAgentIconKey } from "@revv/shared";
import Robot from "phosphor-svelte/lib/Robot";
import type { Component } from "svelte";
import AnthropicIcon from "./AnthropicIcon.svelte";
import CursorIcon from "./CursorIcon.svelte";
import OpenAIIcon from "./OpenAIIcon.svelte";
import OpenCodeIcon from "./OpenCodeIcon.svelte";

// biome-ignore lint/suspicious/noExplicitAny: heterogeneous icon component prop shapes
type IconComponent = Component<any>;

const ICONS: Record<AcpAgentIconKey, IconComponent> = {
  anthropic: AnthropicIcon,
  openai: OpenAIIcon,
  opencode: OpenCodeIcon,
  cursor: CursorIcon,
  generic: Robot,
};

export function acpAgentIcon(icon: AcpAgentIconKey): IconComponent {
  return ICONS[icon] ?? Robot;
}
