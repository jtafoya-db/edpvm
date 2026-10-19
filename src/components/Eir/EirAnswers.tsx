import { answerSections, type EirFlag, type EirFormValues } from "@/data";
import type { EirScreenChrome } from "./EirShared";

type Props = {
  values: EirFormValues;
  version: string | undefined;
  /** Rows to highlight for the validator (`eirFlags`). */
  flags?: EirFlag[];
  Icon: EirScreenChrome["Icon"];
  /** Heading level for the section titles, under the panel's own heading. */
  headingLevel?: 3 | 4;
  /**
   * `grid` (the validator's cards): answers side by side. `list` (the
   * person's review and submitted summary): one answer per line, the question
   * beside its answer, stacking on a narrow screen.
   */
  layout?: "grid" | "list";
};

const muted = { color: "var(--text-muted)", fontSize: "var(--font-size-3xs)" } as const;

/**
 * Answers to any stored form version, read-only: a structured version (1.2 or
 * later) by section with the declaration, flagged rows highlighted; a legacy
 * version under its own name and labels, said plainly to be legacy.
 */
export function EirAnswers({
  values,
  version,
  flags,
  Icon,
  headingLevel = 3,
  layout = "grid",
}: Props) {
  const answers = answerSections(values, version, { flags: flags ?? [] });
  const Heading = headingLevel === 3 ? "h3" : "h4";
  return (
    <div style={layout === "list" ? { maxWidth: 800 } : undefined}>
      {answers.legacy ? (
        <p
          role="note"
          style={{
            margin: "0 0 12px",
            padding: "10px 14px",
            borderLeft: "4px solid var(--color-gray-cool-50)",
            background: "var(--color-gray-cool-5)",
            fontSize: "var(--font-size-2xs)",
          }}
        >
          <strong>Legacy answers:</strong> recorded on the {answers.name}. They were migrated as
          they were given; the questions on later EIR forms weren&apos;t asked.
        </p>
      ) : null}
      {layout === "list"
        ? answers.sections.map((section, index) => (
            <section
              key={section.id}
              aria-label={section.title}
              style={{ marginTop: index ? 22 : 0 }}
            >
              <Heading
                style={{
                  margin: "0 0 4px",
                  fontFamily: "var(--font-heading)",
                  fontSize: "var(--font-size-md)",
                  color: "var(--text-default)",
                }}
              >
                {section.title}
              </Heading>
              <dl style={{ margin: 0 }}>
                {section.rows.map((row) => (
                  <div
                    key={row.field}
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      columnGap: 24,
                      rowGap: 2,
                      padding: "10px 0",
                      borderBottom: "1px solid var(--border-default)",
                    }}
                  >
                    <dt
                      style={{
                        flex: "1 1 260px",
                        color: "var(--color-gray-cool-70)",
                        fontSize: "var(--font-size-2xs)",
                        lineHeight: 1.5,
                      }}
                    >
                      {row.label}
                    </dt>
                    <dd
                      style={{
                        flex: "1 1 260px",
                        margin: 0,
                        fontSize: "var(--font-size-2xs)",
                        fontWeight: 700,
                        lineHeight: 1.5,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {row.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))
        : null}
      {layout === "grid" &&
        answers.sections.map((section) => (
          <section key={section.id} aria-label={section.title} style={{ marginBottom: 14 }}>
            <Heading
              style={{
                margin: "0 0 8px",
                fontFamily: "var(--font-sans)",
                fontSize: "var(--font-size-xs)",
                color: "var(--text-default)",
              }}
            >
              {section.title}
            </Heading>
            <dl
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                gap: 12,
                margin: 0,
              }}
            >
              {section.rows.map((row) => {
                const flagged = row.flags.length > 0;
                return (
                  <div
                    key={row.field}
                    data-flagged={flagged || undefined}
                    style={
                      flagged
                        ? {
                            padding: "8px 10px",
                            borderLeft: "4px solid var(--theme-warning)",
                            background: "var(--theme-warning-lighter)",
                            borderRadius: "var(--radius-md)",
                          }
                        : { padding: "0 0 0 2px" }
                    }
                  >
                    <dt style={muted}>{row.label}</dt>
                    <dd
                      style={{
                        margin: "4px 0 0",
                        fontSize: "var(--font-size-2xs)",
                        fontWeight: 700,
                        overflowWrap: "anywhere",
                      }}
                    >
                      {row.value}
                    </dd>
                    {row.flags.map((text) => (
                      <dd
                        key={text}
                        style={{
                          margin: "4px 0 0",
                          display: "flex",
                          gap: 6,
                          alignItems: "flex-start",
                          color: "var(--color-gray-cool-80)",
                          fontSize: "var(--font-size-3xs)",
                        }}
                      >
                        <Icon name="flag" size={14} color="var(--theme-warning-darker)" />
                        <span>
                          <strong>Flag:</strong> {text}
                        </span>
                      </dd>
                    ))}
                  </div>
                );
              })}
            </dl>
          </section>
        ))}
    </div>
  );
}
