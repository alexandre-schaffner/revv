import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type JsonObject = { [key: string]: JsonValue };

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: JsonValue;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: JsonValue;
  error?: {
    code: number;
    message: string;
    data?: JsonValue;
  };
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: JsonValue;
};

type Candidate = {
  id: string;
  label: string;
  command: string;
  args: string[];
  notes: string[];
  envKeys: string[];
};

type RequestRecord = {
  method: string;
  params: JsonValue | undefined;
};

type UpdateRecord = {
  sessionUpdate: string;
  summary: JsonObject;
};

type AgentResult = {
  id: string;
  label: string;
  command: string;
  args: string[];
  notes: string[];
  envPresence: Record<string, boolean>;
  status: "passed" | "partial" | "failed" | "skipped";
  error?: string;
  initialize?: JsonValue;
  authMethods: JsonValue[];
  authenticated: boolean | "not-required" | "failed";
  session?: JsonValue;
  sessionWithHttpMcp: "passed" | "failed" | "not-advertised" | "not-run";
  loadSession: boolean;
  mcpHttp: boolean;
  promptCapabilities?: JsonValue;
  sessionCapabilities?: JsonValue;
  modes?: JsonValue;
  planMode?: {
    candidateModeId?: string;
    setMode: "passed" | "failed" | "not-found" | "not-run";
    refusedEdit?: boolean;
    error?: string;
  };
  nativeFsShell?: {
    promptRun: "passed" | "failed" | "not-run";
    fileEdited: boolean;
    commitCreated: boolean;
    clientFsCalls: number;
    clientTerminalCalls: number;
    stopReason?: JsonValue;
    error?: string;
  };
  cancellation?: {
    run: "passed" | "failed" | "not-run";
    stopReason?: JsonValue;
    error?: string;
  };
  closeSession?: "passed" | "failed" | "not-advertised" | "not-run";
  observedClientRequests: RequestRecord[];
  observedUpdates: UpdateRecord[];
  stderrTail: string[];
  repoPath?: string;
  logPath?: string;
};

const candidates: Candidate[] = [
  {
    id: "claude-agent-acp",
    label: "Claude Agent ACP",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    notes: ["Primary gate for the ACP unification effort."],
    envKeys: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
  },
  {
    id: "opencode-acp",
    label: "opencode acp",
    command: "opencode",
    args: ["acp"],
    notes: ["Uses the locally installed opencode CLI."],
    envKeys: ["OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"],
  },
  {
    id: "gemini-experimental-acp",
    label: "Gemini experimental ACP",
    command: "npx",
    args: ["-y", "@google/gemini-cli", "--experimental-acp"],
    notes: ["Uses the current npm Gemini CLI package because gemini is not always installed."],
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
  },
  {
    id: "codex-acp-subcommand",
    label: "Codex CLI ACP subcommand",
    command: "codex",
    args: ["acp"],
    notes: ["Confirms whether the installed Codex CLI has the planned `codex acp` subcommand."],
    envKeys: ["OPENAI_API_KEY"],
  },
  {
    id: "zed-codex-acp",
    label: "Zed Codex ACP adapter",
    command: "npx",
    args: ["-y", "@zed-industries/codex-acp"],
    notes: ["Fallback factual check: current public Codex ACP adapter package."],
    envKeys: ["OPENAI_API_KEY"],
  },
];

const args = new Set(Bun.argv.slice(2));
const selectedAgent = valueAfter("--agent");
const skipPrompt = args.has("--skip-prompt");
const skipMode = args.has("--skip-mode");
const skipCancel = args.has("--skip-cancel");
const timeoutMs = Number(valueAfter("--timeout-ms") ?? "180000");
const runStamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const runRoot = resolve(".context", "acp-capability-spike", runStamp);

