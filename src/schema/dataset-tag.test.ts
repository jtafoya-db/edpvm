/**
 * The dataset tag rule (#131 UAT): tags become UC tag values and group names
 * (`edp-ds-{datasetTag}-{role}`), so only identifier-safe ones pass.
 */
import { describe, expect, it } from "vitest";

import {
  datasetIssues,
  datasetTagError,
  findDatasetTagProblem,
  isValidDatasetTag,
  suggestDatasetTag,
} from "./index";
import { BAD_TAGS, GOOD_TAGS } from "./dataset-tag.fixtures";

describe("the dataset tag rule", () => {
  it.each(BAD_TAGS)("refuses a tag with %s", (_label, tag, message) => {
    expect(isValidDatasetTag(tag)).toBe(false);
    expect(datasetTagError(tag)).toMatch(message);
  });

  it.each(GOOD_TAGS)("accepts %s", (tag) => {
    expect(isValidDatasetTag(tag)).toBe(true);
    expect(datasetTagError(tag)).toBeNull();
  });

  it("suggests the fixed tag when the input is close", () => {
    expect(suggestDatasetTag("Refund Anomaly Scores")).toBe("refund_anomaly_scores");
    expect(suggestDatasetTag("refund-scores")).toBe("refund_scores");
    expect(suggestDatasetTag("  Case  Signals ")).toBe("case_signals");
    expect(datasetTagError("Refund Anomaly Scores")).toBe(
      "A dataset tag can only use lowercase letters, numbers and underscores. Use refund_anomaly_scores instead.",
    );
  });

  it("doesn't guess when the fix would still break the rule", () => {
    expect(suggestDatasetTag("2024 refunds")).toBeNull();
    expect(suggestDatasetTag("ab")).toBeNull();
    expect(suggestDatasetTag("refund_scores")).toBeNull(); // already valid
  });
});

describe("dataset tags in an intake", () => {
  const dataset = (datasetTag: string) => ({
    name: "Signals",
    domain: "individual-filing",
    datasetTag,
    owners: [{ name: "Olive Owner", email: "olive.owner@example.test" }],
  });

  it("reports a rule break against the dataset's tag", () => {
    expect(datasetIssues([dataset("Refund Anomaly Scores")])).toEqual([
      {
        key: "0:tag",
        message:
          "Dataset 1: A dataset tag can only use lowercase letters, numbers and underscores. Use refund_anomaly_scores instead.",
      },
    ]);
  });

  it("reports a tag another dataset in the request already uses", () => {
    expect(datasetIssues([dataset("case_signals"), dataset("case_signals")])).toEqual([
      {
        key: "1:tag",
        message: "Dataset 2: dataset 1 already uses the tag case_signals. Use a different tag.",
      },
    ]);
  });

  it("gives a store the refusal code for a bad or repeated tag", () => {
    expect(findDatasetTagProblem([dataset("refund-scores")])).toMatchObject({
      code: "invalid-dataset-tag",
    });
    expect(findDatasetTagProblem([dataset("abc"), dataset("abc")])).toMatchObject({
      code: "duplicate-dataset-tag",
    });
    expect(findDatasetTagProblem([dataset("abc"), dataset("def")])).toBeNull();
  });
});
