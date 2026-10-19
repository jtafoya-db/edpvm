import { beforeAll, describe, expect, it } from "vitest";

import {
  TAG_VOCABULARY,
  getDatasetsByTag,
  getDomainsByTag,
  listDatasetTags,
  listDomainTags,
} from "../tags";
import { readAppDataSeed } from "../seed";

beforeAll(async () => {
  await import("../../legacy/appData.js");
});

const expectedDomainTags = [
  "Authentication",
  "Business Tax",
  "Case Management",
  "Collections",
  "Compliance",
  "Credentials",
  "Document Matching",
  "Electronic Filing",
  "Enforcement",
  "Entities",
  "Examination",
  "Filing",
  "Fraud Prevention",
  "Identity",
  "Individual Tax",
  "Information Reporting",
  "Oversight",
  "Submission Processing",
  "Tax Professionals",
  "Taxpayer Accounts",
  "Withholding",
];

const expectedDatasetTags = [
  "1099",
  "AI",
  "AI/BI",
  "AIMS",
  "Authentication",
  "BMF",
  "CE",
  "Collections",
  "Curated",
  "Daily",
  "Dashboard",
  "Enforcement",
  "Entity",
  "Exam",
  "FTI",
  "Genie",
  "Gold",
  "Identity",
  "IMF",
  "Internal",
  "IRP",
  "MeF",
  "Operational",
  "PII",
  "Preparer",
  "Quality",
  "Reference",
  "Refund",
  "Restricted",
];

describe("two-level discovery tags", () => {
  it("lists distinct domain tags", () => {
    expect(listDomainTags()).toEqual(expectedDomainTags);
  });

  it("lists distinct dataset tags", () => {
    expect(listDatasetTags()).toEqual(expectedDatasetTags);
  });

  it("finds domains by tag and returns an empty list for a miss", () => {
    expect(getDomainsByTag("Filing").map(({ id }) => id)).toEqual([
      "individual-filing",
      "business-filing",
      "modernized-efile",
    ]);
    expect(getDomainsByTag("Not a domain tag")).toEqual([]);
  });

  it("finds datasets by tag and returns an empty list for a miss", () => {
    expect(getDatasetsByTag("AIMS").map(({ id }) => id)).toEqual(["exam-case-outcomes"]);
    expect(getDatasetsByTag("Not a dataset tag")).toEqual([]);
  });

  it("keeps every seeded tag inside its controlled vocabulary", () => {
    const seed = readAppDataSeed();
    const seededDomainTags = new Set(seed.domains.flatMap((domain) => domain.tags ?? []));
    const seededDatasetTags = new Set(seed.datasets.flatMap((dataset) => dataset.tags));

    expect(seededDomainTags).toEqual(new Set(TAG_VOCABULARY.domain));
    expect(seededDatasetTags).toEqual(new Set(TAG_VOCABULARY.dataset));
  });
});
