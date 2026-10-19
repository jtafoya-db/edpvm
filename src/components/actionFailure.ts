/**
 * What a failed action says, in words that match what happened (#189):
 * "refused" only when the server refused. An expired sign-in says nothing was
 * saved; a lost or unreadable answer says the save is unconfirmed. Shared by
 * the blocking saves' ActionErrorNotice and the optimistic saves' notices
 * (src/components/SaveStatus.tsx), so both say the same thing.
 */
import { apiFailureKind, type ApiFailureKind } from "@/data/api-response";

export interface ActionFailureCopy {
  kind: ApiFailureKind;
  title: string;
  body: string;
}

export function actionFailureCopy(error: Error, refusedTitle: string): ActionFailureCopy {
  const kind = apiFailureKind(error);
  const [title, body] =
    kind === "session-expired"
      ? ["Your sign-in has expired", "Reload the page to sign in again — nothing was saved."]
      : kind === "outcome-unknown"
        ? ["We couldn't confirm this save", "Check the list before trying again."]
        : kind === "unavailable"
          ? ["We couldn't reach the app", "Try again in a moment."]
          : kind === "failed"
            ? ["Something went wrong", error.message]
            : [refusedTitle, error.message];
  return { kind, title, body };
}