function valueAfter(name: string): string | undefined {
  const prefix = `${name}=`;
  const item = Bun.argv.slice(2).find((argument) => argument.startsWith(prefix));
  return item?.slice(prefix.length);
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getObject(value: JsonValue | undefined, key: string): JsonObject | undefined {
  if (!isObject(value)) return undefined;
  const child = value[key];
  return isObject(child) ? child : undefined;
}

function getArray(value: JsonValue | undefined, key: string): JsonValue[] {
  if (!isObject(value)) return [];
  const child = value[key];
  return Array.isArray(child) ? child : [];
}

function getString(value: JsonValue | undefined, key: string): string | undefined {
  if (!isObject(value)) return undefined;
  const child = value[key];
  return typeof child === "string" ? child : undefined;
}

function getBoolean(value: JsonValue | undefined, key: string): boolean {
  if (!isObject(value)) return false;
  return value[key] === true;
}

function summarizeJson(value: JsonValue): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized.length < 700) return value;
  return `${serialized.slice(0, 700)}...`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  const process = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `${command} ${args.map(shellQuote).join(" ")} failed (${exitCode}): ${stderr || stdout}`,
    );
  }
  return stdout.trim();
}

async function npmPackageVersion(packageName: string): Promise<string> {
  const process = Bun.spawn(["npm", "view", packageName, "version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  if (exitCode !== 0) return "unknown";
  return stdout.trim() || "unknown";
}

async function createGitRepo(agentId: string): Promise<string> {
  const repoPath = join(runRoot, "repos", agentId);
  await mkdir(repoPath, { recursive: true });
  await writeFile(join(repoPath, "README.md"), `# ACP spike ${agentId}\n`);
  await runCommand("git", ["init"], repoPath);
  await runCommand("git", ["config", "user.email", "acp-spike@example.invalid"], repoPath);
  await runCommand("git", ["config", "user.name", "ACP Spike"], repoPath);
  await runCommand("git", ["add", "README.md"], repoPath);
  await runCommand("git", ["commit", "-m", "initial"], repoPath);
  return repoPath;
}

function startMcpEchoServer(logs: string[]): { url: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const url = new URL(request.url);
      logs.push(`${request.method} ${url.pathname}`);
      if (request.method === "GET") {
        return new Response("event: endpoint\ndata: /mcp\n\n", {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      let body: JsonValue;
      try {
        body = await request.json();
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
      const response = Array.isArray(body)
        ? body.map(handleMcpMessage).filter(Boolean)
        : handleMcpMessage(body);
      if (!response || (Array.isArray(response) && response.length === 0)) {
        return new Response(null, { status: 202 });
      }
      return Response.json(response, {
        headers: {
          "mcp-session-id": "revv-acp-spike",
        },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    stop: () => server.stop(true),
  };
}

function handleMcpMessage(message: JsonValue): JsonRpcResponse | undefined {
  if (!isObject(message)) return undefined;
  const id = message.id;
  const method = getString(message, "method");
  if (typeof id !== "number" && typeof id !== "string") return undefined;
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "revv-acp-spike-echo", version: "0.0.0" },
      },
    };
  }
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "echo",
            description: "Echoes text for the Revv ACP capability spike.",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
        ],
      },
    };
  }
  if (method === "tools/call") {
    const params = getObject(message.params, "arguments");
    const text = typeof params?.text === "string" ? params.text : JSON.stringify(message.params);
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: `echo: ${text}` }] },
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    result: {},
  };
}

class AcpProbeConnection {
  private nextId = 1;
  private buffer = "";
  private pending = new Map<
    number | string,
    {
      resolve: (value: JsonValue) => void;
      reject: (error: Error) => void;
      timer: Timer;
    }
  >();

  readonly stderr: string[] = [];
  readonly updates: UpdateRecord[] = [];
  readonly clientRequests: RequestRecord[] = [];
  readonly rawMessages: JsonValue[] = [];
  private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;

