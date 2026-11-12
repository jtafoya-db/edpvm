import { describe, expect, it } from "vitest";

import {
  createSimulatedManagerDirectory,
  simulatedManagerDirectoryState,
} from "../manager-directory";
import { createRegistry } from "../delta/registry";
import { registerManagerDirectoryArea } from "../delta/areas/manager-directory";

describe("simulated manager-directory port", () => {
  it.each(["ok", "missing", "stale", "ambiguous", "sync-failed"] as const)(
    "deterministically selects %s without external credentials or network calls",
    async (state) => {
      const directory = createSimulatedManagerDirectory({
        active: true,
        state,
        syncedAt: new Date("2026-10-30T12:00:00.000Z"),
      });

      const first = await directory.managerOf("employee-1");
      const again = await directory.managerOf("employee-1");

      expect(again).toEqual(first);
      expect(first.state).toBe(state);
      expect(first.active).toBe(true);
      if (state === "ok") {
        expect(first).toMatchObject({
          manager: {
            principalId: "simulated-manager-for-employee-1",
            displayName: "Simulated Manager",
            email: "simulated.manager@example.gov",
          },
          syncedAt: "2026-10-30T12:00:00.000Z",
        });
      } else {
        expect(first.manager).toBeUndefined();
      }
    },
  );

  it("is inactive unless a caller explicitly enables the simulation", async () => {
    const directory = createSimulatedManagerDirectory();

    expect(directory.active).toBe(false);
    await expect(directory.managerOf("employee-1")).resolves.toMatchObject({
      active: false,
      state: "missing",
    });
  });

  it("keys results by the server-resolved principal", async () => {
    const directory = createSimulatedManagerDirectory({ active: true, state: "ok" });

    await expect(directory.managerOf("employee-1")).resolves.toMatchObject({
      manager: { principalId: "simulated-manager-for-employee-1" },
    });
    await expect(directory.managerOf("employee-2")).resolves.toMatchObject({
      manager: { principalId: "simulated-manager-for-employee-2" },
    });
  });

  it("does not let one employee request another employee's manager result", async () => {
    const registry = createRegistry();
    registerManagerDirectoryArea(
      registry,
      createSimulatedManagerDirectory({ active: true, state: "ok" }),
    );
    const read = registry.findRead("eir", "manager-directory")!;

    expect(() => read.query.parse({ principalId: "employee-2" })).toThrow();
    await expect(
      read.run({
        query: {},
        user: {
          principalId: "employee-1",
          displayName: "Employee One",
          email: "employee.one@example.gov",
          isAdmin: false,
          onboardingReviewerRoles: [],
        },
        names: {} as never,
        read: async () => [],
      }),
    ).resolves.toMatchObject({
      manager: { principalId: "simulated-manager-for-employee-1" },
    });
  });

  it("maps an unknown selected state to sync-failed without breaking the API", () => {
    expect(simulatedManagerDirectoryState("missng", "true", "edp_vm_pr348_")).toBe("sync-failed");
  });

  it("keeps an unknown selected state missing outside a PR preview", () => {
    expect(simulatedManagerDirectoryState("missng", undefined, "edp_vm_pr348_")).toBe("missing");
    expect(simulatedManagerDirectoryState("missng", "true", "production_")).toBe("missing");
  });

  it.each(["ok", "stale", "ambiguous", "sync-failed"] as const)(
    "keeps %s unavailable unless an explicit PR-preview guard is satisfied",
    (state) => {
      expect(simulatedManagerDirectoryState(state, undefined, "edp_vm_pr348_")).toBe("missing");
      expect(simulatedManagerDirectoryState(state, "true", "")).toBe("missing");
      expect(simulatedManagerDirectoryState(state, "true", "edp_vm_pr348_")).toBe(state);
    },
  );

  it("keeps missing as the safe default with or without preview mode", () => {
    expect(simulatedManagerDirectoryState(undefined, undefined, "")).toBe("missing");
    expect(simulatedManagerDirectoryState("missing", "true", "edp_vm_pr348_")).toBe("missing");
  });
});
