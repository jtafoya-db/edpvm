import type { DataStore } from "../store";
import type { PrivacyAcknowledgment } from "./repository";

const inFlightAcknowledgments = new WeakMap<DataStore, Promise<PrivacyAcknowledgment>>();

/** Hold guarded EIR traffic until this store's optimistic acknowledgment is durable. */
export function trackPrivacyAcknowledgment(
  store: DataStore,
  acknowledgment: Promise<PrivacyAcknowledgment>,
): void {
  inFlightAcknowledgments.set(store, acknowledgment);
  const clear = () => {
    if (inFlightAcknowledgments.get(store) === acknowledgment) {
      inFlightAcknowledgments.delete(store);
    }
  };
  // A failed write remains a fail-closed barrier. Only an explicit retry may
  // replace it; otherwise Query's own later retry could reach guarded EIR APIs.
  void acknowledgment.then(clear, () => undefined);
}

/** Run an EIR operation only after any optimistic acknowledgment has completed. */
export async function afterPrivacyAcknowledgment<T>(
  store: DataStore,
  operation: () => Promise<T>,
): Promise<T> {
  await inFlightAcknowledgments.get(store);
  return operation();
}
