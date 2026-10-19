// @vitest-environment node
/**
 * Fail closed (#200): with the bootstrap EIR definition unreadable, both
 * repositories refuse every employee write and store nothing.
 */
import { describe, expect, it, vi } from "vitest";

import {
  APPLICANT,
  deltaImplementation,
  memoryImplementation,
  pdf,
  VALUES,
} from "./eir-harness.ts";

vi.mock("../../../data/eir/definition/bootstrap-source.ts", () => ({
  readBootstrapEirSource: () => undefined,
}));

describe.each([
  ["memory", memoryImplementation],
  ["delta", deltaImplementation],
] as const)("EIR with no bootstrap definition: %s", (_name, make) => {
  it("refuses a draft save, a start and a submission, and stores nothing", async () => {
    const impl = make();
    const as = impl.as(APPLICANT);
    const unavailable = {
      message: expect.stringMatching(
        /^The EIR form is temporarily unavailable\. Nothing has been saved\.$/,
      ),
    };
    await expect(as.saveDraft(APPLICANT.principalId, VALUES)).rejects.toMatchObject(unavailable);
    await expect(as.start(APPLICANT.principalId, APPLICANT.displayName)).rejects.toMatchObject(
      unavailable,
    );
    await expect(
      as.submitWithFile({
        principalId: APPLICANT.principalId,
        personName: APPLICANT.displayName,
        file: pdf(),
        values: VALUES,
      }),
    ).rejects.toMatchObject(unavailable);
    expect(await as.get(APPLICANT.principalId)).toMatchObject({
      stage: "not-started",
      submissions: [],
      actions: [],
    });
    expect((await as.get(APPLICANT.principalId)).draftValues).toBeUndefined();
  });
});
