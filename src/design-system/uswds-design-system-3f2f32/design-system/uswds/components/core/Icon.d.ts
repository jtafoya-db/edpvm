import * as React from "react";

/**
 * USWDS Icon — inline SVG glyph, dependency-free, inherits currentColor.
 */
/** Every glyph name in the bundled icon registry. */
export type IconName =
    | "close" | "menu" | "search" | "expand_more" | "expand_less"
    | "navigate_next" | "navigate_before" | "check" | "check_circle"
    | "error" | "warning" | "info" | "arrow_forward" | "arrow_back"
    | "file_download" | "launch" | "account_balance" | "home"
    | "attach_money" | "medical_services" | "person" | "lock"
    | "mail" | "public" | "rss_feed" | "facebook";

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, "name" | "color"> {
  /** Icon name from the bundled registry (e.g. "search", "check_circle"). */
  name: IconName;
  /** Size (any CSS length). Defaults to 1em so it scales with text. */
  size?: string | number;
  /** Fill color. Defaults to currentColor. */
  color?: string;
  /** Accessible label. Omit for decorative icons (hidden from AT). */
  title?: string;
}

export function Icon(props: IconProps): React.JSX.Element;
export const ICON_NAMES: IconName[];
