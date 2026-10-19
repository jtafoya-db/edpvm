import { useEffect, useRef, useState } from "react";

import { SaveNotices, SavingTag } from "@/components/SaveStatus";
import {
  accessRequestRecord,
  approveAccessRequestSave,
  rejectAccessRequestSave,
  useAccessRequestInbox,
  useAccessRequestSettings,
} from "@/data/access-requests/queries";
import { useSave, useSavesUnder } from "@/data/optimistic-save";
import { samePrincipal } from "@/data/access-requests/ownership";
import type { DatasetAccessRequest } from "@/data/access-requests/types";
import { useDatasets, useRoleDescriptions } from "@/data/datasets/queries";
import type { RoleDescriptions } from "@/data/datasets/role-descriptions";
import type { Dataset } from "@/data/datasets/types";
import { isDatasetOwner } from "@/data/datasets/ownership";
import { useUser } from "@/data/queries";
import { FeatureGate } from "@/features/FeatureGate";
import { RefreshButton } from "../RefreshButton";
import {
  ActionErrorNotice,
  GrantList,
  Notice,
  QueryGate,
  Timestamp,
} from "../DatasetAccess/chrome";
import {
  resolveChrome,
  type DatasetAccessChrome,
  type ScreenCtx,
  type ScreenProps,
} from "../DatasetAccess/resolveChrome";
import * as s from "../DatasetAccess/styles";
import {
  RequestStateNotice,
  RequestTabs,
  SlaPill,
  SlaTargetNote,
  StatusPill,
  TableScroll,
} from "./parts";

type Filter = "open" | "decided";

/**
 * A dataset owner's inbox: the access requests for the datasets they own.
 * Open requests show their SLA state, and the owner approves (a direct add,
 * change-list entry included) or rejects each one.
 */
export function AccessInboxScreen({ ctx, chrome: injected }: ScreenProps) {
  const chrome = resolveChrome(injected);
  const { Page, Trail } = chrome;
  const inbox = useAccessRequestInbox();
  const datasets = useDatasets();
  const roles = useRoleDescriptions();
  const settings = useAccessRequestSettings();
  const user = useUser();
  const [filter, setFilter] = useState<Filter>("open");
  const noticesRef = useRef<HTMLDivElement>(null);

  const all = inbox.data ?? [];
  const open = all.filter((r) => r.status === "requested");
  const decided = all.filter((r) => r.status !== "requested").reverse();
  const owned = user.data ? (datasets.data ?? []).filter((d) => isDatasetOwner(d, user.data)) : [];

  return (
    <Page>
      <Trail
        items={[
          { label: "Home", go: () => ctx.go("home") },
          { label: "Access requests", go: () => ctx.go("access-requests") },
          { label: "Owner inbox" },
        ]}
      />
      <FeatureGate id="access-requests">
        <div style={s.titleRow}>
          <div>
            <h1 style={s.h1}>Access requests</h1>
            <p style={s.subtitle}>
              Requests for the datasets you own. Approving adds the person to the dataset, just as
              adding them on the team page does.
            </p>
          </div>
          {inbox.data ? <RefreshButton queries={[inbox]} what="the access request inbox" /> : null}
        </div>
        <RequestTabs ctx={ctx} current="access-inbox" inboxCount={open.length} chrome={chrome} />
        <QueryGate
          isPending={
            inbox.isPending ||
            datasets.isPending ||
            roles.isPending ||
            settings.isPending ||
            user.isPending
          }
          error={inbox.error ?? datasets.error ?? roles.error ?? settings.error ?? user.error}
          chrome={chrome}
        >
          {roles.data && settings.data ? (
            <div style={s.stack}>
              <RequestStateNotice chrome={chrome} />
              <SlaTargetNote sla={settings.data.sla} />
              <div ref={noticesRef} tabIndex={-1} style={{ outline: "none" }}>
                <SaveNotices prefixes={["access-request:"]} label="Your decisions" />
              </div>
              {owned.length === 0 ? (
                <Notice kind="info" chrome={chrome} title="You don't own any datasets">
                  This inbox lists access requests for the datasets you own.
                </Notice>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <Chip
                      label="Open"
                      count={open.length}
                      active={filter === "open"}
                      onClick={() => setFilter("open")}
                    />
                    <Chip
                      label="Decided"
                      count={decided.length}
                      active={filter === "decided"}
                      onClick={() => setFilter("decided")}
                    />
                  </div>
                  {filter === "open" ? (
                    <OpenRequests
                      ctx={ctx}
                      chrome={chrome}
                      onDecided={() => noticesRef.current?.focus()}
                      requests={open}
                      datasets={owned}
                      roles={roles.data}
                    />
                  ) : (
                    <DecidedRequests
                      chrome={chrome}
                      requests={decided}
                      datasets={owned}
                      roles={roles.data}
                    />
                  )}
                </>
              )}
            </div>
          ) : null}
        </QueryGate>
      </FeatureGate>
    </Page>
  );
}

