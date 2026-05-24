<script lang="ts">
import type { Command as CommandPrimitive, Dialog as DialogPrimitive } from "bits-ui";
import type { Snippet } from "svelte";
import * as Dialog from "$lib/components/ui/dialog/index.js";
import { cn, type WithoutChildrenOrChild } from "$lib/utils.js";
import Command from "./command.svelte";

let {
  open = $bindable(false),
  ref = $bindable(null),
  value = $bindable(""),
  title = "Command Palette",
  description = "Search for a command to run",
  portalProps,
  /** Tailwind classes appended to the Dialog.Content shell (width, padding, …). */
  contentClass = "",
  /** Defaults to false. The palette closes on Esc + outside-click; the X
   *  button reads as enterprise-form chrome in this surface. */
  showCloseButton = false,
  children,
  ...restProps
}: WithoutChildrenOrChild<DialogPrimitive.RootProps> &
  WithoutChildrenOrChild<CommandPrimitive.RootProps> & {
    portalProps?: DialogPrimitive.PortalProps;
    children: Snippet;
    title?: string;
    description?: string;
    contentClass?: string;
    showCloseButton?: boolean;
  } = $props();
</script>

<Dialog.Root bind:open {...restProps}>
  <Dialog.Header class="sr-only">
    <Dialog.Title>{title}</Dialog.Title>
    <Dialog.Description>{description}</Dialog.Description>
  </Dialog.Header>
  <Dialog.Content
    class={cn("overflow-hidden p-0", contentClass)}
    {showCloseButton}
    {...portalProps ? { portalProps } : {}}
  >
    <Command {...restProps} bind:value bind:ref {children} />
  </Dialog.Content>
</Dialog.Root>
