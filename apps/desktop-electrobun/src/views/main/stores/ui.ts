import { Store } from "@tanstack/store";

export const uiStore = new Store({
  sidebarOpen: true,
  selectedWorkspaceId: null as string | null,
  activeModal: null as "add-workspace" | null,
});
