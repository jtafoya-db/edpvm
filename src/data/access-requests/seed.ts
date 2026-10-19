/**
 * Sample open access requests for the default dataset seed. Sample data only.
 *
 * Requests live in one tab's memory (the `access-request-persistence` stub),
 * so a requester and an owner in different browsers never see each other's.
 * These give the first seeded dataset's owner (who a preview names with
 * `EDP_SEED_DATASET_OWNER_IDS`) something in their inbox to approve or
 * reject: one past its SLA target, one due soon. The requesters are sample
 * people at `example.gov`.
 */
import { addBusinessDays } from "../sla";
import type { SeededAccessRequest } from "./memory";

export function sampleAccessRequests(now: Date): SeededAccessRequest[] {
  const ago = (days: number) => addBusinessDays(now, -days).toISOString();
  return [
    {
      datasetId: "ds-refund-anomaly-scores",
      role: "tester",
      reason: "Validate the anomaly scores against last season's refund holds.",
      requester: {
        principalId: "seed-priya-natarajan",
        name: "Priya Natarajan (sample)",
        email: "priya.natarajan@example.gov",
      },
      requestedAt: ago(4),
    },
    {
      datasetId: "ds-refund-anomaly-scores",
      role: "developer",
      reason: "Build the nightly job that refreshes the scores.",
      requester: {
        principalId: "seed-tom-becker",
        name: "Tom Becker (sample)",
        email: "tom.becker@example.gov",
      },
      requestedAt: ago(2),
    },
  ];
}