  constructor(
    candidate: Candidate,
    private readonly log: (line: string) => void,
  ) {
    this.process = Bun.spawn([candidate.command, ...candidate.args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
  }

  start(): void {
    void this.readStdout();
    void this.readStderr();
  }

  async request(
    method: string,
    params: JsonValue,
    requestTimeoutMs = timeoutMs,
  ): Promise<JsonValue> {
    const id = this.nextId;
    this.nextId += 1;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    this.write(request);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${requestTimeoutMs}ms`));
      }, requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params: JsonValue): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  async stop(): Promise<void> {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`agent stopped before response ${String(id)}`));
    }
    this.pending.clear();
    await killDescendants(this.process.pid, "SIGTERM");
    this.process.kill();
    const exited = await Promise.race([
      this.process.exited.then(() => true).catch(() => true),
      Bun.sleep(3000).then(() => false),
    ]);
    if (!exited) {
      await killDescendants(this.process.pid, "SIGKILL");
      this.process.kill("SIGKILL");
      await Promise.race([this.process.exited.catch(() => 1), Bun.sleep(1000)]);
    }
  }

  private write(message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification): void {
    this.log(`--> ${JSON.stringify(message)}`);
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async readStdout(): Promise<void> {
    const reader = this.process.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      this.buffer += decoder.decode(chunk.value, { stream: true });
      this.drainBuffer();
    }
  }

  private async readStderr(): Promise<void> {
    const reader = this.process.stderr.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const text = decoder.decode(chunk.value, { stream: true });
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        this.stderr.push(line);
        this.log(`[stderr] ${line}`);
      }
    }
  }

  private drainBuffer(): void {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    this.log(`<-- ${line}`);
    let message: JsonValue;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.stderr.push(`non-json stdout: ${line}; ${String(error)}`);
      return;
    }
    this.rawMessages.push(message);
    if (!isObject(message)) return;

    const id = message.id;
    if ((typeof id === "number" || typeof id === "string") && !message.method) {
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      const error = getObject(message, "error");
      if (error) {
        pending.reject(new Error(JSON.stringify(error)));
        return;
      }
      pending.resolve(message.result ?? null);
      return;
    }

    const method = getString(message, "method");
    if (!method) return;
    if (typeof id === "number" || typeof id === "string") {
      void this.handleAgentRequest(id, method, message.params);
      return;
    }
    this.handleAgentNotification(method, message.params);
  }

  private async handleAgentRequest(
    id: number | string,
    method: string,
    params: JsonValue | undefined,
  ): Promise<void> {
    this.clientRequests.push({ method, params });
    if (method === "session/request_permission") {
      const options = getArray(params, "options");
      const selected = options.find((option) => getString(option, "kind")?.startsWith("allow"));
      const optionId = getString(selected, "optionId") ?? getString(options[0], "optionId");
      if (optionId) {
        this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "selected", optionId } } });
        return;
      }
      this.write({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
      return;
    }
    if (method === "fs/read_text_file") {
      this.write({ jsonrpc: "2.0", id, result: { content: "" } });
      return;
    }
    if (method === "fs/write_text_file") {
      this.write({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Client method not implemented by spike: ${method}` },
    });
  }

  private handleAgentNotification(method: string, params: JsonValue | undefined): void {
    if (method !== "session/update") return;
    const update = getObject(params, "update");
    const sessionUpdate = getString(update, "sessionUpdate") ?? "unknown";
    this.updates.push({
      sessionUpdate,
      summary: isObject(update) ? update : {},
    });
  }
}

async function killDescendants(rootPid: number, signal: NodeJS.Signals): Promise<void> {
  const processList = Bun.spawn(["ps", "-axo", "pid,ppid"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(processList.stdout).text();
  await processList.exited.catch(() => 1);
  const children = new Map<number, number[]>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const existing = children.get(ppid) ?? [];
    existing.push(pid);
    children.set(ppid, existing);
  }
  const stack = [...(children.get(rootPid) ?? [])];
  const descendants: number[] = [];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (pid === undefined) continue;
    descendants.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  for (const pid of descendants.reverse()) {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may already have exited between ps and kill.
    }
  }
}

