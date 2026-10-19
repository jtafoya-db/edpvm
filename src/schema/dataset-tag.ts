/**
 * The dataset tag rule (#131 UAT). A dataset tag becomes a Unity Catalog tag
 * value and part of the dataset's group names (`edp-ds-{datasetTag}-{role}`),
 * so it must be identifier-safe: lowercase letters a-z, digits and
 * underscores; starting with a letter; no leading, trailing or doubled
 * underscore; 3 to 64 characters. One rule for the intake form, both
 * onboarding stores and the pilot configuration.
 */

export const DATASET_TAG_MIN = 3;
export const DATASET_TAG_MAX = 64;

/** Shown under the field. */
export const DATASET_TAG_HINT =
  "Lowercase letters, numbers and underscores, starting with a letter. Example: refund_anomaly_scores";

/** How a store refuses a request whose tags break the rule. */
export type DatasetTagRefusalCode = "invalid-dataset-tag" | "duplicate-dataset-tag";

/** Why `tag` breaks the rule, as a sentence, or null when it's a valid tag. Blank is not checked here. */
function ruleBroken(tag: string): string | null {
  if (/[^a-z0-9_]/.test(tag)) {
    return "A dataset tag can only use lowercase letters, numbers and underscores.";
  }
  if (!/^[a-z]/.test(tag)) return "A dataset tag must start with a letter.";
  if (/__|_$/.test(tag)) {
    return "A dataset tag can't end with an underscore or have two in a row.";
  }
  if (tag.length < DATASET_TAG_MIN || tag.length > DATASET_TAG_MAX) {
    return `A dataset tag must be ${DATASET_TAG_MIN} to ${DATASET_TAG_MAX} characters.`;
  }
  return null;
}

export function isValidDatasetTag(tag: string): boolean {
  return ruleBroken(tag) === null;
}

/**
 * The valid tag a near miss was probably meant to be: lowercased, with runs of
 * spaces, hyphens and other separators as one underscore. Null when that still
 * isn't valid (say it starts with a digit, or is too long): no guessing then.
 */
export function suggestDatasetTag(input: string): string | null {
  const fixed = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return fixed !== input && isValidDatasetTag(fixed) ? fixed : null;
}

/** What's wrong with `tag`, with a fix when one is close, or null when it's valid. Blank is not checked here. */
export function datasetTagError(tag: string): string | null {
  const broken = ruleBroken(tag);
  if (!broken) return null;
  const suggestion = suggestDatasetTag(tag);
  return suggestion ? `${broken} Use ${suggestion} instead.` : broken;
}

/**
 * The first tag problem in a request's datasets, for a store to refuse with:
 * a tag that breaks the rule, or one another dataset in the request already
 * uses. Blank tags are left to the intake's own required-field check.
 */
export function findDatasetTagProblem(
  datasets: ReadonlyArray<{ datasetTag?: unknown }>,
): { code: DatasetTagRefusalCode; message: string } | null {
  const seen = new Map<string, number>();
  for (const [i, dataset] of datasets.entries()) {
    const tag = typeof dataset.datasetTag === "string" ? dataset.datasetTag.trim() : "";
    if (!tag) continue;
    const error = datasetTagError(tag);
    if (error) return { code: "invalid-dataset-tag", message: `Dataset ${i + 1}: ${error}` };
    const first = seen.get(tag);
    if (first !== undefined) {
      return {
        code: "duplicate-dataset-tag",
        message: `Dataset ${i + 1}: dataset ${first + 1} already uses the tag ${tag}. Each dataset in a request needs its own tag.`,
      };
    }
    seen.set(tag, i);
  }
  return null;
}