function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        border: `1px solid ${active ? "var(--theme-primary)" : "var(--border-strong)"}`,
        borderRadius: "var(--radius-pill)",
        padding: "7px 15px",
        cursor: "pointer",
        background: active ? "var(--color-blue-5v)" : "var(--surface-default)",
        color: active ? "var(--theme-primary)" : "var(--color-gray-cool-70)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--font-size-2xs)",
        fontWeight: active ? 700 : 500,
      }}
    >
      {label} · {count}
    </button>
  );
}

function OpenRequests({
  chrome,
  requests,
  datasets,
  roles,
  onDecided,
}: {
  ctx: ScreenCtx;
  /** A decision started: its card is gone, so focus goes to the notices saying how it's going. */
  onDecided: () => void;
  chrome: DatasetAccessChrome;
  requests: DatasetAccessRequest[];
  datasets: Dataset[];
  roles: RoleDescriptions;
}) {
  const { Panel } = chrome;
  const approve = useSave(approveAccessRequestSave);
  const reject = useSave(rejectAccessRequestSave);
  const user = useUser();
  const byId = new Map(datasets.map((d) => [d.id, d]));
  // A decision leaves Open at once; Decided shows it marked Saving… until the server confirms.
  const decision = (request: DatasetAccessRequest) => ({
    request,
    by: user.data?.principalId ?? "",
    datasetName: byId.get(request.datasetId)?.name ?? request.datasetId,
    roleLabel: roles.roles[request.role].label,
  });
  const intent = () => ({ idempotencyKey: globalThis.crypto.randomUUID() });

  return requests.length === 0 ? (
    <Panel pad={24}>
      <span style={{ color: "var(--text-muted)" }}>No requests are waiting on you.</span>
    </Panel>
  ) : (
    <>
      {requests.map((request) => (
        <OpenRequest
          key={request.id}
          chrome={chrome}
          request={request}
          dataset={byId.get(request.datasetId)}
          roles={roles}
          onApprove={() => {
            if (approve(decision(request), intent())) onDecided();
          }}
          onReject={(note) => {
            if (reject({ ...decision(request), note }, intent())) onDecided();
          }}
        />
      ))}
    </>
  );
}

function OpenRequest({
  chrome,
  request,
  dataset,
  roles,
  onApprove,
  onReject,
}: {
  chrome: DatasetAccessChrome;
  request: DatasetAccessRequest;
  dataset: Dataset | undefined;
  roles: RoleDescriptions;
  onApprove: () => void;
  onReject: (note: string) => void;
}) {
  const { Panel, Icon } = chrome;
  const [mode, setMode] = useState<"idle" | "approve" | "reject">("idle");
  const [note, setNote] = useState("");
  const decisionHeadingRef = useRef<HTMLHeadingElement>(null);
  const role = roles.roles[request.role];
  const dangerBtn = {
    ...s.outlineBtn,
    color: "var(--theme-error-dark)",
    borderColor: "var(--color-red-cool-30v)",
  };

  useEffect(() => {
    if (mode !== "idle") decisionHeadingRef.current?.focus();
  }, [mode]);

  return (
    <Panel pad={24}>
      <article aria-label={`${request.id} from ${request.requester.name}`}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap-reverse",
            justifyContent: "space-between",
            gap: "8px 16px",
          }}
        >
          <div style={{ minWidth: 0, flex: "1 1 260px" }}>
            <h2
              style={{ margin: 0, fontFamily: "var(--font-sans)", fontSize: "var(--font-size-sm)" }}
            >
              {request.requester.name} asks for {role.label} on {dataset?.name ?? request.datasetId}
            </h2>
            <div style={{ ...s.muted, marginTop: 2 }}>
              {request.requester.email} · {request.id} · requested{" "}
              <Timestamp iso={request.requestedAt} />
            </div>
            <p style={{ margin: "10px 0 0", fontSize: "var(--font-size-2xs)" }}>
              <strong>Reason:</strong> {request.reason}
            </p>
          </div>
          <div style={{ flexShrink: 0 }}>
            {request.sla ? <SlaPill sla={request.sla} chrome={chrome} /> : null}
          </div>
        </div>

        {mode === "approve" ? (
          <section aria-label="Confirm the approval" style={{ marginTop: 16 }}>
            <h3 ref={decisionHeadingRef} tabIndex={-1} style={{ margin: "0 0 10px" }}>
              Review approval
            </h3>
            <div style={s.summaryBox}>
              <p style={{ margin: "0 0 10px" }}>
                Approving adds <strong>{request.requester.email}</strong> as{" "}
                <strong>{role.label}</strong> and puts an add-member entry on the change list. They
                will get:
              </p>
              <GrantList grants={role.grants} chrome={chrome} />
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 14 }}>
              <button type="button" onClick={onApprove} style={s.primaryBtn}>
                <Icon name="check" size={18} color="#fff" />
                Confirm approval
              </button>
              <button type="button" onClick={() => setMode("idle")} style={s.outlineBtn}>
                Cancel
              </button>
            </div>
          </section>
        ) : mode === "reject" ? (
          <section aria-label="Confirm the rejection" style={{ marginTop: 16 }}>
            <h3 ref={decisionHeadingRef} tabIndex={-1} style={{ margin: "0 0 10px" }}>
              Review rejection
            </h3>
            <label htmlFor={`${request.id}-note`} style={s.lbl}>
              Note to {request.requester.name} (optional)
            </label>
            <textarea
              id={`${request.id}-note`}
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              style={{ ...s.inp, resize: "vertical" }}
            />
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 14 }}>
              <button type="button" onClick={() => onReject(note)} style={dangerBtn}>
                <Icon name="close" size={16} color="var(--theme-error-dark)" />
                Confirm rejection
              </button>
              <button type="button" onClick={() => setMode("idle")} style={s.outlineBtn}>
                Cancel
              </button>
            </div>
          </section>
        ) : (
          <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
            <button type="button" onClick={() => setMode("approve")} style={s.primaryBtn}>
              Approve
            </button>
            <button type="button" onClick={() => setMode("reject")} style={dangerBtn}>
              Reject
            </button>
          </div>
        )}
      </article>
    </Panel>
  );
}

