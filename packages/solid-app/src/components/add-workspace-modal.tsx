import { Kbd } from "@revv/solid-ui/components/kbd";
import { cn } from "@revv/solid-ui/lib/utils";
import { createForm } from "@tanstack/solid-form";
import { FolderGit, X } from "lucide-solid";
import { type Component, Show } from "solid-js";

interface AddWorkspaceModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (values: { name: string; path: string }) => void;
}

export const AddWorkspaceModal: Component<AddWorkspaceModalProps> = (props) => {
  const form = createForm(() => ({
    onSubmit: async ({ value }) => {
      props.onSubmit(value);
      form.reset();
    },
    defaultValues: {
      name: "",
      path: "",
    },
  }));

  return (
    <Show when={props.open}>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div class="w-full max-w-md rounded-lg border border-gray-200 bg-white p-6 shadow-xl">
          <div class="mb-4 flex items-center justify-between">
            <h2 class="text-lg font-semibold text-gray-900">Add Workspace</h2>
            <button
              type="button"
              onClick={props.onClose}
              class="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              form.handleSubmit();
            }}
            class="space-y-4"
          >
            <form.Field
              name="name"
              validators={{
                onChange: ({ value }) =>
                  !value ? "Name is required" : undefined,
              }}
              children={(field) => (
                <div>
                  <label
                    for={field().name}
                    class="mb-1 block text-sm font-medium text-gray-700"
                  >
                    Name
                  </label>
                  <input
                    id={field().name}
                    name={field().name}
                    value={field().state.value}
                    onBlur={field().handleBlur}
                    onInput={(e) => field().handleChange(e.currentTarget.value)}
                    placeholder="My Project"
                    class={cn(
                      "w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2",
                      field().state.meta.errors.length > 0
                        ? "border-red-300 focus:border-red-400 focus:ring-red-200"
                        : "border-gray-300 focus:border-blue-400 focus:ring-blue-200",
                    )}
                  />
                  <Show when={field().state.meta.errors.length > 0}>
                    <p class="mt-1 text-xs text-red-500">
                      {field().state.meta.errors[0]}
                    </p>
                  </Show>
                </div>
              )}
            />

            <form.Field
              name="path"
              validators={{
                onChange: ({ value }) =>
                  !value ? "Path is required" : undefined,
              }}
              children={(field) => (
                <div>
                  <label
                    for={field().name}
                    class="mb-1 block text-sm font-medium text-gray-700"
                  >
                    Path
                  </label>
                  <div class="relative">
                    <FolderGit
                      size={16}
                      class="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                    />
                    <input
                      id={field().name}
                      name={field().name}
                      value={field().state.value}
                      onBlur={field().handleBlur}
                      onInput={(e) =>
                        field().handleChange(e.currentTarget.value)
                      }
                      placeholder="/path/to/repo"
                      class={cn(
                        "w-full rounded-md border py-2 pl-9 pr-3 text-sm outline-none focus:ring-2",
                        field().state.meta.errors.length > 0
                          ? "border-red-300 focus:border-red-400 focus:ring-red-200"
                          : "border-gray-300 focus:border-blue-400 focus:ring-blue-200",
                      )}
                    />
                  </div>
                  <Show when={field().state.meta.errors.length > 0}>
                    <p class="mt-1 text-xs text-red-500">
                      {field().state.meta.errors[0]}
                    </p>
                  </Show>
                </div>
              )}
            />

            <div class="flex items-center justify-between pt-2">
              <Kbd keys="Escape" size="sm" />
              <div class="flex gap-2">
                <button
                  type="button"
                  onClick={props.onClose}
                  class="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <form.Subscribe
                  selector={(state) => ({
                    canSubmit: state.canSubmit,
                    isSubmitting: state.isSubmitting,
                  })}
                  children={(state) => (
                    <button
                      type="submit"
                      disabled={!state().canSubmit}
                      class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {state().isSubmitting ? "Adding..." : "Add Workspace"}
                    </button>
                  )}
                />
              </div>
            </div>
          </form>
        </div>
      </div>
    </Show>
  );
};
