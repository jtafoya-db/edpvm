// Renderer for the `dataset-list` field type (#86): one or more datasets, each
// with a name, a domain (or "Other"), a dataset tag and one or more dataset
// owner contacts. The value is an IntakeDatasetInput[]; validation lives in the
// schema (validateDatasets) — this component edits the list and, once a field
// has been touched or the person has tried to continue, shows that field's
// error in the design system's field-error style (error border + icon +
// specific text), connected to the input with aria-describedby.

import React from "react";
import {
  DATASET_TAG_HINT,
  OTHER_DOMAIN,
  blankDataset,
  datasetIssues,
  datasetTagError,
  type IntakeDatasetInput,
  type IntakeOwnerContact,
  type PatternOption,
} from "../../schema";
import type { DynamicOption, IconComponent } from "./SchemaForm";
import { FieldError, datasetInputId } from "./field-helpers";
import { OwnerPicker, type OwnerKind, type SignedInPerson } from "./InitiativeOwnerField";
import { FieldHelp } from "./FieldHelp";

const lbl: React.CSSProperties = {
  display: "block",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  marginBottom: 7,
};

const labelRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  marginBottom: 7,
  minWidth: 0,
};

const req = (
  <span aria-hidden="true" style={{ color: "var(--theme-secondary)" }}>
    *
  </span>
);

function inp(invalid: boolean): React.CSSProperties {
  return {
    width: "100%",
    border: `1.5px solid ${invalid ? "var(--theme-error)" : "var(--border-strong)"}`,
    borderRadius: "var(--radius-md)",
    padding: "11px 13px",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--font-size-2xs)",
    background: "var(--surface-default)",
    boxSizing: "border-box",
  };
}

const linkBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--link-default)",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-2xs)",
  fontWeight: 700,
  cursor: "pointer",
};

const dangerBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  background: "var(--surface-default)",
  border: "1px solid var(--color-red-cool-30v)",
  borderRadius: "var(--radius-md)",
  padding: "8px 14px",
  fontSize: "var(--font-size-3xs)",
  fontWeight: 700,
  fontFamily: "var(--font-sans)",
  color: "var(--theme-error-dark)",
  cursor: "pointer",
};

const grid3: React.CSSProperties = {
  display: "grid",
  gap: 16,
};

const blank = (v: string | undefined) => !v || v.trim().length === 0;

const tagHint: React.CSSProperties = {
  fontSize: "var(--font-size-3xs)",
  color: "var(--text-muted)",
  marginTop: 5,
  lineHeight: 1.45,
  // The example tag is one long word; on a phone the column is narrower than it.
  overflowWrap: "anywhere",
};

/**
 * A stable React key for each dataset row and owner row, which travels with
 * the row itself: its stored record ID, or one made for that row object and
 * carried to the new object whenever this field edits the row. Never its
 * position: an owner's picker keeps what was typed for Someone else, so a
 * positional key would hand one row's hidden details to whichever row takes
 * its place. A reordered row keeps its key; a fresh copy gets a fresh one.
 * The keys live here, never in the form's values, so the server never sees
 * them.
 */
const rowKeys = new WeakMap<object, string>();
let lastRowKey = 0;

function rowKey(row: IntakeDatasetInput | IntakeOwnerContact): string {
  if (row.id) return row.id;
  let key = rowKeys.get(row);
  if (!key) rowKeys.set(row, (key = `row-${++lastRowKey}`));
  return key;
}

/** `next`, an edit of `row`, as the same row: it keeps `row`'s key. */
function sameRow<T extends IntakeDatasetInput | IntakeOwnerContact>(row: T, next: T): T {
  if (!next.id) rowKeys.set(next, rowKey(row));
  return next;
}

/** An owner row's choice: Myself, Someone else, or (a new, untouched row) nothing yet. */
function ownerKind(owner: IntakeOwnerContact): OwnerKind | undefined {
  if (owner.self === true) return "self";
  if (owner.self === false) return "someone-else";
  // A stored contact, or one typed before a choice: Someone else.
  return blank(owner.name) && blank(owner.email) ? undefined : "someone-else";
}

