import { App } from '@revv/solid-app';
import { useLiveQuery } from '@tanstack/solid-db';
import { createQuery, useQueryClient } from '@tanstack/solid-query';
import { createFileRoute } from '@tanstack/solid-router';
import { createSignal, Show } from 'solid-js';
import { api } from '../lib/eden';
import { getWorkspaceCollection } from '../db/collections';

export const Route = createFileRoute('/')({
	component: HomeComponent,
});

function HomeComponent() {
	const queryClient = useQueryClient();
	const [selectedId, setSelectedId] = createSignal<string | null>(null);
	const [isModalOpen, setIsModalOpen] = createSignal(false);
	const [apiError, setApiError] = createSignal<string | null>(null);

	const workspaceCollection = getWorkspaceCollection() as any;

	const hydrationQuery = createQuery(() => ({
		queryKey: ['workspaces', 'hydrate'],
		queryFn: async () => {
			try {
				const { data, error } = await api.api.workspaces.get();
				if (error) throw error;
				const workspaces = (data ?? []) as any[];
				for (const ws of workspaces) {
					workspaceCollection.insert(ws);
				}
				setApiError(null);
				return workspaces;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				setApiError(msg);
				return [];
			}
		},
		staleTime: Infinity,
		retry: false,
	}));

	const liveQuery = useLiveQuery((q) => q.from({ ws: workspaceCollection }));

	const workspaces = () => (liveQuery() ?? []) as any[];
	const isLoading = () => hydrationQuery.isLoading;

	const handleAdd = async (name: string, path: string) => {
		try {
			const { data, error } = await api.api.workspaces.post({
				id: crypto.randomUUID(),
				name,
				path,
				branch: null,
				worktreeCount: null,
			});
			if (error) throw error;
			if (data) {
				workspaceCollection.insert(data);
				queryClient.invalidateQueries({ queryKey: ['workspaces'] });
			}
			setApiError(null);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			setApiError('Add failed: ' + msg);
		}
	};

	const handleRemove = async (id: string) => {
		try {
			const { error } = await api.api.workspaces({ id }).delete();
			if (error) throw error;
			workspaceCollection.delete(id);
			queryClient.invalidateQueries({ queryKey: ['workspaces'] });
			setApiError(null);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			setApiError('Remove failed: ' + msg);
		}
	};

	const handleRefreshGit = async (id: string) => {
		try {
			const { data, error } = await api.api.workspaces({ id })['refresh-git'].post();
			if (error) throw error;
			if (data) {
				workspaceCollection.update(id, (draft: any) => {
					draft.branch = data.branch;
					draft.worktreeCount = data.worktreeCount;
				});
			}
			setApiError(null);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			setApiError('Refresh failed: ' + msg);
		}
	};

	return (
		<Show
			when={!apiError()}
			fallback={
				<div style={{ padding: '40px', 'font-family': 'sans-serif' }}>
					<h2 style={{ color: '#dc2626' }}>Error</h2>
					<pre
						style={{
							background: '#fee2e2',
							padding: '16px',
							'border-radius': '8px',
							color: '#7f1d1d',
							overflow: 'auto',
							'max-height': '300px',
						}}
					>
						{apiError()}
					</pre>
					<button
						onClick={() => {
							setApiError(null);
							hydrationQuery.refetch();
						}}
						style={{
							'margin-top': '16px',
							padding: '8px 16px',
							background: '#2563eb',
							color: 'white',
							border: 'none',
							'border-radius': '6px',
							cursor: 'pointer',
						}}
					>
						Retry
					</button>
				</div>
			}
		>
			<App
				workspaces={workspaces()}
				selectedId={selectedId()}
				isLoading={isLoading()}
				isModalOpen={isModalOpen()}
				onSelect={setSelectedId}
				onRemove={handleRemove}
				onAdd={handleAdd}
				onRefreshGit={handleRefreshGit}
				onToggleModal={() => setIsModalOpen((o) => !o)}
			/>
		</Show>
	);
}