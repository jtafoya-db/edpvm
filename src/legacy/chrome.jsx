import React from "react";
import { getData } from "./appDataBridge.js";
import { ds } from "./ds.jsx";
import { EIR_NAV_ITEM } from "../components/Eir/route";
import { EDP_ADMIN_NAV_ITEM, isEdpStaff } from "../components/EdpAdmin/access";
// App chrome: top navigation bar, global search, cart button, footer.
const DSButton = ds("Button", "button");

function TopNav({ route, go, prefetchRoute }) {
  const D = getData();
  // MVP navigation: only the surfaces that are genuinely real. Discovery,
  // bundles, cart, requests and access are mock-backed and hidden (their
  // screens are gated behind coming-soon cards; see App.jsx / registry.ts), so
  // the nav never offers a feature that isn't there.
  const nav = [
    { id: "home", label: "Home", section: "home" },
    { id: "onboarding", label: "Onboard new data", section: "onboarding" },
    EIR_NAV_ITEM,
    { id: "datasets", label: "Datasets", section: "datasets" },
    { id: "access-requests", label: "Access requests", section: "access-requests" },
    { id: "onboarding-requests", label: "My onboarding requests", section: "onboarding-requests" },
    // One link for every staff function (#159): the review inboxes, EIR
    // validation, the change list and the intake form editor are sections of
    // the EDP Admin page, shown only to EDP staff.
    EDP_ADMIN_NAV_ITEM,
  ];
  return (
    <header
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        background: "var(--surface-default)",
        borderBottom: "1px solid var(--border-default)",
        boxShadow: "var(--shadow-1)",
      }}
    >
      <div
        style={{
          maxWidth: 1240,
          margin: "0 auto",
          padding: "0 24px",
          display: "flex",
          alignItems: "center",
          gap: 20,
          height: 64,
        }}
      >
        {/* brand */}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            go("home");
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            textDecoration: "none",
            color: "var(--text-default)",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: "var(--radius-md)",
              background: "var(--surface-dark)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <AppIcon name="account_balance" size={22} color="#fff" />
          </div>
          <span style={{ lineHeight: 1.1 }}>
            <strong
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: "var(--font-size-sm)",
                fontWeight: 700,
                display: "block",
              }}
            >
              Data Access Broker
            </strong>
            <span
              style={{
                fontSize: "var(--font-size-micro)",
                color: "var(--text-muted)",
                letterSpacing: ".02em",
              }}
            >
              Internal Revenue Service · Databricks
            </span>
          </span>
        </a>
        {/* user — the avatar links to the Profile page */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            flexShrink: 0,
            marginLeft: "auto",
          }}
        >
          <button
            type="button"
            aria-label="Open your profile"
            title="Your profile"
            onClick={() => go("profile")}
            style={{
              width: 36,
              height: 36,
              borderRadius: "var(--radius-pill)",
              background: "var(--theme-primary)",
              color: "#fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontFamily: "var(--font-sans)",
              fontSize: "var(--font-size-2xs)",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            {D.user.initials || <AppIcon name="person" size={18} color="#fff" />}
          </button>
        </div>
      </div>
      {/* nav row */}
      <div
        style={{
          borderTop: "1px solid var(--border-default)",
          background: "var(--color-gray-cool-1)",
          position: "relative",
        }}
      >
        <nav
          aria-label="Primary"
          style={{
            maxWidth: 1240,
            margin: "0 auto",
            padding: "0 24px",
            display: "flex",
            gap: 4,
            overflowX: "auto",
            boxSizing: "border-box",
          }}
        >
          {nav.map((n) => {
            if (n.staffOnly && !isEdpStaff(D.user)) return null;
            const active = route.section === n.section;
            return (
              <a
                key={n.label}
                href="#"
                onMouseEnter={() => prefetchRoute?.(n.id, n.params)}
                onFocus={(e) => {
                  prefetchRoute?.(n.id, n.params);
                  e.currentTarget.scrollIntoView?.({ block: "nearest", inline: "nearest" });
                }}
                onClick={(e) => {
                  e.preventDefault();
                  go(n.id, n.params);
                }}
                style={{
                  flexShrink: 0,
                  whiteSpace: "nowrap",
                  padding: "11px 14px",
                  fontFamily: "var(--font-sans)",
                  fontSize: "var(--font-size-2xs)",
                  fontWeight: active ? 700 : 500,
                  color: active ? "var(--theme-primary)" : "var(--color-gray-cool-70)",
                  textDecoration: "none",
                  borderBottom: active ? "3px solid var(--theme-primary)" : "3px solid transparent",
                  marginBottom: -1,
                }}
              >
                {n.label}
              </a>
            );
          })}
        </nav>
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: "0 0 0 auto",
            width: 28,
            pointerEvents: "none",
            background: "linear-gradient(90deg, transparent, var(--color-gray-cool-1) 80%)",
          }}
        />
      </div>
    </header>
  );
}

