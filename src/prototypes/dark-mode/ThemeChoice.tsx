// THROWAWAY PROTOTYPE for the dark-mode spike (#347): the explicit choice. Not
// mounted anywhere in the app. A real version would sit in the Profile page
// or the header's account menu (ticket DM-4 in docs/research/dark-mode-spike.md).
import { useEffect, useId, useState } from "react";

import {
  DARK_QUERY,
  applyTheme,
  followSystemTheme,
  readPreference,
  resolveTheme,
  writePreference,
  type ThemePreference,
} from "./theme";

const LABELS: Record<ThemePreference, string> = {
  system: "Match my device",
  light: "Light",
  dark: "Dark",
};

/** Reads, applies, saves and (for "system") follows the theme preference. */
export function useThemePreference(root: HTMLElement = document.documentElement) {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    readPreference(window.localStorage),
  );

  useEffect(() => {
    writePreference(window.localStorage, preference);
    applyTheme(root, resolveTheme(preference, window.matchMedia));
    return followSystemTheme(root, preference, window.matchMedia(DARK_QUERY));
  }, [preference, root]);

  return [preference, setPreference] as const;
}

export function ThemeChoice({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (preference: ThemePreference) => void;
}) {
  const name = useId();
  return (
    <fieldset
      style={{
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-md)",
        background: "var(--surface-default)",
        color: "var(--text-default)",
        padding: "12px 16px",
        margin: 0,
      }}
    >
      <legend style={{ fontWeight: 700, padding: "0 4px" }}>Color theme</legend>
      {(Object.keys(LABELS) as ThemePreference[]).map((option) => (
        <label
          key={option}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}
        >
          <input
            type="radio"
            name={name}
            value={option}
            checked={value === option}
            onChange={() => onChange(option)}
          />
          {LABELS[option]}
        </label>
      ))}
    </fieldset>
  );
}
