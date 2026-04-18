import { T as TSS_SERVER_FUNCTION } from "../server.js";
import { execFile } from "node:child_process";
var createServerRpc = (serverFnMeta, splitImportFn) => {
  const url = "/_serverFn/" + serverFnMeta.id;
  return Object.assign(splitImportFn, {
    url,
    serverFnMeta,
    [TSS_SERVER_FUNCTION]: true
  });
};
function exec(cmd, args = [], options) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: options == null ? void 0 : options.cwd,
        timeout: (options == null ? void 0 : options.timeout) ?? 1e4,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        resolve({
          stdout: (stdout == null ? void 0 : stdout.toString()) ?? "",
          stderr: (stderr == null ? void 0 : stderr.toString()) ?? "",
          code: error && "code" in error ? error.code : error ? 1 : 0
        });
      }
    );
  });
}
let counter = 0;
const log = [];
function nextId() {
  return `cmd_${++counter}_${Date.now()}`;
}
function enqueue(block, cmd, args = [], cwd) {
  const entry = {
    id: nextId(),
    block,
    cmd,
    args,
    cwd: cwd ?? process.cwd(),
    status: "pending",
    result: null,
    createdAt: Date.now(),
    finishedAt: null
  };
  log.push(entry);
  return entry;
}
async function approve(id) {
  const entry = log.find((e) => e.id === id);
  if (!entry) throw new Error(`Command ${id} not found`);
  if (entry.status !== "pending") throw new Error(`Command ${id} is ${entry.status}, not pending`);
  entry.status = "running";
  const result = await exec(entry.cmd, entry.args, { cwd: entry.cwd });
  entry.result = result;
  entry.status = result.code === 0 ? "done" : "error";
  entry.finishedAt = Date.now();
  return entry;
}
function deny(id) {
  const entry = log.find((e) => e.id === id);
  if (!entry) throw new Error(`Command ${id} not found`);
  if (entry.status !== "pending") throw new Error(`Command ${id} is ${entry.status}, not pending`);
  entry.status = "denied";
  entry.finishedAt = Date.now();
  return entry;
}
async function run(block, cmd, args = [], cwd) {
  const entry = enqueue(block, cmd, args, cwd);
  return approve(entry.id);
}
function getLog(block) {
  if (block) return log.filter((e) => e.block === block);
  return [...log];
}
function getCommand(id) {
  return log.find((e) => e.id === id) ?? null;
}
function getPending(block) {
  return getLog(block).filter((e) => e.status === "pending");
}
export {
  getLog as a,
  getPending as b,
  createServerRpc as c,
  approve as d,
  enqueue as e,
  deny as f,
  getCommand as g,
  run as r
};
