/**
 * The built-in EIR definitions (#224): the ones the app ships with, each
 * under a reserved identity no publish can take (`identity.ts`): `bootstrap`
 * (`bootstrap.eir.yaml`) and `bootstrap-2` (`bootstrap-2.eir.yaml`, #217).
 */
import { ACTIVE_EIR_DEFINITION, BUILT_IN_DEFINITIONS } from "./active.ts";
import { BOOTSTRAP_DEFINITION_ID, LEGACY_BOOTSTRAP_FORM_VERSION } from "./identity.ts";
import type { EirDefinition } from "./types.ts";

/**
 * The fallback built-in definition (`bootstrap-2`, #217): what new drafts use
 * while no published version is active. Undefined when it can't be loaded.
 */
export const bootstrapEirDefinition = (): EirDefinition | undefined =>
  ACTIVE_EIR_DEFINITION.ok ? ACTIVE_EIR_DEFINITION.definition : undefined;

/**
 * The built-in definition with that identity, else undefined: `bootstrap`,
 * `bootstrap-2`, and `1.3`, the bootstrap's form version before #224, so
 * answers stored under it keep their label and `bootstrap`'s rules.
 */
export const builtInById = (id: string): EirDefinition | undefined => {
  const builtIn = BUILT_IN_DEFINITIONS.get(id);
  if (builtIn) return builtIn;
  const bootstrap = BUILT_IN_DEFINITIONS.get(BOOTSTRAP_DEFINITION_ID);
  return bootstrap && id === LEGACY_BOOTSTRAP_FORM_VERSION ? withId(bootstrap, id) : undefined;
};

/** A definition under another identity: the one the server gave it. */
export const withId = (definition: EirDefinition, id: string): EirDefinition =>
  definition.form.version === id
    ? definition
    : Object.freeze({ ...definition, form: Object.freeze({ ...definition.form, version: id }) });
