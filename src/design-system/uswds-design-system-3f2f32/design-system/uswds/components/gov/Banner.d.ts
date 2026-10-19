import * as React from "react";

/**
 * USWDS Banner — official ".gov" site identification, with an expandable
 * "Here's how you know" panel. Place at the very top of a government page.
 *
 * @startingPoint section="Government" subtitle="Official .gov banner with expandable detail" viewport="1024x40"
 */
export interface BannerProps extends React.HTMLAttributes<HTMLElement> {
  /** Top-level domain phrasing (".gov" or ".mil"). */
  tld?: string;
}

export function Banner(props: BannerProps): React.JSX.Element;
