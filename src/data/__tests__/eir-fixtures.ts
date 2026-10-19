/**
 * Synthetic EIR answers for tests. Never a real person's name, email, user ID
 * or manager: obvious test values only.
 */
import type { EirFormValues } from "../eir/types.ts";

/** A complete EIR form 1.3 with nothing to flag as of 2026-10-01. */
export const EIR_VALUES: EirFormValues = {
  userId: "A1B2C",
  workEmail: "test.person@example.gov",
  firstName: "Test",
  lastName: "Person",
  team: "Test Team",
  subTeam: "",
  contractingCompany: "Example Contracting LLC",
  managerId: "M9N8P",
  managerEmail: "test.manager@example.gov",
  managerFirstName: "Test",
  managerLastName: "Manager",
  unauthorizedAccessTrainingDate: "2026-06-01",
  privacyTrainingDate: "2026-06-02",
  cyberAwarenessTrainingDate: "2026-06-03",
  irmAcknowledged: "yes",
  mbiInitialDate: "2025-01-15",
  mbiPreliminary: "no",
  mbiExpirationDate: "2030-01-15",
  ndaSigned: "yes",
  declarationAgreed: "yes",
};

/** #98's interim checklist answers (form 0.1), as its volume records stored them. */
export const EIR_STUB_VALUES: EirFormValues = {
  fullName: "Test Person",
  organization: "Example Org",
  jobTitle: "Analyst",
  businessNeed: "Synthetic test record",
};
