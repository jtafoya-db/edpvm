// The Safeguards EIR definition workspace (#201), an EDP Admin section in the
// staff app. Safeguards edit an EIR definition's YAML, validate and preview it
// on the server, publish it as a new immutable version, and activate a
// published version (reactivating an earlier one is the rollback). EDP staff
// see the versions and activation history only. The server checks every
// role and every rule again; this screen only decides what to show.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import {
  canAuthorEirDefinitions,
  useActivateEirDefinition,
  useCheckEirDefinition,
  useEirDefinitionHistory,
  useEirDefinitionVersion,
  usePublishEirDefinition,
  useUser,
  type EirDefinitionCheck,
  type EirDefinitionHistory,
  type EirFormValues,
} from "@/data";
import { readBootstrapEirSource } from "@/data/eir/definition/bootstrap-source";
import { definitionLabel, FALLBACK_BUILT_IN_ID } from "@/data/eir/definition/identity";
import {
  PendingActionButton,
  PendingActionStatus,
  keepIntentForUnknownOutcome,
  usePendingActionGroup,
} from "@/components/PendingAction";
import {
  h1,
  headRow,
  muted,
  notice,
  outlineBtn,
  primaryBtn,
  row,
  subtitle,
  table,
  td,
  th,
} from "@/components/DatasetAccess/styles";
import {
  eirReferenceCodeAnchor,
  eirReferenceKeyAnchor,
  eirReferenceKeyFor,
} from "@/data/eir/definition/reference";
import { EirForm } from "@/components/Eir/EirForm";
import { SchemaReference, type SchemaReferenceHandle } from "./SchemaReference";
import { YamlEditor, type YamlEditorHandle } from "./YamlEditor";

const EDITOR_ID = "eir-definition-yaml";
/** Publish and activate both change the one register: one at a time. */
const REGISTER = "eir-definition-register";
const HINT_ID = "eir-definition-yaml-hint";

const h2: CSSProperties = {
  margin: "0 0 10px",
  fontFamily: "var(--font-sans)",
  fontSize: "var(--font-size-sm)",
  fontWeight: 700,
};
const panel: CSSProperties = {
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius-md)",
  padding: 20,
  marginBottom: 22,
  background: "var(--surface-default, #fff)",
};
const actions: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 10, marginTop: 14 };
const smallBtn: CSSProperties = { ...outlineBtn, padding: "6px 12px" };
/** A link that looks like one (the page's reset strips the browser's): colour and underline. */
const referenceLink: CSSProperties = {
  color: "var(--link-default, #005ea2)",
  textDecoration: "underline",
};
// The editor and the schema reference side by side on a wide screen, stacked on a narrow one.
const columns: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 22,
  alignItems: "flex-start",
};
const editorColumn: CSSProperties = { flex: "2 1 560px", minWidth: 0 };
const referenceColumn: CSSProperties = { flex: "1 1 340px", minWidth: 0 };

const NoIcon = () => null;
const noop = () => undefined;

const when = (iso: string) => new Date(iso).toLocaleString();

