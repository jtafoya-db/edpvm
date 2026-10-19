import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { ACTIVE_PRIVACY_NOTICE, canonicalPrivacyNoticeContent } from "./notice";

describe("active privacy notice", () => {
  it("identifies the fixed canonical heading, body and help with sha256", () => {
    const digest = createHash("sha256")
      .update(canonicalPrivacyNoticeContent(ACTIVE_PRIVACY_NOTICE))
      .digest("hex");

    expect(ACTIVE_PRIVACY_NOTICE.contentHash).toBe(`sha256:${digest}`);
  });
});
