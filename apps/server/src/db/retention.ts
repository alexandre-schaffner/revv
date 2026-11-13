import type { Db } from "./index";

/**
 * How long a feature keeps rows of a table it owns. The feature defines it;
 * `DbMaintenance` runs every policy on its sweep.
 */
export interface RetentionPolicy {
  readonly table: string;
  /** Delete what the feature no longer needs; returns the rows deleted. */
  readonly sweep: (db: Db, now: Date) => number;
}

export function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}
