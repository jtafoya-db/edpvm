/**
 * Saves that feel instant on a slow backend (ADR-0009 phase 1, #140).
 *
 * A Delta save takes ~5 s. Instead of waiting, a save:
 *
 * 1. **shows its result at once**, on the reads it changes, marked "Saving…"
 *    ({@link useSaves}), and never as done;
 * 2. **keeps running if the person navigates away**: it's a TanStack mutation
 *    in the client's mutation cache, not in a component, so any screen that
 *    renders the record shows it as pending;
 * 3. **becomes "Saved" only when the server confirms**: the server's result
 *    replaces the projection, then the changed reads refresh in the background;
 * 4. **rolls back on a refusal**: its projection is dropped, the screen shows
 *    the server's data again, and the reason stays on screen;
 * 5. **stays visibly unconfirmed** when the outcome is unknown (offline,
 *    502/503/504, `outcome-unknown`): the projection stays, and "Try again"
 *    resends the same idempotency key, so the server replays a commit that
 *    already happened instead of making a second one (#182, ADR-0007).
 *
 * One save per record runs at a time: a second click on a record that's
 * saving is ignored. Different records save concurrently; there's no global
 * lock.
 *
 * How the projection survives refetches: for every read a pending save
 * changes, this module keeps the server's last answer (the base) and paints
 * base + every pending projection into the cache. A refetch that lands while
 * a save is pending replaces the base, and the projections are painted on top
 * again, so a stale read can't erase a pending change. Rolling back is
 * dropping one projection and repainting, which leaves other records' saves
 * alone.
 *
 * Saves that ADR-0009 decision 2 keeps synchronous (EIR submit and renew,
 * validator decisions, staff approvals, Apply and change-list Mark applied,
 * FTI access) don't use this: they keep the honest blocking "Saving…" of
 * src/components/PendingAction.tsx.
 */
import {
  hashKey,
  useMutationState,
  useQueryClient,
  type Mutation,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useCallback } from "react";

import { apiFailureKind, type ApiFailureKind } from "./api-response";
import type { DataStore } from "./store";
import { useStore } from "./store-context";

/** Every save's mutation key starts with this. */
export const SAVE_KEY = ["save"] as const;

/** The browser-minted key for one confirmed intent. A retry of that intent reuses it. */
export interface SaveIntent {
  idempotencyKey: string;
}

/** A read the save changes, and how it changes it. */
export interface Projection<TInput, TResult> {
  queryKey: QueryKey;
  /** The change as the person expects it, applied to what the server last said. Pure. */
  show: (data: unknown, input: TInput) => unknown;
  /** The committed change, from the server's result. Defaults to `show`. */
  confirm?: (data: unknown, result: TResult, input: TInput) => unknown;
}

/** Typed helper for one {@link Projection}: `show` and `confirm` see the read's own type. */
export function project<TData, TInput, TResult = unknown>(
  queryKey: QueryKey,
  show: (data: TData, input: TInput) => TData,
  confirm?: (data: TData, result: TResult, input: TInput) => TData,
): Projection<TInput, TResult> {
  // A read that isn't loaded yet has nothing to project onto; it picks the
  // projection up when it loads (see `paint`).
  return {
    queryKey,
    show: (data, input) => (data === undefined ? data : show(data as TData, input)),
    ...(confirm
      ? {
          confirm: (data: unknown, result: TResult, input: TInput) =>
            data === undefined ? data : confirm(data as TData, result, input),
        }
      : {}),
  };
}

export interface SaveSpec<TInput, TResult> {
  /** What kind of save, e.g. `add-member`. */
  action: string;
  /** The record it changes. One save per record at a time. */
  record: (input: TInput) => string;
  /** What the person asked for, in plain words: "Add Tess Tester as Tester". */
  describe: (input: TInput) => string;
  /** The heading when the server refuses it, as the blocking screens said it (#189). */
  refusedTitle: string;
  /** What happened, once committed. Defaults to "Saved: " and `describe`. */
  describeSaved?: (result: TResult, input: TInput) => string;
  run: (store: DataStore, input: TInput & SaveIntent) => Promise<TResult>;
  projections?: (input: TInput) => Projection<TInput, TResult>[];
  /** Reads to refresh in the background once it settles. */
  invalidates: (input: TInput) => QueryKey[];
}

export type SaveState = "saving" | "saved" | "refused" | "unconfirmed";

/**
 * True when nobody can say whether the save committed (#189's classification):
 * keep showing it, unconfirmed, and retry it with the same key. Anything else
 * that failed (a refusal, an expired sign-in, a failed read before the write)
 * saved nothing, so it's rolled back.
 */
export function isUnknownOutcome(error: unknown): boolean {
  return apiFailureKind(error) === "outcome-unknown";
}

interface SaveMeta {
  action: string;
  record: string;
  label: string;
  refusedTitle: string;
  savedLabel: (result: unknown) => string;
  /** When the server answered, for ordering what's shown. */
  settledAt?: number;
  retry: () => void;
  dismiss: () => void;
}

