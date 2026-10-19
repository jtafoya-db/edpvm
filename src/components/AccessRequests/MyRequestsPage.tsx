import { useEffect, useRef, useState } from "react";

import { SaveNotices, SavingTag } from "@/components/SaveStatus";
import {
  accessRequestRecord,
  useAccessRequestInbox,
  useAccessRequestSettings,
  useMyAccessRequests,
  withdrawAccessRequestSave,
} from "@/data/access-requests/queries";
import { useSave, useSavesUnder } from "@/data/optimistic-save";
import { samePrincipal } from "@/data/access-requests/ownership";
import type { DatasetAccessRequest } from "@/data/access-requests/types";
import { useDatasets, useRoleDescriptions } from "@/data/datasets/queries";
import type { RoleDescriptions } from "@/data/datasets/role-descriptions";
import type { Dataset } from "@/data/datasets/types";
import { isDatasetOwner } from "@/data/datasets/ownership";
import { useUser } from "@/data/queries";
import type { UserProfile } from "@/data/types";
import { FeatureGate } from "@/features/FeatureGate";
import { QueryGate, Timestamp } from "../DatasetAccess/chrome";
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
import { srOnly } from "./a11y";

/**
 * A person's access requests: the datasets they can ask for a role on, with
 * the owners who decide, and the stage of every request they've made.
 */
export function MyAccessRequestsScreen({ ctx, chrome: injected }: ScreenProps) {
  const chrome = resolveChrome(injected);
  const { Page, Trail } = chrome;
  const datasets = useDatasets();
  const mine = useMyAccessRequests();
  const inbox = useAccessRequestInbox();
  const roles = useRoleDescriptions();
  const settings = useAccessRequestSettings();
  const user = useUser();

  return (
    <Page>
      <Trail items={[{ label: "Home", go: () => ctx.go("home") }, { label: "Access requests" }]} />
      <FeatureGate id="access-requests">
        <div style={s.titleRow}>
          <div>
            <h1 style={s.h1}>Access requests</h1>
            <p style={s.subtitle}>
              Ask a dataset's owners for a dataset role. They approve or reject it in the app.
            </p>
          </div>
        </div>
        <RequestTabs
          ctx={ctx}
          current="access-requests"
          inboxCount={inbox.data?.filter((r) => r.status === "requested").length}
          chrome={chrome}
        />
        <QueryGate
          isPending={
            datasets.isPending ||
            mine.isPending ||
            roles.isPending ||
            settings.isPending ||
            user.isPending
          }
          error={datasets.error ?? mine.error ?? roles.error ?? settings.error ?? user.error}
          chrome={chrome}
        >
          {datasets.data && mine.data && roles.data && settings.data && user.data ? (
            <div style={s.stack}>
              <RequestStateNotice chrome={chrome} />
              <SlaTargetNote sla={settings.data.sla} />
              <AskPanel ctx={ctx} chrome={chrome} datasets={datasets.data} user={user.data} />
              <YourRequests
                chrome={chrome}
                requests={mine.data}
                datasets={datasets.data}
                roles={roles.data}
              />
            </div>
          ) : null}
        </QueryGate>
      </FeatureGate>
    </Page>
  );
}

