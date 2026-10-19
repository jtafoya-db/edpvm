import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  ACTIVE_PRIVACY_NOTICE,
  useAcknowledgePrivacyNotice,
  usePrivacyAcknowledgment,
  useUser,
} from "@/data";
import { apiFailureKind } from "@/data/api-response";
import { EirEmployeeWorkflow, type EirScreenProps } from "./EirEmployeeWorkflow";
import { heading, link, outlineButton, primaryButton, type EirScreenChrome } from "./EirShared";

const DefaultPage: EirScreenChrome["Page"] = ({ children }: { children?: ReactNode }) => (
  <div>{children}</div>
);
const DefaultTrail: EirScreenChrome["Trail"] = () => null;

function SupportContact({ email }: { email: string | undefined }) {
  return email ? (
    <p>
      Need help?{" "}
      <a style={link} href={`mailto:${email}`}>
        Email the EDP support team
      </a>
      .
    </p>
  ) : (
    <p>No support contact is configured for this deployment.</p>
  );
}

export function EirPrivacyGate(props: EirScreenProps) {
  const current = usePrivacyAcknowledgment();
  const acknowledge = useAcknowledgePrivacyNotice();
  const user = useUser();
  const [left, setLeft] = useState(false);
  const [optimistic, setOptimistic] = useState(false);
  const [entered, setEntered] = useState(false);
  const leftHeading = useRef<HTMLHeadingElement>(null);
  const recoveryButton = useRef<HTMLButtonElement>(null);
  const Page = props.chrome?.Page ?? DefaultPage;
  const Trail = props.chrome?.Trail ?? DefaultTrail;

  useEffect(() => {
    if (left) leftHeading.current?.focus();
  }, [left]);

  useEffect(() => {
    if (acknowledge.isError) recoveryButton.current?.focus();
  }, [acknowledge.isError, optimistic]);

  if (current.isLoading || user.isLoading) return <p role="status">Loading privacy notice…</p>;
  if (current.data && !entered) return <EirEmployeeWorkflow {...props} />;
  const leftScreen = (
    <Page>
      <Trail
        items={[
          { label: "Home", ...(props.ctx?.go ? { go: () => props.ctx?.go?.("home") } : {}) },
          { label: "My EIR" },
        ]}
      />
      <section aria-labelledby="privacy-left-heading">
        <h1 ref={leftHeading} tabIndex={-1} id="privacy-left-heading" style={heading}>
          You left the EIR journey
        </h1>
        <p>Nothing about a refusal was recorded.</p>
        <SupportContact email={user.data?.supportEmail} />
        <button type="button" style={primaryButton} onClick={() => props.ctx?.go?.("home")}>
          Go to home
        </button>
      </section>
    </Page>
  );
  if (left && !entered) return leftScreen;
  const error = current.error ?? acknowledge.error;
  const noticeChanged = (error as { code?: string } | null)?.code === "privacy-notice-changed";
  const errorMessage = noticeChanged
    ? "The privacy notice changed. Reload to read the new notice."
    : apiFailureKind(error) === "session-expired"
      ? "Your session expired. Please sign in again, then retry the acknowledgment. We couldn't confirm your acknowledgment."
      : "We couldn't confirm your acknowledgment. Check your connection and retry.";
  const gate = (
    <Page>
      <Trail
        items={[
          { label: "Home", ...(props.ctx?.go ? { go: () => props.ctx?.go?.("home") } : {}) },
          { label: "My EIR" },
        ]}
      />
      <section aria-labelledby="privacy-heading" style={{ maxWidth: 760 }}>
        <h1 id="privacy-heading" style={heading}>
          {ACTIVE_PRIVACY_NOTICE.heading}
        </h1>
        <p>{ACTIVE_PRIVACY_NOTICE.body}</p>
        <p>{ACTIVE_PRIVACY_NOTICE.help}</p>
        <SupportContact email={user.data?.supportEmail} />
        {current.isError || acknowledge.isError ? <p role="alert">{errorMessage}</p> : null}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {noticeChanged ? (
            <button
              ref={recoveryButton}
              type="button"
              style={primaryButton}
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          ) : (
            <button
              ref={recoveryButton}
              type="button"
              style={primaryButton}
              onClick={() => {
                setEntered(true);
                setOptimistic(true);
                void acknowledge.start().then(
                  () => setOptimistic(false),
                  () => setOptimistic(false),
                );
              }}
              disabled={acknowledge.isPending}
            >
              {acknowledge.isError ? "Retry acknowledgment" : "Acknowledge and continue"}
            </button>
          )}
          <button type="button" style={outlineButton} onClick={() => setLeft(true)}>
            Leave without acknowledging
          </button>
        </div>
      </section>
    </Page>
  );
  if (!entered) return gate;
  const showWorkflow = Boolean(current.data || optimistic);
  return (
    <>
      <div hidden={!showWorkflow} aria-hidden={showWorkflow ? undefined : "true"}>
        <EirEmployeeWorkflow {...props} />
      </div>
      {showWorkflow ? null : left ? leftScreen : gate}
    </>
  );
}
