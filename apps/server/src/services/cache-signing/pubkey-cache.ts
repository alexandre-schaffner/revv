import { SshKeysFetchFailed } from "../../domain/errors";

const TTL_MS = 15 * 60 * 1000;
const NOTFOUND_TTL_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_BODY_BYTES = 64 * 1024;

interface Entry {
  keys: string[];
  fetchedAt: number;
  notFound: boolean;
}

/**
 * Public keys GitHub serves at `https://<host>/<login>.keys`: raw
 * authorized_keys lines, ready for an `ssh-keygen -Y verify` `allowed_signers`
 * file.
 */
export class PubkeyCache {
  private readonly cache = new Map<string, Entry>();

  /** An unknown login (404) yields no keys; any other failure throws `SshKeysFetchFailed`. */
  async getKeys(host: string, login: string): Promise<string[]> {
    const cacheKey = `${host}:${login}`;
    const now = Date.now();
    const entry = this.cache.get(cacheKey);

    if (entry) {
      const ttl = entry.notFound ? NOTFOUND_TTL_MS : TTL_MS;
      if (now - entry.fetchedAt < ttl) {
        return entry.keys;
      }
    }

    const url = `https://${host}/${login}.keys`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: "text/plain" },
      });

      if (res.status === 404) {
        this.cache.set(cacheKey, { keys: [], fetchedAt: now, notFound: true });
        return [];
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const text = await res.text();
      if (text.length > MAX_BODY_BYTES) {
        throw new Error(`response too large (${text.length} bytes)`);
      }

      const keys = text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      this.cache.set(cacheKey, { keys, fetchedAt: now, notFound: false });
      return keys;
    } catch (cause) {
      if (cause instanceof SshKeysFetchFailed) throw cause;
      throw new SshKeysFetchFailed({ host, login, cause });
    } finally {
      clearTimeout(timer);
    }
  }

  invalidate(): void {
    this.cache.clear();
  }
}
