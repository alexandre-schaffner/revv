import { BrowserWindow } from "electrobun/bun";
import { createElysiaServer } from "./server";

// Start Elysia server
const ELYSIA_PORT = 45678;
const _server = createElysiaServer(ELYSIA_PORT);
console.log(`[Elysia] Server running on http://localhost:${ELYSIA_PORT}`);

const _mainWindow = new BrowserWindow({
  title: "Revv Solid Desktop",
  url: "views://main/index.html",
  frame: {
    width: 1200,
    height: 800,
    x: 200,
    y: 200,
  },
});

console.log("Revv Solid Desktop started!");

export type { ElysiaApp } from "./server";