// --- The projection layer -------------------------------------------------

interface Layer {
  projections: Projection<unknown, unknown>[];
  input: unknown;
}

interface Overlay {
  /** Pending (or unconfirmed) projections, by idempotency key, oldest first. */
  layers: Map<string, Layer>;
  /** The server's last answer for each read under a projection, by query hash. */
  bases: Map<string, { queryKey: QueryKey; data: unknown }>;
}

const overlays = new WeakMap<QueryClient, Overlay>();

function overlayFor(client: QueryClient): Overlay {
  const existing = overlays.get(client);
  if (existing) return existing;
  const overlay: Overlay = { layers: new Map(), bases: new Map() };
  overlays.set(client, overlay);
  client.getQueryCache().subscribe((event) => {
    // A fetch landed on a read under a projection: it's the new base.
    if (event.type !== "updated" || event.action.type !== "success" || event.action.manual) return;
    const base = overlay.bases.get(event.query.queryHash);
    if (!base) return;
    base.data = event.query.state.data;
    paint(client, overlay, event.query.queryHash);
  });
  return overlay;
}

/** Write base + every pending projection on one read into the cache. */
function paint(client: QueryClient, overlay: Overlay, hash: string) {
  const base = overlay.bases.get(hash);
  if (!base) return;
  let data = base.data;
  let projected = false;
  for (const layer of overlay.layers.values()) {
    for (const p of layer.projections) {
      if (hashKey(p.queryKey) !== hash) continue;
      data = p.show(data, layer.input);
      projected = true;
    }
  }
  if (!projected) overlay.bases.delete(hash);
  if (data !== undefined) client.setQueryData(base.queryKey, data);
}

function hashesOf(layer: Layer | undefined): string[] {
  return [...new Set((layer?.projections ?? []).map((p) => hashKey(p.queryKey)))];
}

// --- Running a save ---------------------------------------------------------

type SaveMutation = Mutation<unknown, Error, unknown, unknown>;

const saveMetaOf = (mutation: { options: { meta?: Record<string, unknown> } }) =>
  mutation.options.meta?.["save"] as SaveMeta | undefined;

const intentOf = (mutation: { state: { variables: unknown } }) =>
  (mutation.state.variables as SaveIntent | undefined)?.idempotencyKey;

function saves(client: QueryClient): SaveMutation[] {
  return client.getMutationCache().findAll({ mutationKey: SAVE_KEY }) as SaveMutation[];
}

/**
 * Start a save. Returns `false`, doing nothing, if this record already has a
 * save running (a double click). The save outlives the calling component.
 */
export interface SaveCallbacks<TResult> {
  /** Runs if the screen is still there; the save's own outcome doesn't depend on it. */
  onSaved?: (result: TResult) => void;
  /** A refusal: e.g. put the person's input back so they can fix it. */
  onRefused?: (error: Error) => void;
}

