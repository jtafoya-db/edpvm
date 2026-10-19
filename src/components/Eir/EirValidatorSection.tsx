import { EIR_FORMS, LEGACY_EIR_FORMS, useEirForms, useEirInbox, useUser } from "@/data";
import { RefreshButton } from "../RefreshButton";
import { EirValidatorWorkflow } from "./EirValidatorWorkflow";
import type { EirScreenChrome } from "./EirShared";

const DefaultPanel: EirScreenChrome["Panel"] = ({ children, style }) => (
  <section style={style}>{children}</section>
);
const DefaultPill: EirScreenChrome["Pill"] = ({ children }) => <span>{children}</span>;
const DefaultIcon: EirScreenChrome["Icon"] = () => null;
const DefaultSectionHead: EirScreenChrome["SectionHead"] = ({ eyebrow, title, action }) => (
  <div>
    {eyebrow ? <div>{eyebrow}</div> : null}
    <h2>{title}</h2>
    {action}
  </div>
);

/**
 * The safeguards validator's EIR inbox and valid-EIR list, for the EDP Admin
 * page (#159). Moved off My EIR, which now shows only the person's own EIR.
 * Renders nothing for anyone who isn't a validator; the store and server
 * still check every decision.
 */
export function EirValidatorSection({ chrome }: { chrome?: Partial<EirScreenChrome> }) {
  const user = useUser();
  const isValidator = user.data?.isSafeguardsValidator === true;
  const inbox = useEirInbox(isValidator);
  // Answers given on a published definition's form (#201) show with its labels
  // once the form is fetched; until then, or if it can't be, they're listed as stored.
  // Only the app's own forms need no read: the server says what a number names (#224).
  const unknown = [
    ...new Set(
      (inbox.data ?? [])
        .flatMap((item) => [item.formVersion, item.renewal?.formVersion])
        .filter(
          (version): version is string =>
            Boolean(version) && !EIR_FORMS[version!] && !LEGACY_EIR_FORMS[version!],
        ),
    ),
  ].slice(0, 10);
  useEirForms(unknown, isValidator && unknown.length > 0);
  if (!user.data || !isValidator) return null;
  return (
    <EirValidatorWorkflow
      principalId={user.data.principalId}
      items={inbox.data ?? []}
      // #163's load states: a pending or failed read never looks like an empty
      // inbox, and Retry keeps the alert up with its own focus rules.
      isLoading={inbox.isPending}
      loadError={inbox.error}
      isLoadError={inbox.isError}
      retrying={inbox.isFetching}
      onRetry={() => inbox.refetch()}
      refresh={<RefreshButton queries={[inbox]} what="the EIR inbox" />}
      // A PR preview's test mode, from the session (the server enforces it again).
      selfDecisionTestMode={user.data.eirSelfDecisionTestMode === true}
      chrome={{
        Panel: chrome?.Panel ?? DefaultPanel,
        Pill: chrome?.Pill ?? DefaultPill,
        Icon: chrome?.Icon ?? DefaultIcon,
        SectionHead: chrome?.SectionHead ?? DefaultSectionHead,
      }}
    />
  );
}
