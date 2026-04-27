import { createRootRoute, Outlet } from '@tanstack/solid-router';

export const Route = createRootRoute({
	component: RootComponent,
});

function RootComponent() {
	return (
		<div style={{ height: '100vh', width: '100vw' }}>
			<Outlet />
		</div>
	);
}