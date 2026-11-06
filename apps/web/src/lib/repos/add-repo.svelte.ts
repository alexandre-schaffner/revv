import type { Repository } from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import {
  fetchAvailableRepos,
  getAvailableRepos,
  getAvailableReposFetchFailed,
  getAvailableReposLoading,
} from "$lib/repos/catalog.svelte";
import { getRepositories } from "$lib/stores/repos.svelte";
import { repoKey } from "./add-repo";

const MAX_AUTO_RETRIES = 3;
const AUTO_RETRY_DELAY_MS = 2000;

/** The tracked repository named `fullName`, compared case-insensitively. */
export function getTrackedRepo(fullName: string): Repository | undefined {
  const key = repoKey(fullName);
  return getRepositories().find((repo) => repoKey(repo.fullName) === key);
}

/**
 * Loads the browsable-repo catalog for a picker while it is mounted. Call
 * during component init.
 */
export function useAvailableRepos() {
  let autoRetries = $state(0);

  $effect(() => {
    if (
      getAvailableRepos().length === 0 &&
      !getAvailableReposLoading() &&
      !getAvailableReposFetchFailed()
    ) {
      void fetchAvailableRepos();
    }
  });

  // A freshly issued GitHub token can briefly 401 while sign-in propagates,
  // so a failed fetch is retried a few times before the picker offers Retry.
  $effect(() => {
    if (!getAvailableReposFetchFailed() || autoRetries >= MAX_AUTO_RETRIES) return;
    const timer = setTimeout(() => {
      autoRetries++;
      void fetchAvailableRepos(true);
    }, AUTO_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  });

  return {
    /** Loading, or failed with automatic retries still to come. */
    get loading(): boolean {
      return (
        getAvailableReposLoading() ||
        (getAvailableReposFetchFailed() && autoRetries < MAX_AUTO_RETRIES)
      );
    },
    /** Failed and out of automatic retries. */
    get failed(): boolean {
      return getAvailableReposFetchFailed() && autoRetries >= MAX_AUTO_RETRIES;
    },
    retry(): void {
      autoRetries = 0;
      void fetchAvailableRepos(true);
    },
  };
}

/** Opens the native folder picker. Null when the user cancels or it fails. */
export async function pickDirectory(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true });
    return typeof selected === "string" ? selected : null;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : "Failed to open folder picker");
    return null;
  }
}

interface Inspection {
  path: string;
  isGitRepo: boolean;
  remotes: { name: string; url: string }[];
  /** Resolved from the clone's `origin` remote; null when it isn't on this GitHub host. */
  fullName: string | null;
}

/**
 * A local checkout the user wants to link. The GitHub identity always comes
 * from the server's inspection of the folder, never from user input, and only
 * counts while the path field still holds the inspected path.
 */
export class LocalClone {
  path = $state("");
  inspecting = $state(false);
  #inspection = $state<Inspection | null>(null);
  #current = $derived(this.#inspection?.path === this.path.trim() ? this.#inspection : null);

  get isGitRepo(): boolean | null {
    return this.#current?.isGitRepo ?? null;
  }

  get remotes(): { name: string; url: string }[] {
    return this.#current?.remotes ?? [];
  }

  get fullName(): string | null {
    return this.#current?.fullName ?? null;
  }

  get alreadyTracked(): boolean {
    const name = this.fullName;
    return name !== null && getTrackedRepo(name) !== undefined;
  }

  get linkable(): boolean {
    return (
      this.isGitRepo === true && this.fullName !== null && !this.alreadyTracked && !this.inspecting
    );
  }

  async inspect(): Promise<void> {
    const path = this.path.trim();
    if (!path) {
      this.#inspection = null;
      return;
    }
    this.inspecting = true;
    try {
      const { data, error } = await api.api.repos["inspect-local"].post({ path });
      if (error) {
        const value = error.value as { error?: string; message?: string } | undefined;
        throw new Error(value?.error ?? value?.message ?? "Failed to inspect local repository");
      }
      if (!data || "error" in data) throw new Error("Failed to inspect local repository");
      this.#inspection = {
        path,
        isGitRepo: data.isGitRepo,
        remotes: [...data.remotes],
        fullName: data.proposedFullName,
      };
      if (!data.isGitRepo) toast.error("Choose a folder that contains a git repository");
    } catch (e) {
      this.#inspection = null;
      toast.error(e instanceof Error ? e.message : "Failed to inspect local repository");
    } finally {
      this.inspecting = false;
    }
  }

  async browse(): Promise<void> {
    if (this.inspecting) return;
    const selected = await pickDirectory();
    if (selected === null) return;
    this.path = selected;
    await this.inspect();
  }

  clear(): void {
    this.path = "";
    this.#inspection = null;
  }
}
