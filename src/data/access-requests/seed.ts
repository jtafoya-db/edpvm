/**
 * Sample open access requests for the default dataset seed. Sample data only.
 *
 * Requests live in one tab's memory (the `access-request-persistence` stub),
 * so a requester and an owner in different browsers never see each other's.
 * These give the first seeded dataset's owner (who a preview names with
 * `EDP_SEED_DATASET_OWNER_IDS`) something in their inbox to approve or
 * reject: one past its SLA target, one due soon. The requesters are sample
 * people at `example.gov`.
 *
 * On Delta, approving one adds a real member, so only a PR preview with
 * `EDP_SAMPLE_ACCESS_REQUESTS=true` gets them (src/server/sample-access-requests.ts,
 * #312). The memory backend always has them.
 */
import { addBusinessDays } from "../sla";
import type { SeededAccessRequest } from "./memory";

/**
 * The sample requesters. The server refuses to add them, or list a change for
 * them, unless its own sample mode is on (src/server/sample-access-requests.ts).
 */
export const SAMPLE_REQUESTERS = [
  {
    principalId: "seed-priya-natarajan",
    name: "Priya Natarajan (sample)",
    email: "priya.natarajan@example.gov",
  },
  {
    principalId: "seed-tom-becker",
    name: "Tom Becker (sample)",
    email: "tom.becker@example.gov",
  },
] as const;

/**
 * An email as compared with the samples' (#312), for matching only; nothing
 * stored changes. NFKC (so fullwidth or mathematical lookalike letters, `＋`
 * and `＠` become plain ones), trimmed, lower-cased, and without a `+tag` in
 * the local part, so an alias of a sample's address still matches.
 */
function sampleMatchKey(email: string): string {
  const plain = email.normalize("NFKC").trim().toLowerCase();
  const at = plain.lastIndexOf("@");
  if (at < 0) return plain;
  return `${plain.slice(0, at).replace(/\+.*$/, "")}${plain.slice(at)}`;
}

const SAMPLE_EMAIL_KEYS = new Set(SAMPLE_REQUESTERS.map((sample) => sampleMatchKey(sample.email)));

/**
 * Whether a person is one of the sample requesters: by principal ID, or by
 * email in any case, padding, `+tag` alias or NFKC lookalike.
 */
export function isSampleRequester(person: {
  email?: string | null;
  principalId?: string | null;
}): boolean {
  if (person.principalId && SAMPLE_REQUESTERS.some((s) => s.principalId === person.principalId)) {
    return true;
  }
  const email = person.email ?? "";
  return email.trim() !== "" && SAMPLE_EMAIL_KEYS.has(sampleMatchKey(email));
}

export function sampleAccessRequests(now: Date): SeededAccessRequest[] {
  const ago = (days: number) => addBusinessDays(now, -days).toISOString();
  const [priya, tom] = SAMPLE_REQUESTERS;
  return [
    {
      datasetId: "ds-refund-anomaly-scores",
      role: "tester",
      reason: "Validate the anomaly scores against last season's refund holds.",
      requester: { ...priya },
      requestedAt: ago(4),
    },
    {
      datasetId: "ds-refund-anomaly-scores",
      role: "developer",
      reason: "Build the nightly job that refreshes the scores.",
      requester: { ...tom },
      requestedAt: ago(2),
    },
  ];
}