/** What's wrong with dataset `i`'s tag (the shared rule, then uniqueness in this request), or null. */
function tagIssue(datasets: IntakeDatasetInput[], i: number): string | null {
  const tag = datasets[i]?.datasetTag?.trim() ?? "";
  if (!tag) return "Enter a dataset tag.";
  const error = datasetTagError(tag);
  if (error) return error;
  const first = datasets.findIndex((d) => d.datasetTag?.trim() === tag);
  return first < i ? `Dataset ${first + 1} already uses this tag. Use a different tag.` : null;
}

export function DatasetListField({
  label,
  help,
  value,
  domains,
  ingestPatterns = [],
  onChange,
  Icon,
  showAll = false,
  idPrefix,
  signedIn,
}: {
  label: string;
  help?: string | undefined;
  value: unknown;
  domains: DynamicOption[];
  ingestPatterns?: PatternOption[];
  onChange: (next: IntakeDatasetInput[]) => void;
  Icon: IconComponent;
  /** Show every field's error, not only touched ones (after a failed attempt to continue). */
  showAll?: boolean | undefined;
  /** Optional DOM id prefix for pages that render more than one dataset list at once. */
  idPrefix?: string | undefined;
  /** The signed-in person, shown for an owner picked as Myself (#103); the server fills the rest. */
  signedIn?: SignedInPerson | undefined;
}) {
  const datasets = Array.isArray(value) ? (value as IntakeDatasetInput[]) : [];
  const domainOptions = [
    ...domains,
    { value: OTHER_DOMAIN, label: "No domain fits — propose another with EDP staff" },
  ];
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(new Set());
  const touch = (key: string) => setTouched((cur) => new Set(cur).add(key));
  const shown = (key: string, invalid: boolean) => invalid && (showAll || touched.has(key));
  const idFor = (key: string) =>
    idPrefix ? `${idPrefix}-${datasetInputId(key)}` : datasetInputId(key);
  /** aria-invalid / aria-describedby for an input, given whether its error shows. */
  const errorProps = (key: string, bad: boolean) => ({
    "aria-invalid": bad || undefined,
    "aria-describedby": bad ? `${idFor(key)}-error` : undefined,
    "aria-required": true,
  });

  // The schema's own owner rules (datasetIssues), shown on the row without the "Dataset 1, owner 2:" prefix.
  const issues = datasetIssues(datasets);
  const ownerIssues = (i: number, j: number) =>
    issues.flatMap(({ key, message }) => {
      const prefix = `${i}:owner${j}:`;
      if (!key.startsWith(prefix)) return [];
      const text = message.replace(/^Dataset \d+, owner \d+: /, "");
      return [{ key: key.slice(prefix.length), message: text[0]!.toUpperCase() + text.slice(1) }];
    });

  const without = <T,>(list: readonly T[], at: number) => list.filter((_, x) => x !== at);
  // Every edit keeps the rows it doesn't touch, and carries the key of the one it rebuilds.
  const update = (i: number, patch: Partial<IntakeDatasetInput>) =>
    onChange(datasets.map((d, k) => (k === i ? sameRow(d, { ...d, ...patch }) : d)));
  const updateOwner = (i: number, j: number, patch: Partial<IntakeOwnerContact>) =>
    update(i, {
      owners: (datasets[i]?.owners ?? []).map((o, k) =>
        k === j ? sameRow(o, { ...o, ...patch }) : o,
      ),
    });
  const removeDataset = (i: number) => onChange(without(datasets, i));
  const addDataset = () => onChange([...datasets, blankDataset()]);
  const addOwner = (i: number) =>
    update(i, { owners: [...(datasets[i]?.owners ?? []), { name: "", email: "" }] });
  const removeOwner = (i: number, j: number) =>
    update(i, { owners: without(datasets[i]?.owners ?? [], j) });

  return (
    <fieldset style={{ border: "none", padding: 0, margin: 0, minWidth: 0 }}>
      <legend style={{ ...lbl, padding: 0 }}>
        {label} {req}
        <FieldHelp id="intake-datasets" label={label}>
          {help}
        </FieldHelp>
      </legend>

      <div style={{ display: "grid", gap: 16 }}>
        {datasets.map((dataset, i) => {
          const n = i + 1;
          const k = (field: string) => `${i}:${field}`;
          const nameBad = shown(k("name"), blank(dataset.name));
          const sourceSystemBad = shown(k("sourceSystem"), blank(dataset.sourceSystem));
          const domainBad = shown(k("domain"), blank(dataset.domain));
          const ingestionBad = shown(k("ingestionMethod"), blank(dataset.ingestionMethod));
          const tagProblem = tagIssue(datasets, i);
          const tagBad = shown(k("tag"), tagProblem !== null);
          const tagId = idFor(k("tag"));
          return (
            <section
              key={rowKey(dataset)}
              aria-label={`Dataset ${n}`}
              style={{
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-md)",
                padding: "18px 20px",
                background: "var(--color-gray-cool-1)",
                boxSizing: "border-box",
                minWidth: 0,
                width: "100%",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                <Icon name="database" size={18} color="var(--theme-primary)" />
                <strong style={{ fontSize: "var(--font-size-2xs)" }}>Dataset {n}</strong>
                {datasets.length > 1 ? (
                  <button
                    type="button"
                    style={{ ...dangerBtn, marginLeft: "auto" }}
                    onClick={() => removeDataset(i)}
                  >
                    <Icon name="close" size={14} color="var(--theme-error-dark)" /> Remove dataset{" "}
                    {n}
                  </button>
                ) : null}
              </div>

              <div className="intake-dataset-grid" style={grid3}>
                <div>
                  <div style={labelRow}>
                    <label style={{ ...lbl, margin: 0, minWidth: 0 }} htmlFor={idFor(k("name"))}>
                      Dataset name {req}
                    </label>
                    <FieldHelp id={datasetInputId(k("name"))} label="Dataset name">
                      The plain-language name people will see when they discover or request this
                      dataset in EDP.
                    </FieldHelp>
                  </div>
                  <input
                    id={idFor(k("name"))}
                    aria-label={`Dataset ${n} name`}
                    {...errorProps(k("name"), nameBad)}
                    value={dataset.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    onBlur={() => touch(k("name"))}
                    style={inp(nameBad)}
                  />
                  {nameBad ? (
                    <FieldError id={`${idFor(k("name"))}-error`} Icon={Icon}>
                      Enter a dataset name.
                    </FieldError>
                  ) : null}
                </div>
                <div>
                  <div style={labelRow}>
                    <label style={{ ...lbl, margin: 0, minWidth: 0 }} htmlFor={idFor(k("domain"))}>
                      Domain {req}
                    </label>
                    <FieldHelp id={datasetInputId(k("domain"))} label="Domain">
                      The business category for this dataset. It controls where the dataset appears
                      for future discovery and domain access. Choose No domain fits when EDP staff
                      should help categorize it.
                    </FieldHelp>
                  </div>
                  <select
                    id={idFor(k("domain"))}
                    aria-label={`Dataset ${n} domain`}
                    {...errorProps(k("domain"), domainBad)}
                    value={dataset.domain}
                    onChange={(e) => update(i, { domain: e.target.value })}
                    onBlur={() => touch(k("domain"))}
                    style={inp(domainBad)}
                  >
                    <option value="" disabled>
                      Choose a domain
                    </option>
                    {domainOptions.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {domainBad ? (
                    <FieldError id={`${idFor(k("domain"))}-error`} Icon={Icon}>
                      Choose a domain, or Other.
                    </FieldError>
                  ) : null}
                </div>
                <div>
                  <div style={labelRow}>
                    <label style={{ ...lbl, margin: 0, minWidth: 0 }} htmlFor={tagId}>
                      Dataset tag {req}
                    </label>
                    <FieldHelp id={datasetInputId(k("tag"))} label="Dataset tag">
                      A short, stable identifier EDP uses to group this dataset's tables and apply
                      dataset roles. Use lowercase letters, numbers and underscores.
                    </FieldHelp>
                  </div>
                  <input
                    id={tagId}
                    aria-label={`Dataset ${n} tag`}
                    {...errorProps(k("tag"), tagBad)}
                    aria-describedby={tagBad ? `${tagId}-hint ${tagId}-error` : `${tagId}-hint`}
                    value={dataset.datasetTag}
                    onChange={(e) => update(i, { datasetTag: e.target.value })}
                    onBlur={() => touch(k("tag"))}
                    placeholder="e.g. case_signals"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    style={inp(tagBad)}
                  />
                  <div id={`${tagId}-hint`} style={tagHint}>
                    {DATASET_TAG_HINT}
                  </div>
                  {tagBad ? (
                    <FieldError id={`${tagId}-error`} Icon={Icon}>
                      {tagProblem}
                    </FieldError>
                  ) : null}
                </div>
              </div>

              <div style={{ ...grid3, marginBottom: 16 }}>
                <div>
                  <div style={labelRow}>
                    <label
                      style={{ ...lbl, margin: 0, minWidth: 0 }}
                      htmlFor={idFor(k("sourceSystem"))}
                    >
                      Source system {req}
                    </label>
                    <FieldHelp id={datasetInputId(k("sourceSystem"))} label="Source system">
                      Name the system, agency, file collection, or location this dataset comes from.
                    </FieldHelp>
                  </div>
                  <input
                    id={idFor(k("sourceSystem"))}
                    aria-label={`Dataset ${n} source system`}
                    {...errorProps(k("sourceSystem"), sourceSystemBad)}
                    value={dataset.sourceSystem ?? ""}
                    onChange={(e) => update(i, { sourceSystem: e.target.value })}
                    onBlur={() => touch(k("sourceSystem"))}
                    placeholder="e.g. IMF / Individual Master File"
                    style={inp(sourceSystemBad)}
                  />
                  {sourceSystemBad ? (
                    <FieldError id={`${idFor(k("sourceSystem"))}-error`} Icon={Icon}>
                      Enter a source system.
                    </FieldError>
                  ) : null}
                </div>
                <div>
                  <div style={labelRow}>
                    <label
                      style={{ ...lbl, margin: 0, minWidth: 0 }}
                      htmlFor={idFor(k("ingestionMethod"))}
                    >
                      Ingestion method {req}
                    </label>
                    <FieldHelp id={datasetInputId(k("ingestionMethod"))} label="Ingestion method">
                      Choose how this specific dataset will reach EDP. Select consultation when the
                      approved methods do not fit or you are unsure.
                    </FieldHelp>
                  </div>
                  <select
                    id={idFor(k("ingestionMethod"))}
                    aria-label={`Dataset ${n} ingestion method`}
                    {...errorProps(k("ingestionMethod"), ingestionBad)}
                    value={dataset.ingestionMethod ?? ""}
                    onChange={(e) => update(i, { ingestionMethod: e.target.value })}
                    onBlur={() => touch(k("ingestionMethod"))}
                    style={inp(ingestionBad)}
                  >
                    <option value="" disabled>
                      Choose an ingestion method
                    </option>
                    {ingestPatterns.map((pattern) => (
                      <option key={pattern.id} value={pattern.id}>
                        {pattern.name}
                      </option>
                    ))}
                  </select>
                  {ingestionBad ? (
                    <FieldError id={`${idFor(k("ingestionMethod"))}-error`} Icon={Icon}>
                      Choose an ingestion method.
                    </FieldError>
                  ) : null}
                </div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <div style={labelRow}>
                  <label
                    style={{ ...lbl, margin: 0, minWidth: 0 }}
                    htmlFor={idFor(k("ingestionDetails"))}
                  >
                    Proposed ingestion approach
                  </label>
                  <FieldHelp
                    id={datasetInputId(k("ingestionDetails"))}
                    label="Proposed ingestion approach"
                  >
                    Describe what connects, how data moves, and how often so EDP can evaluate the
                    request before a consultation.
                  </FieldHelp>
                </div>
                <textarea
                  id={idFor(k("ingestionDetails"))}
                  aria-label={`Dataset ${n} proposed ingestion approach`}
                  value={dataset.ingestionDetails ?? ""}
                  onChange={(e) => update(i, { ingestionDetails: e.target.value })}
                  rows={3}
                  placeholder="e.g. Query a partner API each morning or stream events."
                  style={{ ...inp(false), resize: "vertical" }}
                />
              </div>

              <div style={{ marginTop: 18 }}>
                <div style={lbl}>
                  Dataset owners {req}
                  <FieldHelp id={`${datasetInputId(k("owners"))}`} label="Dataset owners">
                    The people accountable for approving dataset roles and certifying the dataset.
                    This is operational accountability, not legal ownership. Each owner receives the
                    Maintainer dataset role.
                  </FieldHelp>
                </div>
                <div
                  style={{
                    fontSize: "var(--font-size-3xs)",
                    color: "var(--text-muted)",
                    margin: "-2px 0 10px",
                    lineHeight: 1.5,
                  }}
                >
                  Choose Myself or Someone else for each owner, as for the initiative point of
                  contact. EDP links each owner to their account when the initiative is set up.
                </div>
                <div style={{ display: "grid", gap: 10 }}>
                  {dataset.owners.map((owner, j) => {
                    const m = j + 1;
                    const base = idFor(k(`owner${j}:kind`)).replace(/-kind$/, "");
                    return (
                      <div
                        key={rowKey(owner)}
                        style={{
                          border: "1px solid var(--border-default)",
                          borderRadius: "var(--radius-md)",
                          padding: "12px 14px",
                          background: "var(--surface-default)",
                          boxSizing: "border-box",
                          minWidth: 0,
                          width: "100%",
                        }}
                      >
                        <OwnerPicker
                          id={base}
                          legend={`Owner ${m}`}
                          groupLabel={`Dataset ${n} owner ${m}`}
                          value={{ kind: ownerKind(owner), name: owner.name, email: owner.email }}
                          onChange={(next) =>
                            updateOwner(i, j, {
                              self: next.kind === "self",
                              name: next.name,
                              email: next.email,
                            })
                          }
                          signedIn={signedIn}
                          issues={ownerIssues(i, j)}
                          showAll={showAll}
                          Icon={Icon}
                          action={
                            dataset.owners.length > 1 ? (
                              <button
                                type="button"
                                style={dangerBtn}
                                onClick={() => removeOwner(i, j)}
                              >
                                <Icon name="close" size={14} color="var(--theme-error-dark)" />{" "}
                                Remove owner {m}
                              </button>
                            ) : undefined
                          }
                        />
                      </div>
                    );
                  })}
                </div>
                <button
                  id={idFor(k("owners"))}
                  type="button"
                  style={{ ...linkBtn, marginTop: 12 }}
                  onClick={() => addOwner(i)}
                >
                  <Icon name="add" size={16} color="var(--link-default)" /> Add an owner to dataset{" "}
                  {n}
                </button>
              </div>
            </section>
          );
        })}
      </div>

      <button
        id={idFor("add")}
        type="button"
        style={{ ...linkBtn, marginTop: 14 }}
        onClick={addDataset}
      >
        <Icon name="add" size={16} color="var(--link-default)" /> Add another dataset
      </button>
    </fieldset>
  );
}
