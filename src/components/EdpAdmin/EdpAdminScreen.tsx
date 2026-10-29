// The EDP Admin page (#159): one staff-only page that mounts the existing staff
// screens, unchanged, as sections. A pilot stopgap before the separate staff
// app (#132). Each section shows only to the roles that can act on it; the
// store and server keep every permission check they had.
import type { ReactNode } from "react";

import { useUser } from "@/data";
import { ChangeListScreen, type DatasetAccessChrome } from "@/components/DatasetAccess";
import type { EirScreenChrome } from "@/components/Eir/EirShared";
import { EirValidatorSection } from "@/components/Eir/EirValidatorSection";
import { EirDefinitionWorkspace } from "@/components/EirDefinitions/EirDefinitionWorkspace";
import { OnboardingInboxScreen } from "@/components/Onboarding";
import type { OnboardingChrome } from "@/components/Onboarding/chrome";
import { h1, primaryBtn, subtitle } from "@/components/DatasetAccess/styles";
import { EDP_ADMIN_ROUTE, visibleSections, type EdpAdminSectionId } from "./access";
import { OwnerReassignmentSection } from "./OwnerReassignmentSection";

type AdminChrome = OnboardingChrome & DatasetAccessChrome & EirScreenChrome;

export interface EdpAdminScreenProps {
  ctx: { go: (name: string, params?: { id?: string }) => void };
  params?: { id?: string };
  chrome?: Partial<AdminChrome>;
}

const Plain = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
const Bare = ({ children }: { children?: ReactNode }) => <>{children}</>;
const NoTrail = () => null;
const DefaultTrail = ({ items }: { items: Array<{ label: string }> }) => (
  <nav aria-label="Breadcrumb">{items.map((item) => item.label).join(" / ")}</nav>
);

export function NotAvailable({ children }: { children: ReactNode }) {
  return (
    <>
      <h1 style={h1}>Not available</h1>
      <p style={subtitle}>{children}</p>
    </>
  );
}

export function EdpAdminScreen({ ctx, params, chrome = {} }: EdpAdminScreenProps) {
  const Page = chrome.Page ?? Plain;
  const Trail = chrome.Trail ?? DefaultTrail;
  const Panel = chrome.Panel ?? Plain;
  // A mounted screen draws inside this page: no page shell or trail of its own.
  const embedded = { ...chrome, Page: Bare, Trail: NoTrail };
  const user = useUser();
  const sections = visibleSections(user.data);
  const requested = sections.find((section) => section.id === params?.id);
  const current = params?.id ? requested : sections[0];
  const home = { label: "Home", go: () => ctx.go("home") };

  if (user.isPending) {
    return (
      <Page>
        <p style={subtitle}>Loading…</p>
      </Page>
    );
  }
  if (user.isError) {
    return (
      <Page>
        <p role="alert" style={subtitle}>
          Could not resolve who you are: {user.error.message}
        </p>
      </Page>
    );
  }
  if (sections.length === 0) {
    return (
      <Page>
        <Trail items={[home, { label: "EDP Admin" }]} />
        <NotAvailable>
          This page is for EDP staff: direct members of the EDP admin group.
        </NotAvailable>
      </Page>
    );
  }

  const body: Record<EdpAdminSectionId, () => ReactNode> = {
    "business-office": () => (
      <OnboardingInboxScreen ctx={ctx} params={{ id: "business-office" }} chrome={embedded} />
    ),
    ccb: () => <OnboardingInboxScreen ctx={ctx} params={{ id: "ccb" }} chrome={embedded} />,
    eir: () => (
      <>
        <h1 style={h1}>EIR validation</h1>
        <p style={{ ...subtitle, marginBottom: 20 }}>
          Submitted EIRs waiting on a safeguards validator, and every valid EIR. Your own EIR is on
          My EIR.
        </p>
        <EirValidatorSection chrome={chrome} />
      </>
    ),
    "eir-definitions": () => <EirDefinitionWorkspace />,
    "change-list": () => <ChangeListScreen ctx={ctx} chrome={embedded} />,
    "owner-reassignment": () => <OwnerReassignmentSection chrome={chrome} />,
    "intake-editor": () => (
      <>
        <h1 style={h1}>Intake form editor</h1>
        <p style={{ ...subtitle, marginBottom: 20 }}>
          Change the questions on the onboarding intake form.
        </p>
        <Panel pad={24}>
          <p style={{ ...subtitle, marginBottom: 16 }}>The editor is on the Admin console page.</p>
          <button type="button" style={primaryBtn} onClick={() => ctx.go("admin")}>
            Open the intake form editor
          </button>
        </Panel>
      </>
    ),
  };

  return (
    <Page>
      <Trail
        items={[
          home,
          current
            ? { label: "EDP Admin", go: () => ctx.go(EDP_ADMIN_ROUTE.name) }
            : { label: "EDP Admin" },
          ...(current ? [{ label: current.label }] : []),
        ]}
      />
      <nav
        aria-label="EDP Admin sections"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
          borderBottom: "1px solid var(--border-default)",
          marginBottom: 22,
        }}
      >
        {sections.map((section) => {
          const active = section.id === current?.id;
          return (
            <a
              key={section.id}
              href={`#${EDP_ADMIN_ROUTE.name}/${section.id}`}
              aria-label={section.ariaLabel}
              aria-current={active ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                ctx.go(EDP_ADMIN_ROUTE.name, { id: section.id });
              }}
              style={{
                padding: "11px 16px",
                fontFamily: "var(--font-sans)",
                fontSize: "var(--font-size-2xs)",
                fontWeight: active ? 700 : 500,
                color: active ? "var(--theme-primary)" : "var(--color-gray-cool-60)",
                textDecoration: "none",
                borderBottom: active ? "3px solid var(--theme-primary)" : "3px solid transparent",
                marginBottom: -1,
              }}
            >
              {section.label}
            </a>
          );
        })}
      </nav>
      {current ? (
        body[current.id]()
      ) : (
        <NotAvailable>
          This section is for a role you don&apos;t hold. Choose one of your sections above.
        </NotAvailable>
      )}
    </Page>
  );
}
