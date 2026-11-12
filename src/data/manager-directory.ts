export const MANAGER_DIRECTORY_STATES = [
  "ok",
  "missing",
  "stale",
  "ambiguous",
  "sync-failed",
] as const;

export type ManagerDirectoryState = (typeof MANAGER_DIRECTORY_STATES)[number];

export function isManagerDirectoryState(value: unknown): value is ManagerDirectoryState {
  return MANAGER_DIRECTORY_STATES.includes(value as ManagerDirectoryState);
}

/** Provisional attributes pending the production directory contract in #341 AC5. */
export interface DirectoryManager {
  principalId: string;
  displayName: string;
  email: string;
}

export interface ManagerDirectoryResult {
  active: boolean;
  state: ManagerDirectoryState;
  manager?: DirectoryManager;
  syncedAt?: string;
}

/** Server-resolved principal in production; callers never identify a person by email. */
export interface ManagerDirectory {
  /** True only when the server's explicit PR-preview simulation guard passed. */
  active?: boolean;
  managerOf(principalId: string): Promise<ManagerDirectoryResult>;
}
