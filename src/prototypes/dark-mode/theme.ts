// THROWAWAY PROTOTYPE for the dark-mode spike (#347). Nothing in the app
// imports this folder (theme.test.ts fails if anything does), so the shipped
// app has no dark mode. See docs/research/dark-mode-spike.md for the findings
// and the follow-up tickets that would replace this with the real thing.
//
// The model: the person picks Light, Dark or "Match my device" (system). The
// choice is kept in localStorage. The resolved theme is one class on <html>
// (`.dark`, which Tailwind's `dark:` variant and shadcn's tokens already key
// on). dark-tokens.css sets `color-scheme` from that class, so native controls
// and scrollbars follow, and print still gets light.

export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "edp-vm:theme";
export const DARK_QUERY = "(prefers-color-scheme: dark)";

type StorageLike = Pick<Storage, "getItem" | "setItem">;
type MatchMediaLike = (query: string) => Pick<MediaQueryList, "matches">;

function isPreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && (THEME_PREFERENCES as readonly string[]).includes(value);
}

/** The saved choice; "system" when nothing (or something unreadable) is saved. */
export function readPreference(storage: StorageLike | undefined): ThemePreference {
  try {
    const saved = storage?.getItem(THEME_STORAGE_KEY);
    return isPreference(saved) ? saved : "system";
  } catch {
    // Storage can throw (disabled cookies, some private modes): fall back.
    return "system";
  }
}

export function writePreference(storage: StorageLike | undefined, preference: ThemePreference) {
  try {
    storage?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Not persisted; the choice still applies for this page.
  }
}

export function resolveTheme(
  preference: ThemePreference,
  matchMedia: MatchMediaLike | undefined,
): ResolvedTheme {
  if (preference !== "system") return preference;
  return matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

/** Puts the resolved theme on the document root. Light removes every trace. */
export function applyTheme(root: HTMLElement, theme: ResolvedTheme) {
  root.classList.toggle("dark", theme === "dark");
}

/**
 * Inline <head> script that applies the saved theme before first paint, so a
 * dark-mode user never sees a white flash while the client bundle loads. It
 * duplicates resolveTheme on purpose: it must run before any module loads.
 * Reading storage has its own try, so blocked storage (which throws) still
 * falls back to the device setting. A real implementation would render it
 * from the root route's shell.
 */
export const THEME_INIT_SCRIPT = `(function(){var p;try{p=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})}catch(e){}if(p!=="light"&&p!=="dark")p="system";try{var d=p==="dark"||(p==="system"&&window.matchMedia(${JSON.stringify(
  DARK_QUERY,
)}).matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})();`;

/**
 * Follows the device setting while the preference is "system". Returns the
 * unsubscribe function.
 */
export function followSystemTheme(
  root: HTMLElement,
  preference: ThemePreference,
  mediaList: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener">,
) {
  if (preference !== "system") return () => {};
  const onChange = () => applyTheme(root, mediaList.matches ? "dark" : "light");
  mediaList.addEventListener("change", onChange);
  return () => mediaList.removeEventListener("change", onChange);
}