function DecidedRequests({
  chrome,
  requests,
  datasets,
  roles,
}: {
  chrome: DatasetAccessChrome;
  requests: DatasetAccessRequest[];
  datasets: Dataset[];
  roles: RoleDescriptions;
}) {
  const { Panel } = chrome;
  const byId = new Map(datasets.map((d) => [d.id, d]));
  const saves = useSavesUnder("access-request:");
  const unresolved = (id: string) =>
    [...saves]
      .reverse()
      .find(
        (save) =>
          save.record === accessRequestRecord(id) &&
          (save.state === "saving" || save.state === "unconfirmed"),
      );
  if (requests.length === 0) {
    return (
      <Panel pad={24}>
        <span style={{ color: "var(--text-muted)" }}>Nothing has been decided yet.</span>
      </Panel>
    );
  }
  return (
    <Panel pad={0} style={{ overflow: "hidden" }}>
      <TableScroll label="Decided requests" minWidth={860}>
        <table style={s.table} aria-label="Decided requests">
          <thead>
            <tr style={s.headRow}>
              {["Request", "Person", "Role", "Stage", "By", "When", "Change list"].map((h) => (
                <th key={h} style={s.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {requests.map((request) => {
              const dataset = byId.get(request.datasetId);
              const by = request.outcome?.by ?? "";
              const byName =
                request.status === "withdrawn"
                  ? `${request.requester.name} (withdrew)`
                  : (dataset?.owners.find((o) => samePrincipal(o.principalId, by))?.displayName ??
                    by);
              return (
                <tr key={request.id} style={s.row}>
                  <td style={s.td}>
                    <div style={{ fontWeight: 700 }}>{dataset?.name ?? request.datasetId}</div>
                    <div style={s.muted}>{request.id}</div>
                  </td>
                  <td style={s.td}>
                    <div>{request.requester.name}</div>
                    <div style={s.muted}>{request.requester.email}</div>
                  </td>
                  <td style={s.td}>{roles.roles[request.role].label}</td>
                  <td style={s.td}>
                    {unresolved(request.id) ? (
                      <SavingTag save={unresolved(request.id)} />
                    ) : (
                      <StatusPill status={request.status} chrome={chrome} />
                    )}
                    {request.outcome?.note ? (
                      <div style={{ ...s.muted, marginTop: 4 }}>“{request.outcome.note}”</div>
                    ) : null}
                  </td>
                  <td style={s.td}>{byName}</td>
                  <td style={{ ...s.td, ...s.muted }}>
                    {request.outcome ? <Timestamp iso={request.outcome.at} /> : null}
                  </td>
                  <td style={s.td}>
                    {request.changeListEntryIds.length ? (
                      request.changeListEntryIds.map((id) => (
                        <code key={id} style={s.mono}>
                          {id}
                        </code>
                      ))
                    ) : (
                      <span style={{ color: "var(--text-muted)" }}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableScroll>
    </Panel>
  );
}
