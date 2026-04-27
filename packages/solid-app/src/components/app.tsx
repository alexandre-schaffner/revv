import { Kbd } from "@revv/solid-ui/components/kbd";
import { HotkeysProvider } from "@tanstack/solid-hotkeys";
import type { Component } from "solid-js";
import type { Workspace } from "../types";
import { Sidebar } from "./sidebar";

interface AppProps {
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

export const App: Component<AppProps> = (props) => {
  return (
    <HotkeysProvider>
      <div class="flex h-screen w-screen overflow-hidden bg-white text-gray-900">
        <Sidebar
          workspaces={props.workspaces}
          selectedId={props.selectedId}
          isLoading={props.isLoading}
          isModalOpen={props.isModalOpen}
          onSelect={props.onSelect}
          onRemove={props.onRemove}
          onAdd={props.onAdd}
          onRefreshGit={props.onRefreshGit}
          onToggleModal={props.onToggleModal}
        />
        <main class="flex flex-1 flex-col items-center justify-center bg-gray-50">
          <div class="text-center space-y-2">
            <h2 class="text-2xl font-bold text-gray-900">Workspace Editor</h2>
            <p class="text-gray-500">
              Select a workspace from the sidebar to get started.
            </p>
            <div class="mt-4 inline-flex gap-4 text-xs text-gray-400">
              <span>
                <Kbd keys="Mod+A" size="sm" /> Add workspace
              </span>
              <span>
                <Kbd keys={["↑", "↓"]} size="sm" /> Navigate
              </span>
              <span>
                <Kbd keys="Enter" size="sm" /> Select
              </span>
            </div>
          </div>
        </main>
      </div>
    </HotkeysProvider>
  );
};
