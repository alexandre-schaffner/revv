import {
  buildPullRequestDeepLink,
  parsePullRequestDeepLink,
} from "../packages/shared/src/pr-deep-link";

function assertContract(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`PR deep-link contract failed: ${message}`);
}

const locator = {
  githubHost: "github.com",
  repositoryFullName: "owner/repository",
  number: 123,
};
const built = buildPullRequestDeepLink(locator);
assertContract(
  built === "revv://pr?host=github.com&repo=owner%2Frepository&number=123",
  `unexpected canonical URL: ${built}`,
);
assertContract(
  JSON.stringify(parsePullRequestDeepLink(built)) === JSON.stringify(locator),
  "round trip",
);

const desktopConfig = await Bun.file("apps/desktop/tauri.conf.json").json();
const schemes = desktopConfig?.plugins?.["deep-link"]?.desktop?.schemes;
assertContract(Array.isArray(schemes) && schemes.includes("revv"), "desktop scheme registration");

const desktopManifest = await Bun.file("apps/desktop/Cargo.toml").text();
assertContract(
  /tauri-plugin-single-instance\s*=\s*\{[^}]*features\s*=\s*\[[^\]]*"deep-link"/.test(
    desktopManifest,
  ),
  "single-instance deep-link forwarding",
);

const webPackage = await Bun.file("apps/web/package.json").json();
assertContract(
  typeof webPackage?.dependencies?.["@tauri-apps/plugin-deep-link"] === "string",
  "frontend deep-link binding dependency",
);

const layout = await Bun.file("apps/web/src/routes/+layout.svelte").text();
assertContract(layout.includes("onOpenUrl") && layout.includes("getCurrent"), "root URL listeners");

console.log(`PR deep-link contract OK: ${built}`);
