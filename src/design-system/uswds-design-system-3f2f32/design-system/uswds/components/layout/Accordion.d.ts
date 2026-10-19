import * as React from "react";

interface AccordionItem {
  /** Unique id (also used as the panel's DOM id). */
  id: string;
  /** Header label. */
  title: React.ReactNode;
  /** Panel content. */
  content: React.ReactNode;
}

/** USWDS Accordion — expandable/collapsible content sections. */
export interface AccordionProps extends React.HTMLAttributes<HTMLDivElement> {
  items: AccordionItem[];
  /** Allow multiple panels open at once. */
  multiselectable?: boolean;
  /** Show 1px borders around each item (default true). */
  bordered?: boolean;
  /** Ids of panels open on first render. */
  defaultOpen?: string[];
}

export function Accordion(props: AccordionProps): React.JSX.Element;