export function startSave<TInput, TResult>(
  client: QueryClient,
  store: DataStore,
  spec: SaveSpec<TInput, TResult>,
  input: TInput,
  intent: SaveIntent = { idempotencyKey: globalThis.crypto.randomUUID() },
  callbacks: SaveCallbacks<TResult> = {},
): boolean {
  const record = spec.record(input);
  const all = saves(client);
  if (all.some((m) => m.state.status === "pending" && saveMetaOf(m)?.record === record)) {
    return false;
  }
  // A new attempt on this record replaces what the last one said.
  for (const m of all) {
    const meta = saveMetaOf(m);
    if (
      meta?.record === record &&
      (meta.action === spec.action || intentOf(m) === intent.idempotencyKey)
    ) {
      client.getMutationCache().remove(m);
    }
  }

  const overlay = overlayFor(client);
  const key = intent.idempotencyKey;
  const variables = { ...input, idempotencyKey: key };
  const refresh = () => {
    for (const queryKey of spec.invalidates(input)) {
      void client.invalidateQueries({ queryKey });
    }
  };
  const drop = () => {
    const layer = overlay.layers.get(key);
    overlay.layers.delete(key);
    for (const hash of hashesOf(layer)) paint(client, overlay, hash);
  };

  const meta: SaveMeta = {
    action: spec.action,
    record,
    label: spec.describe(input),
    refusedTitle: spec.refusedTitle,
    savedLabel: (result) =>
      spec.describeSaved
        ? spec.describeSaved(result as TResult, input)
        : `Saved: ${spec.describe(input)}`,
    retry: () => void startSave(client, store, spec, input, intent, callbacks),
    dismiss: () => {
      // The person gives up on an unconfirmed save: show what the server says.
      if (mutation.state.status !== "pending") {
        drop();
        refresh();
        client.getMutationCache().remove(mutation);
      }
    },
  };

  const mutation = client.getMutationCache().build(client, {
    mutationKey: [...SAVE_KEY, spec.action, record],
    meta: { save: meta },
    gcTime: Infinity,
    mutationFn: () => spec.run(store, variables),
    onMutate: async () => {
      const layer: Layer = {
        projections: (spec.projections?.(input) ?? []) as Projection<unknown, unknown>[],
        input,
      };
      for (const p of layer.projections) {
        const hash = hashKey(p.queryKey);
        if (!overlay.bases.has(hash)) {
          overlay.bases.set(hash, { queryKey: p.queryKey, data: client.getQueryData(p.queryKey) });
        }
      }
      overlay.layers.delete(key);
      overlay.layers.set(key, layer);
      for (const hash of hashesOf(layer)) paint(client, overlay, hash);
      // A read already on its way would land without the change. Cancelling
      // puts back the data from before it started, so paint again after.
      await Promise.all(
        layer.projections.map((p) => client.cancelQueries({ queryKey: p.queryKey, exact: true })),
      );
      for (const hash of hashesOf(layer)) paint(client, overlay, hash);
    },
    onSuccess: (result) => {
      meta.settledAt = Date.now();
      // Committed: fold the server's result into the base, then refresh behind it.
      const layer = overlay.layers.get(key);
      overlay.layers.delete(key);
      for (const p of layer?.projections ?? []) {
        const base = overlay.bases.get(hashKey(p.queryKey));
        if (base) base.data = (p.confirm ?? p.show)(base.data, result as never, input);
      }
      for (const hash of hashesOf(layer)) paint(client, overlay, hash);
      refresh();
      callbacks.onSaved?.(result as TResult);
    },
    onError: (error) => {
      meta.settledAt = Date.now();
      // Unknown outcome: it may have committed, so keep showing it, unconfirmed.
      if (isUnknownOutcome(error)) return;
      drop();
      refresh();
      callbacks.onRefused?.(error);
    },
  }) as SaveMutation;
  void mutation.execute(variables).catch(() => undefined);
  return true;
}

// --- Reading saves in screens -----------------------------------------------

export interface SaveView {
  id: number;
  action: string;
  record: string;
  state: SaveState;
  /** What the person asked for, or what happened once saved. */
  label: string;
  /** Why it was refused or couldn't be confirmed. */
  reason: string | null;
  /** The failure, for its #189 wording (src/components/actionFailure.ts). */
  error: Error | null;
  /** What the failure means: `outcome-unknown` is the unconfirmed state. */
  failure: ApiFailureKind | null;
  refusedTitle: string;
  input: unknown;
  idempotencyKey: string | undefined;
  submittedAt: number;
  /** When the server answered; 0 while saving. */
  settledAt: number;
  retry: () => void;
  dismiss: () => void;
}

function stateOf(status: string, error: unknown): SaveState {
  if (status === "success") return "saved";
  if (status === "error") return isUnknownOutcome(error) ? "unconfirmed" : "refused";
  return "saving";
}

/** Every save in this app session, oldest first. Optionally filtered. */
export function useSaves(filter?: (save: SaveView) => boolean): SaveView[] {
  const views = useMutationState({
    filters: { mutationKey: SAVE_KEY },
    select: (mutation): SaveView | null => {
      const meta = saveMetaOf(mutation);
      if (!meta) return null;
      const { status, error, data, variables, submittedAt } = mutation.state;
      const state = stateOf(status, error);
      return {
        id: mutation.mutationId,
        action: meta.action,
        record: meta.record,
        state,
        label: state === "saved" ? meta.savedLabel(data) : meta.label,
        reason: error instanceof Error ? error.message : null,
        error: error instanceof Error ? error : null,
        failure: status === "error" ? apiFailureKind(error) : null,
        refusedTitle: meta.refusedTitle,
        input: variables,
        idempotencyKey: intentOf(mutation),
        submittedAt,
        settledAt: state === "saving" ? 0 : (meta.settledAt ?? submittedAt),
        retry: meta.retry,
        dismiss: meta.dismiss,
      };
    },
  });
  return views.filter((v): v is SaveView => v !== null && (!filter || filter(v)));
}

/** Saves on records that start with `prefix`, oldest first. */
export function useSavesUnder(prefix: string): SaveView[] {
  return useSaves((save) => save.record.startsWith(prefix));
}

/** The latest save on one record, if any. */
export function useRecordSave(record: string): SaveView | undefined {
  return useSaves((save) => save.record === record).at(-1);
}

/** Start saves of one kind from a screen. `save` returns false for a double click. */
export function useSave<TInput, TResult>(spec: SaveSpec<TInput, TResult>) {
  const client = useQueryClient();
  const store = useStore();
  return useCallback(
    (input: TInput, intent?: SaveIntent, callbacks?: SaveCallbacks<TResult>) =>
      startSave(client, store, spec, input, intent, callbacks),
    [client, store, spec],
  );
}
