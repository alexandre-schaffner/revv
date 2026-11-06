// Client-local preferences: per-machine display state that never round-trips
// through the server. Every localStorage key Revv writes is listed here. The
// older keys keep their original spelling so values users already stored
// survive; new keys use the `revv:` prefix.

export const STORAGE_KEYS = {
  /** Also read by the pre-paint script in `app.html`, which can't import this. */
  theme: "revv-theme",
  diffTheme: "revv-diff-theme",
  diffWrap: "revv-diff-wrap",
  sidebarWidth: "revv:sidebar-width",
  rightPanelWidth: "revv:right-panel-width",
  railCollapsedOwners: "revv:rail-collapsed-owners",
  prLastTab: "revv:pr-last-tab",
  prVisits: "rev_pr_visits",
  /** Per user: switching accounts keeps each one's selection. */
  activeOrg: (userId: string | null) => (userId ? `rev_active_org_${userId}` : "rev_active_org"),
  archiveOpen: (repoId: string) => `revv:archive-open:${repoId}`,
  dismissedUpdate: "revv:updater:dismissed-version",
  lastCloneBase: "revv:lastCloneBaseDir",
} as const;

export interface StorageCodec<T> {
  /** `undefined` when the stored text isn't a valid value; the fallback applies. */
  parse(raw: string): T | undefined;
  /** `null` removes the key. */
  serialize(value: T): string | null;
}

/** `true` is stored as `"1"`; `false` removes the key. */
export const flagCodec: StorageCodec<boolean> = {
  parse: (raw) => raw === "1",
  serialize: (value) => (value ? "1" : null),
};

/** Blank text and `null` remove the key. */
export const textCodec: StorageCodec<string | null> = {
  parse: (raw) => (raw.trim() ? raw : undefined),
  serialize: (value) => (value?.trim() ? value : null),
};

export function oneOfCodec<T extends string>(values: readonly T[]): StorageCodec<T> {
  return {
    parse: (raw) => values.find((v) => v === raw),
    serialize: (value) => value,
  };
}

export function clampedIntCodec(min: number, max: number): StorageCodec<number> {
  return {
    parse: (raw) => {
      const n = Number.parseInt(raw, 10);
      return Number.isNaN(n) ? undefined : Math.max(min, Math.min(max, n));
    },
    serialize: (value) => String(value),
  };
}

export function jsonCodec<T>(validate: (value: unknown) => T | undefined): StorageCodec<T> {
  return {
    parse: (raw) => {
      try {
        return validate(JSON.parse(raw));
      } catch {
        return undefined;
      }
    },
    serialize: (value) => JSON.stringify(value),
  };
}

function storage(): Storage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}

export function readStored<T>(key: string, codec: StorageCodec<T>, fallback: T): T {
  const raw = storage()?.getItem(key) ?? null;
  if (raw === null) return fallback;
  return codec.parse(raw) ?? fallback;
}

export function writeStored<T>(key: string, codec: StorageCodec<T>, value: T): void {
  const raw = codec.serialize(value);
  try {
    if (raw === null) storage()?.removeItem(key);
    else storage()?.setItem(key, raw);
  } catch {
    // Storage full or unavailable: the in-memory value still holds this session.
  }
}

/** A reactive value backed by one storage key. */
class Persisted<T> {
  #value: T = $state() as T;
  readonly #key: string;
  readonly #codec: StorageCodec<T>;

  constructor(key: string, codec: StorageCodec<T>, fallback: T) {
    this.#key = key;
    this.#codec = codec;
    this.#value = readStored(key, codec, fallback);
  }

  get current(): T {
    return this.#value;
  }

  set current(value: T) {
    this.#value = value;
    writeStored(this.#key, this.#codec, value);
  }
}

export function persisted<T>(key: string, codec: StorageCodec<T>, fallback: T): Persisted<T> {
  return new Persisted(key, codec, fallback);
}
