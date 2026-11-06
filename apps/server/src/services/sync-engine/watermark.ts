export type CommentSyncWatermark = string;

export interface UpdatedAtRecord {
  readonly updatedAt: string;
}

export function latestUpdatedAt<T extends UpdatedAtRecord>(
  records: ReadonlyArray<T>,
): CommentSyncWatermark | null {
  if (records.length === 0) return null;
  return records.reduce((max, record) => (record.updatedAt > max ? record.updatedAt : max), "");
}
