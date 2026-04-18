import { c as createServerRpc, e as enqueue } from "./command-log-BBd2Zv4Y.js";
import { c as createServerFn } from "../server.js";
import "node:child_process";
import "node:async_hooks";
import "node:stream";
import "react";
import "@tanstack/react-router";
import "react/jsx-runtime";
import "@tanstack/react-router/ssr/server";
const BLOCK = "files";
const requestLs_createServerFn_handler = createServerRpc({
  id: "72414761d666b5dd6ca5c883d88652a9db0f4191a99660ba1b8249e2d06904ce",
  name: "requestLs",
  filename: "src/blocks/files/commands.ts"
}, (opts) => requestLs.__executeServer(opts));
const requestLs = createServerFn({
  method: "POST"
}).handler(requestLs_createServerFn_handler, async () => {
  return enqueue(BLOCK, "ls", ["-la"]);
});
export {
  requestLs_createServerFn_handler
};
