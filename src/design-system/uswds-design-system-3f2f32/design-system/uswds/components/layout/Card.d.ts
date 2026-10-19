import * as React from "react";

/**
 * USWDS Card — bordered container for a discrete piece of content.
 *
 * @startingPoint section="Layout" subtitle="Media + heading + body + footer card" viewport="360x420"
 */
export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Serif heading text. */
  heading?: React.ReactNode;
  /** Heading element to render. */
  headingLevel?: "h2" | "h3" | "h4";
  /** Image URL shown in a 16:9 media area at the top. */
  media?: string;
  /** Alt text for the media image. */
  mediaAlt?: string;
  /** Footer content — typically a Button. */
  footer?: React.ReactNode;
  children?: React.ReactNode;
}

export function Card(props: CardProps): React.JSX.Element;
