import { isDeepStrictEqual } from "node:util";
import {
  API_PORT,
  COLLECTOR_PORT,
  DEV_API_PORT,
  WEB_DEV_PORT,
} from "../packages/shared/src/constants";
import {
  APP_DATA_DIR_NAME,
  DESKTOP_PID_ENV,
  REPO_SLUG,
} from "../packages/shared/src/desktop-contract";

// Default WebSocket port of tauri-plugin-mcp-bridge (the dev webview bridge).
const MCP_BRIDGE_PORT = 9223;

const CONSTANTS = "packages/shared/src/constants.ts";
const DESKTOP_CONTRACT = "packages/shared/src/desktop-contract.ts";

interface Value {
  readonly value: string;
  readonly source: string;
}
const apiPort: Value = { value: String(API_PORT), source: `API_PORT in ${CONSTANTS}` };
const devApiPort: Value = { value: String(DEV_API_PORT), source: `DEV_API_PORT in ${CONSTANTS}` };
const collectorPort: Value = {
  value: String(COLLECTOR_PORT),
  source: `COLLECTOR_PORT in ${CONSTANTS}`,
};
const webDevPort: Value = { value: String(WEB_DEV_PORT), source: `WEB_DEV_PORT in ${CONSTANTS}` };
const desktopPidEnv: Value = {
  value: DESKTOP_PID_ENV,
  source: `DESKTOP_PID_ENV in ${DESKTOP_CONTRACT}`,
};
const appDataDir: Value = {
  value: APP_DATA_DIR_NAME,
  source: `APP_DATA_DIR_NAME in ${DESKTOP_CONTRACT}`,
};
const repoSlug: Value = { value: REPO_SLUG, source: `REPO_SLUG in ${DESKTOP_CONTRACT}` };

