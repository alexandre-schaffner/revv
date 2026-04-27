import { treaty } from "@elysiajs/eden";

const ELYSIA_URL = "http://localhost:45678";

export const api = treaty(ELYSIA_URL) as any;
