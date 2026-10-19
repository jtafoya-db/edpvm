import * as React from "react";

/**
 * USWDS Alert — keep users informed of important status changes.
 *
 * @startingPoint section="Feedback" subtitle="Info, success, warning, error & emergency alerts" viewport="700x320"
 */
export interface AlertProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Status type — sets color, icon, and ARIA role. */
  type?: "info" | "warning" | "error" | "success" | "emergency";
  /** Bold heading above the body. */
  heading?: React.ReactNode;
  /** Compact variant for terser messages. */
  slim?: boolean;
  /** Hide the status icon. */
  noIcon?: boolean;
  children?: React.ReactNode;
}

export function Alert(props: AlertProps): React.JSX.Element;
