import * as React from "react";

interface Crumb { label: React.ReactNode; href?: string; }

/** USWDS Breadcrumb — shows the page's place in the site hierarchy. */
export interface BreadcrumbProps extends React.HTMLAttributes<HTMLElement> {
  /** Trail items, root first; the last is the current page. */
  items: Crumb[];
}

export function Breadcrumb(props: BreadcrumbProps): React.JSX.Element;
