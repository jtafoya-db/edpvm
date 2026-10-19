// The #admin route, where the intake form editor lives. Its EDP Admin section
// is staff-only, so the route is too: anyone who can't act on that section
// sees the same "Not available" page as EDP Admin. Staff get a way back to it.
import type { ComponentType, ReactNode } from "react";

import { useUser } from "@/data";
import { subtitle } from "@/components/DatasetAccess/styles";
import { EDP_ADMIN_ROUTE, visibleSections } from "./access";
import { NotAvailable } from "./EdpAdminScreen";

interface Ctx {
  go: (name: string, params?: { id?: string }) => void;
}

export interface IntakeEditorRouteProps {
  ctx: Ctx;
  params?: Record<string, string | undefined>;
  /** The legacy Admin console screen this route guards. */
  Screen: ComponentType<{ ctx: Ctx; params: Record<string, string | undefined> }>;
  chrome?: {
    Page?: ComponentType<{ children?: ReactNode }>;
    Trail?: ComponentType<{ items: Array<{ label: string; go?: () => void }> }>;
  };
}

const Plain = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
const DefaultTrail = ({ items }: { items: Array<{ label: string }> }) => (
  <nav aria-label="Breadcrumb">{items.map((item) => item.label).join(" / ")}</nav>
);

export function IntakeEditorRoute({
  ctx,
  params = {},
  Screen,
  chrome = {},
}: IntakeEditorRouteProps) {
  const Page = chrome.Page ?? Plain;
  const Trail = chrome.Trail ?? DefaultTrail;
  const user = useUser();

  if (user.isPending) {
    return (
      <Page>
        <p style={subtitle}>Loading…</p>
      </Page>
    );
  }
  const isStaff = visibleSections(user.data).some((section) => section.id === "intake-editor");
  if (user.isError || !isStaff) {
    return (
      <Page>
        <Trail items={[{ label: "Home", go: () => ctx.go("home") }, { label: "Admin console" }]} />
        <NotAvailable>This page is for EDP staff.</NotAvailable>
      </Page>
    );
  }

  return (
    <>
      <div style={{ background: "var(--color-gray-cool-2)" }}>
        <div style={{ maxWidth: 1240, margin: "0 auto", padding: "16px 24px 0" }}>
          <a
            href={`#${EDP_ADMIN_ROUTE.name}/intake-editor`}
            onClick={(e) => {
              e.preventDefault();
              ctx.go(EDP_ADMIN_ROUTE.name, { id: "intake-editor" });
            }}
            style={{
              fontSize: "var(--font-size-2xs)",
              fontWeight: 600,
              color: "var(--theme-primary)",
            }}
          >
            ← Back to EDP Admin
          </a>
        </div>
      </div>
      <Screen ctx={ctx} params={params} />
    </>
  );
}
