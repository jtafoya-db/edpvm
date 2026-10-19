// @vitest-environment node
/**
 * Where #202's privacy guard sits relative to the EIR definitions (#201), with
 * the real guard and nobody's acknowledgment recorded:
 *
 * - every tenant `eir/*` command and read still refuses, active definition or not;
 * - `eir-definitions/forms` answers: it holds form definitions (labels, rules,
 *   versions), never anyone's EIR information, and the validator inbox reads it
 *   too. #202 gates EIR information, and "other non-EIR tenant functions are
 *   not accidentally gated";
 * - the staff definition endpoints answer Safeguards (staff aren't asked to
 *   acknowledge the employee notice), and stay staff-only.
 */
import { describe, expect, it } from "vitest";

import type { EirFormsAnswer } from "../../../data/eir/definition/repository";
import { ACTIVE_PRIVACY_NOTICE } from "../../../data/privacy/notice";
import {
  PRIVACY_ACKNOWLEDGMENT_REQUIRED,
  privacyAcknowledgmentGuard,
} from "../../privacy-enforcement";
import { handleDeltaApiRequest } from "../api";
import { registerEirDefinitionsArea } from "../areas/eir-definitions";
import { registerPrivacyArea } from "../areas/privacy";
import type { SessionUser } from "../registry";
import { EMPLOYEE, nextDefinitionYaml, SAFEGUARDS } from "./eir-definition-harness";
import { deltaImplementation } from "./eir-harness";

let key = 0;
const nextKey = () => `00000000-0000-4000-8000-${String(++key).padStart(12, "0")}`;
const command = (area: string, name: string, payload: unknown, expectedVersion = 0) =>
  new Request(`https://app/api/commands/${area}/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotencyKey: nextKey(), expectedVersion, payload }),
  });
const read = (area: string, name: string) => new Request(`https://app/api/reads/${area}/${name}`);

/** The EIR, definitions and privacy areas on one store, behind the real guard. */
function guarded() {
  const implementation = deltaImplementation();
  registerEirDefinitionsArea(implementation.deps.registry);
  registerPrivacyArea(implementation.deps.registry, ACTIVE_PRIVACY_NOTICE);
  implementation.deps.requirePrivacyAcknowledgment = privacyAcknowledgmentGuard({
    runner: implementation.deps.runner,
    names: implementation.deps.names,
    notice: ACTIVE_PRIVACY_NOTICE,
  });
  return implementation;
}

const refusedForPrivacy = async (response: Response) => {
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({
    error: { code: PRIVACY_ACKNOWLEDGMENT_REQUIRED },
  });
};

describe("the privacy guard and the EIR definitions (#201 with #202)", () => {
  it("still refuses every tenant EIR command and read after a definition is activated", async () => {
    const implementation = guarded();
    const as = (user: SessionUser, request: Request) => implementation.request(user, request);
    expect(
      (
        await as(
          SAFEGUARDS,
          command("eir-definitions", "publish", { sourceYaml: nextDefinitionYaml(2) }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await as(SAFEGUARDS, command("eir-definitions", "activate", { versionNumber: 1 }, 1)))
        .status,
    ).toBe(200);

    for (const name of ["mine", "generated-pdf"]) {
      await refusedForPrivacy(await as(EMPLOYEE, read("eir", name)));
    }
    for (const name of ["start", "save-draft", "evaluate", "submit", "respond"]) {
      await refusedForPrivacy(await as(EMPLOYEE, command("eir", name, {})));
    }
  });

  it("answers the employee's form definitions without an acknowledgment: no EIR information is in them", async () => {
    const implementation = guarded();
    const response = await implementation.request(EMPLOYEE, read("eir-definitions", "forms"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as EirFormsAnswer;
    expect(body.active.version).toBe("bootstrap-2");
    // The guard is live: the same person's EIR is refused.
    await refusedForPrivacy(await implementation.request(EMPLOYEE, read("eir", "mine")));
  });

  it("lets Safeguards author without acknowledging the employee notice, and keeps authoring staff-only", async () => {
    const implementation = guarded();
    expect(
      (await implementation.request(SAFEGUARDS, read("eir-definitions", "history"))).status,
    ).toBe(200);
    expect(
      (
        await implementation.request(
          SAFEGUARDS,
          command("eir-definitions", "publish", { sourceYaml: nextDefinitionYaml(3) }),
        )
      ).status,
    ).toBe(200);

    // The tenant app serves none of them, with or without the guard.
    const tenantOnly = (request: Request) =>
      handleDeltaApiRequest(request, {
        ...implementation.deps,
        serves: ["tenant"],
        resolveUser: async () => SAFEGUARDS,
      });
    expect((await tenantOnly(read("eir-definitions", "history"))).status).toBe(404);
    expect(
      (await tenantOnly(command("eir-definitions", "activate", { versionNumber: 1 }, 1))).status,
    ).toBe(404);
  });
});
