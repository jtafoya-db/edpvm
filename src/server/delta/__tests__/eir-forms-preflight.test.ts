// @vitest-environment node
/**
 * #235 at the employee's forms seam (`EirFormSource.forms`, the tenant app's
 * `eir-definitions/forms` read): besides the forms, a published definition's
 * rules and timelines, by identity, so the browser can block at once.
 * Preflight only (the server still decides), checked, size-bounded, and
 * without anything only staff see: no YAML, scenarios or publisher. The
 * built-in definitions ship with the app, so they aren't sent.
 */
import { describe, expect, it } from "vitest";

import type { DeltaApiTransport } from "../../../data/adapters/delta";
import { createDeltaEirFormSource } from "../../../data/eir/definition/delta-repository";
import { loadDefinition } from "../../../data/eir/definition/load";
import {
  memoryEirFormSource,
  type EirDefinitionRepository,
  type EirFormSource,
} from "../../../data/eir/definition/repository";
import { formsOfDefinitions } from "../../../data/eir/repository";
import type { SessionUser } from "../registry";
import {
  deltaEirWithDefinitions,
  memoryEirWithDefinitions,
  nextDefinitionYaml,
  SAFEGUARDS,
  type EirWithDefinitions,
} from "./eir-definition-harness";
import { APPLICANT } from "./eir-harness";

function formSourceOf(store: EirWithDefinitions, user: SessionUser): EirFormSource {
  if (store.name === "memory") {
    const definitions = {
      active: () => current?.active(),
      byId: (id: string) => current?.byId(id),
    };
    let current: Awaited<ReturnType<EirWithDefinitions["resolve"]>> | undefined;
    return {
      async forms(versions) {
        current = await store.resolve({ ids: versions });
        return memoryEirFormSource(formsOfDefinitions(definitions), definitions).forms(versions);
      },
    };
  }
  const eir = (store as ReturnType<typeof deltaEirWithDefinitions>).eir;
  const transport: DeltaApiTransport = {
    read: async (area, name, query) => {
      const response = await eir.request(
        user,
        new Request(
          `https://app/api/reads/${area}/${name}${query && Object.keys(query).length ? `?${new URLSearchParams(query)}` : ""}`,
        ),
      );
      const body = await response.json();
      if (!response.ok) throw Object.assign(new Error(body.error?.message), body.error);
      return body;
    },
    command: () => Promise.reject(new Error("reads only")),
    legacyWrite: () => Promise.reject(new Error("reads only")),
  };
  return createDeltaEirFormSource({ transport });
}

async function publishAndActivate(definitions: EirDefinitionRepository, yaml: string) {
  const history = await definitions.history();
  const published = await definitions.publish({
    sourceYaml: yaml,
    expectedVersion: history.version,
  });
  await definitions.activate({
    versionNumber: published.versionNumber,
    expectedVersion: published.version,
  });
  return published.versionNumber;
}

const typed = (yaml: string) => {
  const loaded = loadDefinition(yaml, "unpublished");
  if (!loaded.ok) throw new Error("fixture must load");
  return loaded.definition;
};

describe.each([
  ["memory", memoryEirWithDefinitions],
  ["delta", deltaEirWithDefinitions],
] as const)(
  "the employee's forms carry published rules for the pre-check (#235): %s",
  (_n, make) => {
    it("the active published definition's rules and timelines, by its identity, and nothing staff-only", async () => {
      const store = make();
      const number = await publishAndActivate(store.definitions(SAFEGUARDS), nextDefinitionYaml(1));
      const answer = await formSourceOf(store, APPLICANT).forms([]);

      expect(answer.active.version).toBe(String(number));
      const sent = answer.rules?.[String(number)];
      expect(sent).toBeDefined();
      expect(Object.keys(sent!).sort()).toEqual(["id", "rules", "timelines"]);
      expect(sent!.id).toBe(String(number));
      const expected = typed(nextDefinitionYaml(1));
      expect(sent!.rules).toEqual(expected.rules);
      expect(sent!.timelines).toEqual(expected.timelines);
      expect(JSON.stringify(answer)).not.toMatch(
        /scenarios|sourceYaml|publishedBy|Sara Safeguards/,
      );
    });

    it("the rules of the definition a draft is pinned to, as well as the active one's", async () => {
      const store = make();
      const first = await publishAndActivate(store.definitions(SAFEGUARDS), nextDefinitionYaml(1));
      const second = await publishAndActivate(store.definitions(SAFEGUARDS), nextDefinitionYaml(2));
      const answer = await formSourceOf(store, APPLICANT).forms([String(first)]);
      expect(Object.keys(answer.rules ?? {}).sort()).toEqual([String(first), String(second)]);
    });

    it("no rules for the built-in definitions: the app already has them", async () => {
      const store = make();
      const answer = await formSourceOf(store, APPLICANT).forms(["bootstrap"]);
      expect(answer.active.version).toBe("bootstrap-2");
      expect(answer.rules ?? {}).toEqual({});
    });
  },
);

describe("the browser checks the rules it's sent (#235)", () => {
  it("drops an entry that doesn't check out, so the pre-check asks the server instead", async () => {
    const store = memoryEirWithDefinitions();
    await publishAndActivate(store.definitions(SAFEGUARDS), nextDefinitionYaml(1));
    const good = (await formSourceOf(store, APPLICANT).forms([])).rules!["1"]!;
    const served = {
      active: (await formSourceOf(store, APPLICANT).forms([])).active,
      forms: {},
      rules: {
        "1": good,
        "2": { ...good, id: "2", rules: [{ ...good.rules[0], operator: "newer-check" }] },
        "3": { ...good, id: "3", scenarios: [] },
        "4": { ...good, id: "5" },
        "6": { ...good, id: "6", rules: Array.from({ length: 101 }, () => good.rules[0]) },
      },
    };
    const source = createDeltaEirFormSource({
      transport: {
        read: async () => served as never,
        command: () => Promise.reject(new Error("reads only")),
        legacyWrite: () => Promise.reject(new Error("reads only")),
      },
    });
    const answer = await source.forms([]);
    expect(Object.keys(answer.rules ?? {})).toEqual(["1"]);
    expect(answer.rules!["1"]).toEqual(good);
  });
});
