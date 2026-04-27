import './styles.css';
import { render } from 'solid-js/web';
import { RouterProvider } from '@tanstack/solid-router';
import { QueryClient, QueryClientProvider } from '@tanstack/solid-query';
import { getRouter } from './router';
import { initCollections } from './db/collections';

const queryClient = new QueryClient({
	defaultOptions: {
		queries: { staleTime: 5 * 60 * 1000 },
	},
});

async function boot() {
	await initCollections();

	const router = getRouter();

	const app = document.getElementById('app');
	if (!app) throw new Error('Root element #app not found');

	render(() => <RouterProvider router={router} />, app);
}

boot().catch((err) => {
	console.error('Boot failed:', err);
	const app = document.getElementById('app');
	if (app) {
		app.innerHTML = '<div style=\"padding:40px;font-family:sans-serif;color:#dc2626\"><h2>Boot Failed</h2><pre>' + String(err).replace(/</g, '&lt;') + '</pre></div>';
	}
});