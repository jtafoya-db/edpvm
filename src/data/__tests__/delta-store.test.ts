import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attestationToRow,
  createDeltaStore,
  DeltaApiError,
  httpTransport,
  requestToRows,
  rowToAttestation,
  rowsToRequest,
  type DeltaApiTransport,
} from "../adapters/delta";
import type { AccessRequest, RequestStatus, WaiverAttestation } from "../types";
import {
  DATASET_ID,
  OWNER,
  STAFF,
  STRANGER,
  TEST_GROUP_NAMING,
  TEST_ROLE_DESCRIPTIONS,
  makeClock,
  makeDatasetSeed,
} from "./dataset-fixture";
import { makeNewRequest, makeSnapshot } from "./fixture";

/**
 * A fake of the server's Delta API: it keeps requests and attestations in
 * memory and, like the real server, takes the requester and attestor from
 * its own session rather than from the body.
 */
function fakeServer(session: { principalId: string; username: string }) {
  const requests: AccessRequest[] = [];
  const attestations: WaiverAttestation[] = [];
  const statuses = (): Record<string, RequestStatus> =>
    Object.fromEntries(
      requests.map((request) => [
        request.id,
        {
          requestId: request.id,
          status: request.status,
          overall: request.overall,
          stageIndex: request.stageIndex,
          stages: [],
          subRequests: request.subRequests,
        },
      ]),
    );
  const transport: DeltaApiTransport = {
    read: vi.fn(async (area: string, name: string, query?: Record<string, string>) => {
      if (`${area}/${name}` === "requests/statuses") {
        return structuredClone({ requests, statuses: statuses() });
      }
      if (`${area}/${name}` === "requests/access-requests") {
        if (query?.["id"])
          return structuredClone(requests.find((r) => r.id === query["id"]) ?? null);
        return structuredClone(requests);
      }
      throw new Error(`unexpected read ${area}/${name}`);
    }) as DeltaApiTransport["read"],
    command: vi.fn(async () => {
      throw new Error("#72's request writes aren't commands");
    }) as DeltaApiTransport["command"],
    legacyWrite: vi.fn(async (area: string, name: string, body: unknown) => {
      const payload = body as Record<string, unknown>;
      if (name === "create-request") {
        const stored = {
          ...(payload as unknown as AccessRequest),
          requesterPrincipalId: session.principalId,
          requesterUsername: session.username,
        };
        requests.push(stored);
        return { result: structuredClone(stored) };
      }
      if (name === "transition-request") {
        const { id, ...update } = payload as { id: string };
        const index = requests.findIndex((r) => r.id === id);
        requests[index] = { ...requests[index]!, ...(update as Partial<AccessRequest>) };
        return { result: structuredClone(requests[index]) };
      }
      if (name === "append-waiver-attestation") {
        const stored = {
          ...(payload as unknown as WaiverAttestation),
          attestorPrincipalId: session.principalId,
          attestorUsername: session.username,
        };
        attestations.push(stored);
        return { result: structuredClone(stored) };
      }
      throw new Error(`unexpected legacy write ${area}/${name}`);
    }) as DeltaApiTransport["legacyWrite"],
  };
  return { transport, requests, session };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Delta request row mappings", () => {
  it("round-trips the record and principal identity", () => {
    const request = {
      ...makeNewRequest(),
      requesterPrincipalId: "scim-42",
      requesterUsername: "analyst@example.gov",
    };
    const rows = requestToRows(request);
    expect(rowsToRequest(rows.request, rows.items, rows.steps)).toEqual(request);
  });
  it("round-trips a principal-keyed append attestation", () => {
    const value: WaiverAttestation = {
      id: "ATT-1",
      requestId: "REQ-1",
      checklistItemId: "ldw",
      attestorPrincipalId: "scim-9",
      attestorUsername: "approver@example.gov",
      attested: true,
      attestedAt: "2026-09-30T12:00:00Z",
      note: "On file",
      source: "app",
      createdAt: "2026-09-30T12:00:00Z",
    };
    expect(rowToAttestation(attestationToRow(value))).toEqual(value);
  });
});

