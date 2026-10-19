import type { EirScreenChrome } from "../Eir/EirShared";

const legacyWindow = window as typeof window & {
  Page: EirScreenChrome["Page"];
  Trail: EirScreenChrome["Trail"];
  Panel: EirScreenChrome["Panel"];
  Pill: EirScreenChrome["Pill"];
  AppIcon: EirScreenChrome["Icon"];
  SectionHead: EirScreenChrome["SectionHead"];
};

export const SCREEN_CHROME = {
  get Page() {
    return legacyWindow.Page;
  },
  get Trail() {
    return legacyWindow.Trail;
  },
  get Panel() {
    return legacyWindow.Panel;
  },
  get Pill() {
    return legacyWindow.Pill;
  },
  get Icon() {
    return legacyWindow.AppIcon;
  },
  get SectionHead() {
    return legacyWindow.SectionHead;
  },
};

export const SHELL_ROUTE_SECTIONS = { profile: "profile" } as const;
