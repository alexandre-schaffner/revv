<script lang="ts">
import { Command as CommandPrimitive, useId } from "bits-ui";
import type { Snippet } from "svelte";
import { cn } from "$lib/utils.js";

let {
  ref = $bindable(null),
  class: className,
  children,
  heading,
  headingChild,
  value,
  ...restProps
}: CommandPrimitive.GroupProps & {
  heading?: string;
  /** Custom heading content (e.g. an avatar + label). Takes precedence over
   *  the plain `heading` string. Pass `value` to keep the group's cmdk key. */
  headingChild?: Snippet;
} = $props();
</script>

<CommandPrimitive.Group
  bind:ref
  data-slot="command-group"
  class={cn("text-foreground overflow-hidden p-1", className)}
  value={value ?? heading ?? `----${useId()}`}
  {...restProps}
>
  {#if headingChild}
    <CommandPrimitive.GroupHeading
      class="text-muted-foreground px-2 py-1.5 text-xs font-medium"
    >
      {@render headingChild()}
    </CommandPrimitive.GroupHeading>
  {:else if heading}
    <CommandPrimitive.GroupHeading
      class="text-muted-foreground px-2 py-1.5 text-xs font-medium"
    >
      {heading}
    </CommandPrimitive.GroupHeading>
  {/if}
  {#if children}
    <CommandPrimitive.GroupItems {children} />
  {/if}
</CommandPrimitive.Group>
