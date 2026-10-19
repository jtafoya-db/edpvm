import { useEffect, useRef, useState, type FormEvent } from "react";

import { SaveNotices } from "@/components/SaveStatus";
import type { AccessRequestConfig } from "@/data/access-requests/config";
import { isDatasetOwner } from "@/data/datasets/ownership";
import {
  accessRequestRecord,
  submitAccessRequestSave,
  useAccessRequestSettings,
} from "@/data/access-requests/queries";
import { useSave } from "@/data/optimistic-save";
import { useDataset, useRoleDescriptions } from "@/data/datasets/queries";
import type { RoleDescriptions } from "@/data/datasets/role-descriptions";
import type { Dataset, DatasetRoleName } from "@/data/datasets/types";
import { useUser } from "@/data/queries";
import { FeatureGate } from "@/features/FeatureGate";
import { ActionErrorNotice, GrantList, Notice, QueryGate } from "../DatasetAccess/chrome";
import { RoleCard } from "../DatasetAccess/DatasetTeamPage";
import { handleRoleGroupKeyDown } from "../DatasetAccess/role-card-keyboard";
import {
  resolveChrome,
  type DatasetAccessChrome,
  type ScreenCtx,
  type ScreenProps,
} from "../DatasetAccess/resolveChrome";
import * as s from "../DatasetAccess/styles";
import { RequestStateNotice, SlaTargetNote } from "./parts";

/**
 * Ask one dataset's owners for a dataset role. The person picks a role from
 * the same cards owners add with, sees what it grants, and gives a reason.
 * Who is asking comes from the session.
 */
export function RequestAccessScreen({ ctx, params, chrome: injected }: ScreenProps) {
  const chrome = resolveChrome(injected);
  const { Page, Trail } = chrome;
  const datasetId = params?.id ?? "";
  const dataset = useDataset(datasetId);
  const roles = useRoleDescriptions();
  const settings = useAccessRequestSettings();
  const user = useUser();

  return (
    <Page>
      <Trail
        items={[
          { label: "Home", go: () => ctx.go("home") },
          { label: "Access requests", go: () => ctx.go("access-requests") },
          { label: "Request a role" },
        ]}
      />
      <FeatureGate id="access-requests">
        <QueryGate
          isPending={dataset.isPending || roles.isPending || settings.isPending || user.isPending}
          error={dataset.error ?? roles.error ?? settings.error ?? user.error}
          chrome={chrome}
        >
          {dataset.data === null ? (
            <Notice kind="warning" chrome={chrome} title="No such dataset">
              There's no dataset <code style={s.mono}>{datasetId}</code>. <BackLink ctx={ctx} />
            </Notice>
          ) : dataset.data && roles.data && settings.data && user.data ? (
            <>
              <div style={s.titleRow}>
                <div>
                  <h1 style={s.h1}>Request a role on {dataset.data.name}</h1>
                  <p style={s.subtitle}>
                    Its owners decide: {dataset.data.owners.map((o) => o.displayName).join(", ")}
                  </p>
                </div>
              </div>
              <div style={s.stack}>
                <RequestStateNotice chrome={chrome} />
                {isDatasetOwner(dataset.data, user.data) ? (
                  <Notice kind="info" chrome={chrome} title="You own this dataset">
                    Owners add people, themselves included, on the dataset's team page.
                  </Notice>
                ) : (
                  <RequestForm
                    ctx={ctx}
                    dataset={dataset.data}
                    roles={roles.data}
                    settings={settings.data}
                    chrome={chrome}
                  />
                )}
              </div>
            </>
          ) : null}
        </QueryGate>
      </FeatureGate>
    </Page>
  );
}

function BackLink({ ctx }: { ctx: ScreenCtx }) {
  return (
    <a
      href="#access-requests"
      onClick={(e) => {
        e.preventDefault();
        ctx.go("access-requests");
      }}
      style={s.linkBtn}
    >
      See your requests
    </a>
  );
}

