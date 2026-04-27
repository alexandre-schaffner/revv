import { Kbd } from "@revv/solid-ui/components/kbd";
import { createHotkey, createHotkeys } from "@tanstack/solid-hotkeys";
import { FolderOpen, Plus, RefreshCw } from "lucide-solid";
import { type Component, Show } from "solid-js";
import type { Workspace } from "../types";
import { AddWorkspaceModal } from "./add-workspace-modal";
import { WorkspaceList } from "./workspace-list";

interface SidebarProps {
  workspaces: Workspace[];
  selectedId: string | null;
  isLoading: boolean;
  isModalOpen: boolean;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (name: string, path: string) => void;
  onRefreshGit: (id: string) => void;
  onToggleModal: () => void;
}

export const Sidebar: Component<SidebarProps> = (props) => {
  // Keyboard shortcuts
  createHotkey("Mod+A", () => {
    props.onToggleModal();
  });

  createHotkey("Escape", () => {
    if (props.isModalOpen) {
      props.onToggleModal();
    }
  });

  createHotkeys([
    {
      hotkey: "ArrowDown",
      callback: () => {
        const idx = props.workspaces.findIndex(
          (w) => w.id === props.selectedId,
        );
        if (idx >= 0 && idx < props.workspaces.length - 1) {
          props.onSelect(props.workspaces[idx + 1]!.id);
        } else if (props.workspaces.length > 0) {
          props.onSelect(props.workspaces[0]!.id);
        }
      },
    },
    {
      hotkey: "ArrowUp",
      callback: () => {
        const idx = props.workspaces.findIndex(
          (w) => w.id === props.selectedId,
        );
        if (idx > 0) {
          props.onSelect(props.workspaces[idx - 1]!.id);
        }
      },
    },
    {
      hotkey: "Enter",
      callback: () => {
        const ws = props.workspaces.find((w) => w.id === props.selectedId);
        if (ws) {
          console.log("Selected workspace:", ws.name);
        }
      },
    },
  ]);

  const handleAdd = async (values: { name: string; path: string }) => {
    await props.onAdd(values.name, values.path);
  };

  const selectedWorkspace = () =>
    props.workspaces.find((w) => w.id === props.selectedId);

  return (
    <div class="flex h-full w-64 flex-col border-r border-gray-200 bg-gray-50">
      <div class="flex items-center justify-between border-b border-gray-200 px-3 py-3">
        <h1 class="text-sm font-semibold text-gray-900">Workspaces</h1>
        <div class="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              const ws = selectedWorkspace();
              if (ws) props.onRefreshGit(ws.id);
            }}
            class="inline-flex items-center gap-1 rounded-md bg-gray-100 px-2 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200 transition-colors"
            title="Refresh git state"
          >
            <RefreshCw size={12} />
          </button>
          <button
            type="button"
            onClick={() => props.onToggleModal()}
            class="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <Plus size={14} />
            <span>Add</span>
            <Kbd keys="Mod+A" class="ml-1" size="sm" />
          </button>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto p-2">
        <Show
          when={!props.isLoading}
          fallback={
            <div class="flex items-center justify-center py-8">
              <div class="h-5 w-5 animate-spin rounded-full border-2 border-gray-300 border-t-blue-600" />
            </div>
          }
        >
          <WorkspaceList
            workspaces={props.workspaces}
            selectedId={props.selectedId}
            onSelect={props.onSelect}
            onRemove={props.onRemove}
          />
        </Show>
      </div>

      <div class="border-t border-gray-200 px-3 py-2">
        <div class="flex items-center gap-2 text-xs text-gray-400">
          <FolderOpen size={14} />
          <span class="truncate">
            {selectedWorkspace()?.path ?? "No workspace selected"}
          </span>
        </div>
      </div>

      <AddWorkspaceModal
        open={props.isModalOpen}
        onClose={() => props.onToggleModal()}
        onSubmit={handleAdd}
      />
    </div>
  );
};
