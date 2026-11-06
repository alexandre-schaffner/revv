import type { AppChannel } from "./constants";

/**
 * `GET /api/health`. Also read outside TypeScript: `scripts/revv`,
 * `scripts/tests/bundled-server.py` and the desktop shell's `server.rs`.
 */
export interface RuntimeHealth {
  status: "ok";
  channel: AppChannel;
  /**
   * Commit the server was built from; `null` when it can't be read. Absent on
   * servers that predate this field.
   */
  commit?: string | null;
  port: number;
  timestamp: string;
}