// `$`-prefixed names are shell variables (e.g. the Tauri identifier's own dir).
const APP_SUPPORT_DIR = /Application Support\/(?!\$)([^/"'}\n]+)/g;

interface Copy {
  readonly file: string;
  readonly what: string;
  /** Global, one capture group: the distinct matches must be exactly the expected values. */
  readonly pattern: RegExp;
  readonly expected: Value | readonly Value[];
}

const copies: readonly Copy[] = [
  {
    file: "apps/desktop/src/server_config.rs",
    what: "default server PORT",
    pattern: /\.unwrap_or\("(\d+)"\)/g,
    expected: apiPort,
  },
  {
    file: "apps/desktop/src/server.rs",
    what: "desktop pid env var",
    pattern: /\.env\("(REVV_[A-Z_]*PID)"/g,
    expected: desktopPidEnv,
  },
  {
    file: "apps/desktop/src/server_tests.rs",
    what: "desktop pid env var",
    pattern: /process\.env\.(REVV_[A-Z_]*PID)/g,
    expected: desktopPidEnv,
  },
  {
    file: "apps/desktop/tauri.conf.json",
    what: "devUrl port",
    pattern: /"devUrl": "http:\/\/localhost:(\d+)"/g,
    expected: webDevPort,
  },
  {
    file: "apps/web/vite.config.ts",
    what: "dev server port",
    pattern: /port: (\d+)/g,
    expected: webDevPort,
  },
  {
    file: "integrations/external-mcp-bridge/revv-mcp.ts",
    // Pinned installs read REVV_API_URL; older copies probe these ports.
    what: "legacy server ports (LEGACY_PORTS)",
    pattern: /(?<=LEGACY_PORTS = \[[^\]]*?)\b(\d{4,5})\b/g,
    expected: [apiPort, devApiPort],
  },
  {
    file: "apps/desktop/src/server_config.rs",
    what: "app data directory",
    pattern: APP_SUPPORT_DIR,
    expected: appDataDir,
  },
  {
    file: "scripts/revv",
    what: "API_URL port",
    pattern: /API_URL="http:\/\/localhost:(\d+)"/g,
    expected: apiPort,
  },
  {
    file: "scripts/revv",
    what: "server_running port probe",
    pattern: /nc -z 127\.0\.0\.1 (\d+)/g,
    expected: apiPort,
  },
  {
    file: "scripts/revv",
    what: "app data directory",
    pattern: APP_SUPPORT_DIR,
    expected: appDataDir,
  },
  {
    file: "scripts/revv",
    what: "REVV_GITHUB_REPO",
    pattern: /REVV_GITHUB_REPO="([^"]+)"/g,
    expected: repoSlug,
  },
  {
    file: "scripts/revv",
    what: "reinstall URL repository",
    pattern: /raw\.githubusercontent\.com\/([^/]+\/[^/]+)\//g,
    expected: repoSlug,
  },
  {
    file: "scripts/lib/common.sh",
    what: "desktop-server.json PORT",
    pattern: /PORT: "(\d+)"/g,
    expected: apiPort,
  },
  {
    file: "scripts/lib/common.sh",
    what: "app data directory",
    pattern: APP_SUPPORT_DIR,
    expected: appDataDir,
  },
  {
    file: "install.sh",
    what: "server URL port",
    pattern: /http:\/\/localhost:(\d+)/g,
    expected: apiPort,
  },
  {
    file: "install.sh",
    what: "dev-server port hint",
    pattern: /\(port (\d+)\)/g,
    expected: devApiPort,
  },
  {
    file: "install.sh",
    what: "app data directory",
    pattern: APP_SUPPORT_DIR,
    expected: appDataDir,
  },
  {
    file: "install.sh",
    what: "REVV_GITHUB_REPO",
    pattern: /REVV_GITHUB_REPO="([^"]+)"/g,
    expected: repoSlug,
  },
  {
    file: "install.sh",
    what: "repository URL",
    pattern: /https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git|\/)/g,
    expected: repoSlug,
  },
  {
    file: "scripts/release/install.sh.tmpl",
    what: "REPO",
    pattern: /^REPO="([^"]+)"/gm,
    expected: repoSlug,
  },
  { file: "nix/update-release.sh", what: "repo", pattern: /^repo="([^"]+)"/gm, expected: repoSlug },
  {
    file: "nix/app.nix",
    what: "homepage repository",
    pattern: /homepage = "https:\/\/github\.com\/([^"]+)"/g,
    expected: repoSlug,
  },
  {
    file: "nix/home-manager.nix",
    what: "app data directory",
    pattern: APP_SUPPORT_DIR,
    expected: appDataDir,
  },
  {
    file: "nix/cli.nix",
    what: "app data directory",
    pattern: APP_SUPPORT_DIR,
    expected: appDataDir,
  },
  {
    file: "scripts/ci/configure-github.py",
    what: "--repo default",
    pattern: /"--repo", default="([^"]+)"/g,
    expected: repoSlug,
  },
  {
    file: "scripts/ci/nix-check.sh",
    what: "app data directory",
    pattern: APP_SUPPORT_DIR,
    expected: appDataDir,
  },
  {
    file: "scripts/performance/install-machine.py",
    what: "app data directory",
    pattern: APP_SUPPORT_DIR,
    expected: appDataDir,
  },
  {
    file: "integrations/claude-code-plugin/.claude-plugin/plugin.json",
    what: "homepage repository",
    pattern: /"homepage": "https:\/\/github\.com\/([^"]+)"/g,
    expected: repoSlug,
  },
  { file: "Makefile", what: "dev PORT", pattern: /\bPORT=(\d+)/g, expected: devApiPort },
  {
    file: "Makefile",
    what: "VITE_API_PORT",
    pattern: /VITE_API_PORT=(\d+)/g,
    expected: devApiPort,
  },
  {
    file: "Makefile",
    what: "dev-server port hint",
    pattern: /\(port (\d+)\)/g,
    expected: devApiPort,
  },
  {
    file: "Makefile",
    what: "OTLP endpoint port",
    pattern: /OTEL_EXPORTER_OTLP_ENDPOINT=http:\/\/localhost:(\d+)/g,
    expected: collectorPort,
  },
  {
    file: "Makefile",
    what: "collector port hint",
    pattern: /OTLP on :(\d+)/g,
    expected: collectorPort,
  },
  {
    file: ".env.example",
    what: "OTLP endpoint port",
    pattern: /OTEL_EXPORTER_OTLP_ENDPOINT=http:\/\/localhost:(\d+)/g,
    expected: collectorPort,
  },
  {
    file: "observability/grafana/provisioning/datasources/revv.yaml",
    what: "collector allowed host port",
    pattern: /host\.docker\.internal:(\d+)/g,
    expected: collectorPort,
  },
  {
    file: CONSTANTS,
    what: "API_PORT as flake.nix parses it",
    pattern: /^export const API_PORT = ([0-9]+);$/gm,
    expected: apiPort,
  },
];

const errors: string[] = [];

