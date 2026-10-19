import { useCallback, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { loadApp, type LegacyAppProps } from "@/legacy/bootstrap.jsx";
import { StoreProvider, useLegacyAppData, useSubmitRequest } from "@/data";
import type { AccessRequest } from "@/data/types";
import { BackendUnavailableNotice } from "./BackendUnavailableNotice";
import { SaveFailedNotice } from "./SaveFailedNotice";
import { SaveStatusRegion } from "./SaveStatus";
// Attached USWDS design system theme (fonts + tokens). Loaded after the
// project's own styles so its token values take precedence.
import "@/design-system/uswds-design-system-3f2f32/design-system/uswds/styles.css";

function CenteredNotice({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        minHeight: "60vh",
        display: "grid",
        placeItems: "center",
        padding: "24px",
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}

/**
 * Feeds the ported app ALL of its state from the data seam through TanStack
 * Query — catalog, requests and the status timelines — and routes submits back
 * through the seam. There is no window.AppData fallback: while the seam loads
 * we show a loading state, and if it fails (e.g. a backend/config error, or the
 * deferred Delta adapter) we surface the failure instead of masking it with
 * prototype data. So a failing backend is visible, not faked.
 */
function LegacyAppHost({ App }: { App: ComponentType<LegacyAppProps> }) {
  const legacy = useLegacyAppData();
  const submit = useSubmitRequest();
  const submitRequest = useCallback(
    (request: AccessRequest) => {
      submit.mutate(request);
    },
    [submit],
  );

  if (legacy.isError) {
    return (
      <CenteredNotice>
        <BackendUnavailableNotice
          message={legacy.error?.message ?? "Unknown error"}
          onRetry={legacy.retry}
        />
      </CenteredNotice>
    );
  }

  if (legacy.isLoading || !legacy.data) {
    return (
      <CenteredNotice>
        <span style={{ color: "var(--text-muted, #565c65)" }}>Loading IRS Data Access Broker…</span>
      </CenteredNotice>
    );
  }

  return (
    <>
      {submit.isError && submit.error && (
        <SaveFailedNotice error={submit.error} onDismiss={() => submit.reset()} />
      )}
      <App data={legacy.data} submitRequest={submitRequest} />
      <SaveStatusRegion />
    </>
  );
}

export default function BrokerApp() {
  const [App, setApp] = useState<ComponentType<LegacyAppProps> | null>(null);

  useEffect(() => {
    let alive = true;
    loadApp().then((C: ComponentType<LegacyAppProps>) => {
      if (alive) setApp(() => C);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!App) {
    return (
      <CenteredNotice>
        <span style={{ color: "var(--text-muted, #565c65)" }}>Loading IRS Data Access Broker…</span>
      </CenteredNotice>
    );
  }
  return (
    <StoreProvider>
      <LegacyAppHost App={App} />
    </StoreProvider>
  );
}