function RequestForm({
  ctx,
  dataset,
  roles,
  settings,
  chrome,
}: {
  ctx: ScreenCtx;
  dataset: Dataset;
  roles: RoleDescriptions;
  settings: AccessRequestConfig;
  chrome: DatasetAccessChrome;
}) {
  const { Panel, SectionHead, Icon } = chrome;
  const submit = useSave(submitAccessRequestSave);
  const user = useUser();
  const [role, setRole] = useState<DatasetRoleName>(settings.requestableRoles[0]!);
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  /** The role just sent: its save says Saving…, then Sent, in place. */
  const [sent, setSent] = useState<DatasetRoleName | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement>(null);
  const sentRef = useRef<HTMLDivElement>(null);

  const reasonError = reason.trim() ? null : "Say why you need this role.";
  const owners = dataset.owners.map((o) => o.displayName).join(", ");
  const description = roles.roles[role];

  useEffect(() => {
    if (reviewing) reviewHeadingRef.current?.focus();
  }, [reviewing]);

  // The form the person was in is gone: put them on what replaced it.
  useEffect(() => {
    if (sent) sentRef.current?.focus();
  }, [sent]);

  const review = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (reasonError) reasonRef.current?.focus();
    else setReviewing(true);
  };
  // Shows in Your requests at once, marked Saving…. A refusal puts the form back as it was.
  const confirm = () => {
    const profile = user.data;
    if (!profile) return;
    const confirmed = { role, reason };
    const started = submit(
      {
        datasetId: dataset.id,
        role,
        reason,
        requester: {
          principalId: profile.principalId ?? "",
          name: profile.name,
          email: profile.email ?? "",
        },
        roleLabel: roles.roles[role].label,
        datasetName: dataset.name,
        owners,
      },
      { idempotencyKey: globalThis.crypto.randomUUID() },
      {
        onRefused: () => {
          setRole(confirmed.role);
          setReason(confirmed.reason);
          setSent(null);
        },
      },
    );
    if (!started) return;
    setSent(role);
    setReviewing(false);
    setReason("");
    setTouched(false);
  };

  const notices = (
    <SaveNotices
      prefixes={[accessRequestRecord(`new:${dataset.id}:`)]}
      label="Your request to the owners"
    />
  );

  if (sent) {
    return (
      <div ref={sentRef} tabIndex={-1} style={{ outline: "none", display: "grid", gap: 12 }}>
        {notices}
        <Notice
          kind="info"
          chrome={chrome}
          title={`Asked ${owners} for ${roles.roles[sent].label}.`}
        >
          Follow it, or withdraw it, from your requests. <BackLink ctx={ctx} />
        </Notice>
      </div>
    );
  }

  return (
    <Panel pad={24}>
      <SectionHead eyebrow="Access request" title="Choose a role" />
      <div style={{ marginBottom: 12 }}>{notices}</div>
      {reviewing ? (
        <section aria-label="Confirm the request">
          <h3 ref={reviewHeadingRef} tabIndex={-1} style={{ margin: "0 0 10px" }}>
            Review your request
          </h3>
          <div style={s.summaryBox}>
            <p style={{ margin: "0 0 10px", fontSize: "var(--font-size-sm)" }}>
              You're asking {owners} for <strong>{description.label}</strong> on{" "}
              <strong>{dataset.name}</strong>. If they approve, you'll get:
            </p>
            <GrantList grants={description.grants} chrome={chrome} />
            <p style={{ margin: "12px 0 0" }}>
              <strong>Your reason:</strong> {reason.trim()}
            </p>
          </div>
          <div style={{ marginTop: 12 }}>
            <SlaTargetNote sla={settings.sla} />
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 18 }}>
            <button type="button" onClick={confirm} style={s.primaryBtn}>
              <Icon name="check" size={18} color="#fff" />
              Send request
            </button>
            <button type="button" onClick={() => setReviewing(false)} style={s.outlineBtn}>
              <Icon name="arrow_back" size={16} color="var(--theme-primary)" />
              Change details
            </button>
          </div>
        </section>
      ) : (
        <form onSubmit={review} aria-label="Request a role" noValidate>
          <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
            <legend style={s.lbl}>
              Dataset role <span style={{ color: "var(--theme-secondary)" }}>*</span>
            </legend>
            <div
              role="radiogroup"
              aria-label="Dataset role"
              aria-required="true"
              onKeyDown={handleRoleGroupKeyDown}
              style={{
                ...s.cardGrid,
                gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 200px), 1fr))",
              }}
            >
              {settings.requestableRoles.map((r) => (
                <RoleCard
                  key={r}
                  role={r}
                  roles={roles}
                  selected={role === r}
                  tabIndex={role === r ? 0 : -1}
                  onSelect={() => setRole(r)}
                  chrome={chrome}
                />
              ))}
            </div>
            {settings.nonRequestableNote ? (
              <div style={s.help}>{settings.nonRequestableNote}</div>
            ) : null}
            <div style={s.help}>{roles.consumerNote}</div>
          </fieldset>
          <div style={{ marginTop: 22 }}>
            <label htmlFor="request-reason" style={s.lbl}>
              Reason <span style={{ color: "var(--theme-secondary)" }}>*</span>
            </label>
            <textarea
              ref={reasonRef}
              id="request-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              aria-required="true"
              aria-invalid={touched && reasonError ? true : undefined}
              aria-describedby={
                touched && reasonError ? "request-reason-error" : "request-reason-help"
              }
              style={{
                ...s.inp,
                resize: "vertical",
                ...(touched && reasonError ? { borderColor: "var(--theme-error)" } : null),
              }}
            />
            {touched && reasonError ? (
              <div id="request-reason-error" role="alert" style={s.fieldError}>
                <Icon name="error" size={14} color="var(--theme-error-dark)" />
                {reasonError}
              </div>
            ) : (
              <div id="request-reason-help" style={s.help}>
                What you'll use the role for. The owners read this.
              </div>
            )}
          </div>
          <div style={{ marginTop: 22 }}>
            <button type="submit" style={s.primaryBtn}>
              Review request
              <Icon name="arrow_forward" size={18} color="#fff" />
            </button>
          </div>
        </form>
      )}
    </Panel>
  );
}
