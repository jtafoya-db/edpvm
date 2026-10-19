/**
 * Checking an EIR definition before it's published (#201): the #200
 * definition service (`loadDefinition`) and its synthetic scenarios
 * (`runScenarios`), and nothing else. The Safeguards workspace shows what
 * this returns; it never validates YAML itself. Publishing runs it again on
 * the server, so a check the browser saw is never trusted.
 */
import { loadDefinition } from "./load.ts";
import { runScenarios, type EirScenarioResult } from "./scenarios.ts";
import type { EirDefinition, EirDefinitionDiagnostic } from "./types.ts";

export type EirDefinitionCheck =
  | {
      ok: false;
      publishable: false;
      diagnostics: EirDefinitionDiagnostic[];
    }
  | {
      ok: true;
      /** True only when every synthetic scenario produced its declared outcome. */
      publishable: boolean;
      definition: EirDefinition;
      scenarios: EirScenarioResult[];
      /** SHA-256 of the YAML as written: the content identity a publication records. */
      contentSha256: string;
    };

/** The longest YAML a definition may be, in UTF-8 bytes. The bootstrap is about 10 KB. */
export const MAX_EIR_DEFINITION_BYTES = 256 * 1024;

/** A definition's size as stored: UTF-8 bytes, not UTF-16 code units. */
export const eirDefinitionBytes = (sourceYaml: string): number =>
  new TextEncoder().encode(sourceYaml).length;

export async function sha256OfText(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Validate a definition's YAML and, when it loads, run every scenario it declares. */
export async function checkEirDefinition(sourceYaml: string): Promise<EirDefinitionCheck> {
  const loaded = loadDefinition(sourceYaml);
  if (!loaded.ok) return { ok: false, publishable: false, diagnostics: loaded.diagnostics };
  const scenarios = runScenarios(loaded.definition);
  return {
    ok: true,
    publishable: scenarios.every((scenario) => scenario.ok),
    definition: loaded.definition,
    scenarios,
    contentSha256: await sha256OfText(sourceYaml),
  };
}
