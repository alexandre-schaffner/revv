import { describe, expect, it } from "bun:test";
import { settingsRoutes } from "./settings";

const call = (method: string, path: string) =>
  settingsRoutes.handle(new Request(`http://localhost${path}`, { method }));

describe("settings routes without a session", () => {
  // Process-spawning routes: a body-less POST or a GET is a CORS-simple
  // request, so any web page the user visits could otherwise trigger them.
  it.each([
    ["POST", "/api/settings/cache/adc-login"],
    ["GET", "/api/settings/cache/adc-status"],
    ["GET", "/api/settings/models"],
    ["GET", "/api/settings/cache/status"],
    ["POST", "/api/settings/cache/signing/test"],
    ["PUT", "/api/settings"],
    ["PUT", "/api/settings/jev/api-key"],
    ["POST", "/api/settings/jev/test"],
  ])("%s %s answers 401", async (method, path) => {
    expect((await call(method, path)).status).toBe(401);
  });
});

describe("settings routes onboarding needs before sign-in", () => {
  it("reaches the host write's body validation instead of answering 401", async () => {
    const res = await settingsRoutes.handle(
      new Request("http://localhost/api/settings/github", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ githubHost: "" }),
      }),
    );
    expect(res.status).toBe(422);
  });
});
