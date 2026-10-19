/**
 * Self-decisions in the EIR rules (`createMemoryEirRepository`), which the
 * server runs for every decision: refused unless the rules were built with
 * `selfDecisionTestMode: true`, marked only by the rules, and a typed note
 * can never carry the marker.
 */
import { describe, expect, it } from "vitest";

import { createMemoryEirRepository, type MemoryEirRepository } from "../eir/repository";
import { SELF_DECISION_TEST_MODE_NOTE } from "../eir/self-decision";
import type { EirDecision } from "../eir/types";
import { EIR_VALUES } from "./eir-fixtures";

const NOW = new Date("2026-10-07T12:00:00Z");
const PERSON = "person-1";
const VALIDATOR = "validator-1";

async function submitted(repo: MemoryEirRepository, who = PERSON) {
  await repo.submit(who, "Test Person", `/Volumes/edp/docs/eir/${who}/one.pdf`, EIR_VALUES);
}

/** A valid EIR with a renewal waiting on a validator. */
async function renewing(repo: MemoryEirRepository, who = PERSON) {
  await submitted(repo, who);
  await repo.decide(who, "valid", "validator-2");
  await repo.renew(who, who, `/Volumes/edp/docs/eir/${who}/two.pdf`);
}

describe("EIR rules: a validator's own EIR", () => {
  it.each(["valid", "questions", "rejected", "revoked"] as EirDecision[])(
    "refuses %s on their own EIR by default (403), changing nothing",
    async (decision) => {
      const repo = createMemoryEirRepository({ clock: () => NOW });
      await submitted(repo, VALIDATOR);
      if (decision === "revoked") await repo.decide(VALIDATOR, "valid", "validator-2");
      const before = await repo.get(VALIDATOR);
      await expect(
        repo.decide(VALIDATOR, decision, VALIDATOR, "A note", "Val Idator"),
      ).rejects.toMatchObject({
        status: 403,
        message: "Safeguards validators can't decide their own EIR.",
      });
      expect(await repo.get(VALIDATOR)).toEqual(before);
    },
  );

  it("refuses a decision on their own renewal by default", async () => {
    const repo = createMemoryEirRepository({ clock: () => NOW });
    await renewing(repo, VALIDATOR);
    await expect(repo.decide(VALIDATOR, "valid", VALIDATOR)).rejects.toMatchObject({ status: 403 });
  });

  it("allows every decision only when built with test mode, each marked by the rules", async () => {
    const repo = createMemoryEirRepository({ clock: () => NOW, selfDecisionTestMode: true });
    await submitted(repo, VALIDATOR);
    await repo.decide(VALIDATOR, "questions", VALIDATOR, "Clarify the team");
    await repo.submit(
      VALIDATOR,
      "Val Idator",
      "/Volumes/edp/docs/eir/validator-1/two.pdf",
      EIR_VALUES,
      "Done",
    );
    await repo.decide(VALIDATOR, "valid", VALIDATOR);
    await repo.renew(VALIDATOR, VALIDATOR, "/Volumes/edp/docs/eir/validator-1/three.pdf");
    await repo.decide(VALIDATOR, "revoked", VALIDATOR, "Testing revocation");
    const rejecting = createMemoryEirRepository({ clock: () => NOW, selfDecisionTestMode: true });
    await submitted(rejecting, VALIDATOR);
    await rejecting.decide(VALIDATOR, "rejected", VALIDATOR, "Testing rejection");

    const actions = [
      ...(await repo.get(VALIDATOR)).actions,
      ...(await rejecting.get(VALIDATOR)).actions,
    ].map((a) => [
      a.kind,
      a.actorScimId,
      a.note ?? a.response ?? null,
      a.selfDecisionTestMode ?? false,
    ]);
    expect(actions).toEqual([
      ["submitted", VALIDATOR, null, false],
      ["questions", VALIDATOR, "Clarify the team", true],
      ["submitted", VALIDATOR, "Done", false],
      ["valid", VALIDATOR, null, true],
      ["renewed", VALIDATOR, null, false],
      // The revocation closes the renewal: that follow-on is the system's, not marked.
      ["renewal-closed", "system", "Closed because the current EIR was revoked.", false],
      ["revoked", VALIDATOR, "Testing revocation", true],
      ["submitted", VALIDATOR, null, false],
      ["rejected", VALIDATOR, "Testing rejection", true],
    ]);
  });

  it("never marks another validator's decision, even in test mode", async () => {
    const repo = createMemoryEirRepository({ clock: () => NOW, selfDecisionTestMode: true });
    await submitted(repo);
    const decided = await repo.decide(PERSON, "questions", VALIDATOR, "Clarify");
    expect(decided.actions.at(-1)).toEqual(
      expect.not.objectContaining({ selfDecisionTestMode: true }),
    );
    expect(decided.actions.at(-1)?.note).toBe("Clarify");
  });

  it("still needs a note where a decision needs one: the marker doesn't count", async () => {
    const repo = createMemoryEirRepository({ clock: () => NOW, selfDecisionTestMode: true });
    await submitted(repo, VALIDATOR);
    await expect(repo.decide(VALIDATOR, "rejected", VALIDATOR)).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("EIR rules: a forged marker in a typed note", () => {
  const forged = [
    `${SELF_DECISION_TEST_MODE_NOTE} Looks fine`,
    `   ${SELF_DECISION_TEST_MODE_NOTE}`,
    `${SELF_DECISION_TEST_MODE_NOTE.toUpperCase()} shouting`,
    "[self-decision under PREVIEW test mode]",
    `\u200B\u2060${SELF_DECISION_TEST_MODE_NOTE}`,
    `\uFF3BSelf-decision under preview test mode\uFF3D`,
  ];
  const cases: [string, (repo: MemoryEirRepository) => Promise<void>, EirDecision][] = [
    ["send back", (repo) => submitted(repo), "questions"],
    ["reject", (repo) => submitted(repo), "rejected"],
    ["mark valid (an optional note)", (repo) => submitted(repo), "valid"],
    [
      "revoke",
      async (repo) => {
        await submitted(repo);
        await repo.decide(PERSON, "valid", "validator-2");
      },
      "revoked",
    ],
    ["send back a renewal", (repo) => renewing(repo), "questions"],
    ["reject a renewal", (repo) => renewing(repo), "rejected"],
    ["approve a renewal", (repo) => renewing(repo), "valid"],
    ["revoke with a renewal waiting", (repo) => renewing(repo), "revoked"],
  ];

  for (const testMode of [false, true]) {
    it.each(cases)(
      `refuses it on someone else's EIR (${testMode ? "test mode on" : "default"}): %s`,
      async (_label, setup, decision) => {
        for (const note of forged) {
          const repo = createMemoryEirRepository({
            clock: () => NOW,
            selfDecisionTestMode: testMode,
          });
          await setup(repo);
          const before = await repo.get(PERSON);
          await expect(repo.decide(PERSON, decision, VALIDATOR, note)).rejects.toMatchObject({
            status: 400,
            message: expect.stringContaining("only the app marks a self-decision"),
          });
          const after = await repo.get(PERSON);
          expect(after).toEqual(before);
          expect(after.actions.some((a) => a.selfDecisionTestMode)).toBe(false);
        }
      },
    );
  }

  it("refuses it on a real self-decision too: the rules add the one marker", async () => {
    const repo = createMemoryEirRepository({ clock: () => NOW, selfDecisionTestMode: true });
    await submitted(repo, VALIDATOR);
    await expect(
      repo.decide(VALIDATOR, "questions", VALIDATOR, `${SELF_DECISION_TEST_MODE_NOTE} twice`),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("allows the marker's words anywhere but the start of a note", async () => {
    const repo = createMemoryEirRepository({ clock: () => NOW });
    await submitted(repo);
    const note = `Not a ${SELF_DECISION_TEST_MODE_NOTE}`;
    const decided = await repo.decide(PERSON, "questions", VALIDATOR, note);
    expect(decided.actions.at(-1)).toMatchObject({ note });
    expect(decided.actions.at(-1)?.selfDecisionTestMode).toBeUndefined();
  });
});

describe("EIR rules: no response can look like the marker either (round 9)", () => {
  const forged = [
    `${SELF_DECISION_TEST_MODE_NOTE} answer`,
    ` \u200B${SELF_DECISION_TEST_MODE_NOTE.toLowerCase()}`,
    `\uFEFF\uFF3BSelf-decision under preview test mode\uFF3D`,
  ];

  it.each(forged)(
    "refuses it in a first submission, a resubmission, a renewal and a Send response: %j",
    async (text) => {
      const repo = createMemoryEirRepository({ clock: () => NOW });
      await expect(
        repo.submit(
          PERSON,
          "Test Person",
          "/Volumes/edp/docs/eir/person-1/one.pdf",
          EIR_VALUES,
          text,
        ),
      ).rejects.toMatchObject({ status: 400 });
      await submitted(repo);
      await repo.decide(PERSON, "questions", VALIDATOR, "Clarify");
      await expect(
        repo.submit(
          PERSON,
          "Test Person",
          "/Volumes/edp/docs/eir/person-1/two.pdf",
          EIR_VALUES,
          text,
        ),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        repo.respond({ principalId: PERSON, values: EIR_VALUES, response: text }),
      ).rejects.toMatchObject({ status: 400 });
      const valid = createMemoryEirRepository({ clock: () => NOW });
      await submitted(valid);
      await valid.decide(PERSON, "valid", VALIDATOR);
      await expect(
        valid.renew(PERSON, PERSON, "/Volumes/edp/docs/eir/person-1/two.pdf", text),
      ).rejects.toMatchObject({ status: 400 });
      expect((await repo.get(PERSON)).stage).toBe("questions");
    },
  );
});

describe("EIR rules: Send response (round 9)", () => {
  async function sentBack(repo: MemoryEirRepository) {
    await submitted(repo);
    await repo.decide(PERSON, "questions", VALIDATOR, "Clarify the team");
  }

  it("resubmits with the signed answers and PDF: no new submission, back with the validator", async () => {
    let now = NOW;
    const repo = createMemoryEirRepository({ clock: () => now });
    await sentBack(repo);
    await repo.saveDraft(PERSON, EIR_VALUES);
    now = new Date(NOW.getTime() + 2 * 86_400_000);
    const record = await repo.respond({
      principalId: PERSON,
      values: EIR_VALUES,
      response: " Confirmed ",
    });
    expect(record).toMatchObject({ stage: "submitted", response: "Confirmed" });
    expect(record.questions).toBeUndefined();
    expect(record.draftValues).toBeUndefined();
    expect(record.submissions).toHaveLength(1);
    expect(record.actions.at(-1)).toEqual({
      kind: "submitted",
      actorScimId: PERSON,
      at: now.toISOString(),
      response: "Confirmed",
    });
    const [item] = await repo.listValidatorInbox();
    expect(Date.parse(item!.sla.dueAt)).toBeGreaterThan(now.getTime());
  });

  it("refuses changed answers, a blank response, and nothing to respond to", async () => {
    const repo = createMemoryEirRepository({ clock: () => NOW });
    await sentBack(repo);
    await expect(
      repo.respond({
        principalId: PERSON,
        values: { ...EIR_VALUES, team: "Other" },
        response: "x",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "You changed your answers, so you need to sign a new PDF.",
    });
    await expect(
      repo.respond({ principalId: PERSON, values: EIR_VALUES, response: "  " }),
    ).rejects.toMatchObject({ status: 400 });
    const fresh = createMemoryEirRepository({ clock: () => NOW });
    await submitted(fresh);
    await expect(
      fresh.respond({ principalId: PERSON, values: EIR_VALUES, response: "x" }),
    ).rejects.toMatchObject({ status: 409 });
    expect((await repo.get(PERSON)).stage).toBe("questions");
  });
});
