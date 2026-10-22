export function singleFlight<A>(read: (key: string, arg: A) => Promise<void>): {
  run: (key: string, arg: A) => Promise<void>;
  runFromNow: (key: string, arg: A) => Promise<void>;
} {
  const inflight = new Map<string, Promise<void>>();
  const readAfterInflight = new Map<string, A>();

  function start(key: string, arg: A): Promise<void> {
    const promise = (async () => {
      let next = arg;
      for (;;) {
        await read(key, next);
        if (!readAfterInflight.has(key)) return;
        next = readAfterInflight.get(key) as A;
        readAfterInflight.delete(key);
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  return {
    run: (key, arg) => inflight.get(key) ?? start(key, arg),
    runFromNow: (key, arg) => {
      const running = inflight.get(key);
      if (!running) return start(key, arg);
      readAfterInflight.set(key, arg);
      return running;
    },
  };
}
