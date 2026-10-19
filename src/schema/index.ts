// The intake-schema seam (docs/build-plan-p1.md §0, OQ-7).
//
// loadSchema() is the ONLY way consumers obtain the schema. Today it returns the
// checked-in repo config (src/schema/intake.config.json); later this single
// function can be swapped to read a runtime Delta/UC store without touching any
// consumer (renderer, admin editor, LLM challenger).

import rawConfig from "./intake.config.json" with { type: "json" };
import type { IntakeSchema } from "./types.ts";

const schema = rawConfig as IntakeSchema;

/** Obtain the intake schema. The seam that hides where the schema comes from. */
export function loadSchema(): IntakeSchema {
  return schema;
}

export * from "./types.ts";
export {
  assembleRequest,
  blankDataset,
  canAdvance,
  computeRoi,
  datasetIssues,
  estimateSizing,
  fmtUsd,
  getField,
  getPatternList,
  getStep,
  readNumber,
  readNumbers,
  resolveSelections,
  initiativeOwnerIssues,
  validateDatasets,
  validateStep,
} from "./helpers.ts";
export {
  DATASET_TAG_HINT,
  DATASET_TAG_MAX,
  DATASET_TAG_MIN,
  datasetTagError,
  findDatasetTagProblem,
  isValidDatasetTag,
  suggestDatasetTag,
  type DatasetTagRefusalCode,
} from "./dataset-tag.ts";
// The write side of the seam (admin editor, docs/build-plan-p1.md §2, OQ-7).
export {
  CONFIG_PATH,
  cloneSchema,
  serializeConfig,
  unifiedDiff,
  diffSchema,
  diffOnlySaveHandler,
} from "./store.ts";
export type { SchemaSaveHandler, SchemaSaveResult } from "./store.ts";
