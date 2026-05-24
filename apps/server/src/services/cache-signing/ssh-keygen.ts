import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SshKeygenMissing,
  SshSignatureInvalid,
  SshSigningUnavailable,
} from "../../domain/errors";

const TIMEOUT_MS = 5000;

async function runSshKeygen(args: string[], stdin: string): Promise<string> {
  const proc = Bun.spawn(["ssh-keygen", ...args], {
    stdin: Buffer.from(stdin, "utf8"),
    stdout: "pipe",
    stderr: "pipe",
  });

  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
  }, TIMEOUT_MS);

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  clearTimeout(timer);

  if (exitCode !== 0) {
    throw new Error(stderrText.trim() || `ssh-keygen exited with code ${exitCode}`);
  }

  return stdoutText;
}

function isMissingExecutable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const m = e.message.toLowerCase();
  return m.includes("enoent") || m.includes("not found") || m.includes("no such file");
}

/**
 * Sign `message` with the private key at `keyPath` using SSHSIG.
 * Returns the armored SSHSIG block (includes BEGIN/END headers).
 */
export async function sshSign(
  message: string,
  keyPath: string,
  namespace: string,
): Promise<string> {
  try {
    const out = await runSshKeygen(["-Y", "sign", "-f", keyPath, "-n", namespace, "-"], message);
    return out.trim();
  } catch (e) {
    if (isMissingExecutable(e)) {
      throw new SshKeygenMissing({ message: "ssh-keygen not found on PATH" });
    }
    throw new SshSigningUnavailable({
      message: e instanceof Error ? e.message : String(e),
      cause: e,
    });
  }
}

/**
 * Verify `signature` (armored SSHSIG block) against `message`.
 * `publicKeys` is the content of `https://<host>/<login>.keys`
 * split into individual key lines.
 */
export async function sshVerify(
  message: string,
  signature: string,
  signerLogin: string,
  publicKeys: string[],
  namespace: string,
): Promise<void> {
  const tmpDir = await mkdtemp(join(tmpdir(), "revv-ssh-"));
  try {
    const sigPath = join(tmpDir, "message.sig");
    const allowedSignersPath = join(tmpDir, "allowed_signers");

    await writeFile(sigPath, signature, "utf8");
    const allowedSigners = publicKeys
      .filter(Boolean)
      .map((k) => `${signerLogin} ${k.trim()}`)
      .join("\n");
    await writeFile(allowedSignersPath, allowedSigners, "utf8");

    await runSshKeygen(
      [
        "-Y",
        "verify",
        "-f",
        allowedSignersPath,
        "-I",
        signerLogin,
        "-n",
        namespace,
        "-s",
        sigPath,
        "-",
      ],
      message,
    );
  } catch (e) {
    if (isMissingExecutable(e)) {
      throw new SshKeygenMissing({ message: "ssh-keygen not found on PATH" });
    }
    throw new SshSignatureInvalid({
      message: e instanceof Error ? e.message : String(e),
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
