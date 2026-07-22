import { API_PORT, DEV_API_PORT } from "@revv/shared";

const WEB_DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"] as const;
const API_CHANNEL_ORIGINS = [
  `http://localhost:${API_PORT}`,
  `http://localhost:${DEV_API_PORT}`,
] as const;
const TAURI_ORIGINS = [
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
] as const;

export const AUTH_TRUSTED_ORIGINS = [
  ...WEB_DEV_ORIGINS,
  ...API_CHANNEL_ORIGINS,
  ...TAURI_ORIGINS,
] as const;

export const CORS_ORIGINS = [
  ...WEB_DEV_ORIGINS,
  "http://[::1]:5173",
  ...API_CHANNEL_ORIGINS,
  ...TAURI_ORIGINS,
] as const;
