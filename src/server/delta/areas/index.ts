/**
 * Every area's commands and reads. An area ticket adds one `register…Area`
 * line here, next to its own module in this folder.
 */
import { createRegistry, type Registry } from "../registry.ts";
import { registerAdminArea } from "./admin.ts";
import { registerEirArea } from "./eir.ts";
import { registerEirDefinitionsArea } from "./eir-definitions.ts";
import { registerOnboardingArea } from "./onboarding.ts";
import { registerPrivacyArea } from "./privacy.ts";
import { registerReferenceArea } from "./reference.ts";
import { registerRequestsArea } from "./requests.ts";
import { registerTeamsArea } from "./teams.ts";
import { registerMembershipArea, type MembershipAreaConfig } from "./membership.ts";
import { ACTIVE_PRIVACY_NOTICE, type PrivacyNotice } from "../../../data/privacy/notice";

export function createAppRegistry(
  notice: PrivacyNotice = ACTIVE_PRIVACY_NOTICE,
  membership?: MembershipAreaConfig,
): Registry {
  const registry = createRegistry();
  registerAdminArea(registry);
  registerEirArea(registry);
  registerEirDefinitionsArea(registry);
  registerOnboardingArea(registry);
  registerPrivacyArea(registry, notice);
  registerReferenceArea(registry);
  registerRequestsArea(registry);
  registerTeamsArea(registry);
  if (membership) registerMembershipArea(registry, membership);
  return registry;
}
