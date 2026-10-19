/**
 * The built-in EIR definitions (`<id>.eir.yaml`), each loaded once under its
 * reserved identity (#224): `bootstrap` and `bootstrap-2` (#217). The
 * fallback one, `bootstrap-2`, is active until Safeguards activates a
 * published definition (#201). When it can't be read or is refused, there is
 * no current form: the employee screen says so and every EIR employee command
 * refuses (fail closed, never guessed rules). Another built-in that can't be
 * loaded only makes its own drafts unavailable.
 */
import { readBootstrapEirSource } from "./bootstrap-source.ts";
import {
  BUILT_IN_DEFINITION_IDS,
  FALLBACK_BUILT_IN_ID,
  type BuiltInDefinitionId,
} from "./identity.ts";
import { loadDefinition } from "./load.ts";
import type { EirDefinition, EirDefinitionResult } from "./types.ts";

function loadBuiltIn(id: BuiltInDefinitionId): EirDefinitionResult {
  const text = readBootstrapEirSource(id);
  if (text === undefined) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "unavailable",
          message: "The bootstrap EIR definition couldn't be read.",
          path: [],
        },
      ],
    };
  }
  const result = loadDefinition(text, id);
  if (!result.ok && typeof window === "undefined") {
    // Codes and line numbers only: a path segment or message can carry
    // anything the YAML says (keys included), so neither is logged.
    const where = result.diagnostics.map((d) => `${d.code}${d.line ? ` (line ${d.line})` : ""}`);
    console.error(`[eir] The bootstrap EIR definition ${id} was refused: ${where.join("; ")}`);
  }
  return result;
}

const LOADED = new Map(BUILT_IN_DEFINITION_IDS.map((id) => [id, loadBuiltIn(id)]));

/** The fallback built-in definition (`bootstrap-2`, #217): active while nothing published is. */
export const ACTIVE_EIR_DEFINITION: EirDefinitionResult = LOADED.get(FALLBACK_BUILT_IN_ID)!;

/** Every built-in definition that loaded, by identity, oldest first. */
export const BUILT_IN_DEFINITIONS: ReadonlyMap<string, EirDefinition> = new Map(
  [...LOADED].flatMap(([id, result]) => (result.ok ? [[id, result.definition] as const] : [])),
);
