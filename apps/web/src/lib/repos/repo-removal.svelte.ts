import type { Repository } from "@revv/shared";
import { deleteRepo } from "$lib/stores/repos.svelte";

/** Confirm-then-remove state for a list of tracked repositories, driving `RepoDeleteConfirm`. */
export class RepoRemoval {
  /** The repository awaiting confirmation; the dialog is open while set. */
  pending = $state<Repository | null>(null);
  #removing = $state(new Set<string>());

  isRemoving(id: string): boolean {
    return this.#removing.has(id);
  }

  request(repo: Repository): void {
    this.pending = repo;
  }

  onOpenChange = (open: boolean): void => {
    if (!open) this.pending = null;
  };

  // Removal is optimistic and its progress lives in a toast, so the confirm
  // dialog closes immediately rather than idling on a row that's already gone.
  confirm = async (): Promise<void> => {
    const repo = this.pending;
    this.pending = null;
    if (!repo || this.#removing.has(repo.id)) return;
    this.#removing = new Set([...this.#removing, repo.id]);
    try {
      await deleteRepo(repo.id);
    } catch {
      // deleteRepo restores the optimistic removal and shows the failure toast.
    } finally {
      const next = new Set(this.#removing);
      next.delete(repo.id);
      this.#removing = next;
    }
  };
}
