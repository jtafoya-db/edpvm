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
import { registerConfigurationArea } from "./configuration.ts";
import { ACTIVE_PRIVACY_NOTICE, type PrivacyNotice } from "../../../data/privacy/notice";
import type { LoadedAccessMatrix } from "../../access-matrix.ts";

export function createAppRegistry(
  notice: PrivacyNotice = ACTIVE_PRIVACY_NOTICE,
  membership?: MembershipAreaConfig,
  accessMatrix?: () => LoadedAccessMatrix,
): Registry {
  const registry = createRegistry();
  registerAdminArea(registry);
  registerEirArea(registry);
  registerEirDefinitionsArea(registry);
  registerOnboardingArea(registry);
  registerPrivacyArea(registry, notice);
  registerReferenceArea(registry);
  registerRequestsArea(registry);
  registerTeamsArea(registry, membership ? { membership } : {});
  if (membership) registerMembershipArea(registry, membership);
  if (accessMatrix) registerConfigurationArea(registry, accessMatrix);
  return registry;
}
