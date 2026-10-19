import React from "react";
import { ds } from "./ds.jsx";
import { setData } from "./appDataBridge.js";
import { FeatureGate } from "../features/FeatureGate";
import { EIR_ROUTE } from "../components/Eir/route";
import { SCREEN_CHROME, SHELL_ROUTE_SECTIONS } from "../components/AppShell/legacyMounts";
import { usePrefetchRoute } from "../components/AppShell/usePrefetchRoute";
import { ChangeListScreen, DatasetTeamScreen, DatasetsScreen } from "../components/DatasetAccess";
import { MyOnboardingRequestsMount, legacyChrome } from "./onboarding.jsx";
import {
  EDP_ADMIN_ROUTE,
  EdpAdminScreen,
  IntakeEditorRoute,
  redirectToEdpAdmin,
} from "../components/EdpAdmin";
import {
  AccessInboxScreen,
  MyAccessRequestsScreen,
  RequestAccessScreen,
} from "../components/AccessRequests";
// App shell ported from the IRS Data Access Broker prototype.
// Screens, primitives and the USWDS design system are registered on `window`
// by the modules loaded in ./bootstrap.js before this component renders.
const Banner = ds("Banner");
// route name -> nav section
const SECTION = {
  home: "home",
  search: "browse",
  browse: "browse",
  domain: "browse",
  dataset: "browse",
  bundle: "bundles",
  bundles: "bundles",
  cart: "cart",
  requests: "requests",
  status: "requests",
  access: "access",
  onboarding: "onboarding",
  [EIR_ROUTE.name]: EIR_ROUTE.section,
  admin: "admin",
  ...SHELL_ROUTE_SECTIONS,
  datasets: "datasets",
  team: "datasets",
  "change-list": "change-list",
  "onboarding-requests": "onboarding-requests",
  [EDP_ADMIN_ROUTE.name]: EDP_ADMIN_ROUTE.section,
  "access-requests": "access-requests",
  "access-inbox": "access-requests",
  "request-access": "access-requests",
};

// MVP gate: every mock-backed screen is hidden from nav (see chrome.jsx) and,
// on direct navigation (bookmarked hash), rendered as its coming-soon
// FeatureGate card instead of the mock content. Only the real surfaces — the
// Home landing, the onboarding wizard and the Admin intake editor — render
// their own component. The value is the feature id whose coming-soon status
// drives the card (src/features/registry.ts).
export const GATED_FEATURES = {
  search: "data-discovery",
  browse: "data-discovery",
  domain: "data-discovery",
  dataset: "data-discovery",
  bundles: "access-bundles",
  bundle: "access-bundles",
  cart: "request-cart",
  requests: "request-status-tracking",
  status: "request-status-tracking",
  access: "cross-system-access",
};

function Stub({ name }) {
  return (
    <window.Page>
      <window.Panel pad={48} style={{ textAlign: "center" }}>
        <h2 style={{ fontFamily: "var(--font-heading)" }}>{name}</h2>
        <p style={{ color: "var(--text-muted)" }}>This screen is being built.</p>
      </window.Panel>
    </window.Page>
  );
}

function Toast({ toast }) {
  return (
    <div role="status" aria-live="polite" aria-atomic="true">
      {toast ? (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 100,
            background: "var(--surface-dark)",
            color: "#fff",
            borderRadius: "var(--radius-md)",
            padding: "12px 20px",
            boxShadow: "var(--shadow-4)",
            display: "flex",
            alignItems: "center",
            gap: 10,
            fontSize: "var(--font-size-2xs)",
            fontWeight: 600,
            maxWidth: "calc(100vw - 32px)",
            width: "max-content",
            boxSizing: "border-box",
          }}
        >
          <AppIcon name="check_circle" size={18} color="var(--theme-success-light)" />
          {toast}
        </div>
      ) : null}
    </div>
  );
}