describe("Delta adapter contract", () => {
  it("creates, reads, transitions, and appends through the API, with the server naming the actor", async () => {
    const server = fakeServer({ principalId: "scim-42", username: "analyst@example.gov" });
    const store = createDeltaStore({ transport: server.transport });
    const request = {
      ...makeNewRequest(),
      requesterPrincipalId: "scim-42",
      requesterUsername: "analyst@example.gov",
    };
    expect(await store.requests.createRequest(request)).toEqual(request);
    expect(await store.requests.getRequest(request.id)).toEqual(request);
    const updated = await store.requests.transitionRequest(request.id, {
      status: "Completed",
      overall: "Access active",
      stageIndex: 5,
      subRequests: [{ system: "Access active", status: "done", detail: "Granted" }],
    });
    expect(updated).toMatchObject({
      status: "Completed",
      stageIndex: 5,
      subRequests: [{ status: "done" }],
    });
    server.session.principalId = "scim-9";
    server.session.username = "approver@example.gov";
    const attestation: WaiverAttestation = {
      id: "ATT-1",
      requestId: request.id,
      checklistItemId: "ldw",
      attestorPrincipalId: "scim-9",
      attestorUsername: "approver@example.gov",
      attested: true,
      attestedAt: "2026-09-30T12:00:00Z",
      source: "app",
      createdAt: "2026-09-30T12:00:00Z",
    };
    expect(await store.requests.appendWaiverAttestation(attestation)).toEqual(attestation);
    expect(server.transport.legacyWrite).toHaveBeenCalledTimes(3);
    expect(server.transport.command).not.toHaveBeenCalled();
  });

  it("never names the actor or sends SQL in a write body", async () => {
    const server = fakeServer({ principalId: "scim-42", username: "analyst@example.gov" });
    const store = createDeltaStore({ transport: server.transport });
    // A caller that tries to name someone else is overridden by the session.
    const created = await store.requests.createRequest({
      ...makeNewRequest(),
      requesterPrincipalId: "scim-someone-else",
      requesterUsername: "someone@example.gov",
    });
    expect(created.requesterPrincipalId).toBe("scim-42");
    await store.requests.appendWaiverAttestation({
      id: "ATT-2",
      requestId: created.id,
      checklistItemId: "ldw",
      attestorPrincipalId: "scim-someone-else",
      attestorUsername: "someone@example.gov",
      attested: true,
      attestedAt: "2026-09-30T12:00:00Z",
      source: "app",
      createdAt: "2026-09-30T12:00:00Z",
    });
    for (const [, , payload] of vi.mocked(server.transport.legacyWrite).mock.calls) {
      const text = JSON.stringify(payload);
      expect(text).not.toMatch(/someone|requesterPrincipalId|attestorPrincipalId|principal_id/);
      expect(text).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE)\b/);
    }
  });

  it("surfaces Delta failures and never falls back to memory", async () => {
    const failure = new Error("warehouse unavailable");
    const transport: DeltaApiTransport = {
      read: vi.fn().mockRejectedValue(failure),
      command: vi.fn().mockRejectedValue(failure),
      legacyWrite: vi.fn().mockRejectedValue(failure),
    };
    const store = createDeltaStore({ transport });
    await expect(store.requests.listRequests()).rejects.toBe(failure);
    await expect(store.catalog.listDatasets()).rejects.toBe(failure);
    await expect(store.requests.createRequest(makeNewRequest())).rejects.toBe(failure);
  });

  it("shares only an in-flight request/statuses read; later refetches hit the server", async () => {
    const first = makeNewRequest();
    const second = { ...makeNewRequest(), id: "REQ-9002", title: "Updated on the server" };
    let current = [first];
    const transport: DeltaApiTransport = {
      read: vi.fn(async <T>(area: string, name: string): Promise<T> => {
        if (`${area}/${name}` !== "requests/statuses")
          throw new Error(`unexpected read ${area}/${name}`);
        return structuredClone({
          requests: current,
          statuses: Object.fromEntries(
            current.map((request) => [
              request.id,
              {
                requestId: request.id,
                status: request.status,
                overall: request.overall,
                stageIndex: request.stageIndex,
                stages: [],
                subRequests: request.subRequests,
              },
            ]),
          ),
        }) as T;
      }) as DeltaApiTransport["read"],
      command: vi.fn(),
      legacyWrite: vi.fn(),
    };
    const store = createDeltaStore({ transport, stages: () => makeSnapshot().STAGES });

    expect(
      await Promise.all([store.requests.listRequests(), store.status.listRequestStatuses()]),
    ).toHaveLength(2);
    expect(transport.read).toHaveBeenCalledTimes(1);

    current = [second];
    expect((await store.requests.listRequests()).map((request) => request.id)).toEqual([
      "REQ-9002",
    ]);
    expect(transport.read).toHaveBeenCalledTimes(2);
  });

  it("retries a failed bootstrap read instead of pinning the rejection", async () => {
    const failure = new Error("temporary warehouse outage");
    const transport: DeltaApiTransport = {
      read: vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ requests: [], statuses: {} }),
      command: vi.fn(),
      legacyWrite: vi.fn(),
    };
    const store = createDeltaStore({ transport });

    await expect(store.requests.listRequests()).rejects.toBe(failure);
    await expect(store.requests.listRequests()).resolves.toEqual([]);
    expect(transport.read).toHaveBeenCalledTimes(2);
  });

  it("retries a failed catalog bootstrap read instead of pinning the rejection", async () => {
    const failure = new Error("temporary catalog outage");
    const transport: DeltaApiTransport = {
      read: vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({
          domains: [],
          datasets: [{ ...makeSnapshot().datasets[0]!, id: "ds-fresh" }],
          bundles: [],
          systems: [],
          personas: [],
          tenants: [],
        }),
      command: vi.fn(),
      legacyWrite: vi.fn(),
    };
    const store = createDeltaStore({ transport });

    await expect(store.catalog.listDatasets()).rejects.toBe(failure);
    await expect(store.catalog.listDatasets()).resolves.toEqual([
      expect.objectContaining({ id: "ds-fresh" }),
    ]);
    expect(transport.read).toHaveBeenCalledTimes(2);
  });

  it("surfaces staff tenant bootstrap errors from the combined catalog read", async () => {
    const transport: DeltaApiTransport = {
      read: vi.fn().mockResolvedValue({
        domains: [],
        datasets: [],
        bundles: [],
        systems: [],
        personas: [],
        tenants: null,
        tenantsError: {
          code: "tenant-rollup-unavailable",
          message: "Tenant financials are temporarily unavailable.",
        },
      }),
      command: vi.fn(),
      legacyWrite: vi.fn(),
    };
    const store = createDeltaStore({
      transport,
      accessStores: { currentUser: async () => ({ ...makeSnapshot().user, isAdmin: true }) },
    });

    await expect(store.catalog.listTenants()).rejects.toMatchObject({
      name: "DeltaApiError",
      status: 500,
      code: "tenant-rollup-unavailable",
      message: "Tenant financials are temporarily unavailable.",
    } satisfies Partial<DeltaApiError>);
  });

  it.each(["create-request", "transition-request"])(
    "breaks in-flight request/statuses sharing after %s",
    async (writeName) => {
      const pending = deferred<{
        requests: AccessRequest[];
        statuses: Record<string, RequestStatus>;
      }>();
      const fresh = { ...makeNewRequest(), id: "REQ-FRESH" };
      const transport: DeltaApiTransport = {
        read: vi
          .fn()
          .mockReturnValueOnce(pending.promise)
          .mockResolvedValueOnce({
            requests: [fresh],
            statuses: {
              [fresh.id]: {
                requestId: fresh.id,
                status: fresh.status,
                overall: fresh.overall,
                stageIndex: fresh.stageIndex,
                stages: [],
                subRequests: fresh.subRequests,
              },
            },
          }),
        command: vi.fn(),
        legacyWrite: vi.fn(
          async <T>() => ({ result: makeNewRequest() }) as T,
        ) as DeltaApiTransport["legacyWrite"],
      };
      const store = createDeltaStore({ transport });

      const staleRead = store.requests.listRequests();
      if (writeName === "create-request") {
        await store.requests.createRequest(makeNewRequest());
      } else {
        await store.requests.transitionRequest("REQ-9001", {
          status: "Completed",
          overall: "Access active",
          stageIndex: 5,
          subRequests: [],
        });
      }

      const freshRead = store.requests.listRequests();
      pending.resolve({ requests: [], statuses: {} });

      await expect(staleRead).resolves.toEqual([]);
      await expect(freshRead).resolves.toEqual([fresh]);
      expect(transport.read).toHaveBeenCalledTimes(2);
      expect(transport.legacyWrite).toHaveBeenCalledWith("requests", writeName, expect.anything());
    },
  );

  it("does not let an older request/statuses completion clear a newer in-flight read", async () => {
    const stale = deferred<{
      requests: AccessRequest[];
      statuses: Record<string, RequestStatus>;
    }>();
    const fresh = deferred<{
      requests: AccessRequest[];
      statuses: Record<string, RequestStatus>;
    }>();
    const request = { ...makeNewRequest(), id: "REQ-FRESH" };
    const transport: DeltaApiTransport = {
      read: vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise),
      command: vi.fn(),
      legacyWrite: vi.fn(
        async <T>() => ({ result: makeNewRequest() }) as T,
      ) as DeltaApiTransport["legacyWrite"],
    };
    const store = createDeltaStore({ transport });

    const staleRead = store.requests.listRequests();
    await store.requests.createRequest(makeNewRequest());
    const freshRead = store.requests.listRequests();
    stale.resolve({ requests: [], statuses: {} });
    await expect(staleRead).resolves.toEqual([]);

    const sharedFreshStatusRead = store.status.listRequestStatuses();
    expect(transport.read).toHaveBeenCalledTimes(2);

    fresh.resolve({
      requests: [request],
      statuses: {
        [request.id]: {
          requestId: request.id,
          status: request.status,
          overall: request.overall,
          stageIndex: request.stageIndex,
          stages: [],
          subRequests: request.subRequests,
        },
      },
    });
    await expect(freshRead).resolves.toEqual([request]);
    await expect(sharedFreshStatusRead).resolves.toHaveProperty(request.id);
    expect(transport.read).toHaveBeenCalledTimes(2);
  });

  it("reads #72 reference data from allow-listed endpoints, not SQL", async () => {
    const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      if (String(url).includes("catalog/bootstrap")) {
        return new Response(
          JSON.stringify({
            datasets: [{ id: "d1" }],
            bundles: [],
            systems: [],
            personas: [],
            tenants: [],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify(String(url).includes("catalog/datasets") ? [{ id: "d1" }] : []),
        {
          status: 200,
        },
      );
    });
    const store = createDeltaStore({
      transport: httpTransport(request as typeof fetch),
      accessStores: { currentUser: async () => ({ ...makeSnapshot().user, isAdmin: true }) },
    });
    expect(await store.catalog.getDataset("d1")).toEqual({ id: "d1" });
    await store.catalog.listTenants();
    await store.status.getMyAccess();
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/reads/catalog/bootstrap",
      "/api/reads/catalog/bootstrap",
      "/api/reads/access/my-access",
    ]);
  });

  it("maps a server refusal to an error carrying its code and message", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "version-conflict",
              message: "This changed since you opened it. Reload to see the latest.",
            },
          }),
          { status: 409 },
        ),
    );
    const store = createDeltaStore({ transport: httpTransport(request as typeof fetch) });
    await expect(store.requests.createRequest(makeNewRequest())).rejects.toMatchObject({
      status: 409,
      code: "version-conflict",
      message: "This changed since you opened it. Reload to see the latest.",
    });
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/legacy-writes/requests/create-request");
    expect(init.method).toBe("POST");
    // The payload only: no idempotency key or version it would pretend to honour.
    expect(Object.keys(JSON.parse(String(init.body)))).toEqual(["payload"]);
  });
});

