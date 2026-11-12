// Dark-mode spike (#347): the preference model, the pre-paint script, and the
// guard that keeps this throwaway prototype out of the shipped app.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FEATURES } from "@/features/registry";
import {
  THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY,
  applyTheme,
  followSystemTheme,
  readPreference,
  resolveTheme,
  writePreference,
} from "./theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const device = (dark: boolean) => () => ({ matches: dark });

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.className = "";
  localStorage.clear();
});

describe("theme preference", () => {
  it("defaults to the device setting when nothing usable is saved", () => {
    expect(readPreference(memoryStorage())).toBe("system");
    expect(readPreference(memoryStorage({ [THEME_STORAGE_KEY]: "sepia" }))).toBe("system");
    expect(readPreference(undefined)).toBe("system");
  });

  it("falls back to the device setting when storage throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readPreference(throwing)).toBe("system");
    expect(() => writePreference(throwing, "dark")).not.toThrow();
  });

  it("keeps an explicit choice across a reload", () => {
    const storage = memoryStorage();
    writePreference(storage, "dark");
    expect(readPreference(storage)).toBe("dark");
  });

  it("resolves system from the device, and an explicit choice over it", () => {
    expect(resolveTheme("system", device(true))).toBe("dark");
    expect(resolveTheme("system", device(false))).toBe("light");
    expect(resolveTheme("light", device(true))).toBe("light");
    expect(resolveTheme("dark", device(false))).toBe("dark");
    expect(resolveTheme("system", undefined)).toBe("light");
  });

  it("puts one class on the root and removes it for light", () => {
    const root = document.documentElement;
    applyTheme(root, "dark");
    expect(root.classList.contains("dark")).toBe(true);
    applyTheme(root, "light");
    expect(root.className).toBe("");
  });

  it("follows a device change only while the preference is system", () => {
    const root = document.documentElement;
    const listeners = new Set<() => void>();
    const media = {
      matches: false,
      addEventListener: (_: string, fn: () => void) => void listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => void listeners.delete(fn),
    } as unknown as MediaQueryList;

    const stop = followSystemTheme(root, "system", media);
    (media as { matches: boolean }).matches = true;
    listeners.forEach((fn) => fn());
    expect(root.classList.contains("dark")).toBe(true);
    stop();
    expect(listeners.size).toBe(0);

    followSystemTheme(root, "light", media);
    expect(listeners.size).toBe(0);
  });
});

describe("pre-paint script", () => {
  function runInitScript(dark: boolean) {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({ matches: dark, media: query })) as never;
    try {
      new Function(THEME_INIT_SCRIPT)();
    } finally {
      window.matchMedia = original;
    }
    return document.documentElement.classList.contains("dark");
  }

  it("applies the same theme resolveTheme would, before any module loads", () => {
    for (const saved of [null, "system", "light", "dark", "junk"]) {
      for (const dark of [true, false]) {
        localStorage.clear();
        document.documentElement.className = "";
        if (saved) localStorage.setItem(THEME_STORAGE_KEY, saved);
        const expected = resolveTheme(readPreference(localStorage), device(dark)) === "dark";
        expect(runInitScript(dark), `saved=${saved} deviceDark=${dark}`).toBe(expected);
      }
    }
  });
  it("still follows the device when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(runInitScript(true)).toBe(true);
    document.documentElement.className = "";
    expect(runInitScript(false)).toBe(false);
  });
});

describe("isolation", () => {
  it("is not imported by any app module, so the shipped app has no dark mode", () => {
    const src = join(process.cwd(), "src");
    const here = join(src, "prototypes", "dark-mode");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (path.startsWith(here)) continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (
          /\.(tsx?|jsx?|css)$/.test(name) &&
          /prototypes\/dark-mode/.test(readFileSync(path, "utf8"))
        )
          offenders.push(relative(src, path));
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });

  it("has no capability-registry entry, so no screen can claim dark mode exists", () => {
    const themed = Object.values(FEATURES).filter((f) => /dark|theme/i.test(`${f.id} ${f.label}`));
    expect(themed).toEqual([]);
  });
});