function AppFooter({ go }) {
  return (
    <footer style={{ marginTop: 64 }}>
      <div style={{ background: "var(--surface-dark)", color: "#fff" }}>
        <div
          style={{
            maxWidth: 1240,
            margin: "0 auto",
            padding: "32px 24px",
            display: "flex",
            alignItems: "flex-start",
            gap: 24,
            flexWrap: "wrap",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <AppIcon name="account_balance" size={34} color="#fff" />
            <div>
              <div
                style={{
                  fontFamily: "var(--font-sans)",
                  fontWeight: 700,
                  fontSize: "var(--font-size-sm)",
                }}
              >
                IRS Data Access Broker
              </div>
              <div
                style={{
                  fontSize: "var(--font-size-3xs)",
                  color: "var(--color-blue-20v)",
                  marginTop: 2,
                }}
              >
                A Databricks App · Enterprise Data Platform
              </div>
            </div>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 40, flexWrap: "wrap" }}>
            <FooterCol
              h="Get started"
              items={[["Onboard new data into EDP", "onboarding"]]}
              go={go}
            />
          </div>
        </div>
        <div style={{ borderTop: "1px solid rgba(255,255,255,.12)" }}>
          <div
            style={{
              maxWidth: 1240,
              margin: "0 auto",
              padding: "14px 24px",
              fontSize: "var(--font-size-3xs)",
              color: "var(--color-blue-20v)",
              display: "flex",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 8,
            }}
          >
            <span>
              Discovery visibility does not imply data access. Access is governed by Unity Catalog
              and approved through BEARS, the IRS entitlement system built on SailPoint.
            </span>
            <span>v1.0 · Prototype</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
function FooterCol({ h, items, go }) {
  return (
    <div>
      <div
        style={{
          fontWeight: 700,
          fontSize: "var(--font-size-3xs)",
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: "var(--color-blue-20v)",
          marginBottom: 10,
        }}
      >
        {h}
      </div>
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 7,
        }}
      >
        {items.map(([l, r]) => (
          <li key={l}>
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                go(r);
              }}
              style={{
                color: "#fff",
                fontSize: "var(--font-size-2xs)",
                textDecoration: "none",
                opacity: 0.9,
              }}
            >
              {l}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Page container
function Page({ children, bg }) {
  return (
    <div style={{ background: bg || "var(--color-gray-cool-2)", minHeight: "70vh" }}>
      <div style={{ maxWidth: 1240, margin: "0 auto", padding: "32px 24px 8px" }}>{children}</div>
    </div>
  );
}

// Breadcrumb-ish trail
function Trail({ items, go }) {
  return (
    <nav
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        flexWrap: "wrap",
        marginBottom: 18,
        fontSize: "var(--font-size-2xs)",
      }}
    >
      {items.map((it, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <AppIcon name="chevron_right" size={15} color="var(--text-muted)" /> : null}
          {it.go ? (
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                it.go();
              }}
              style={{ color: "var(--link-default)", textDecoration: "none", fontWeight: 600 }}
            >
              {it.label}
            </a>
          ) : (
            <span style={{ color: "var(--text-muted)" }}>{it.label}</span>
          )}
        </React.Fragment>
      ))}
    </nav>
  );
}

Object.assign(window, { TopNav, AppFooter, Page, Trail });
