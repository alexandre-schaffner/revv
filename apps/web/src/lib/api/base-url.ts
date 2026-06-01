import { API_PORT, type AppChannel, DEFAULT_APP_CHANNEL } from "@revv/shared";

const port = import.meta.env.VITE_API_PORT ? Number(import.meta.env.VITE_API_PORT) : API_PORT;

export const API_BASE_URL = `http://localhost:${port}`;
export const APP_CHANNEL: AppChannel =
  import.meta.env.VITE_REVV_CHANNEL === "dev" ? "dev" : DEFAULT_APP_CHANNEL;
