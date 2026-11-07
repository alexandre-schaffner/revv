import { API_PORT, DEV_API_PORT, WEB_DEV_PORT } from "@revv/shared";

const WEB_DEV_ORIGINS = [
  `http://localhost:${WEB_DEV_PORT}`,
  `http://127.0.0.1:${WEB_DEV_PORT}`,
  `http://[::1]:${WEB_DEV_PORT}`,
] as const;
const API_CHANNEL_ORIGINS = [
  `http://localhost:${API_PORT}`,
  `http://localhost:${DEV_API_PORT}`,
] as const;
const TAURI_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
] as const;

export const CORS_ORIGINS = [...WEB_DEV_ORIGINS, ...API_CHANNEL_ORIGINS, ...TAURI_ORIGINS] as const;