function parseHash() {
  const h = (window.location.hash || "").replace(/^#/, "");
  if (!h) return { name: "home", params: {} };
  const [name, id, q] = h.split("/");
  const params = {};
  if (id) params.id = decodeURIComponent(id);
  if (q) params.q = decodeURIComponent(q);
  return { name, params };
}

// The EDP Admin page (#159) mounts the staff screens with the full legacy chrome.
const EdpAdminMount = (props) => <EdpAdminScreen {...props} chrome={legacyChrome()} />;
// #admin (the intake form editor) is staff-only, like its EDP Admin section.
const AdminMount = (props) => (
  <IntakeEditorRoute {...props} Screen={window.AdminScreen} chrome={legacyChrome()} />
);

function App({ data, submitRequest: submitRequestProp }) {
  // All app state arrives from the data seam through TanStack Query (see
  // src/data/legacy-bridge.ts). We inject it so the ported screens read it via
  // getData() instead of the window.AppData global, and read the request list
  // straight off it. The host guarantees `data` is present before we render.
  setData(data);
  const D = data;
  const requests = D.requests;
  const [hashRoute, setRoute] = React.useState(parseHash);
  // Old staff routes (#review/…, and #change-list for staff) now live on the
  // EDP Admin page (#159): render that section and rewrite the address bar.
  const moved = redirectToEdpAdmin(hashRoute, D.user);
  const route = moved || hashRoute;
  const movedHash = moved ? `${moved.name}/${moved.params.id}` : null;
  React.useEffect(() => {
    if (movedHash) window.history.replaceState(null, "", `#${movedHash}`);
  }, [movedHash]);
  const [cart, setCart] = React.useState([]);
  const [toast, setToast] = React.useState(null);
  const toastTimer = React.useRef(null);
  const prefetchRoute = usePrefetchRoute(route);

  React.useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const flash = (msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2600);
  };

  const go = (name, params = {}) => {
    let h = name;
    if (params.id) h += "/" + encodeURIComponent(params.id);
    else if (params.q != null) h += "//" + encodeURIComponent(params.q);
    window.location.hash = h;
    setRoute({ name, params });
    window.scrollTo({ top: 0 });
  };
  const isInCart = (kind, id) => cart.some((c) => c.kind === kind && c.id === id);
  const addItem = (kind, id, label) => {
    if (isInCart(kind, id)) return;
    setCart((c) => [...c, { kind, id }]);
    flash(`Added to request cart: ${label}`);
  };
  const addDataset = (a) => addItem("dataset", a.id, a.businessName);
  const addBundle = (b) => addItem("bundle", b.id, b.name);
  const removeItem = (kind, id) =>
    setCart((c) => c.filter((x) => !(x.kind === kind && x.id === id)));
  const clearCart = () => setCart([]);

  const submitRequest = (newReq) => {
    submitRequestProp(newReq);
    clearCart();
  };

  const ctx = {
    go,
    route,
    cart,
    isInCart,
    addItem,
    addDataset,
    addBundle,
    removeItem,
    clearCart,
    requests,
    submitRequest,
    flash,
  };

  const section = SECTION[route.name] || "home";
  const screens = {
    home: window.HomeScreen,
    browse: window.BrowseScreen,
    domain: window.DomainScreen,
    dataset: window.DatasetScreen,
    bundle: window.BundleScreen,
    bundles: window.BundlesScreen,
    search: window.SearchScreen,
    cart: window.CartScreen,
    requests: window.RequestsScreen,
    status: window.StatusScreen,
    access: window.AccessScreen,
    onboarding: window.OnboardingScreen,
    [EIR_ROUTE.name]: EIR_ROUTE.Screen,
    admin: AdminMount,
    profile: window.ProfileScreen,
    datasets: DatasetsScreen,
    team: DatasetTeamScreen,
    "change-list": ChangeListScreen,
    // Onboarding request lifecycle (#86): typed TSX screens on the data seam.
    "onboarding-requests": MyOnboardingRequestsMount,
    [EDP_ADMIN_ROUTE.name]: EdpAdminMount,
    "access-requests": MyAccessRequestsScreen,
    "access-inbox": AccessInboxScreen,
    "request-access": RequestAccessScreen,
  };
  const Screen = screens[route.name];
  const gatedId = GATED_FEATURES[route.name];

  return (
    <div>
      <Banner />
      <window.TopNav
        route={{ ...route, section }}
        go={go}
        cartCount={cart.length}
        prefetchRoute={prefetchRoute}
      />
      <main>
        {Screen ? (
          gatedId ? (
            // Mock-backed surface: show the honest coming-soon card, never the
            // mock screen behind it.
            <window.Page>
              <FeatureGate id={gatedId}>
                <Screen ctx={ctx} params={route.params} />
              </FeatureGate>
            </window.Page>
          ) : (
            <Screen ctx={ctx} params={route.params} chrome={SCREEN_CHROME} />
          )
        ) : (
          <Stub name={route.name} />
        )}
        <Toast toast={toast} />
      </main>
      <window.AppFooter go={go} />
    </div>
  );
}

export default App;
