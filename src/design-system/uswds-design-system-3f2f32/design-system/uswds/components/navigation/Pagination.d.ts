import * as React from "react";

/** USWDS Pagination — navigate multi-page result sets. */
export interface PaginationProps extends Omit<React.HTMLAttributes<HTMLElement>, "onChange"> {
  /** Current 1-based page. */
  current?: number;
  /** Total number of pages. */
  total?: number;
  /** Called with the requested page number. */
  onChange?: (page: number) => void;
}

export function Pagination(props: PaginationProps): React.JSX.Element;