async function probeCandidate(candidate: Candidate, mcpUrl: string): Promise<AgentResult> {
  const logLines: string[] = [];
  const log = (line: string) => logLines.push(`${new Date().toISOString()} ${line}`);
  const envPresence = Object.fromEntries(
    candidate.envKeys.map((key) => [key, Boolean(process.env[key])]),
  );
  const result: AgentResult = {
    id: candidate.id,
    label: candidate.label,
    command: candidate.command,
    args: candidate.args,
    notes: candidate.notes,
    envPresence,
    status: "partial",
    authMethods: [],
    authenticated: "not-required",
    sessionWithHttpMcp: "not-run",
    loadSession: false,
    mcpHttp: false,
    observedClientRequests: [],
    observedUpdates: [],
    stderrTail: [],
  };
  const logPath = join(runRoot, "logs", `${candidate.id}.jsonl`);
  const repoPath = await createGitRepo(candidate.id);
  result.repoPath = repoPath;
  result.logPath = logPath;

  const connection = new AcpProbeConnection(candidate, log);
  connection.start();
  try {
    const initialize = await connection.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "revv-acp-capability-spike", version: "0.0.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    });
    result.initialize = summarizeJson(initialize);
    const capabilities = getObject(initialize, "agentCapabilities");
    result.authMethods = getArray(initialize, "authMethods");
    result.loadSession = getBoolean(capabilities, "loadSession");
    result.mcpHttp = getBoolean(getObject(capabilities, "mcpCapabilities"), "http");
    result.promptCapabilities = getObject(capabilities, "promptCapabilities");
    result.sessionCapabilities = getObject(capabilities, "sessionCapabilities");

    if (result.authMethods.length > 0) {
      const firstMethodId = getString(result.authMethods[0], "id");
      if (firstMethodId) {
        try {
          await connection.request("authenticate", { methodId: firstMethodId }, 120000);
          result.authenticated = true;
        } catch (error) {
          result.authenticated = "failed";
          throw new Error(`authenticate failed for ${firstMethodId}: ${String(error)}`);
        }
      }
    }

    if (!result.mcpHttp) {
      result.sessionWithHttpMcp = "not-advertised";
    }

    const session = await connection.request("session/new", {
      cwd: repoPath,
      mcpServers: [
        {
          type: "http",
          name: "revv-acp-spike-echo",
          url: mcpUrl,
          headers: [{ name: "Authorization", value: "Bearer revv-acp-spike" }],
        },
      ],
    });
    result.session = summarizeJson(session);
    result.sessionWithHttpMcp = "passed";
    result.modes = getObject(session, "modes");
    const sessionId = getString(session, "sessionId");
    if (!sessionId) throw new Error("session/new did not return sessionId");

    if (!skipPrompt) {
      result.nativeFsShell = await probeNativeFsShell(connection, repoPath, sessionId);
    } else {
      result.nativeFsShell = {
        promptRun: "not-run",
        fileEdited: false,
        commitCreated: false,
        clientFsCalls: countClientCalls(connection.clientRequests, "fs/"),
        clientTerminalCalls: countClientCalls(connection.clientRequests, "terminal/"),
      };
    }

    if (!skipMode) {
      result.planMode = await probePlanMode(connection, repoPath, sessionId, result.modes);
    } else {
      result.planMode = { setMode: "not-run" };
    }

    if (!skipCancel) {
      result.cancellation = await probeCancellation(connection, sessionId);
    } else {
      result.cancellation = { run: "not-run" };
    }

    if (hasSessionClose(result.sessionCapabilities)) {
      try {
        await connection.request("session/close", { sessionId }, 30000);
        result.closeSession = "passed";
      } catch {
        result.closeSession = "failed";
      }
    } else {
      result.closeSession = "not-advertised";
    }

    const nativePassed =
      result.nativeFsShell?.promptRun !== "passed" ||
      (result.nativeFsShell.fileEdited && result.nativeFsShell.commitCreated);
    const planPassed =
      result.planMode?.setMode === "not-run" ||
      result.planMode?.setMode === "passed" ||
      result.planMode?.setMode === "not-found";
    result.status =
      result.sessionWithHttpMcp === "passed" && nativePassed && planPassed ? "passed" : "partial";
  } catch (error) {
    result.status = result.initialize ? "partial" : "failed";
    result.error = String(error);
    if (result.sessionWithHttpMcp === "not-run" && result.mcpHttp) {
      result.sessionWithHttpMcp = "failed";
    }
  } finally {
    result.observedClientRequests = connection.clientRequests;
    result.observedUpdates = connection.updates.map((update) => ({
      sessionUpdate: update.sessionUpdate,
      summary: summarizeUpdate(update.summary),
    }));
    result.stderrTail = connection.stderr.slice(-20);
    await connection.stop();
    await mkdir(join(runRoot, "logs"), { recursive: true });
    await writeFile(logPath, `${logLines.join("\n")}\n`);
  }
  return result;
}

