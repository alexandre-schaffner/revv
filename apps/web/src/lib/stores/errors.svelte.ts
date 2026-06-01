import { toast } from "svelte-sonner";

export type AppError = {
  message: string;
  code?: string;
  retryAfter?: number;
};

function formatRetryAfter(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function setError(error: AppError): void {
  const details = [
    error.code ? `Code: ${error.code}` : null,
    error.retryAfter && error.retryAfter > 0
      ? `Retrying in ${formatRetryAfter(error.retryAfter)}`
      : null,
  ].filter((detail): detail is string => detail !== null);

  toast.error(
    error.message,
    details.length > 0
      ? {
          description: details.join(" · "),
          duration: 6000,
        }
      : { duration: 6000 },
  );
}