/** Every dataset with the owners to ask, and a way to ask. */
function AskPanel({
  ctx,
  chrome,
  datasets,
  user,
}: {
  ctx: ScreenCtx;
  chrome: DatasetAccessChrome;
  datasets: Dataset[];
  user: UserProfile;
}) {
  const { Panel, SectionHead, Icon } = chrome;
  return (
    <div>
      <SectionHead eyebrow="Datasets" title="Ask for a dataset role" />
      <Panel pad={0} style={{ overflow: "hidden" }}>
        <TableScroll label="Datasets to request" minWidth={620}>
          <table style={s.table} aria-label="Datasets to request">
            <thead>
              <tr style={s.headRow}>
                {["Dataset", "Domain", "Owners to ask"].map((h) => (
                  <th key={h} style={s.th}>
                    {h}
                  </th>
                ))}
                <th style={s.th}>
                  <span style={srOnly}>Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {datasets.map((dataset) => {
                const owned = isDatasetOwner(dataset, user);
                return (
                  <tr key={dataset.id} style={s.row}>
                    <td style={{ ...s.td, fontWeight: 700 }}>{dataset.name}</td>
                    <td style={s.td}>
                      <code style={s.mono}>{dataset.domainTag}</code>
                    </td>
                    <td style={s.td}>{dataset.owners.map((o) => o.displayName).join(", ")}</td>
                    <td style={{ ...s.td, textAlign: "right" }}>
                      {owned ? (
                        <span style={s.muted}>You own this dataset</span>
                      ) : (
                        <a
                          href={`#request-access/${encodeURIComponent(dataset.id)}`}
                          aria-label={`Request a role on ${dataset.name}`}
                          onClick={(e) => {
                            e.preventDefault();
                            ctx.go("request-access", { id: dataset.id });
                          }}
                          style={s.linkBtn}
                        >
                          Request a role
                          <Icon name="chevron_right" size={16} />
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      </Panel>
    </div>
  );
}

function YourRequests({
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
  const { Panel, SectionHead, Icon } = chrome;
  const withdraw = useSave(withdrawAccessRequestSave);
  const user = useUser();
  const saves = useSavesUnder("access-request:");
  const unresolved = (id: string) =>
    [...saves]
      .reverse()
      .find(
        (save) =>
          save.record === accessRequestRecord(id) &&
          (save.state === "saving" || save.state === "unconfirmed"),
      );
  const [confirming, setConfirming] = useState<string | null>(null);
  const returnFocusTo = useRef<string | null>(null);
  const withdrawButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const doneRef = useRef<HTMLDivElement>(null);
  const byId = new Map(datasets.map((d) => [d.id, d]));
  const ownerName = (dataset: Dataset | undefined, id: string) =>
    dataset?.owners.find((o) => samePrincipal(o.principalId, id))?.displayName ?? id;
  const confirmingRequest = requests.find((r) => r.id === confirming && r.status === "requested");

  useEffect(() => {
    if (confirming || !returnFocusTo.current) return;
    withdrawButtonRefs.current.get(returnFocusTo.current)?.focus();
    returnFocusTo.current = null;
  }, [confirming]);

  const keep = (id: string) => {
    returnFocusTo.current = id;
    setConfirming(null);
  };
  // The request shows as withdrawn at once, marked Saving…. Its button goes
  // with it, so focus moves to the notices that say how the save is going.
  const confirmWithdraw = (request: DatasetAccessRequest) => {
    const started = withdraw(
      {
        id: request.id,
        by: user.data?.principalId ?? "",
        datasetName: byId.get(request.datasetId)?.name ?? request.datasetId,
        roleLabel: roles.roles[request.role].label,
      },
      { idempotencyKey: globalThis.crypto.randomUUID() },
    );
    if (!started) return;
    setConfirming(null);
    doneRef.current?.focus();
  };

  return (
    <div>
      <SectionHead eyebrow="Stage" title="Your requests" />
      <div ref={doneRef} tabIndex={-1} style={{ marginBottom: 12, outline: "none" }}>
        <SaveNotices prefixes={["access-request:"]} label="Your request changes" />
      </div>
      {requests.length === 0 ? (
        <Panel pad={24}>
          <span style={{ color: "var(--text-muted)" }}>You haven't asked for a role yet.</span>
        </Panel>
      ) : (
        <>
          {confirmingRequest ? (
            <ConfirmWithdraw
              chrome={chrome}
              request={confirmingRequest}
              datasetName={
                byId.get(confirmingRequest.datasetId)?.name ?? confirmingRequest.datasetId
              }
              roleLabel={roles.roles[confirmingRequest.role].label}
              onConfirm={() => confirmWithdraw(confirmingRequest)}
              onKeep={() => keep(confirmingRequest.id)}
            />
          ) : null}
          <Panel pad={0} style={{ overflow: "hidden" }}>
            <TableScroll label="Your requests" minWidth={780}>
              <table style={s.table} aria-label="Your requests">
                <thead>
                  <tr style={s.headRow}>
                    {["Request", "Role", "Your reason", "Stage", "Decision"].map((h) => (
                      <th key={h} style={s.th}>
                        {h}
                      </th>
                    ))}
                    <th style={s.th}>
                      <span style={srOnly}>Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((request) => {
                    const dataset = byId.get(request.datasetId);
                    return (
                      <tr key={request.id} style={s.row}>
                        <td style={s.td}>
                          <div style={{ fontWeight: 700 }}>
                            {dataset?.name ?? request.datasetId}
                          </div>
                          <div style={s.muted}>
                            {request.id} · <Timestamp iso={request.requestedAt} />
                          </div>
                        </td>
                        <td style={s.td}>{roles.roles[request.role].label}</td>
                        <td style={{ ...s.td, maxWidth: 260 }}>{request.reason}</td>
                        <td style={s.td}>
                          {unresolved(request.id) ? (
                            <SavingTag save={unresolved(request.id)} />
                          ) : (
                            <StatusPill status={request.status} chrome={chrome} />
                          )}
                        </td>
                        <td style={s.td}>
                          {request.sla ? (
                            <>
                              <SlaPill sla={request.sla} chrome={chrome} />
                              {request.sla.escalationAppropriate ? (
                                <div style={s.muted}>Past the owners' SLA. You can follow up.</div>
                              ) : null}
                            </>
                          ) : request.outcome ? (
                            <div style={s.muted}>
                              {request.status === "withdrawn"
                                ? "You withdrew it"
                                : `By ${ownerName(dataset, request.outcome.by)}`}{" "}
                              · <Timestamp iso={request.outcome.at} />
                              {request.outcome.note ? (
                                <div style={{ color: "var(--text-default)", marginTop: 2 }}>
                                  “{request.outcome.note}”
                                </div>
                              ) : null}
                            </div>
                          ) : null}
                        </td>
                        <td style={{ ...s.td, textAlign: "right" }}>
                          {request.status === "requested" ? (
                            <button
                              ref={(node) => {
                                if (node) withdrawButtonRefs.current.set(request.id, node);
                                else withdrawButtonRefs.current.delete(request.id);
                              }}
                              id={`withdraw-${request.id}`}
                              type="button"
                              aria-label={`Withdraw ${request.id}`}
                              onClick={() => setConfirming(request.id)}
                              style={dangerBtn}
                            >
                              <Icon name="close" size={16} color="var(--theme-error-dark)" />
                              Withdraw
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableScroll>
          </Panel>
        </>
      )}
    </div>
  );
}

const dangerBtn = {
  ...s.outlineBtn,
  color: "var(--theme-error-dark)",
  borderColor: "var(--color-red-cool-30v)",
};

/** The step before a withdrawal: it ends the request, so say what that means first. */
function ConfirmWithdraw({
  chrome,
  request,
  datasetName,
  roleLabel,
  onConfirm,
  onKeep,
}: {
  chrome: DatasetAccessChrome;
  request: DatasetAccessRequest;
  datasetName: string;
  roleLabel: string;
  onConfirm: () => void;
  onKeep: () => void;
}) {
  const { Icon } = chrome;
  const explainId = `withdraw-${request.id}-explain`;
  return (
    <section
      aria-label={`Confirm withdrawing ${request.id}`}
      onKeyDown={(event) => {
        if (event.key === "Escape") onKeep();
      }}
      style={{ ...s.summaryBox, marginBottom: 12 }}
    >
      <p id={explainId} style={{ margin: 0, fontSize: "var(--font-size-2xs)" }}>
        Withdraw <strong>{request.id}</strong>, your request for <strong>{roleLabel}</strong> on{" "}
        <strong>{datasetName}</strong>? It ends the request now: its owners can no longer approve or
        reject it. To get the role later, you'll need to ask again.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 14 }}>
        <button type="button" onClick={onConfirm} aria-describedby={explainId} style={dangerBtn}>
          <Icon name="close" size={16} color="var(--theme-error-dark)" />
          Withdraw request
        </button>
        <button
          type="button"
          autoFocus
          onClick={onKeep}
          aria-describedby={explainId}
          style={s.outlineBtn}
        >
          Keep it
        </button>
      </div>
    </section>
  );
}
