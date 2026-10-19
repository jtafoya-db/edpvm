/**
 * Repository interface for the change list. Part of the {@link DataStore}
 * seam (src/data/store.ts).
 */
import type { ChangeListEntry } from "./types";

export interface ChangeListStore {
  /**
   * Entries, oldest first: every entry for EDP staff; for anyone else, only
   * those on datasets they own.
   */
  listEntries(): Promise<ChangeListEntry[]>;
  /**
   * Mark an entry applied, recording the signed-in user and the time.
   * Refused (`ActionRefusedError`) unless that user is EDP staff.
   */
  markApplied(entryId: string, options?: { idempotencyKey?: string }): Promise<ChangeListEntry>;
}
