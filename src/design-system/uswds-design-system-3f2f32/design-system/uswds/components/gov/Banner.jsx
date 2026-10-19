import React from "react";
import { Icon } from "../core/Icon.jsx";

const FLAG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAsBAMAAAAncaPMAAAAAXNSR0IArs4c6QAAABtQTFRF////4EAg2z8g2z8f2z4f2j4fHjSyHjOxHTOxQEYPwgAAAIdJREFUeNrNkUENxDAMBEOhFJaCKZiCKZhCKBj2ebV3rdR71+pIq+Qxj1GyqjJ3U8VlHkc07hFm0awBYe91juq6MSI0yhSAEgkzJ4TMKiXyzFw3pgR9lmIBJlqj2AmBedf+IycExmlKZVzvZEJ4A0oBrjBl/m6PCy95B3fFAN6YuQPxhbcB4QMkEj04wQXD5wAAAABJRU5ErkJggg==";
const DOTGOV = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'><path fill='%232378C3' fill-rule='evenodd' d='m32 0c17.7 0 32 14.3 32 32s-14.3 32-32 32-32-14.3-32-32 14.3-32 32-32zm0 1.2c-17 0-30.8 13.8-30.8 30.8s13.8 30.8 30.8 30.8 30.8-13.8 30.8-30.8-13.8-30.8-30.8-30.8zm11.4 38.9c.5 0 .9.4.9.8v1.6h-24.6v-1.6c0-.5.4-.8.9-.8zm-17.1-12.3v9.8h1.6v-9.8h3.3v9.8h1.6v-9.8h3.3v9.8h1.6v-9.8h3.3v9.8h.8c.5 0 .9.4.9.8v.8h-21.4v-.8c0-.5.4-.8.9-.8h.8v-9.8zm5.7-8.2 12.3 4.9v1.6h-1.6c0 .5-.4.8-.9.8h-19.6c-.5 0-.9-.4-.9-.8h-1.6v-1.6s12.3-4.9 12.3-4.9z'/></svg>";
const HTTPS = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64' viewBox='0 0 64 64'><path fill='%23719F2A' fill-rule='evenodd' d='M32 0c17.673 0 32 14.327 32 32 0 17.673-14.327 32-32 32C14.327 64 0 49.673 0 32 0 14.327 14.327 0 32 0zm0 1.208C14.994 1.208 1.208 14.994 1.208 32S14.994 62.792 32 62.792 62.792 49.006 62.792 32 49.006 1.208 32 1.208zm0 18.886a7.245 7.245 0 0 1 7.245 7.245v3.103h.52c.86 0 1.557.698 1.557 1.558v9.322c0 .86-.697 1.558-1.557 1.558h-15.53c-.86 0-1.557-.697-1.557-1.558V32c0-.86.697-1.558 1.557-1.558h.52V27.34A7.245 7.245 0 0 1 32 20.094zm0 3.103a4.142 4.142 0 0 0-4.142 4.142v3.103h8.284V27.34A4.142 4.142 0 0 0 32 23.197z'/></svg>";

/**
 * USWDS Banner — the official ".gov" identification banner that appears at the
 * top of every compliant federal site, with an expandable "Here's how you know".
 */
export function Banner({ tld = ".gov", style, ...rest }) {
  const [open, setOpen] = React.useState(false);
  const [focus, setFocus] = React.useState(false);
  return (
    <section aria-label="Official government website banner" style={{ background: "var(--color-gray-cool-2)", fontFamily: "var(--font-body)", color: "var(--text-default)", ...style }} {...rest}>
      <div style={{ maxWidth: 1024, margin: "0 auto", padding: "0 var(--space-2)" }}>
        <header style={{ display: "flex", alignItems: "center", gap: "var(--space-1)", padding: "var(--space-05) 0", fontSize: "var(--font-size-micro)", lineHeight: 1.3 }}>
          <img src={FLAG} alt="U.S. flag" style={{ height: 11, width: "auto" }} />
          <span>An official website of the United States government</span>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
            style={{
              display: "inline-flex", alignItems: "center", gap: 2, marginLeft: 2,
              background: "none", border: 0, padding: "2px 4px", cursor: "pointer",
              color: "var(--link-default)", fontFamily: "var(--font-body)", fontSize: "var(--font-size-micro)",
              textDecoration: "underline", outline: focus ? "var(--focus-outline)" : "none",
            }}
          >
            Here's how you know
            <span aria-hidden="true" style={{ display: "inline-flex", transform: open ? "rotate(180deg)" : "none" }}><Icon name="expand_more" size={14} /></span>
          </button>
        </header>
        {open && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--space-3)", padding: "var(--space-2) 0 var(--space-3)" }}>
            <div style={{ display: "flex", gap: "var(--space-105)", alignItems: "flex-start", fontSize: "var(--font-size-2xs)", lineHeight: "var(--line-height-4)" }}>
              <img src={DOTGOV} alt="" style={{ width: 40, height: 40, flexShrink: 0 }} />
              <p style={{ margin: 0 }}><strong>Official websites use {tld}</strong><br />A <strong>{tld}</strong> website belongs to an official government organization in the United States.</p>
            </div>
            <div style={{ display: "flex", gap: "var(--space-105)", alignItems: "flex-start", fontSize: "var(--font-size-2xs)", lineHeight: "var(--line-height-4)" }}>
              <img src={HTTPS} alt="" style={{ width: 40, height: 40, flexShrink: 0 }} />
              <p style={{ margin: 0 }}><strong>Secure {tld} websites use HTTPS</strong><br />A <strong>lock</strong> or <strong>https://</strong> means you've safely connected to the {tld} website. Share sensitive information only on official, secure websites.</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