// Datasets, dataset roles, team management and the change list are on Delta
// (#123). Their behaviour is covered on both backends by dataset-team.test.ts
// and dataset-team-management.test.ts; these tests pin what the browser
// sends: allow-listed paths, the strict command envelope with no actor, and
// one idempotency key per intent, resent on a retry.
describe("Delta adapter: datasets, team and change list go to the Delta API", () => {
  function recording(answers: Array<(url: string) => Response | Error>) {
    const calls: { url: string; body: unknown }[] = [];
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const answer = answers[calls.length - 1]?.(url) ?? new Response("{}", { status: 500 });
      if (answer instanceof Error) throw answer;
      return answer;
    }) as unknown as typeof fetch;
    return { calls, transport: httpTransport(request) };
  }
  const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

  it("sends a team write as one request, the command, with no actor in the body", async () => {
    const member = {
      datasetId: DATASET_ID,
      person: { name: "Tess Tester", email: "tess.tester@example.gov" },
      role: "tester",
      addedBy: OWNER.principalId,
      addedAt: "2026-10-01T12:00:00.000Z",
      ref: { id: "6a1c0f4e-1d2b-4c3a-9e8f-7a6b5c4d3e2f", version: 1 },
    };
    const { calls, transport } = recording([ok({ result: { member, entries: [] } })]);
    const store = createDeltaStore({ transport, accessStores: { currentUser: async () => OWNER } });

    const added = await store.datasetRoles.addMember({
      datasetId: DATASET_ID,
      name: " Tess Tester ",
      email: " Tess.Tester@example.gov ",
      role: "tester",
    });

    // No ownership read first: the server checks ownership inside the command.
    expect(calls.map((c) => c.url)).toEqual(["/api/commands/teams/add-member"]);
    const body = calls[0]!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["expectedVersion", "idempotencyKey", "payload"]);
    expect(body["payload"]).toEqual({
      datasetId: DATASET_ID,
      name: "Tess Tester",
      email: "tess.tester@example.gov",
      role: "tester",
    });
    // What the screen gets has no row ID or version in it.
    expect(added.member).not.toHaveProperty("ref");
    expect(added.created).toBe(true);
  });

  it("resends the same idempotency key when a command gets no answer", async () => {
    const entry = {
      id: "CL-0001",
      kind: "add-member",
      ref: { id: "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f", version: 1 },
    };
    const { calls, transport } = recording([
      ok([entry]),
      () => new TypeError("fetch failed"),
      ok({ result: { ...entry, applied: { by: STAFF.principalId, at: "x" } } }),
      ok({ result: { ...entry, applied: { by: STAFF.principalId, at: "again" } } }),
    ]);
    const store = createDeltaStore({ transport, accessStores: { currentUser: async () => STAFF } });

    await store.changeList.markApplied("CL-0001");
    await store.changeList.markApplied("CL-0001");

    const [first, second, nextIntent] = calls
      .slice(1)
      .map((c) => c.body as Record<string, unknown>);
    expect(calls.slice(1).map((c) => c.url)).toEqual([
      "/api/commands/change-list/mark-applied",
      "/api/commands/change-list/mark-applied",
      "/api/commands/change-list/mark-applied",
    ]);
    expect(second!["idempotencyKey"]).toBe(first!["idempotencyKey"]);
    expect(nextIntent!["idempotencyKey"]).not.toBe(first!["idempotencyKey"]);
    // The version the list read, for the entry's own row ID.
    expect(first).toMatchObject({
      expectedVersion: 1,
      payload: { entryId: "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f" },
    });
  });

  it("raises the server's refusals as the store's own", async () => {
    const { transport } = recording([
      () =>
        new Response(
          JSON.stringify({ error: { code: "not-owner", message: "Only an owner can." } }),
          { status: 403 },
        ),
    ]);
    const store = createDeltaStore({
      transport,
      accessStores: { currentUser: async () => STRANGER },
    });

    await expect(
      store.datasetRoles.addMember({
        datasetId: DATASET_ID,
        name: "X",
        email: "x@example.gov",
        role: "tester",
      }),
    ).rejects.toMatchObject({ name: "ActionRefusedError", code: "not-owner" });
  });

  it("binds an owner's email on their first action, then resends the same key once", async () => {
    const owners = [
      { displayName: "Nora Owner", email: "nora.owner@example.gov", ref: { id: "o", version: 1 } },
    ];
    const dataset = { id: DATASET_ID, owners };
    const { calls, transport } = recording([
      () =>
        new Response(
          JSON.stringify({ error: { code: "claim-required", message: "Bind first." } }),
          { status: 409 },
        ),
      ok({ result: {} }),
      ok({ result: { dataset, entries: [] } }),
    ]);
    const store = createDeltaStore({ transport, accessStores: { currentUser: async () => OWNER } });

    await store.datasetTeam.addOwner({
      datasetId: DATASET_ID,
      name: "Drew Partner",
      email: "drew.partner@example.gov",
      idempotencyKey: "one-intent",
    });

    expect(calls.map((c) => c.url)).toEqual([
      "/api/commands/teams/add-owner",
      "/api/commands/teams/bind-email",
      "/api/commands/teams/add-owner",
    ]);
    const keys = calls.map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(keys[0]).toBe("one-intent");
    expect(keys[2]).toBe("one-intent");
  });

  it("maps a reused idempotency key refusal to a plain recovery message", async () => {
    const { transport } = recording([
      () =>
        new Response(
          JSON.stringify({
            error: {
              code: "idempotency-key-reused",
              message: "idempotency-key-reused: payload hash mismatch",
            },
          }),
          { status: 409 },
        ),
    ]);
    const store = createDeltaStore({ transport, accessStores: { currentUser: async () => OWNER } });

    await expect(
      store.datasetRoles.addMember({
        datasetId: DATASET_ID,
        name: "Tess Tester",
        email: "tess.tester@example.gov",
        role: "tester",
        idempotencyKey: "fixed-key",
      }),
    ).rejects.toMatchObject({
      name: "ActionRefusedError",
      message: "This change was already submitted. Refresh to see the latest.",
    });
  });
});