function Section({ label, children }: { label: string; children: ReactNode }) {
  const id = `eir-definitions-${label.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <section aria-labelledby={id} style={panel}>
      <h2 id={id} style={h2}>
        {label}
      </h2>
      {children}
    </section>
  );
}

/** A built-in definition, named (#217, #224): "built-in definition bootstrap-2 (version 0)". */
const builtIn = (id: string) => `built-in definition ${definitionLabel(id)}`;

function activeLabel(history: EirDefinitionHistory): string {
  const { active } = history;
  return active.source === "bootstrap"
    ? `The ${builtIn(active.id)}`
    : `Version ${active.versionNumber}`;
}

/** The checked YAML and what the server said about it. */
interface Checked {
  yaml: string;
  result: EirDefinitionCheck;
  preview: boolean;
}

export function EirDefinitionWorkspace() {
  const user = useUser();
  const canAuthor = canAuthorEirDefinitions(user.data);
  const history = useEirDefinitionHistory();
  const activeNumber =
    history.data?.active.source === "published" ? history.data.active.versionNumber : undefined;
  const activeSource = useEirDefinitionVersion(canAuthor ? activeNumber : undefined);
  const check = useCheckEirDefinition();
  const publish = usePublishEirDefinition();
  const activate = useActivateEirDefinition();
  const pending = usePendingActionGroup();
  const editor = useRef<YamlEditorHandle>(null);
  const reference = useRef<SchemaReferenceHandle>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const failureRef = useRef<HTMLParagraphElement>(null);
  const [yaml, setYaml] = useState<string | undefined>();
  const [checked, setChecked] = useState<Checked | undefined>();
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState("");
  // The version an activation is waiting on confirmation for.
  const [confirming, setConfirming] = useState<number | undefined>();
  const [returnFocusTo, setReturnFocusTo] = useState<number | undefined>();
  const [checkRuns, setCheckRuns] = useState(0);
  // Which check is running, for its button's label.
  const [checking, setChecking] = useState<"validate" | "preview">("validate");

  // The editor opens on the active definition's YAML, once.
  useEffect(() => {
    if (yaml !== undefined || !canAuthor || !history.data) return;
    if (history.data.active.source === "bootstrap") setYaml(readBootstrapEirSource() ?? "");
    else if (activeSource.data) setYaml(activeSource.data.sourceYaml);
  }, [yaml, canAuthor, history.data, activeSource.data]);

  useEffect(() => {
    if (message) messageRef.current?.focus();
  }, [message]);
  useEffect(() => {
    if (failure) failureRef.current?.focus();
  }, [failure]);

  // Publish and activate are not optimistic (a version is permanent policy):
  // the screen says what's happening until the server confirms. While the
  // list refreshes after a write, the register version it shows is stale, so
  // the next write waits for it.
  const writing = pending.isRecordPending(REGISTER);
  const busy = check.isPending || writing || history.isFetching;
  const result = checked && checked.yaml === yaml ? checked.result : undefined;
  const publishable = result?.ok === true && result.publishable;

  const run = async (preview: boolean) => {
    if (yaml === undefined || busy) return;
    setFailure("");
    setMessage("");
    setChecking(preview ? "preview" : "validate");
    try {
      const answer = await check.mutateAsync(yaml);
      setChecked({ yaml, result: answer, preview });
      setCheckRuns((runs) => runs + 1);
      if (answer.ok && answer.publishable) {
        setMessage(
          preview
            ? "Valid: the preview is below. Every scenario produced its declared outcome."
            : "Valid: every scenario produced its declared outcome. Preview it before you publish.",
        );
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The check didn't run. Try again.");
    }
  };

  /**
   * After a reply that never came (#189's unknown outcome), look rather than
   * guess, as the privacy acknowledgment does (#207): the fresh history says
   * whether the write landed. `undefined` when it can't be read either.
   */
  const lookAgain = async () => (await history.refetch()).data;

  const doPublish = async () => {
    if (!publishable || !result?.ok || !history.data || busy || yaml === undefined) return;
    const sourceYaml = yaml;
    const { contentSha256 } = result;
    const before = history.data;
    const stillActive =
      before.active.source === "bootstrap"
        ? `the ${builtIn(before.active.id)}`
        : `version ${before.active.versionNumber}`;
    const published = (versionNumber: number, hash: string) => {
      // Published: this YAML can't be published again.
      setChecked(undefined);
      setMessage(
        `Published as version ${versionNumber}. It isn't active: new EIR drafts still use ${stillActive}. Content SHA-256: ${hash}.`,
      );
    };
    setFailure("");
    setMessage("");
    // The same intent (this content, from this register version) keeps its
    // request key across retries, so a retry after a lost reply replays it.
    const intent = pending.makeIntent(REGISTER, "publish", `${contentSha256}@${before.version}`);
    try {
      const reply = await pending.run(
        {
          recordId: REGISTER,
          actionId: "publish",
          label: "Publishing as a new version…",
        },
        (key) =>
          publish.mutateAsync({
            sourceYaml,
            expectedVersion: before.version,
            idempotencyKey: key.idempotencyKey,
          }),
        { intent, keepIntentOnError: keepIntentForUnknownOutcome },
      );
      if (!reply) return;
      published(reply.versionNumber, reply.contentSha256 ?? contentSha256);
    } catch (error) {
      if (!keepIntentForUnknownOutcome(error)) {
        setFailure(`It wasn't published: ${errorText(error, "Try again.")}`);
        return;
      }
      const landed = (await lookAgain().catch(() => undefined))?.versions.find(
        (v) => v.contentSha256 === contentSha256,
      );
      if (landed) {
        pending.clearRecordIntents(REGISTER);
        published(landed.versionNumber, landed.contentSha256);
        return;
      }
      setFailure(
        "We couldn't confirm it was published: the connection dropped before the server answered. Nothing is shown as published until the server confirms it. Your YAML is unchanged; publish again to retry. It can't be published twice.",
      );
    }
  };

  /** "version 2", or the built-in definition in use while none is active. */
  const describe = (versionNumber: number | null) =>
    versionNumber === null
      ? `the ${builtIn(history.data?.active.source === "bootstrap" ? history.data.active.id : FALLBACK_BUILT_IN_ID)}`
      : `version ${versionNumber}`;

  // Cancelled: back to the button that asked.
  useEffect(() => {
    if (returnFocusTo === undefined) return;
    document.getElementById(activateButtonId(returnFocusTo))?.focus();
    setReturnFocusTo(undefined);
  }, [returnFocusTo]);

  const doActivate = async (versionNumber: number, rollback: boolean) => {
    if (!history.data || busy) return;
    const before = history.data;
    const activated = () =>
      setMessage(
        `Version ${versionNumber} is active. New EIR drafts use it; drafts already started keep the version they started on.`,
      );
    setConfirming(undefined);
    setFailure("");
    setMessage("");
    const intent = pending.makeIntent(REGISTER, "activate", `${versionNumber}@${before.version}`);
    try {
      const reply = await pending.run(
        {
          recordId: REGISTER,
          actionId: `activate-${versionNumber}`,
          label: rollback
            ? `Rolling back to version ${versionNumber}…`
            : `Activating version ${versionNumber}…`,
        },
        (key) =>
          activate.mutateAsync({
            versionNumber,
            expectedVersion: before.version,
            idempotencyKey: key.idempotencyKey,
          }),
        { intent, keepIntentOnError: keepIntentForUnknownOutcome },
      );
      if (reply) activated();
    } catch (error) {
      if (!keepIntentForUnknownOutcome(error)) {
        setFailure(`It wasn't activated: ${errorText(error, "Try again.")}`);
        return;
      }
      const now = await lookAgain().catch(() => undefined);
      if (
        now &&
        now.version > before.version &&
        now.active.source === "published" &&
        now.active.versionNumber === versionNumber
      ) {
        pending.clearRecordIntents(REGISTER);
        activated();
        return;
      }
      setFailure(
        `We couldn't confirm version ${versionNumber} was activated: the connection dropped before the server answered. Nothing is shown as active until the server confirms it. Try again; it can't be activated twice.`,
      );
    }
  };

  return (
    <>
      <h1 style={h1}>EIR definitions</h1>
      <p style={{ ...subtitle, marginBottom: 20 }}>
        Safeguards publishes versioned EIR definitions here: the form, its rules and their synthetic
        scenarios. Publishing doesn&apos;t change what employees see; activating a version does, for
        new drafts only. Nothing here makes an EIR valid automatically or authorizes FTI use.
      </p>
      <p
        ref={messageRef}
        tabIndex={-1}
        role="status"
        aria-label="Workspace message"
        style={message ? { ...notice("success"), marginBottom: 16 } : { display: "none" }}
      >
        {message}
      </p>
      {failure ? (
        <p
          ref={failureRef}
          tabIndex={-1}
          role="alert"
          style={{ ...notice("error"), marginBottom: 16 }}
        >
          {failure}
        </p>
      ) : null}

      {history.isPending ? (
        <p role="status" style={subtitle}>
          Loading EIR definitions…
        </p>
      ) : history.isError ? (
        <p role="alert" style={notice("error")}>
          We couldn&apos;t load the EIR definitions: {history.error.message}
        </p>
      ) : (
        <>
          <Section label="Active definition">
            <p style={{ margin: 0, fontFamily: "var(--font-sans)" }}>{activeLabel(history.data)}</p>
            <p style={{ ...muted, margin: "6px 0 0" }}>
              With no published version active, the {builtIn(FALLBACK_BUILT_IN_ID)} that ships with
              the app is used.
            </p>
          </Section>

          {canAuthor ? (
            <div style={columns}>
              <div style={editorColumn}>
                <Section label="Edit a definition">
                  <p id={HINT_ID} style={{ ...muted, margin: "0 0 10px" }}>
                    YAML, checked on the server. Tab moves to the next control. Enter keeps the
                    indentation; Ctrl+] and Ctrl+[ (Cmd on a Mac) indent and outdent; Ctrl+Z undoes.
                    Validate shows any problem with its line; Preview also renders the form and runs
                    every synthetic scenario. Neither publishes or activates anything. The YAML
                    names no version of its own: publishing gives it the next version number, and
                    EIR drafts keep the version they started on.
                  </p>
                  {yaml === undefined ? (
                    <p role="status" style={subtitle}>
                      Loading the active definition…
                    </p>
                  ) : (
                    <YamlEditor
                      ref={editor}
                      id={EDITOR_ID}
                      label="Definition YAML"
                      value={yaml}
                      onChange={(text) => {
                        setYaml(text);
                        setMessage("");
                      }}
                      describedBy={HINT_ID}
                      readOnly={writing}
                    />
                  )}
                  <div style={actions}>
                    <PendingActionButton
                      type="button"
                      style={outlineBtn}
                      pending={check.isPending && checking === "validate"}
                      savingLabel="Validating…"
                      locked={busy || yaml === undefined}
                      onClick={() => void run(false)}
                    >
                      Validate
                    </PendingActionButton>
                    <PendingActionButton
                      type="button"
                      style={outlineBtn}
                      pending={check.isPending && checking === "preview"}
                      savingLabel="Previewing…"
                      locked={busy || yaml === undefined}
                      onClick={() => void run(true)}
                    >
                      Preview
                    </PendingActionButton>
                    {publishable ? (
                      <PendingActionButton
                        type="button"
                        style={primaryBtn}
                        pending={pending.isActionPending(REGISTER, "publish")}
                        savingLabel="Publishing…"
                        locked={busy}
                        onClick={() => void doPublish()}
                      >
                        Publish as a new version
                      </PendingActionButton>
                    ) : null}
                    <PendingActionStatus pending={writing}>
                      {pending.pending[0]?.label} This can take a few seconds.
                    </PendingActionStatus>
                  </div>
                  {result ? (
                    <CheckResult
                      announce={checkRuns}
                      result={result}
                      preview={checked?.preview === true}
                      goToLine={(line) => editor.current?.goToLine(line)}
                      showReference={(anchor) => reference.current?.show(anchor)}
                    />
                  ) : null}
                </Section>
              </div>
              <div style={referenceColumn}>
                <SchemaReference ref={reference} />
              </div>
            </div>
          ) : (
            <>
              <p style={{ ...muted, marginBottom: 22 }}>
                Only Safeguards can author, publish or activate EIR definitions. You can see what
                has been published and activated, and read the schema reference.
              </p>
              <SchemaReference />
            </>
          )}

          <Section label="Published versions">
            {history.data.versions.length === 0 ? (
              <p style={{ ...muted, margin: 0 }}>Nothing has been published yet.</p>
            ) : (
              <table style={table} aria-label="Published versions">
                <thead>
                  <tr style={headRow}>
                    <th style={th} scope="col">
                      Version
                    </th>
                    <th style={th} scope="col">
                      Published
                    </th>
                    <th style={th} scope="col">
                      Content SHA-256
                    </th>
                    <th style={th} scope="col">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.versions.map((version) => {
                    const isActive = version.versionNumber === activeNumber;
                    const wasActive = history.data.activations.some(
                      (a) => a.versionNumber === version.versionNumber,
                    );
                    return (
                      <tr key={version.versionNumber} style={row}>
                        <th style={td} scope="row">
                          {version.versionNumber}
                        </th>
                        <td style={td}>
                          {when(version.publishedAt)} by {version.publishedBy.display}
                        </td>
                        <td style={{ ...td, fontFamily: "var(--font-mono, monospace)" }}>
                          {version.contentSha256.slice(0, 12)}…
                          <details>
                            <summary style={{ fontFamily: "var(--font-sans)", cursor: "pointer" }}>
                              Show the full SHA-256 of version {version.versionNumber}
                            </summary>
                            <code style={{ wordBreak: "break-all" }}>{version.contentSha256}</code>
                          </details>
                        </td>
                        <td style={td}>
                          {isActive ? (
                            <strong>Active</strong>
                          ) : canAuthor ? (
                            <PendingActionButton
                              type="button"
                              id={activateButtonId(version.versionNumber)}
                              style={smallBtn}
                              pending={pending.isActionPending(
                                REGISTER,
                                `activate-${version.versionNumber}`,
                              )}
                              savingLabel={wasActive ? "Rolling back…" : "Activating…"}
                              locked={busy}
                              aria-expanded={confirming === version.versionNumber}
                              onClick={() => setConfirming(version.versionNumber)}
                            >
                              {wasActive
                                ? `Roll back to version ${version.versionNumber}`
                                : `Activate version ${version.versionNumber}`}
                            </PendingActionButton>
                          ) : (
                            "Not active"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Section>

          {confirming !== undefined && history.data ? (
            <ConfirmActivation
              rollback={history.data.activations.some((a) => a.versionNumber === confirming)}
              versionNumber={confirming}
              target={describe(confirming)}
              current={describe(activeNumber ?? null)}
              busy={busy}
              onConfirm={() =>
                void doActivate(
                  confirming,
                  history.data.activations.some((a) => a.versionNumber === confirming),
                )
              }
              onCancel={() => {
                setReturnFocusTo(confirming);
                setConfirming(undefined);
              }}
            />
          ) : null}

          <Section label="Activation history">
            {history.data.activations.length === 0 ? (
              <p style={{ ...muted, margin: 0 }}>
                No published version has been activated: the {builtIn(FALLBACK_BUILT_IN_ID)} is in
                use.
              </p>
            ) : (
              <table style={table} aria-label="Activation history">
                <thead>
                  <tr style={headRow}>
                    <th style={th} scope="col">
                      When
                    </th>
                    <th style={th} scope="col">
                      Activated
                    </th>
                    <th style={th} scope="col">
                      Replaced
                    </th>
                    <th style={th} scope="col">
                      Kind
                    </th>
                    <th style={th} scope="col">
                      By
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.activations.map((activation, i) => (
                    <tr key={`${activation.activatedAt}-${i}`} style={row}>
                      <td style={td}>{when(activation.activatedAt)}</td>
                      <th style={td} scope="row">
                        Version {activation.versionNumber}
                      </th>
                      <td style={td}>
                        {activation.previousVersionNumber === null
                          ? "A built-in definition"
                          : `Version ${activation.previousVersionNumber}`}
                      </td>
                      <td style={td}>{activation.rollback ? "Rollback" : "Activation"}</td>
                      <td style={td}>{activation.activatedBy.display}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </>
      )}
    </>
  );
}

const activateButtonId = (versionNumber: number) => `eir-definition-activate-${versionNumber}`;

/** What the server said, or `fallback` when it said nothing usable. */
const errorText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

function ConfirmActivation({
  rollback,
  versionNumber,
  target,
  current,
  busy,
  onConfirm,
  onCancel,
}: {
  rollback: boolean;
  versionNumber: number;
  target: string;
  current: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => confirm.current?.focus(), [versionNumber]);
  const verb = rollback ? "Roll back to" : "Activate";
  return (
    <div
      role="group"
      aria-label="Confirm activation"
      style={{ ...notice("warning"), marginBottom: 22 }}
    >
      <p style={{ margin: "0 0 10px", fontFamily: "var(--font-sans)" }}>
        {verb} {target}? It replaces {current} for new EIR drafts.
      </p>
      <p style={{ ...muted, margin: "0 0 10px" }}>
        Drafts already started and submissions keep their own form. The activation is recorded and
        can&apos;t be undone, only replaced by another.
      </p>
      <div style={{ display: "flex", gap: 10 }}>
        <button ref={confirm} type="button" style={primaryBtn} disabled={busy} onClick={onConfirm}>
          {verb} version {versionNumber} now
        </button>
        <button type="button" style={outlineBtn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function CheckResult({
  announce,
  result,
  preview,
  goToLine,
  showReference,
}: {
  /** Goes up with each check: its result is announced (focused) each time. */
  announce: number;
  result: EirDefinitionCheck;
  preview: boolean;
  goToLine: (line: number) => void;
  /** Move to an entry in the schema reference. */
  showReference: (anchor: string) => void;
}) {
  const summary = useRef<HTMLParagraphElement>(null);
  const failed = result.ok ? result.scenarios.filter((scenario) => !scenario.ok) : [];
  const problems = !result.ok || failed.length > 0;
  useEffect(() => {
    if (problems) summary.current?.focus();
  }, [announce, problems]);
  if (!result.ok) {
    const count = result.diagnostics.length;
    return (
      <div style={{ marginTop: 16 }}>
        <Section label="Problems">
          <p
            ref={summary}
            tabIndex={-1}
            role="alert"
            style={{ margin: "0 0 6px", fontFamily: "var(--font-sans)", fontWeight: 700 }}
          >
            {count} problem{count === 1 ? "" : "s"} found
          </p>
          <p style={{ ...notice("error"), margin: "0 0 10px" }}>
            This definition can&apos;t be published. Fix{" "}
            {result.diagnostics.length === 1 ? "this problem" : "these problems"}, then validate
            again.
          </p>
          <ul style={{ margin: 0, paddingLeft: 20, fontFamily: "var(--font-sans)" }}>
            {result.diagnostics.map((diagnostic, i) => {
              const key = eirReferenceKeyFor(diagnostic.path);
              const link = (anchor: string, text: string) => (
                <a
                  href={`#${anchor}`}
                  style={referenceLink}
                  onClick={(event) => {
                    event.preventDefault();
                    showReference(anchor);
                  }}
                >
                  {text}
                </a>
              );
              return (
                <li key={i} style={{ marginBottom: 8 }}>
                  {diagnostic.message}
                  {diagnostic.path.length ? (
                    <>
                      {" "}
                      <code>{diagnostic.path.join(".")}</code>
                    </>
                  ) : null}
                  {diagnostic.line ? (
                    <>
                      {" "}
                      <button
                        type="button"
                        style={{ ...smallBtn, padding: "2px 8px" }}
                        onClick={() => goToLine(diagnostic.line!)}
                      >
                        Go to line {diagnostic.line}
                      </button>
                    </>
                  ) : null}{" "}
                  {link(eirReferenceCodeAnchor(diagnostic.code), `What ${diagnostic.code} means`)}
                  {key ? (
                    <>
                      {" · "}
                      {link(eirReferenceKeyAnchor(key), `About ${key}`)}
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </Section>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 16 }}>
      {failed.length ? (
        <p ref={summary} tabIndex={-1} role="alert" style={notice("error")}>
          This definition loads, but{" "}
          {failed.length === 1 ? "a scenario doesn't" : "scenarios don't"} produce the declared
          outcome, so it can&apos;t be published.
        </p>
      ) : null}
      {preview || failed.length ? (
        <Section label="Preview">
          <p style={{ ...muted, margin: "0 0 12px" }}>
            Valid for {result.definition.validityDays} days. Not published, not active: publishing
            gives it the next version number.
          </p>
          <table style={table} aria-label="Synthetic scenarios">
            <thead>
              <tr style={headRow}>
                <th style={th} scope="col">
                  Scenario
                </th>
                <th style={th} scope="col">
                  Declared
                </th>
                <th style={th} scope="col">
                  Result
                </th>
                <th style={th} scope="col">
                  Why
                </th>
              </tr>
            </thead>
            <tbody>
              {result.scenarios.map((scenario) => (
                <tr key={scenario.id} style={row}>
                  <th style={td} scope="row">
                    {scenario.id}
                  </th>
                  <td style={td}>{scenario.expected}</td>
                  <td style={td}>
                    {scenario.actual}
                    {scenario.ok ? "" : " (doesn't match)"}
                  </td>
                  <td style={td}>
                    {scenario.reasons.length
                      ? scenario.reasons
                          .map((r) => `${r.field}: ${r.reasonCode ?? r.disposition}`)
                          .join("; ")
                      : "No rule fired"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview ? (
            <fieldset
              disabled
              aria-label="Form preview"
              style={{ border: 0, padding: 0, margin: "20px 0 0" }}
            >
              <EirForm
                form={result.definition.form}
                values={{} as EirFormValues}
                onChange={noop}
                errors={[]}
                attempt={0}
                Icon={NoIcon}
              />
            </fieldset>
          ) : null}
        </Section>
      ) : null}
    </div>
  );
}