for (const { file, what, pattern, expected } of copies) {
  const text = await Bun.file(file).text();
  const found = [...text.matchAll(pattern)].map((match) => match[1]);
  if (found.length === 0) {
    errors.push(
      `${file}: no ${what} matching ${pattern}. If that line was rewritten, update the pattern in scripts/check-desktop-contract.ts.`,
    );
  }
  const expectedValues: readonly Value[] = [expected].flat();
  const wanted = expectedValues.map((e) => e.value).toSorted();
  const values = [...new Set(found)].toSorted();
  if (found.length > 0 && !isDeepStrictEqual(values, wanted)) {
    errors.push(
      `${file}: ${what} is ${values.map((v) => `"${v}"`).join(", ")}, expected ${wanted.map((v) => `"${v}"`).join(", ")} (${expectedValues.map((e) => e.source).join(", ")}).`,
    );
  }
}

const PROD_CONF = "apps/desktop/tauri.conf.json";
const DEV_CONF = "apps/desktop/tauri.dev.conf.json";
const prodConf = await Bun.file(PROD_CONF).json();
const devConf = await Bun.file(DEV_CONF).json();

const endpoints = prodConf?.plugins?.updater?.endpoints;
const expectedEndpoints = [
  `http://localhost:${API_PORT}/api/update-manifest`,
  `https://github.com/${REPO_SLUG}/releases/latest/download/latest.json`,
];
if (!isDeepStrictEqual(endpoints, expectedEndpoints)) {
  errors.push(
    `${PROD_CONF}: plugins.updater.endpoints is ${JSON.stringify(endpoints)}, expected ${JSON.stringify(expectedEndpoints)} (API_PORT in ${CONSTANTS}, REPO_SLUG in ${DESKTOP_CONTRACT}).`,
  );
}

const localConnectOrigins = (csp: unknown): string[] =>
  (typeof csp === "string"
    ? csp
        .split(";")
        .map((directive) => directive.trim().split(/\s+/))
        .find(([name]) => name === "connect-src")
        ?.slice(1)
    : undefined
  )?.filter((source) => source.includes("localhost")) ?? [];

const localOrigins = localConnectOrigins(prodConf?.app?.security?.csp);
const expectedLocalOrigins = [
  `http://localhost:${API_PORT}`,
  `http://localhost:${DEV_API_PORT}`,
  `ws://localhost:${API_PORT}`,
  `ws://localhost:${DEV_API_PORT}`,
  `ws://localhost:${MCP_BRIDGE_PORT}`,
];
if (!isDeepStrictEqual(localOrigins, expectedLocalOrigins)) {
  errors.push(
    `${PROD_CONF}: app.security.csp connect-src localhost origins are ${JSON.stringify(localOrigins)}, expected ${JSON.stringify(expectedLocalOrigins)} (API_PORT / DEV_API_PORT in ${CONSTANTS}).`,
  );
}

// The dev config keeps its own CSP: the dev build also talks to the local
// telemetry collector, which prod doesn't reach. Otherwise it is prod's
// policy, so any CSP change has to land in both files.
const directives = (csp: unknown): Record<string, string[]> =>
  Object.fromEntries(
    (typeof csp === "string" ? csp.split(";") : [])
      .map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name, sources.toSorted()]),
  );
const devCsp: unknown = devConf?.app?.security?.csp;
if (devCsp !== undefined) {
  const prodDirectives = directives(prodConf?.app?.security?.csp);
  const expectedDev = {
    ...prodDirectives,
    "connect-src": [
      ...(prodDirectives["connect-src"] ?? []),
      `http://localhost:${COLLECTOR_PORT}`,
    ].toSorted(),
  };
  if (!isDeepStrictEqual(directives(devCsp), expectedDev)) {
    errors.push(
      `${DEV_CONF}: app.security.csp must be ${PROD_CONF}'s plus http://localhost:${COLLECTOR_PORT} in connect-src (COLLECTOR_PORT in ${CONSTANTS}).`,
    );
  }
}

// Tauri merges the dev config as a JSON Merge Patch, which replaces arrays
// whole: the dev windows array must repeat every prod window field.
const DEV_ONLY_WINDOW_FIELDS = ["title"];
const withoutDevOnlyFields = (windows: unknown) =>
  Array.isArray(windows)
    ? windows.map((window: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(window).filter(([key]) => !DEV_ONLY_WINDOW_FIELDS.includes(key)),
        ),
      )
    : windows;
if (
  !isDeepStrictEqual(
    withoutDevOnlyFields(devConf?.app?.windows),
    withoutDevOnlyFields(prodConf?.app?.windows),
  )
) {
  errors.push(
    `${DEV_CONF}: app.windows differs from ${PROD_CONF} beyond ${DEV_ONLY_WINDOW_FIELDS.join(", ")}. Copy the window change into both files.`,
  );
}

if (errors.length > 0) {
  console.error(`Desktop contract failed:\n${errors.map((error) => `  - ${error}`).join("\n")}`);
  process.exit(1);
}
console.log("Desktop contract OK");