describe("Delta adapter: read watermarks", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  const token = (issuedAt: number) =>
    `wm1.${(issuedAt + 30_000).toString(36)}.${issuedAt.toString(36)}.${"a".repeat(64)}`;

  it("stores command watermarks by principal and sends them on later reads", async () => {
    const request = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/commands/teams/add-member")) {
        return new Response(
          JSON.stringify({
            result: { ok: true },
            watermarkPrincipal: "7001",
            watermarks: { teams: token(Date.now()) },
          }),
        );
      }
      return new Response(JSON.stringify([]));
    });
    const transport = httpTransport(request as unknown as typeof fetch);

    await transport.command("teams", "add-member", {
      idempotencyKey: "0b9f6f6e-4b1a-4c55-9b0e-1f2d3c4b5a69",
      expectedVersion: 1,
      payload: {},
    });
    await transport.read("teams", "ownership", { datasetId: "ds1" });

    const readInit = request.mock.calls[1]![1] as RequestInit;
    expect(readInit.headers).toMatchObject({ "x-edp-seen": expect.stringMatching(/^teams=wm1/) });
    expect(JSON.parse(sessionStorage.getItem("edp.delta.seenWatermarks") ?? "{}")).toEqual({
      activePrincipal: "7001",
      byPrincipal: {
        "7001": { teams: expect.stringMatching(/^wm1/) },
      },
    });
  });

  it("keeps watermarks isolated by principal and does not let older tokens replace newer ones", async () => {
    const first = token(Date.now());
    const older = token(Date.now() - 1_000);
    const secondPrincipal = token(Date.now() + 1);
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            watermarkPrincipal: "7001",
            watermarks: { teams: first },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            watermarkPrincipal: "7001",
            watermarks: { teams: older },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            watermarkPrincipal: "8002",
            watermarks: { teams: secondPrincipal },
          }),
        ),
      )
      .mockResolvedValue(new Response(JSON.stringify([])));
    const transport = httpTransport(request as unknown as typeof fetch);

    await transport.command("teams", "add-member", {
      idempotencyKey: "0b9f6f6e-4b1a-4c55-9b0e-1f2d3c4b5a69",
      expectedVersion: 1,
      payload: {},
    });
    await transport.command("teams", "add-member", {
      idempotencyKey: "1b9f6f6e-4b1a-4c55-9b0e-1f2d3c4b5a69",
      expectedVersion: 1,
      payload: {},
    });
    await transport.command("teams", "add-member", {
      idempotencyKey: "2b9f6f6e-4b1a-4c55-9b0e-1f2d3c4b5a69",
      expectedVersion: 1,
      payload: {},
    });
    await transport.read("teams", "ownership", { datasetId: "ds1" });

    const readInit = request.mock.calls[3]![1] as RequestInit;
    expect(readInit.headers).toMatchObject({
      "x-edp-seen": `teams=${encodeURIComponent(secondPrincipal)}`,
    });
    expect(JSON.parse(sessionStorage.getItem("edp.delta.seenWatermarks") ?? "{}")).toEqual({
      activePrincipal: "8002",
      byPrincipal: {
        "7001": { teams: first },
        "8002": { teams: secondPrincipal },
      },
    });
  });

  it("drops expired stored watermarks before sending the read header", async () => {
    const expired = token(Date.now() - 60_000);
    sessionStorage.setItem(
      "edp.delta.seenWatermarks",
      JSON.stringify({ activePrincipal: "7001", byPrincipal: { "7001": { teams: expired } } }),
    );
    const request = vi.fn(async () => new Response(JSON.stringify([])));
    const transport = httpTransport(request as unknown as typeof fetch);

    await transport.read("teams", "ownership", { datasetId: "ds1" });

    const calls = request.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>;
    const readInit = calls[0]![1]!;
    expect(readInit.headers).not.toHaveProperty("x-edp-seen");
  });
});

