import { useCallback, useEffect, useRef, useState } from "react";

interface UseStreamingTextOptions {
  /** Characters per tick (simulates variable token sizes) */
  chunkSize?: { min: number; max: number };
  /** Milliseconds between ticks */
  interval?: number;
  /** Start streaming immediately */
  autoStart?: boolean;
}

/**
 * Simulates LLM-style token streaming for demo purposes.
 * Returns the progressively revealed text and controls.
 */
export function useStreamingText(
  fullText: string,
  options: UseStreamingTextOptions = {},
) {
  const {
    chunkSize = { min: 1, max: 4 },
    interval = 20,
    autoStart = false,
  } = options;

  const [position, setPosition] = useState(0);
  const [isStreaming, setIsStreaming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval>>(undefined);

  const text = fullText.slice(0, position);
  const isDone = position >= fullText.length;

  const stop = useCallback(() => {
    clearInterval(timerRef.current);
    setIsStreaming(false);
  }, []);

  const start = useCallback(() => {
    setPosition(0);
    setIsStreaming(true);
  }, []);

  // Tick loop
  useEffect(() => {
    if (!isStreaming) return;

    timerRef.current = setInterval(() => {
      setPosition((prev) => {
        const size =
          Math.floor(Math.random() * (chunkSize.max - chunkSize.min + 1)) +
          chunkSize.min;
        const next = Math.min(prev + size, fullText.length);
        if (next >= fullText.length) {
          clearInterval(timerRef.current);
          setIsStreaming(false);
        }
        return next;
      });
    }, interval);

    return () => clearInterval(timerRef.current);
  }, [isStreaming, fullText.length, chunkSize.min, chunkSize.max, interval]);

  // Auto-start
  useEffect(() => {
    if (autoStart) start();
  }, [autoStart, start]);

  return { text, isStreaming, isDone, start, stop };
}
