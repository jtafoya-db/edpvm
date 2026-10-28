// Discard unsaved changes on My EIR (#273): it asks first, in the repo's
// confirm dialog (Radix AlertDialog). Focus moves to Keep editing when it
// opens, Escape or Keep editing leaves the edits as they are, and focus goes
// back to the button. Nothing is sent or deleted: the saved draft is kept.
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";

import { disabledPendingStyle } from "@/components/PendingAction";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { linkButton, outlineButton, primaryButton } from "./EirShared";

export function DiscardUnsavedChanges({
  disabled,
  onDiscard,
}: {
  /** Nothing unsaved, or the EIR is busy: the button shows, but can't be used. */
  disabled: boolean;
  onDiscard: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <button
          type="button"
          style={disabledPendingStyle(linkButton, disabled)}
          disabled={disabled}
        >
          Discard unsaved changes
        </button>
      </AlertDialogTrigger>
      {/* Scrolls inside itself when zoomed in, so every word and button stays reachable. */}
      <AlertDialogContent
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
        style={{
          fontFamily: "var(--font-sans)",
          color: "var(--text-default)",
          background: "var(--surface-default)",
          borderRadius: "var(--radius-md)",
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle style={heading}>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription style={body}>
            The answers you changed since you last saved go back to how they were. Your saved
            answers are kept, and nothing is deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter style={{ gap: 10 }}>
          <AlertDialogPrimitive.Cancel style={outlineButton}>
            Keep editing
          </AlertDialogPrimitive.Cancel>
          <AlertDialogPrimitive.Action style={primaryButton} onClick={onDiscard}>
            Discard changes
          </AlertDialogPrimitive.Action>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const heading = {
  fontFamily: "var(--font-heading)",
  fontSize: "var(--font-size-lg)",
  fontWeight: 700,
  margin: 0,
} as const;

const body = {
  fontSize: "var(--font-size-2xs)",
  color: "var(--text-default)",
  lineHeight: 1.5,
  margin: 0,
} as const;
