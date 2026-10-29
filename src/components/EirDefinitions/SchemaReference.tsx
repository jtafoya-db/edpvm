// The EIR definition schema reference (#219): a panel beside the YAML editor
// in the EIR definitions workspace, for everyone who can see the workspace.
// Everything it says comes from `eirSchemaReference()`, which builds it from
// the checker's own schema and tables, so it can't drift from what Validate
// enforces. It's plain HTML (headings, lists, links), not part of the
// editor: searchable, and each entry has an anchor the editor's problems
// link to (`show`).
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";

import {
  eirReferenceCodeAnchor,
  eirSchemaReference,
  type EirOperatorExample,
  type EirReferenceConstraint,
} from "@/data/eir/definition/reference";
import { formatEirDay } from "@/data/eir/form";
import { help, inp, lbl, muted, notice } from "@/components/DatasetAccess/styles";

export interface SchemaReferenceHandle {
  /** Clear any search, then move focus to the entry with this anchor. */
  show(anchor: string): void;
}

const HEADING_ID = "eir-schema-reference";
const SEARCH_ID = "eir-schema-reference-search";

const panel: CSSProperties = {
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-md)",
  padding: 20,
  marginBottom: 22,
  background: "var(--surface-default, #fff)",
  fontFamily: "var(--font-sans)",
};
const scroller: CSSProperties = { maxHeight: "80vh", overflowY: "auto", marginTop: 14 };
const h2: CSSProperties = {
  margin: "0 0 6px",
  fontSize: "var(--font-size-sm)",
  fontWeight: 700,
};
const h3: CSSProperties = {
  margin: "22px 0 8px",
  fontSize: "var(--font-size-xs, 15px)",
  fontWeight: 700,
};
const h4: CSSProperties = { margin: "0 0 4px", fontSize: "var(--font-size-2xs)", fontWeight: 700 };
const article: CSSProperties = {
  borderTop: "1px solid var(--border-default)",
  padding: "10px 0",
  fontSize: "var(--font-size-2xs)",
};
const dl: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "max-content 1fr",
  gap: "4px 12px",
  margin: "6px 0 0",
};
const dt: CSSProperties = { fontWeight: 700 };
const dd: CSSProperties = { margin: 0 };
const list: CSSProperties = { margin: 0, paddingLeft: 18, listStyle: "disc" };
const code: CSSProperties = { fontFamily: "var(--font-mono, monospace)" };
/** A link that looks like one (the page's reset strips the browser's): colour and underline. */
const referenceLink: CSSProperties = {
  color: "var(--link-default, #005ea2)",
  textDecoration: "underline",
};

/** Follow an in-page reference link through `show`, so a search never hides its target. */
const follow = (show: (anchor: string) => void, anchor: string) => (event: MouseEvent) => {
  event.preventDefault();
  show(anchor);
};

function Entry({
  anchor,
  title,
  children,
}: {
  anchor: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <article id={anchor} tabIndex={-1} aria-labelledby={`${anchor}-title`} style={article}>
      <h4 id={`${anchor}-title`} style={h4}>
        <code style={code}>{title}</code>
      </h4>
      {children}
    </article>
  );
}

function Constraints({
  items,
  show,
}: {
  items: readonly EirReferenceConstraint[];
  show: (anchor: string) => void;
}) {
  return (
    <ul style={list}>
      {items.map((item) => {
        const anchor = eirReferenceCodeAnchor(item.code);
        return (
          <li key={`${item.code}-${item.text}`}>
            {item.text} If not:{" "}
            <a href={`#${anchor}`} onClick={follow(show, anchor)} style={referenceLink}>
              <code style={code}>{item.code}</code>
            </a>
            .
          </li>
        );
      })}
    </ul>
  );
}

/** "Timeline 0 to 1 years, checked 10/20/2026: 10/19/2025 fails." */
function exampleText(example: EirOperatorExample, operator: string): string {
  const day = (value: string) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? formatEirDay(value) : value);
  const answer = /^\d{4}/.test(example.answer) ? day(example.answer) : `"${example.answer}"`;
  const outcome = example.meets ? "meets it" : "fails";
  const context =
    operator === "within-timeline" && example.timeline
      ? `Timeline ${example.timeline.min} to ${example.timeline.max} ${example.timeline.unit}, anchored ${example.timeline.anchor}; started ${day(example.formStartedAt)}, checked ${day(example.submittedAt)}: `
      : operator === "not-future" || operator === "not-past"
        ? `Checked ${day(example.submittedAt)}: `
        : operator === "on-or-after"
          ? `Other date ${day(example.otherAnswer ?? "")}: `
          : operator === "equals"
            ? `value "${example.value}": `
            : "";
  return `${context}${answer} ${outcome}.`;
}

