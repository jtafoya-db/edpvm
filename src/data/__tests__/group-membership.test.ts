import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryGroupMembershipReader, type GroupMembership } from "../group-membership";
import { createDeltaGroupMembershipReader } from "../../server/group-membership";
const rows: GroupMembership[] = [
  {
    groupName: "domain-a",
    groupId: "g1",
    kind: "domain",
    domain: "a",
    managedBy: "scim",
    userId: "u1",
    email: "one@example.gov",
    displayName: "One",
    firstSeen: "2026-01-01",
    lastSeen: "2026-01-02",
  },
  {
    groupName: "domain-b",
    groupId: "g2",
    kind: "domain",
    domain: "b",
    managedBy: "manual",
    userId: "u2",
    email: "two@example.gov",
    displayName: "Two",
    firstSeen: "2026-01-01",
    lastSeen: "2026-01-02",
  },
];
describe("GroupMembershipReader", () => {
  afterEach(() => vi.useRealTimers());
  it("in-memory fake limits rows to server-resolved domains", async () => {
    const reader = createMemoryGroupMembershipReader(rows, async () => ({
      edpStaff: false,
      domains: ["a"],
      datasetTags: [],
    }));
    expect(await reader.listMemberships()).toEqual([rows[0]]);
  });
  it("in-memory fake excludes another dataset's group in the same domain", async () => {
    const ownDataset = { ...rows[0]!, kind: "dataset" as const, datasetTag: "mine" };
    const otherDataset = {
      ...rows[1]!,
      kind: "dataset" as const,
      domain: "a",
      datasetTag: "theirs",
    };
    const reader = createMemoryGroupMembershipReader([ownDataset, otherDataset], async () => ({
      edpStaff: false,
      domains: ["a"],
      datasetTags: ["mine"],
    }));

    expect(await reader.listMemberships()).toEqual([ownDataset]);
  });
  it("in-memory fake returns no member rows when server visibility is empty", async () => {
    const reader = createMemoryGroupMembershipReader(rows, async () => ({
      edpStaff: false,
      domains: [],
      datasetTags: [],
    }));

    expect(await reader.listMemberships()).toEqual([]);
    expect(await reader.listHistory()).toEqual({ rows: [], nextCursor: null });
  });
  it("omits removed rows by default and exposes them for history", async () => {
    const removed = { ...rows[0]!, removedAt: "2026-01-03" };
    const reader = createMemoryGroupMembershipReader([removed], async () => ({ edpStaff: true }));
    expect(await reader.listMemberships()).toEqual([]);
    expect(await reader.listMemberships({ includeRemoved: true })).toEqual([removed]);
  });
  it("Delta adapter applies domain filtering in SQL", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [], numAffectedRows: null });
    const reader = createDeltaGroupMembershipReader({
      client: { execute },
      catalog: "catalog",
      schema: "membership",
      visibility: async () => ({
        edpStaff: false,
        domains: ["a", "b"],
        datasetTags: ["owned_dataset"],
      }),
    });
    await reader.listMemberships();
    expect(execute).toHaveBeenCalledWith(
      {
        statement: expect.stringContaining(
          "WHERE removed_at IS NULL AND ((kind = 'domain' AND domain IN (:domain0,:domain1)) OR (kind = 'dataset' AND dataset_tag IN (:datasetTag0)))",
        ),
        parameters: { domain0: "a", domain1: "b", datasetTag0: "owned_dataset" },
      },
      { readId: expect.any(String) },
    );
  });
  it("EDP staff read all rows without a domain predicate", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [], numAffectedRows: null });
    const reader = createDeltaGroupMembershipReader({
      client: { execute },
      catalog: "catalog",
      schema: "membership",
      visibility: async () => ({ edpStaff: true }),
    });
    await reader.listMemberships();
    expect(execute.mock.calls[0]?.[0].statement).not.toContain("domain IN");
    expect(execute.mock.calls[0]?.[0].parameters).toBeUndefined();
  });
  it("in-memory fake reports the latest run, or null when the job never ran", async () => {
    const noRun = createMemoryGroupMembershipReader(rows, async () => ({ edpStaff: true }));
    expect(await noRun.latestRun()).toBeNull();
    const run = {
      runId: "r1",
      startedAt: "2026-01-02T00:00:00Z",
      endedAt: "2026-01-02T00:00:05Z",
      status: "succeeded",
      groupsExpected: ["g1"],
      groupsRead: ["g1"],
      complete: true,
    };
    const withRun = createMemoryGroupMembershipReader(rows, async () => ({ edpStaff: true }), run);
    expect(await withRun.latestRun()).toEqual(run);
  });
  it("in-memory fake derives complete=false for an empty expected set", async () => {
    const claimedComplete = {
      runId: "r-empty",
      startedAt: "2026-01-02T00:00:00Z",
      endedAt: "2026-01-02T00:00:05Z",
      status: "succeeded",
      groupsExpected: [],
      groupsRead: [],
      complete: true,
    };
    const reader = createMemoryGroupMembershipReader(
      rows,
      async () => ({ edpStaff: true }),
      claimedComplete,
    );

    expect(await reader.latestRun()).toEqual({ ...claimedComplete, complete: false });
  });
  it("Delta adapter reads the newest snapshot_runs row and maps it", async () => {
    const execute = vi.fn().mockResolvedValue({
      rows: [
        {
          run_id: "r9",
          started_at: "2026-01-05T00:00:00Z",
          ended_at: "2026-01-05T00:00:03Z",
          status: "succeeded",
          groups_expected: ["g1", "g2"],
          groups_read: ["g1"],
        },
      ],
      numAffectedRows: null,
    });
    const reader = createDeltaGroupMembershipReader({
      client: { execute },
      catalog: "catalog",
      schema: "membership",
      visibility: async () => ({ edpStaff: true }),
    });
    const run = await reader.latestRun();
    expect(execute.mock.calls[0]?.[0].statement).toContain(
      "FROM `catalog`.`membership`.`snapshot_runs`",
    );
    expect(execute.mock.calls[0]?.[0].statement).toContain("ORDER BY started_at DESC LIMIT 1");
    expect(run).toEqual({
      runId: "r9",
      startedAt: "2026-01-05T00:00:00Z",
      endedAt: "2026-01-05T00:00:03Z",
      status: "succeeded",
      groupsExpected: ["g1", "g2"],
      groupsRead: ["g1"],
      complete: false,
    });
  });
  it("Delta adapter returns null when snapshot_runs is empty", async () => {
    const reader = createDeltaGroupMembershipReader({
      client: { execute: vi.fn().mockResolvedValue({ rows: [], numAffectedRows: null }) },
      catalog: "catalog",
      schema: "membership",
      visibility: async () => ({ edpStaff: true }),
    });
    expect(await reader.latestRun()).toBeNull();
  });
  it.each([
    { label: "empty", expected: [], read: [] },
    { label: "legacy null", expected: null, read: null },
  ])("Delta adapter marks $label expected groups incomplete", async ({ expected, read }) => {
    const reader = createDeltaGroupMembershipReader({
      client: {
        execute: vi.fn().mockResolvedValue({
          rows: [
            {
              run_id: "r-old",
              started_at: "2026-01-05T00:00:00Z",
              ended_at: "2026-01-05T00:00:03Z",
              status: "succeeded",
              groups_expected: expected,
              groups_read: read,
            },
          ],
          numAffectedRows: null,
        }),
      },
      catalog: "catalog",
      schema: "membership",
      visibility: async () => ({ edpStaff: true }),
    });

    expect(await reader.latestRun()).toEqual({
      runId: "r-old",
      startedAt: "2026-01-05T00:00:00Z",
      endedAt: "2026-01-05T00:00:03Z",
      status: "succeeded",
      groupsExpected: [],
      groupsRead: [],
      complete: false,
    });
  });
  it("Delta adapter reads membership changes from Change Data Feed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T00:00:00Z"));
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ version: 4, timestamp: "2026-01-03T00:00:00Z" }],
        numAffectedRows: null,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            group_name: "domain-a",
            group_id: "g1",
            kind: "domain",
            domain: "a",
            dataset_tag: null,
            managed_by: "scim",
            user_id: "u1",
            email: "one@example.gov",
            display_name: "One",
            first_seen: "2026-01-01",
            last_seen: "2026-01-03",
            removed_at: "2026-01-03",
            _change_type: "update_postimage",
            _commit_timestamp: "2026-01-03T00:00:00Z",
            _commit_version: 4,
          },
        ],
        numAffectedRows: null,
      });
    const reader = createDeltaGroupMembershipReader({
      client: { execute },
      catalog: "catalog",
      schema: "membership",
      visibility: async () => ({ edpStaff: false, domains: ["a"], datasetTags: ["mine"] }),
    });

    expect(await reader.listHistory()).toEqual({
      rows: [
        expect.objectContaining({
          groupId: "g1",
          userId: "u1",
          changeType: "update_postimage",
          changedAt: "2026-01-03T00:00:00Z",
          commitVersion: 4,
          removedAt: "2026-01-03",
        }),
      ],
      nextCursor: null,
    });
    expect(execute.mock.calls[0]?.[0]).toEqual({
      statement: "DESCRIBE HISTORY `catalog`.`membership`.`group_members` LIMIT 1000",
    });
    expect(execute.mock.calls[1]?.[0]).toEqual({
      statement: expect.stringContaining(
        "(post.kind = 'domain' AND post.domain IN (:domain0)) OR (post.kind = 'dataset' AND post.dataset_tag IN (:datasetTag0))",
      ),
      parameters: {
        domain0: "a",
        datasetTag0: "mine",
        fetchLimit: { type: "INT", value: 501 },
      },
    });
  });
  it("excludes last_seen-only updates and caps each CDF page", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T00:00:00Z"));
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ version: 8, timestamp: "2026-01-04T00:00:00Z" }],
        numAffectedRows: null,
      })
      .mockResolvedValueOnce({ rows: [], numAffectedRows: null });
    const reader = createDeltaGroupMembershipReader({
      client: { execute },
      catalog: "catalog",
      schema: "membership",
      visibility: async () => ({ edpStaff: true }),
    });

    expect(
      await reader.listHistory({
        limit: 20,
        cursor: { commitVersion: 8, groupId: "g0500", userId: "u0500" },
      }),
    ).toEqual({ rows: [], nextCursor: null });
    expect(execute.mock.calls[1]?.[0]).toEqual({
      statement: expect.stringMatching(
        /post\._change_type = 'update_postimage' AND NOT \(post\.removed_at <=> pre\.removed_at\).*post\._commit_version < :cursorVersion.*post\.group_id > :cursorGroupId.*post\.user_id > :cursorUserId.*LIMIT :fetchLimit/,
      ),
      parameters: {
        cursorVersion: 8,
        cursorGroupId: "g0500",
        cursorUserId: "u0500",
        fetchLimit: { type: "INT", value: 21 },
      },
    });
  });
  it("continues a fake-SQL page inside one bulk commit and marks the final page exhausted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T00:00:00Z"));
    const change = (groupId: string) => ({
      group_name: `domain-${groupId}`,
      group_id: groupId,
      kind: "domain",
      domain: "a",
      dataset_tag: null,
      managed_by: "scim",
      user_id: "u1",
      email: `${groupId}@example.gov`,
      display_name: groupId,
      first_seen: "2026-01-01",
      last_seen: "2026-01-04",
      removed_at: null,
      _change_type: "insert",
      _commit_timestamp: "2026-01-04T00:00:00Z",
      _commit_version: 8,
    });
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ version: 8, timestamp: "2026-01-04T00:00:00Z" }],
        numAffectedRows: null,
      })
      .mockResolvedValueOnce({
        rows: [change("g1"), change("g2"), change("g3")],
        numAffectedRows: null,
      })
      .mockResolvedValueOnce({
        rows: [{ version: 8, timestamp: "2026-01-04T00:00:00Z" }],
        numAffectedRows: null,
      })
      .mockResolvedValueOnce({ rows: [change("g3")], numAffectedRows: null });
    const reader = createDeltaGroupMembershipReader({
      client: { execute },
      catalog: "catalog",
      schema: "membership",
      visibility: async () => ({ edpStaff: true }),
    });

    const first = await reader.listHistory({ limit: 2 });
    expect(first).toMatchObject({
      rows: [{ groupId: "g1" }, { groupId: "g2" }],
      nextCursor: { commitVersion: 8, groupId: "g2", userId: "u1" },
    });
    const second = await reader.listHistory({ limit: 2, cursor: first.nextCursor! });
    expect(second).toMatchObject({ rows: [{ groupId: "g3" }], nextCursor: null });
    expect(execute.mock.calls[3]?.[0].parameters).toEqual({
      cursorVersion: 8,
      cursorGroupId: "g2",
      cursorUserId: "u1",
      fetchLimit: { type: "INT", value: 3 },
    });
  });
  it("continues an in-memory page inside one bulk commit", async () => {
    const history = ["g1", "g2", "g3"].map((groupId) => ({
      ...rows[0]!,
      groupId,
      userId: "u1",
      changeType: "insert",
      changedAt: "2026-01-04T00:00:00Z",
      commitVersion: 8,
    }));
    const reader = createMemoryGroupMembershipReader(
      rows,
      async () => ({ edpStaff: true }),
      null,
      history,
    );

    const first = await reader.listHistory({ limit: 2 });
    expect(first).toMatchObject({
      rows: [{ groupId: "g1" }, { groupId: "g2" }],
      nextCursor: { commitVersion: 8, groupId: "g2", userId: "u1" },
    });
    await expect(
      reader.listHistory({ limit: 2, cursor: first.nextCursor! }),
    ).resolves.toMatchObject({
      rows: [{ groupId: "g3" }],
      nextCursor: null,
    });
  });
  it("uses code-unit ordering in memory and excludes rows without the MERGE key", async () => {
    const history = ["a", "Z"].map((groupId) => ({
      ...rows[0]!,
      groupId,
      changeType: "insert",
      changedAt: "2026-01-04T00:00:00Z",
      commitVersion: 8,
    }));
    history.push({ ...history[0]!, groupId: null } as unknown as (typeof history)[number]);
    const reader = createMemoryGroupMembershipReader(
      rows,
      async () => ({ edpStaff: true }),
      null,
      history,
    );

    await expect(reader.listHistory()).resolves.toMatchObject({
      rows: [{ groupId: "Z" }, { groupId: "a" }],
      nextCursor: null,
    });
  });
  it("continues from the last row of one commit into the next older commit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T00:00:00Z"));
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ version: 8, timestamp: "2026-01-04T00:00:00Z" }],
        numAffectedRows: null,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            group_name: "older",
            group_id: "g1",
            kind: "domain",
            domain: "a",
            dataset_tag: null,
            managed_by: "scim",
            user_id: "u1",
            email: "older@example.gov",
            display_name: "Older",
            first_seen: "2026-01-01",
            last_seen: "2026-01-03",
            removed_at: null,
            _change_type: "insert",
            _commit_timestamp: "2026-01-03T00:00:00Z",
            _commit_version: 7,
          },
        ],
        numAffectedRows: null,
      });
    const reader = createDeltaGroupMembershipReader({
      client: { execute },
      catalog: "catalog",
      schema: "membership",
      visibility: async () => ({ edpStaff: true }),
    });

    await expect(
      reader.listHistory({
        limit: 2,
        cursor: { commitVersion: 8, groupId: "g-last", userId: "u-last" },
      }),
    ).resolves.toMatchObject({ rows: [{ commitVersion: 7, groupId: "g1" }], nextCursor: null });
    expect(execute.mock.calls[1]?.[0].statement).toContain(
      "post.group_id IS NOT NULL AND post.user_id IS NOT NULL",
    );
  });
  it("EDP staff history is unscoped but still bounded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-05T00:00:00Z"));
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ version: 8, timestamp: "2026-01-04T00:00:00Z" }],
        numAffectedRows: null,
      })
      .mockResolvedValueOnce({ rows: [], numAffectedRows: null });
    const reader = createDeltaGroupMembershipReader({
      client: { execute },
      catalog: "catalog",
      schema: "membership",
      visibility: async () => ({ edpStaff: true }),
    });

    await reader.listHistory();
    expect(execute.mock.calls[1]?.[0].statement).not.toContain("post.domain IN");
    expect(execute.mock.calls[1]?.[0].parameters).toEqual({
      fetchLimit: { type: "INT", value: 501 },
    });
  });
  it("returns no CDF rows when retained history is older than six days", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T00:00:00Z"));
    const execute = vi.fn().mockResolvedValue({
      rows: [{ version: 4, timestamp: "2026-01-03T00:00:00Z" }],
      numAffectedRows: null,
    });
    const reader = createDeltaGroupMembershipReader({
      client: { execute },
      catalog: "catalog",
      schema: "membership",
      visibility: async () => ({ edpStaff: true }),
    });

    expect(await reader.listHistory()).toEqual({ rows: [], nextCursor: null });
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("returns no CDF rows when the table has no history", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [], numAffectedRows: null });
    const reader = createDeltaGroupMembershipReader({
      client: { execute },
      catalog: "catalog",
      schema: "membership",
      visibility: async () => ({ edpStaff: true }),
    });

    expect(await reader.listHistory()).toEqual({ rows: [], nextCursor: null });
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
