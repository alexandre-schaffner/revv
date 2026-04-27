import { cn } from "@revv/solid-ui/lib/utils";
import { GitBranch, GitFork, Trash2 } from "lucide-solid";
import { type Component, For, Show } from "solid-js";
import type { Workspace } from "../types";

interface WorkspaceListProps {
  workspaces: Workspace[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
}

export const WorkspaceList: Component<WorkspaceListProps> = (props) => {
  return (
    <div class="flex flex-col gap-0.5">
      <Show
        when={props.workspaces.length > 0}
        fallback={
          <div class="px-3 py-8 text-center text-sm text-gray-400">
            No workspaces yet.
            <br />
            Press{" "}
            <kbd class="rounded border border-gray-200 bg-gray-50 px-1 py-0.5 font-mono text-xs text-gray-500">
              Mod+A
            </kbd>{" "}
            to add one.
          </div>
        }
      >
        <For each={props.workspaces}>
          {(workspace) => (
            <div
              role="button"
              tabIndex={0}
              onClick={() => props.onSelect(workspace.id)}
              class={cn(
                "group relative flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
                props.selectedId === workspace.id
                  ? "bg-blue-50 text-blue-900"
                  : "text-gray-700 hover:bg-gray-100",
              )}
            >
              <div class="flex min-w-0 flex-1 flex-col">
                <span class="truncate font-medium">{workspace.name}</span>
                <Show when={workspace.branch}>
                  <span
                    class={cn(
                      "flex items-center gap-1 text-xs",
                      props.selectedId === workspace.id
                        ? "text-blue-600"
                        : "text-gray-500",
                    )}
                  >
                    <GitBranch size={12} />
                    {workspace.branch}
                  </span>
                </Show>
                <Show
                  when={workspace.worktreeCount && workspace.worktreeCount > 0}
                >
                  <span
                    class={cn(
                      "flex items-center gap-1 text-xs",
                      props.selectedId === workspace.id
                        ? "text-blue-400"
                        : "text-gray-400",
                    )}
                  >
                    <GitFork size={10} />
                    {workspace.worktreeCount} worktree
                    {workspace.worktreeCount === 1 ? "" : "s"}
                  </span>
                </Show>
              </div>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onRemove(workspace.id);
                }}
                class="opacity-0 rounded-md p-1 text-gray-400 hover:bg-red-50 hover:text-red-500 group-hover:opacity-100 transition-opacity"
                aria-label={`Remove ${workspace.name}`}
              >
                <Trash2 size={14} />
              </button>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
};
