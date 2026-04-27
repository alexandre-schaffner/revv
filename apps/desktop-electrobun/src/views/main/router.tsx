import { createHashHistory, createRouter } from "@tanstack/solid-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
	return createRouter({
		routeTree,
		scrollRestoration: true,
		defaultPreload: "intent",
		history: createHashHistory(),
		defaultErrorComponent: () => (
			<div style="padding: 40px; font-family: sans-serif; color: #dc2626;">
				<h2>Router Error</h2>
				<p>Something went wrong loading this page.</p>
			</div>
		),
		defaultNotFoundComponent: () => (
			<div style="padding: 40px; font-family: sans-serif;">
				<h2>Page Not Found</h2>
				<p>No route matched the current URL.</p>
			</div>
		),
	});
}

declare module "@tanstack/solid-router" {
	interface Register {
		router: ReturnType<typeof getRouter>;
	}
}