function summarizeUpdate(update: JsonObject): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(update)) {
    if (key === "content" || key === "rawInput" || key === "rawOutput") {
      output[key] = summarizeJson(value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function hasSessionClose(sessionCapabilities: JsonValue | undefined): boolean {
  return Boolean(getObject(sessionCapabilities, "close"));
}

function countClientCalls(records: RequestRecord[], prefix: string): number {
  return records.filter((record) => record.method.startsWith(prefix)).length;
}

async function probeNativeFsShell(
  connection: AcpProbeConnection,
  repoPath: string,
  sessionId: string,
): Promise<NonNullable<AgentResult["nativeFsShell"]>> {
  try {
    const response = await connection.request(
      "session/prompt",
      {
        sessionId,
        prompt: [
          {
            type: "text",
            text: "In this throwaway git repository, create a file named acp-spike.txt containing exactly `agent-owned edit confirmed`, then run `git add acp-spike.txt && git commit -m acp-spike-edit`. Do not modify any other files.",
          },
        ],
      },
      timeoutMs,
    );
    const fileStatus = await Bun.file(join(repoPath, "acp-spike.txt")).exists();
    const log = await runCommand("git", ["log", "--oneline", "--max-count=5"], repoPath);
    return {
      promptRun: "passed",
      fileEdited: fileStatus,
      commitCreated: log.includes("acp-spike-edit"),
      clientFsCalls: countClientCalls(connection.clientRequests, "fs/"),
      clientTerminalCalls: countClientCalls(connection.clientRequests, "terminal/"),
      stopReason: getObject(response, "stopReason") ?? response,
    };
  } catch (error) {
    return {
      promptRun: "failed",
      fileEdited: await Bun.file(join(repoPath, "acp-spike.txt")).exists(),
      commitCreated: false,
      clientFsCalls: countClientCalls(connection.clientRequests, "fs/"),
      clientTerminalCalls: countClientCalls(connection.clientRequests, "terminal/"),
      error: String(error),
    };
  }
}

async function probePlanMode(
  connection: AcpProbeConnection,
  repoPath: string,
  sessionId: string,
  modes: JsonValue | undefined,
): Promise<NonNullable<AgentResult["planMode"]>> {
  const modeId = findReadOnlyModeId(modes);
  if (!modeId) return { setMode: "not-found" };
  try {
    await connection.request("session/set_mode", { sessionId, modeId }, 30000);
  } catch (error) {
    return { candidateModeId: modeId, setMode: "failed", error: String(error) };
  }
  if (skipPrompt) {
    return { candidateModeId: modeId, setMode: "passed" };
  }
  const planModeFile = join(repoPath, "plan-mode-should-not-exist.txt");
  try {
    await connection.request(
      "session/prompt",
      {
        sessionId,
        prompt: [
          {
            type: "text",
            text: "You are in read-only planning mode. Try to create plan-mode-should-not-exist.txt and commit it. If the mode is read-only, refuse and explain briefly.",
          },
        ],
      },
      timeoutMs,
    );
    return {
      candidateModeId: modeId,
      setMode: "passed",
      refusedEdit: !(await Bun.file(planModeFile).exists()),
    };
  } catch (error) {
    return {
      candidateModeId: modeId,
      setMode: "passed",
      refusedEdit: !(await Bun.file(planModeFile).exists()),
      error: String(error),
    };
  }
}

function findReadOnlyModeId(modes: JsonValue | undefined): string | undefined {
  const availableModes = getArray(modes, "availableModes");
  for (const mode of availableModes) {
    const id = getString(mode, "id");
    const name = getString(mode, "name") ?? "";
    const description = getString(mode, "description") ?? "";
    const haystack = `${id ?? ""} ${name} ${description}`.toLowerCase();
    if (id && /(plan|ask|architect|read.?only|readonly)/.test(haystack)) return id;
  }
  return undefined;
}

async function probeCancellation(
  connection: AcpProbeConnection,
  sessionId: string,
): Promise<NonNullable<AgentResult["cancellation"]>> {
  try {
    const promptPromise = connection.request(
      "session/prompt",
      {
        sessionId,
        prompt: [
          {
            type: "text",
            text: "Start a long-running task, wait at least 30 seconds, and then answer with `done`.",
          },
        ],
      },
      timeoutMs,
    );
    await Bun.sleep(1500);
    connection.notify("session/cancel", { sessionId });
    const response = await promptPromise;
    return {
      run: getString(response, "stopReason") === "cancelled" ? "passed" : "failed",
      stopReason: getString(response, "stopReason") ?? response,
    };
  } catch (error) {
    return { run: "failed", error: String(error) };
  }
}

function matrix(results: AgentResult[]): string {
  const headers = [
    "Agent",
    "HTTP MCP",
    "loadSession",
    "native fs+shell",
    "auth",
    "plan mode",
    "cancel",
    "GO?",
  ];
  const rows = results.map((result) => [
    result.id,
    result.sessionWithHttpMcp,
    result.loadSession ? "yes" : "no",
    nativeSummary(result),
    String(result.authenticated),
    planSummary(result),
    result.cancellation?.run ?? "not-run",
    goNoGo(result),
  ]);
  const allRows = [headers, ...rows];
  const widths = headers.map((_, index) =>
    Math.max(...allRows.map((row) => row[index]?.length ?? 0)),
  );
  return allRows
    .map((row, rowIndex) => {
      const line = `| ${row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join(" | ")} |`;
      if (rowIndex === 0) {
        return `${line}\n| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`;
      }
      return line;
    })
    .join("\n");
}

function nativeSummary(result: AgentResult): string {
  if (!result.nativeFsShell) return "not-run";
  if (result.nativeFsShell.promptRun === "not-run") return "not-run";
  if (result.nativeFsShell.promptRun !== "passed") return "failed";
  const clientMediation =
    result.nativeFsShell.clientFsCalls > 0 || result.nativeFsShell.clientTerminalCalls > 0;
  if (result.nativeFsShell.fileEdited && result.nativeFsShell.commitCreated && !clientMediation) {
    return "native";
  }
  if (clientMediation) return "client-mediated";
  return "no-commit";
}

function planSummary(result: AgentResult): string {
  if (!result.planMode) return "not-run";
  if (result.planMode.setMode !== "passed") return result.planMode.setMode;
  if (result.planMode.refusedEdit === undefined) return `mode:${result.planMode.candidateModeId}`;
  return result.planMode.refusedEdit
    ? `refused:${result.planMode.candidateModeId}`
    : `allowed-edit:${result.planMode.candidateModeId}`;
}

function goNoGo(result: AgentResult): string {
  if (result.id !== "claude-agent-acp") return result.status;
  const native = nativeSummary(result) === "native" || skipPrompt;
  const plan = result.planMode?.setMode === "passed" || skipMode;
  const auth = result.authenticated === true || result.authenticated === "not-required";
  return result.sessionWithHttpMcp === "passed" && native && plan && auth ? "GO" : "NO-GO";
}

async function writeReport(results: AgentResult[], mcpLogs: string[]): Promise<string> {
  const reportPath = join(runRoot, "capability-matrix.md");
  const sdkVersion = await npmPackageVersion("@agentclientprotocol/sdk");
  const body = `# ACP Capability Spike

Run: ${new Date().toISOString()}

Command: \`${Bun.argv.map(shellQuote).join(" ")}\`

## Matrix

${matrix(results)}

## SDK / Spec Facts

- ACP TypeScript SDK package: \`@agentclientprotocol/sdk\`; npm latest resolved during this run as ${sdkVersion}.
- SDK wiring pattern: spawn agent subprocess, convert stdio to web streams, pass through \`ndJsonStream\`, then create \`ClientSideConnection\`.
- Wire fallback proven by this script: newline-delimited JSON-RPC over stdio.
- Client capabilities used for the Revv target shape: \`fs.readTextFile=false\`, \`fs.writeTextFile=false\`, \`terminal=false\`.
- HTTP MCP server shape passed to \`session/new.mcpServers\`: \`{ type: "http", name, url, headers: [{ name, value }] }\`.
- \`session/set_mode\` is a post-\`session/new\` method; this spike derives the read-only candidate from \`modes.availableModes\`.

## Per-Agent Details

${results.map(agentReport).join("\n\n")}

## MCP Echo Server Observations

\`\`\`text
${mcpLogs.join("\n") || "No HTTP MCP requests observed."}
\`\`\`
`;
  await writeFile(reportPath, body);
  await writeFile(join(runRoot, "results.json"), JSON.stringify(results, null, 2));
  return reportPath;
}

function agentReport(result: AgentResult): string {
  return `### ${result.label} (\`${result.id}\`)

- Launch: \`${[result.command, ...result.args].map(shellQuote).join(" ")}\`
- Status: ${result.status}
- GO/NO-GO: ${goNoGo(result)}
- Env presence: ${Object.entries(result.envPresence)
    .map(([key, present]) => `${key}=${present ? "present" : "missing"}`)
    .join(", ")}
- Agent capabilities: loadSession=${result.loadSession}, mcp.http=${result.mcpHttp}, prompt=${JSON.stringify(
    result.promptCapabilities ?? null,
  )}, session=${JSON.stringify(result.sessionCapabilities ?? null)}
- Auth methods: ${JSON.stringify(result.authMethods)}
- Session: ${JSON.stringify(result.session ?? null)}
- Modes: ${JSON.stringify(result.modes ?? null)}
- Native fs/shell: ${JSON.stringify(result.nativeFsShell ?? null)}
- Plan mode: ${JSON.stringify(result.planMode ?? null)}
- Cancellation: ${JSON.stringify(result.cancellation ?? null)}
- Close session: ${result.closeSession ?? "not-run"}
- Client requests observed: ${result.observedClientRequests.map((request) => request.method).join(", ") || "none"}
- Session updates observed: ${result.observedUpdates.map((update) => update.sessionUpdate).join(", ") || "none"}
- Error: ${result.error ?? "none"}
- Raw log: ${result.logPath ? result.logPath.replace(`${process.cwd()}/`, "") : "none"}
- Throwaway repo: ${result.repoPath ? result.repoPath.replace(`${process.cwd()}/`, "") : "none"}

${result.stderrTail.length > 0 ? `Stderr tail:\n\n\`\`\`text\n${result.stderrTail.join("\n")}\n\`\`\`` : ""}`;
}

async function main(): Promise<void> {
  await mkdir(runRoot, { recursive: true });
  await mkdir(join(runRoot, "repos"), { recursive: true });
  const mcpLogs: string[] = [];
  const mcpServer = startMcpEchoServer(mcpLogs);
  const agents = selectedAgent
    ? candidates.filter((candidate) => candidate.id === selectedAgent)
    : candidates;
  if (agents.length === 0) {
    throw new Error(
      `Unknown --agent=${selectedAgent}. Known agents: ${candidates
        .map((candidate) => candidate.id)
        .join(", ")}`,
    );
  }
  const results: AgentResult[] = [];
  try {
    for (const candidate of agents) {
      console.log(`Probing ${candidate.id} (${candidate.command} ${candidate.args.join(" ")})`);
      results.push(await probeCandidate(candidate, mcpServer.url));
    }
  } finally {
    mcpServer.stop();
  }
  const reportPath = await writeReport(results, mcpLogs);
  console.log(`\n${matrix(results)}\n`);
  console.log(`Report written to ${reportPath}`);
}

await main();
