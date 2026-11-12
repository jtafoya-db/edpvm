import type {
  ManagerDirectory,
  ManagerDirectoryResult,
  ManagerDirectoryState,
} from "../data/manager-directory";
import { isManagerDirectoryState } from "../data/manager-directory";
import { PREVIEW_SCHEMA_PREFIX } from "./eir-test-mode";

export interface SimulatedManagerDirectoryOptions {
  active?: boolean;
  state?: ManagerDirectoryState;
  syncedAt?: Date;
}

/**
 * Deterministic, local-only adapter for the unresolved #341/#249 contract.
 * It has no credentials, storage, SDK client, or network path.
 */
export function createSimulatedManagerDirectory(
  options: SimulatedManagerDirectoryOptions = {},
): ManagerDirectory {
  const state = options.state ?? "missing";
  const active = options.active ?? false;
  const syncedAt = (options.syncedAt ?? new Date("2026-10-30T12:00:00.000Z")).toISOString();
  return {
    active,
    async managerOf(principalId): Promise<ManagerDirectoryResult> {
      if (state !== "ok") return { active, state };
      return {
        active,
        state,
        manager: {
          principalId: `simulated-manager-for-${principalId}`,
          displayName: "Simulated Manager",
          email: "simulated.manager@example.gov",
        },
        syncedAt,
      };
    },
  };
}

export function simulatedManagerDirectoryActive(
  enabled: string | undefined,
  schemaPrefix: string | undefined,
): boolean {
  return enabled?.trim() === "true" && PREVIEW_SCHEMA_PREFIX.test(schemaPrefix ?? "");
}

export function simulatedManagerDirectoryState(
  value: string | undefined,
  enabled: string | undefined,
  schemaPrefix: string | undefined,
): ManagerDirectoryState {
  const previewEnabled = simulatedManagerDirectoryActive(enabled, schemaPrefix);
  if (!previewEnabled) return "missing";
  if (value === undefined || value === "") return "missing";
  // A typo affects only this panel; it must not prevent unrelated APIs from starting.
  if (!isManagerDirectoryState(value)) return "sync-failed";
  return value;
}
