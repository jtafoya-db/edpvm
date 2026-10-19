import { afterEach, describe, expect, it, vi } from "vitest";

import { registerMembershipArea } from "../areas/membership.ts";
import { createRegistry, type SessionUser } from "../registry.ts";
import { createStoreNames } from "../sql-builder.ts";

const tenant: SessionUser = {
  principalId: "tenant-1",
  displayName: "Tenant",
  email: "tenant@example.gov",
  isAdmin: false,
  onboardingReviewerRoles: [],
};

describe("membership read area", () => {
  afterEach(() => vi.useRealTimers());

  it("derives only an owner's datasets on the server and binds exact tags", async () => {
    const registry = createRegistry();
    registerMembershipArea(registry, { catalog: "catalog", schema: "membership" });
    const read = vi
      .fn()
      .mockResolvedValueOnce([{ domain: "tax", dataset_tag: "returns" }])
      .mockResolvedValueOnce([]);
    const definition = registry.findRead("membership", "memberships")!;

    await definition.run({
      query: {},
      user: tenant,
      names: createStoreNames("catalog", "preview_"),
      read,
    });

    expect(read.mock.calls[0]?.[0]).toEqual({
      statement:
        "SELECT DISTINCT d.domain_tag AS domain, d.dataset_tag FROM `catalog`.`preview_initiatives`.`datasets` d JOIN `catalog`.`preview_teams`.`dataset_owners` o ON o.dataset_id = d.id WHERE o.person_principal_id = :principalId",
      parameters: { principalId: "tenant-1" },
    });
    expect(read.mock.calls[1]?.[0]).toEqual({
      statement: expect.stringContaining(
        "(kind = 'domain' AND domain IN (:domain0)) OR (kind = 'dataset' AND dataset_tag IN (:datasetTag0))",
      ),
      parameters: { domain0: "tax", datasetTag0: "returns" },
    });
  });

  it("returns no member rows to a manager who is not an owner", async () => {
    const registry = createRegistry();
    registerMembershipArea(registry, { catalog: "catalog", schema: "membership" });
    const read = vi.fn().mockResolvedValueOnce([]);

    expect(
      await registry.findRead("membership", "memberships")!.run({
        query: {},
        user: tenant,
        names: createStoreNames("catalog", "preview_"),
        read,
      }),
    ).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toEqual({
      statement:
        "SELECT DISTINCT d.domain_tag AS domain, d.dataset_tag FROM `catalog`.`preview_initiatives`.`datasets` d JOIN `catalog`.`preview_teams`.`dataset_owners` o ON o.dataset_id = d.id WHERE o.person_principal_id = :principalId",
      parameters: { principalId: "tenant-1" },
    });
  });

  it("returns no history rows to a manager who is not an owner", async () => {
    const registry = createRegistry();
    registerMembershipArea(registry, { catalog: "catalog", schema: "membership" });
    const read = vi.fn().mockResolvedValueOnce([]);

    await expect(
      registry.findRead("membership", "history")!.run({
        query: {},
        user: tenant,
        names: createStoreNames("catalog", "preview_"),
        read,
      }),
    ).resolves.toEqual({ rows: [], nextCursor: null });
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toEqual({
      statement:
        "SELECT DISTINCT d.domain_tag AS domain, d.dataset_tag FROM `catalog`.`preview_initiatives`.`datasets` d JOIN `catalog`.`preview_teams`.`dataset_owners` o ON o.dataset_id = d.id WHERE o.person_principal_id = :principalId",
      parameters: { principalId: "tenant-1" },
    });
  });

  it("registers paged history and latest-run reads through the reader seam", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T00:00:00Z"));
    const registry = createRegistry();
    registerMembershipArea(registry, { catalog: "catalog", schema: "membership" });
    const historyRead = vi
      .fn()
      .mockResolvedValueOnce([{ domain: "tax", dataset_tag: "returns" }])
      .mockResolvedValueOnce([{ version: 4, timestamp: "2026-01-04T00:00:00Z" }])
      .mockResolvedValueOnce([]);

    await registry.findRead("membership", "history")!.run({
      query: { limit: 25, cursorVersion: 9, cursorGroupId: "g7", cursorUserId: "u4" },
      user: tenant,
      names: createStoreNames("catalog"),
      read: historyRead,
    });
    expect(historyRead.mock.calls[2]?.[0]).toEqual({
      statement: expect.stringContaining("LIMIT :fetchLimit"),
      parameters: {
        domain0: "tax",
        datasetTag0: "returns",
        fetchLimit: { type: "INT", value: 26 },
        cursorVersion: 9,
        cursorGroupId: "g7",
        cursorUserId: "u4",
      },
    });

    const latestRead = vi.fn().mockResolvedValue([
      {
        run_id: "run-1",
        started_at: "2026-01-04T00:00:00Z",
        ended_at: "2026-01-04T00:01:00Z",
        status: "succeeded",
      },
    ]);
    expect(
      await registry.findRead("membership", "latest-run")!.run({
        query: {},
        user: tenant,
        names: createStoreNames("catalog"),
        read: latestRead,
      }),
    ).toEqual(expect.objectContaining({ runId: "run-1", status: "succeeded" }));
  });

  it("lets EDP staff read all snapshot rows without an ownership lookup", async () => {
    const registry = createRegistry();
    registerMembershipArea(registry, { catalog: "catalog", schema: "membership" });
    const read = vi.fn().mockResolvedValue([]);
    const definition = registry.findRead("membership", "memberships")!;

    await definition.run({
      query: {},
      user: { ...tenant, isAdmin: true },
      names: createStoreNames("catalog"),
      read,
    });

    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0].statement).not.toContain("domain IN");
  });
});
