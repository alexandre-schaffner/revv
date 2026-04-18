import { c as createServerRpc, e as enqueue, g as getCommand, a as getLog, b as getPending, d as approve, f as deny } from "./command-log-BBd2Zv4Y.js";
import { c as createServerFn } from "../server.js";
import "node:child_process";
import "node:async_hooks";
import "node:stream";
import "react";
import "@tanstack/react-router";
import "react/jsx-runtime";
import "@tanstack/react-router/ssr/server";
const enqueueCommand_createServerFn_handler = createServerRpc({
  id: "c1baaa23f5ac30b706e5a8a2e00ca80abcd7882a06a9855abd7c53818e63e41d",
  name: "enqueueCommand",
  filename: "src/lib/commands.ts"
}, (opts) => enqueueCommand.__executeServer(opts));
const enqueueCommand = createServerFn({
  method: "POST"
}).inputValidator((input) => input).handler(enqueueCommand_createServerFn_handler, async ({
  data
}) => {
  return enqueue(data.block, data.cmd, data.args ?? [], data.cwd);
});
const getCommandById_createServerFn_handler = createServerRpc({
  id: "1f0995f68a80beb9a31792fdda94f20fc08cd6ced8dec3ebdfab4956d190e427",
  name: "getCommandById",
  filename: "src/lib/commands.ts"
}, (opts) => getCommandById.__executeServer(opts));
const getCommandById = createServerFn({
  method: "GET"
}).inputValidator((input) => input).handler(getCommandById_createServerFn_handler, async ({
  data
}) => {
  return getCommand(data.id);
});
const getCommandLog_createServerFn_handler = createServerRpc({
  id: "37fc7ba39a98604c44c3062c570eaeb7ec32d2b5723607a171981a1e635a711c",
  name: "getCommandLog",
  filename: "src/lib/commands.ts"
}, (opts) => getCommandLog.__executeServer(opts));
const getCommandLog = createServerFn({
  method: "GET"
}).inputValidator((input) => input).handler(getCommandLog_createServerFn_handler, async ({
  data
}) => {
  return getLog(data.block);
});
const getPendingCommands_createServerFn_handler = createServerRpc({
  id: "23f0c1fbc962bda55ab6ae06dda93074f3ff0b9f7d04f0358145ebb7d70636e8",
  name: "getPendingCommands",
  filename: "src/lib/commands.ts"
}, (opts) => getPendingCommands.__executeServer(opts));
const getPendingCommands = createServerFn({
  method: "GET"
}).inputValidator((input) => input).handler(getPendingCommands_createServerFn_handler, async ({
  data
}) => {
  return getPending(data.block);
});
const approveCommand_createServerFn_handler = createServerRpc({
  id: "474f73c8949fd4b5a6752e322fc74be2c4aea69ad32abe8086af9a74296c9a03",
  name: "approveCommand",
  filename: "src/lib/commands.ts"
}, (opts) => approveCommand.__executeServer(opts));
const approveCommand = createServerFn({
  method: "POST"
}).inputValidator((input) => input).handler(approveCommand_createServerFn_handler, async ({
  data
}) => {
  return approve(data.id);
});
const denyCommand_createServerFn_handler = createServerRpc({
  id: "8eb2a73f852d906826ef6b1cd48eae720f61c025e187aa8c8f641104e5488c54",
  name: "denyCommand",
  filename: "src/lib/commands.ts"
}, (opts) => denyCommand.__executeServer(opts));
const denyCommand = createServerFn({
  method: "POST"
}).inputValidator((input) => input).handler(denyCommand_createServerFn_handler, async ({
  data
}) => {
  return deny(data.id);
});
export {
  approveCommand_createServerFn_handler,
  denyCommand_createServerFn_handler,
  enqueueCommand_createServerFn_handler,
  getCommandById_createServerFn_handler,
  getCommandLog_createServerFn_handler,
  getPendingCommands_createServerFn_handler
};
