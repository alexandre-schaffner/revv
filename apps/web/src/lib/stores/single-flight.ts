/**
 * One read per key at a time. `run` joins the read in flight. `rerun` wants
 * an answer that postdates the call: with a read already in flight (one that
 * may have started before whatever changed), it reads once more after that
 * one ends, and resolves when the second read does.
 */
export function singleFlight<A>(read: (key: string, arg: A) => Promise<void>): {
  run: (key: string, arg: A) => Promise<void>;
  rerun: (key: string, arg: A) => Promise<void>;
} {
  const inflight = new Map<string, Promise<void>>();
  const again = new Map<string, A>();

  function start(key: string, arg: A): Promise<void> {
    const promise = (async () => {
      let next = arg;
      for (;;) {
        await read(key, next);
        if (!again.has(key)) return;
        next = again.get(key) as A;
        again.delete(key);
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  return {
    run: (key, arg) => inflight.get(key) ?? start(key, arg),
    rerun: (key, arg) => {
      const running = inflight.get(key);
      if (!running) return start(key, arg);
      again.set(key, arg);
      return running;
    },
  };
}
