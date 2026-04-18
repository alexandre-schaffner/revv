import { c as createServerRpc, r as run } from "./command-log-BBd2Zv4Y.js";
import { c as createServerFn } from "../server.js";
import "node:child_process";
import "node:async_hooks";
import "node:stream";
import "react";
import "@tanstack/react-router";
import "react/jsx-runtime";
import "@tanstack/react-router/ssr/server";
const BLOCK = "cwd";
const getCwd_createServerFn_handler = createServerRpc({
  id: "d03c71cd5c510dab790b98186c51b21bcf1b7c4e858da08e9fce913bff246aad",
  name: "getCwd",
  filename: "src/blocks/cwd/commands.ts"
}, (opts) => getCwd.__executeServer(opts));
const getCwd = createServerFn({
  method: "GET"
}).handler(getCwd_createServerFn_handler, async () => {
  const entry = await run(BLOCK, "pwd");
  return entry.result.stdout.trim();
});
const setCwd_createServerFn_handler = createServerRpc({
  id: "3a2cd06103932f9fa5c6f559d7a09da6b4e90f0be36d556f82fc6f6ef6e9b881",
  name: "setCwd",
  filename: "src/blocks/cwd/commands.ts"
}, (opts) => setCwd.__executeServer(opts));
const setCwd = createServerFn({
  method: "POST"
}).inputValidator((input) => input).handler(setCwd_createServerFn_handler, async ({
  data
}) => {
  await run(BLOCK, "cd", [data.path]);
  process.chdir(data.path);
  const entry = await run(BLOCK, "pwd");
  return entry.result.stdout.trim();
});
const getGitRepos_createServerFn_handler = createServerRpc({
  id: "ccc49305a43e8379867a893b15f40f019d2f0b42188f65a6dd20619403b94ff0",
  name: "getGitRepos",
  filename: "src/blocks/cwd/commands.ts"
}, (opts) => getGitRepos.__executeServer(opts));
const getGitRepos = createServerFn({
  method: "GET"
}).handler(getGitRepos_createServerFn_handler, async () => {
  var _a;
  const home = (await run(BLOCK, "sh", ["-c", "echo $HOME"])).result.stdout.trim();
  const searchDirs = ["dev", "Developer", "projects", "src", "code", "repos", "workspace"].map((d) => `${home}/${d}`);
  const results = await Promise.all(searchDirs.map((dir) => run(BLOCK, "find", [dir, "-maxdepth", "2", "-name", ".git", "-type", "d"])));
  const repos = results.flatMap((entry) => {
    var _a2;
    return (((_a2 = entry.result) == null ? void 0 : _a2.stdout) ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  }).map((gitDir) => gitDir.replace(/\/\.git$/, "")).filter(Boolean);
  const cwd = (await run(BLOCK, "pwd")).result.stdout.trim();
  const cwdCheck = await run(BLOCK, "git", ["revv-parse", "--git-dir"]);
  if (((_a = cwdCheck.result) == null ? void 0 : _a.code) === 0 && !repos.includes(cwd)) {
    repos.unshift(cwd);
  }
  return [...new Set(repos)].sort();
});
export {
  getCwd_createServerFn_handler,
  getGitRepos_createServerFn_handler,
  setCwd_createServerFn_handler
};