export const SchemaReference = forwardRef<SchemaReferenceHandle>(function SchemaReference(_, ref) {
  const reference = useMemo(() => eirSchemaReference(), []);
  const [query, setQuery] = useState("");
  const [focusOn, setFocusOn] = useState<string | undefined>();

  const show = (anchor: string) => {
    setQuery("");
    setFocusOn(anchor);
  };
  useImperativeHandle(ref, () => ({ show }));
  useEffect(() => {
    if (!focusOn) return;
    document.getElementById(focusOn)?.focus();
    setFocusOn(undefined);
  }, [focusOn]);

  const needle = query.trim().toLowerCase();
  const matches = (...texts: (string | undefined)[]) =>
    !needle || texts.some((text) => text?.toLowerCase().includes(needle));

  const keys = reference.keys.filter((key) =>
    matches(
      key.path,
      key.meaning,
      key.whenOmitted,
      key.type,
      ...(key.values ?? []).flatMap((v) => [v.value, v.meaning]),
      ...key.constraints.flatMap((c) => [c.text, c.code]),
    ),
  );
  const operators = reference.operators.filter((op) =>
    matches(op.name, op.checks, op.needs, op.recordedAs, ...op.fieldTypes),
  );
  const dispositions = reference.dispositions.filter((d) => matches(d.name, d.meaning));
  const codes = reference.codes.filter((c) => matches(c.code, c.meaning));
  const rules = reference.definitionRules.filter((r) => matches(r.text, r.code));
  const versions = reference.versions.filter((v) => matches(v.title, v.text));
  const showExample = matches("minimal valid example", reference.example);
  const count =
    keys.length +
    operators.length +
    dispositions.length +
    codes.length +
    rules.length +
    versions.length +
    (showExample ? 1 : 0);

  return (
    <section aria-labelledby={HEADING_ID} style={panel}>
      <h2 id={HEADING_ID} style={h2}>
        Schema reference
      </h2>
      <p style={{ ...muted, margin: "0 0 12px" }}>
        What can go in an EIR definition and what each value means. It&apos;s built from the same
        rules Validate checks, so it always matches them.
      </p>
      <label htmlFor={SEARCH_ID} style={lbl}>
        Search the reference
      </label>
      <input
        id={SEARCH_ID}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        aria-describedby={`${SEARCH_ID}-hint`}
        style={inp}
      />
      <p id={`${SEARCH_ID}-hint`} style={help}>
        A key like rules[].operator, a value like not-past, a code, or any word.
      </p>
      <p role="status" style={{ ...muted, margin: "6px 0 0" }}>
        {needle
          ? count
            ? `${count} ${count === 1 ? "entry" : "entries"} match`
            : `Nothing matches ${query.trim()}.`
          : ""}
      </p>

      <div role="region" aria-label="Schema reference entries" tabIndex={0} style={scroller}>
        {rules.length ? (
          <>
            <h3 style={h3}>Rules for the whole definition</h3>
            <Constraints items={rules} show={show} />
          </>
        ) : null}

        {versions.length ? (
          <>
            <h3 style={h3}>How versions work</h3>
            {versions.map((v) => (
              <article
                key={v.topic}
                id={v.anchor}
                tabIndex={-1}
                aria-labelledby={`${v.anchor}-title`}
                style={article}
              >
                <h4 id={`${v.anchor}-title`} style={h4}>
                  {v.title}
                </h4>
                <p style={{ margin: 0 }}>{v.text}</p>
              </article>
            ))}
          </>
        ) : null}

        {keys.length ? (
          <>
            <h3 style={h3}>Keys</h3>
            <p style={{ ...muted, margin: 0 }}>
              A path like form.sections[].fields[].id means: the id of each field, in each section.
            </p>
            {keys.map((key) => (
              <Entry key={key.path} anchor={key.anchor} title={key.path}>
                <p style={{ margin: 0 }}>{key.meaning}</p>
                {key.mvpDefault ? (
                  <p style={{ ...notice("warning"), margin: "6px 0 0", padding: "4px 8px" }}>
                    Non-production MVP default (#148): the bootstrap uses {key.mvpDefault}, until
                    Safeguards sets it.
                  </p>
                ) : null}
                <dl style={dl}>
                  <dt style={dt}>Type</dt>
                  <dd style={dd}>{key.type}</dd>
                  <dt style={dt}>Required</dt>
                  <dd style={dd}>
                    {key.required ? "Required" : `Optional. If left out: ${key.whenOmitted}`}
                  </dd>
                  {key.values ? (
                    <>
                      <dt style={dt}>Values</dt>
                      <dd style={dd}>
                        <ul style={list}>
                          {key.values.map((value) => (
                            <li key={value.value}>
                              {value.anchor ? (
                                <a
                                  href={`#${value.anchor}`}
                                  onClick={follow(show, value.anchor)}
                                  style={referenceLink}
                                >
                                  <code style={code}>{value.value}</code>
                                </a>
                              ) : (
                                <code style={code}>{value.value}</code>
                              )}
                              : {value.meaning}
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </>
                  ) : null}
                  {key.constraints.length ? (
                    <>
                      <dt style={dt}>Rules</dt>
                      <dd style={dd}>
                        <Constraints items={key.constraints} show={show} />
                      </dd>
                    </>
                  ) : null}
                </dl>
              </Entry>
            ))}
          </>
        ) : null}

        {operators.length ? (
          <>
            <h3 style={h3}>Rule operators</h3>
            <p style={{ ...muted, margin: 0 }}>
              Dates are compared as calendar days (UTC). &ldquo;Checked&rdquo; is the day the EIR is
              checked: today for an employee, submittedAt for a scenario. &ldquo;Started&rdquo; is
              the day the employee started the form.
            </p>
            {operators.map((op) => (
              <Entry key={op.name} anchor={op.anchor} title={op.name}>
                <p style={{ margin: 0 }}>{op.checks}</p>
                <dl style={dl}>
                  <dt style={dt}>Question types</dt>
                  <dd style={dd}>{op.fieldTypes.join(", ")}</dd>
                  <dt style={dt}>Dispositions</dt>
                  <dd style={dd}>{op.dispositions.join(", ")}</dd>
                  <dt style={dt}>Also needs</dt>
                  <dd style={dd}>{op.needs}</dd>
                  <dt style={dt}>Stored as</dt>
                  <dd style={dd}>
                    <code style={code}>{op.recordedAs}</code>
                  </dd>
                  <dt style={dt}>Examples</dt>
                  <dd style={dd}>
                    <ul style={list}>
                      {op.examples.map((example, i) => (
                        <li key={i}>{exampleText(example, op.name)}</li>
                      ))}
                    </ul>
                  </dd>
                </dl>
              </Entry>
            ))}
          </>
        ) : null}

        {dispositions.length ? (
          <>
            <h3 style={h3}>Dispositions</h3>
            <p style={{ ...muted, margin: 0 }}>
              What happens when an answer doesn&apos;t meet a rule. The most serious one wins:
              blocking, then manual-review, then warning. A missing or malformed answer always
              blocks. By default a Safeguards validator decides every EIR. A deploy can set
              automatic validity: then a signed upload whose pre-check passes is recorded as valid
              at once, and a warning only if the deploy also names it. Automatic validity isn&apos;t
              authorized for production use until Safeguards signs off.
            </p>
            {dispositions.map((d) => (
              <Entry key={d.name} anchor={d.anchor} title={d.name}>
                <p style={{ margin: 0 }}>{d.meaning}</p>
                <dl style={dl}>
                  <dt style={dt}>PDF</dt>
                  <dd style={dd}>
                    {d.pdf === "refused" ? "Can't be generated" : "Can be generated"}
                  </dd>
                  <dt style={dt}>Upload</dt>
                  <dd style={dd}>{d.upload === "refused" ? "Refused" : "Accepted"}</dd>
                  <dt style={dt}>Automatic validity</dt>
                  <dd style={dd}>
                    {d.automaticValidity === "if-configured"
                      ? "Only if the deploy names it (not by default)"
                      : "Never"}
                  </dd>
                </dl>
              </Entry>
            ))}
          </>
        ) : null}

        {codes.length ? (
          <>
            <h3 style={h3}>Codes</h3>
            {codes.map((c) => (
              <Entry key={c.code} anchor={c.anchor} title={c.code}>
                <p style={{ ...muted, margin: 0 }}>
                  {c.kind === "check" ? "Shown by Validate" : "Refuses a publish or activate"}
                </p>
                <p style={{ margin: "4px 0 0" }}>{c.meaning}</p>
              </Entry>
            ))}
          </>
        ) : null}

        {showExample ? (
          <>
            <h3 style={h3}>Minimal valid example</h3>
            <p style={{ ...muted, margin: "0 0 6px" }}>
              The least a definition needs. It loads, and both its scenarios pass.
            </p>
            <pre
              style={{
                ...code,
                fontSize: "var(--font-size-3xs, 12px)",
                background: "var(--color-gray-cool-2, #f1f3f6)",
                padding: 10,
                overflowX: "auto",
                margin: 0,
              }}
            >
              {reference.example}
            </pre>
          </>
        ) : null}
      </div>
    </section>
  );
});
