import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { SshSigningUnavailable } from "../../domain/errors";
import { sshSign } from "./ssh-keygen";

describe("sshSign", () => {
  it("reports a wrong key path as a signing failure, not a missing ssh-keygen", async () => {
    const failure = await sshSign("message", "/nonexistent/revv-test-key", "revv").catch(
      (e: unknown) => e,
    );
    expect(failure).toBeInstanceOf(SshSigningUnavailable);
  });

  it("reports a missing ssh-keygen when the executable can't be spawned", async () => {
    // Bun resolves executables against the PATH it started with, so the
    // missing executable needs a process of its own.
    const script = `
      const { sshSign } = await import(${JSON.stringify(join(import.meta.dir, "ssh-keygen.ts"))});
      const failure = await sshSign("message", "/nonexistent/key", "revv").catch((e) => e);
      console.log(failure._tag);
    `;
    const proc = Bun.spawn([process.execPath, "-e", script], {
      env: { PATH: "/nonexistent" },
      stdout: "pipe",
    });
    expect((await new Response(proc.stdout).text()).trim()).toBe("SshKeygenMissing");
  });
});
