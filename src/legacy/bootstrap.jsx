// Loads the ported prototype in the browser only. The prototype modules read
// and write globals (window.AppData, window.HomeScreen, ...), so React must be
// on window before they evaluate and the load order below matters.
import React from "react";
import * as ReactDOM from "react-dom/client";

let appPromise = null;

export function loadApp() {
  if (appPromise) return appPromise;
  appPromise = (async () => {
    window.React = React;
    window.ReactDOM = ReactDOM;
    await import("../uswds/design-system.js");
    await import("./appData.js");
    await import("./icons.jsx");
    await import("./primitives.jsx");
    await import("./chrome.jsx");
    await import("./home.jsx");
    await import("./browse.jsx");
    await import("./domain.jsx");
    await import("./dataset.jsx");
    await import("./bundle.jsx");
    await import("./bundles.jsx");
    await import("./search.jsx");
    await import("./cart.jsx");
    await import("./requests.jsx");
    await import("./access.jsx");
    await import("./onboarding.jsx");
    await import("./admin.jsx");
    await import("./profile.jsx");
    const { default: App } = await import("./App.jsx");
    return App;
  })();
  return appPromise;
}
