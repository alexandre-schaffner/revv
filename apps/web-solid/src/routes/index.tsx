import { App } from "@revv/solid-app";
import { createFileRoute } from "@tanstack/solid-router";
import { createResource, createSignal } from "solid-js";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [isModalOpen, setIsModalOpen] = createSignal(false);

  const [workspaces, { refetch }] = createResource(async () => {
    const raw = localStorage.getItem("workspaces");
    if (!raw) return [];
    return JSON.parse(raw) as Array<{
      id: string;
      name: string;
      path: string;
      branch: string | null;
      worktreeCount: number | null;
    }>;
  });

  const handleAdd = async (name: string, path: string) => {
    const list = workspaces() ?? [];
    const id = crypto.randomUUID();
    const item = {
      id,
      name,
      path,
      branch: null as string | null,
      worktreeCount: null as number | null,
    };
    const updated = [...list, item];
    localStorage.setItem("workspaces", JSON.stringify(updated));
    await refetch();
    setIsModalOpen(false);
  };

  const handleRemove = async (id: string) => {
    const list = workspaces() ?? [];
    const updated = list.filter((w) => w.id !== id);
    localStorage.setItem("workspaces", JSON.stringify(updated));
    await refetch();
  };

  return (
    <App
      workspaces={workspaces() ?? []}
      selectedId={selectedId()}
      isLoading={workspaces.loading}
      isModalOpen={isModalOpen()}
      onSelect={setSelectedId}
      onRemove={handleRemove}
      onAdd={handleAdd}
      onRefreshGit={() => {}}
      onToggleModal={() => setIsModalOpen((o) => !o)}
    />
  );
}
