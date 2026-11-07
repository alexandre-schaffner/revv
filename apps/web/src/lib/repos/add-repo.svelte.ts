import type { Repository } from "@revv/shared";
import { toast } from "svelte-sonner";
import { api } from "$lib/api/client";
import { call } from "$lib/api/errors";
import { thrownMessage } from "$lib/api/wire";
import {
  fetchAvailableRepos,
  fetchDefaultCloneBaseDir,
  getAvailableRepos,
  getAvailableReposFetchFailed,
  getAvailableReposLoading,
  getDefaultCloneBaseDir,
} from "$lib/repos/catalog.svelte";
import { readStored, STORAGE_KEYS, textCodec, writeStored } from "$lib/stores/persisted.svelte";
import { getRepositories } from "$lib/stores/repos.svelte";
import { clonePathPreview, repoKey } from "./add-repo";

const MAX_AUTO_RETRIES = 3;
const AUTO_RETRY_DELAY_MS = 2000;

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
    get loading(): boolean {
      return (
        getAvailableReposLoading() ||
        (getAvailableReposFetchFailed() && autoRetries < MAX_AUTO_RETRIES)
      );
    },
    get failed(): boolean {
      return getAvailableReposFetchFailed() && autoRetries >= MAX_AUTO_RETRIES;
    },
    retry(): void {
      autoRetries = 0;
      void fetchAvailableRepos(true);
    },
  };
}

export async function pickDirectory(): Promise<string | null> {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ directory: true });
    return typeof selected === "string" ? selected : null;
  } catch (e) {
    toast.error(thrownMessage(e));
    return null;
  }
}

/**
 * Where "Clone from GitHub" puts a clone: the last custom base the user cloned
 * into, else the server's default. Construct during component init.
 */
export class CloneBase {
  /** A custom base; empty means the server's default. */
  path = $state(readStored(STORAGE_KEYS.lastCloneBase, textCodec, null) ?? "");

  constructor() {
    void fetchDefaultCloneBaseDir();
  }

  get defaultPath(): string | null {
    return getDefaultCloneBaseDir();
  }

  /** The custom base to send; absent defers to the server's default. */
  get custom(): string | undefined {
    return this.path.trim() || undefined;
  }

  previewFor(fullName: string): string | null {
    const base = this.custom ?? getDefaultCloneBaseDir();
    return base ? clonePathPreview(base, fullName) : null;
  }

  /**
   * After a successful clone, so the next one starts there. An empty value
   * stays empty: pinning the default would outlive a later server change.
   */
  remember(): void {
    writeStored(STORAGE_KEYS.lastCloneBase, textCodec, this.path.trim());
  }

  async browse(): Promise<void> {
    const selected = await pickDirectory();
    if (selected !== null) this.path = selected;
  }
}

interface Inspection {
  path: string;
  isGitRepo: boolean;
  /** Resolved from the clone's `origin` remote; null when it isn't on this GitHub host. */
  fullName: string | null;
}

/** What the inspected folder is, for the hint under the path field. */
export type LocalCloneStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "not-git" }
  /** Its `origin` doesn't point at a repository on this GitHub host. */
  | { readonly kind: "foreign-origin" }
  | { readonly kind: "recognized"; readonly fullName: string }
  | { readonly kind: "tracked"; readonly fullName: string };

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

  readonly status = $derived.by((): LocalCloneStatus => {
    const current = this.#current;
    if (!current) return { kind: "idle" };
    if (!current.isGitRepo) return { kind: "not-git" };
    const fullName = current.fullName;
    if (fullName === null) return { kind: "foreign-origin" };
    return getTrackedRepo(fullName)
      ? { kind: "tracked", fullName }
      : { kind: "recognized", fullName };
  });

  /** The recognized, untracked repository to link, once inspection settled. */
  get linkableName(): string | null {
    return this.status.kind === "recognized" && !this.inspecting ? this.status.fullName : null;
  }

  async inspect(): Promise<void> {
    const path = this.path.trim();
    if (!path) {
      this.#inspection = null;
      return;
    }
    this.inspecting = true;
    try {
      const data = await call(
        api.api.repos["inspect-local"].post({ path }),
        "Failed to inspect local repository",
      );
      this.#inspection = {
        path,
        isGitRepo: data.isGitRepo,
        fullName: data.proposedFullName,
      };
      if (!data.isGitRepo) toast.error("Choose a folder that contains a git repository");
    } catch (e) {
      this.#inspection = null;
      toast.error(thrownMessage(e));
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
