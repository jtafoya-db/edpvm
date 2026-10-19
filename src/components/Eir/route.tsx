import { EirScreen } from "./EirScreen";

export const EIR_ROUTE = {
  name: "eir",
  section: "eir",
  Screen: EirScreen,
} as const;

export const EIR_NAV_ITEM = {
  id: EIR_ROUTE.name,
  label: "My EIR",
  section: EIR_ROUTE.section,
} as const;