describe("Delta adapter: staff-only reads and unknown outcomes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("shows someone outside EDP staff an empty pipeline when the server refuses them", async () => {
    const store = createDeltaStore({
      transport: httpTransport(
        respond(403, { error: { code: "forbidden", message: "Only EDP staff can do this." } }),
      ),
    });
    expect(await store.requests.listPipeline()).toEqual([]);
  });

  it("reuses the shell session for staff-only reads without an extra session request", async () => {
    const currentUser = vi.fn(async () => ({ ...makeSnapshot().user, isAdmin: true }));
    const request = vi.fn(async (_url: RequestInfo | URL) => new Response("[]", { status: 200 }));
    const store = createDeltaStore({
      transport: httpTransport(request as unknown as typeof fetch),
      accessStores: { currentUser },
    });
    await store.catalog.listTenants();
    await store.requests.listPipeline();
    expect(await store.catalog.getUser()).toMatchObject({ isAdmin: true });
    expect(currentUser).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/reads/catalog/bootstrap",
      "/api/reads/requests/pipeline",
    ]);
  });

  it("asks /api/session once on a staff first load of the legacy shell (#168)", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      const path = String(url);
      urls.push(path);
      const snapshot = makeSnapshot();
      const body =
        path === "/api/session"
          ? { ...snapshot.user, isAdmin: true }
          : path === "/api/reads/catalog/bootstrap"
            ? {
                domains: snapshot.domains,
                datasets: snapshot.datasets,
                bundles: snapshot.bundles,
                systems: snapshot.systems,
                personas: snapshot.onboardingPersonas,
                tenants: snapshot.tenants,
              }
            : path === "/api/reads/requests/statuses"
              ? { requests: [], statuses: {} }
              : path === "/api/reads/access/my-access"
                ? snapshot.myAccess
                : [];
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const store = createDeltaStore();
    // The seven queries useLegacyAppData() starts together, with no requests yet.
    await Promise.all([
      store.catalog.listDomains(),
      store.catalog.listDatasets(),
      store.catalog.listBundles(),
      store.catalog.listSystems(),
      store.catalog.listPersonas(),
      store.catalog.listTenants(),
      store.requests.listRequests(),
      store.requests.listRequests(),
      store.status.listStages(),
      store.status.getMyAccess(),
      store.requests.listPipeline(),
      store.catalog.getUser(),
    ]);
    expect(urls.filter((url) => url === "/api/session")).toHaveLength(1);
    expect(urls.filter((url) => url === "/api/reads/catalog/bootstrap")).toHaveLength(1);
    expect(urls.filter((url) => url === "/api/reads/requests/statuses")).toHaveLength(1);
    expect(urls.filter((url) => url === "/api/reads/access/my-access")).toHaveLength(1);
    expect(urls.filter((url) => url === "/api/reads/requests/pipeline")).toHaveLength(1);
  });

  it("shows an empty pipeline and tenant list when the app doesn't serve the staff surface", async () => {
    const store = createDeltaStore({
      transport: httpTransport(
        respond(404, { error: { code: "not-found", message: "No such endpoint." } }),
      ),
    });
    expect(await store.requests.listPipeline()).toEqual([]);
    expect(await store.catalog.listTenants()).toEqual([]);
  });

  it("shows an empty tenant list when the server refuses the tenant financials", async () => {
    const store = createDeltaStore({
      transport: httpTransport(
        respond(403, { error: { code: "forbidden", message: "Only EDP staff can do this." } }),
      ),
    });
    expect(await store.catalog.listTenants()).toEqual([]);
  });

  it("still surfaces any other pipeline failure", async () => {
    const store = createDeltaStore({
      transport: httpTransport(respond(500, { error: { code: "internal", message: "boom" } })),
    });
    await expect(store.requests.listPipeline()).rejects.toMatchObject({ status: 500 });
  });

  it("passes the server's 'reload before retrying' message through when a write's outcome is unknown", async () => {
    const message = "We couldn't confirm this was saved. Reload to check before trying again.";
    const store = createDeltaStore({
      transport: httpTransport(respond(503, { error: { code: "outcome-unknown", message } })),
    });
    await expect(store.requests.createRequest(makeNewRequest())).rejects.toMatchObject({
      status: 503,
      code: "outcome-unknown",
      message,
    });
  });
});
