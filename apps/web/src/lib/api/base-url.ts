import { API_PORT } from '@revv/shared';

const port = import.meta.env.VITE_API_PORT
	? Number(import.meta.env.VITE_API_PORT)
	: API_PORT;

export const API_BASE_URL = `http://localhost:${port}`;
export const WS_BASE_URL = `ws://localhost:${port}`;
