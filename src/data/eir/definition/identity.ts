/**
 * Which EIR definition a draft or submission was answered under (#224): its
 * **identity**, stored in `form_version` and carried as the form's `version`.
 * Authors never write one; the server assigns it.
 *
 * - **Published**: the number publish assigned, `1`, `2`, `3`… Publish counts
 *   from 1 and the database refuses anything lower, so no publish can take a
 *   reserved identity.
 * - **Built in**: a reserved name, never digits. The bootstrap definition
 *   (`bootstrap.eir.yaml`) is `bootstrap`, shown as "bootstrap (version 0)".
 *   The second, `bootstrap-2.eir.yaml` (#217), is `bootstrap-2`, shown as
 *   "bootstrap-2 (version 0)": version 0 means built in, never published,
 *   and the name tells them apart. No number to reserve, no schema change.
 * - **Legacy**: form versions stored before #224. `1.3` is the bootstrap
 *   definition's content under its old label; `1.2` and `0.1` are the forms
 *   in `config.ts`.
 * - **Unpublished**: a definition being checked before it's published.
 */

export const BOOTSTRAP_DEFINITION_ID = "bootstrap";

/**
 * The built-in definitions, oldest first, each shipped as `<id>.eir.yaml`
 * (#217): `bootstrap` (form 1.3's rules: compliance answers flagged for the
 * validator) and `bootstrap-2` (every rule blocks, with guidance).
 */
export const BUILT_IN_DEFINITION_IDS = [BOOTSTRAP_DEFINITION_ID, "bootstrap-2"] as const;
export type BuiltInDefinitionId = (typeof BUILT_IN_DEFINITION_IDS)[number];

/**
 * The built-in new drafts use while no published version is active: the
 * product owner's MVP decision (#148, #217) is that every rule blocks, so
 * it's `bootstrap-2`. Drafts already on `bootstrap` (or its old label 1.3)
 * keep `bootstrap`'s rules.
 */
export const FALLBACK_BUILT_IN_ID: BuiltInDefinitionId = "bootstrap-2";

/** The bootstrap definition's form version before #224: its stored answers keep this label. */
export const LEGACY_BOOTSTRAP_FORM_VERSION = "1.3";

/** A definition being validated and previewed: not published, so not numbered. */
export const UNPUBLISHED_DEFINITION_ID = "unpublished";

/** The identity of published version `versionNumber`. */
export const publishedDefinitionId = (versionNumber: number): string => String(versionNumber);

/** The published version an identity names, or undefined when it isn't a published one. */
export function publishedVersionNumber(id: string): number | undefined {
  return /^[1-9][0-9]{0,15}$/.test(id) ? Number(id) : undefined;
}

/** Whether an identity is a built-in definition's reserved name (`bootstrap`, `bootstrap-2`…). */
export const isBuiltInDefinitionId = (id: string): boolean =>
  /^bootstrap(-[2-9]|-[1-9][0-9]+)?$/.test(id);

/** What the validator view calls the form answers were given on: `EIR form 1.2`, `EIR definition version 7`. */
export const eirFormName = (id: string): string =>
  publishedVersionNumber(id) === undefined && /^\d+\.\d+$/.test(id)
    ? `EIR form ${id}`
    : `EIR definition ${definitionLabel(id)}`;

/** How the PDF and the screens name a definition: `version 7`, `bootstrap (version 0)`, `form 1.2`. */
export function definitionLabel(id: string): string {
  const published = publishedVersionNumber(id);
  if (published !== undefined) return `version ${published}`;
  if (isBuiltInDefinitionId(id)) return `${id} (version 0)`;
  if (id === UNPUBLISHED_DEFINITION_ID) return "not yet published";
  // A form version stored before #224 (1.3 is the bootstrap's): shown as it was.
  return `form ${id}`;
}
