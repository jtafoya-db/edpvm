import { describe, expect, it } from "vitest";
import {
  attest,
  createChecklist,
  DEFAULT_LIVE_DATA_WAIVER_TEMPLATE,
  isComplete,
  remainingRequired,
  waiverRequired,
  type LiveDataWaiverChecklist,
} from "../waiver";

const attestedAt = "2026-09-29T12:00:00.000Z";

describe("live-data waiver checklist", () => {
  it("starts incomplete and returns a fresh copy of the template", () => {
    const checklist = createChecklist();

    expect(isComplete(checklist)).toBe(false);
    expect(checklist).not.toBe(DEFAULT_LIVE_DATA_WAIVER_TEMPLATE);
    expect(checklist.items[0]).not.toBe(DEFAULT_LIVE_DATA_WAIVER_TEMPLATE.items[0]);
  });

  it("is complete after all required items are attested", () => {
    const completed = createChecklist().items.reduce(
      (checklist, item) => attest(checklist, item.id, "Ari Approver", attestedAt),
      createChecklist(),
    );

    expect(isComplete(completed)).toBe(true);
  });

  it("remains incomplete when only an optional item is attested", () => {
    const template: LiveDataWaiverChecklist = {
      items: [
        { id: "required", label: "Required attestation", required: true, attested: false },
        { id: "optional", label: "Optional attestation", required: false, attested: false },
      ],
    };

    expect(isComplete(attest(createChecklist(template), "optional", "Ari", attestedAt))).toBe(
      false,
    );
  });

  it("removes an attested required item from the remaining items", () => {
    const checklist = createChecklist();
    const firstId = checklist.items[0]!.id;

    expect(remainingRequired(checklist)).toHaveLength(checklist.items.length);
    expect(remainingRequired(attest(checklist, firstId, "Ari", attestedAt))).toEqual(
      checklist.items.slice(1),
    );
  });

  it("records the attestor, timestamp, and note without mutating the original", () => {
    const original = createChecklist();
    const itemId = original.items[0]!.id;
    const updated = attest(original, itemId, "Ari Approver", attestedAt, "Confirmed on file");

    expect(updated.items[0]).toMatchObject({
      attested: true,
      attestedBy: "Ari Approver",
      attestedAt,
      note: "Confirmed on file",
    });
    expect(original.items[0]).toMatchObject({ attested: false });
    expect(original.items[0]).not.toHaveProperty("attestedBy");
    expect(updated).not.toBe(original);
  });

  it("requires the waiver only for live-data requests", () => {
    expect(waiverRequired(false)).toBe(false);
    expect(waiverRequired(true)).toBe(true);
  });
});
