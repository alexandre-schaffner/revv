<script lang="ts">
import * as Dialog from "$lib/components/ui/dialog/index.js";
import AddRepoForm from "./AddRepoForm.svelte";

let {
  open = false,
  onOpenChange,
}: {
  open?: boolean;
  onOpenChange: (open: boolean) => void;
} = $props();
</script>

<Dialog.Root {open} {onOpenChange}>
  <Dialog.Content
    class="!gap-0 !p-0 sm:!max-w-[480px] max-h-[min(580px,82vh)] overflow-hidden"
    showCloseButton={false}
  >
    <Dialog.Header class="sr-only">
      <Dialog.Title>Add repository</Dialog.Title>
      <Dialog.Description>Track a new GitHub repository in Revv.</Dialog.Description>
    </Dialog.Header>
    <div class="flex min-h-0 flex-1 flex-col p-5">
      <AddRepoForm onClose={() => onOpenChange(false)} />
    </div>
  </Dialog.Content>
</Dialog.Root>
