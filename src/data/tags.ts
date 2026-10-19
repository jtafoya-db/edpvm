import { readAppDataSeed } from "./seed";
import type { BusinessDomain, DataAsset } from "./types";

/** Allowed discovery tags, kept in sync with the bundled catalog seed. */
export const TAG_VOCABULARY = {
  domain: [
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
  ],
  dataset: [
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
    "IRP",
    "Internal",
    "MeF",
    "Operational",
    "PII",
    "Preparer",
    "Quality",
    "Reference",
    "Refund",
    "Restricted",
  ],
} as const;

function distinctSorted(tags: readonly string[]): string[] {
  return [...new Set(tags)].sort((left, right) => left.localeCompare(right));
}

/** List domain-level tags currently present in the catalog seed. */
export function listDomainTags(): string[] {
  return distinctSorted(readAppDataSeed().domains.flatMap((domain) => domain.tags ?? []));
}

/** List dataset-level tags currently present in the catalog seed. */
export function listDatasetTags(): string[] {
  return distinctSorted(readAppDataSeed().datasets.flatMap((dataset) => dataset.tags));
}

/** Return domains carrying an exact, case-sensitive domain tag. */
export function getDomainsByTag(tag: string): BusinessDomain[] {
  return readAppDataSeed().domains.filter((domain) => domain.tags?.includes(tag));
}

/** Return datasets carrying an exact, case-sensitive dataset tag. */
export function getDatasetsByTag(tag: string): DataAsset[] {
  return readAppDataSeed().datasets.filter((dataset) => dataset.tags.includes(tag));
}
