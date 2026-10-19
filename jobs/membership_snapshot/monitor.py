"""Freshness monitor that alerts after two missed snapshot runs.

The snapshot job emails on failure, but a Jobs ``on_failure`` notification
cannot fire when a scheduled run never starts at all (a paused schedule, a
deleted job, a scheduler outage) — and it also cannot fire for a deployment
whose snapshot has *never* completed a run. This companion job reads the most
recent *completed* run from ``snapshot_runs`` and *fails on purpose* once that
run is older than the allowed number of missed cadences, so the same
``on_failure`` email reaches the same operators.

Two design points keep it from both missing and false-firing:

* **Zero completed runs still alert.** The reference point is the newest
  completed run, or — when none has completed yet — a configured ``--since``
  baseline (the schedule's go-live). An empty ``snapshot_runs`` table is stale,
  not an unknown baseline: including the go-live opportunity, it alerts after
  two missed opportunities. With no baseline the monitor fails closed and alerts
  rather than staying silent.
* **No same-boundary false alert.** The monitor runs on the snapshot cadence
  but *offset* within the period (see ``membership_monitor_schedule`` in
  ``databricks.yml``) so a just-completed run is already recorded before it
  checks, and it counts whole *completed-run opportunities* that have strictly
  elapsed rather than a raw wall-clock delta, so the exact two-cadence boundary
  does not fire.

It cannot detect an outage that also stops itself; a platform-level job
monitor still backstops that case. The decision logic here is pure so it can
be tested without a workspace.
"""
import argparse
import math
import re
from datetime import datetime, timezone

# Unity Catalog object names the monitor interpolates into SQL. Kept strict so a
# crafted catalog/schema value cannot break out of the identifier position.
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def validate_identifier(name, *, kind="identifier"):
    """Return ``name`` if it is a safe SQL identifier, else raise ``ValueError``."""
    if not isinstance(name, str) or not _IDENTIFIER.match(name):
        raise ValueError(f"Invalid {kind}: {name!r}")
    return name


def completed_run_sql(catalog, schema):
    """Newest run that proves every configured group was read."""
    return (
        f"SELECT max(started_at) AS last_started "
        f"FROM `{catalog}`.`{schema}`.`snapshot_runs` "
        f"WHERE status = 'succeeded' AND size(groups_expected) > 0 "
        f"AND size(array_except(groups_expected, groups_read)) = 0"
    )


def as_utc(value):
    """Normalize a datetime to timezone-aware UTC.

    Spark ``TIMESTAMP`` columns surface as timezone-*naive* ``datetime`` values,
    and subtracting a naive value from an aware ``now`` raises ``TypeError``. A
    naive value is assumed to already be UTC (the snapshot job writes UTC); an
    aware value is converted. ``None`` passes through unchanged.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def missed_cadences(last_run_started_at, now, cadence_seconds, *, baseline=None):
    """Whole completed-run opportunities missed since the last completed run.

    The reference point is ``last_run_started_at`` (the newest completed run),
    or ``baseline`` (the schedule's go-live) when no run has completed yet. With
    neither, the count is unknown (``None``) and the caller decides.

    The count is boundary-safe: it is the number of scheduled refresh times that
    have *strictly* passed without a newer completion. A successful reference
    excludes its own opportunity (``ceil(elapsed / cadence) - 1``); go-live
    includes its opportunity (``ceil(elapsed / cadence)``). At exactly N
    cadences the N-th refresh is
    firing *now*, not yet missed, so it does not count — this is what keeps the
    same-cadence monitor from false-firing on a just-completed run. All datetime
    inputs are normalized to UTC first so a naive Spark timestamp never throws.
    """
    if cadence_seconds <= 0:
        raise ValueError("cadence_seconds must be positive")
    reference = as_utc(last_run_started_at if last_run_started_at is not None else baseline)
    if reference is None:
        return None
    elapsed = (as_utc(now) - reference).total_seconds()
    if elapsed <= 0:
        return 0
    opportunities = math.ceil(elapsed / cadence_seconds)
    return opportunities - (1 if last_run_started_at is not None else 0)


def should_alert(last_run_started_at, now, cadence_seconds, allowed_missed=2, *, baseline=None):
    """True once at least ``allowed_missed`` completed-run opportunities were missed.

    An empty ``snapshot_runs`` table (no completed run) is treated as stale, not
    as an unknown baseline: the first opportunity is at ``baseline`` itself.
    When nothing has completed *and*
    no baseline is configured, the monitor cannot prove freshness, so it fails
    closed and alerts — absence of a successful run is the primary thing to catch.
    """
    missed = missed_cadences(last_run_started_at, now, cadence_seconds, baseline=baseline)
    if missed is None:
        return True
    return missed >= allowed_missed


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--catalog", required=True)
    parser.add_argument("--schema", required=True)
    parser.add_argument("--cadence-seconds", type=int, required=True)
    parser.add_argument("--allowed-missed", type=int, default=2)
    parser.add_argument(
        "--since",
        default="",
        help="ISO-8601 UTC baseline (schedule go-live) used to count missed "
        "cadences when no run has completed yet; empty means fail closed on an "
        "empty table.",
    )
    args = parser.parse_args()
    catalog = validate_identifier(args.catalog, kind="catalog")
    schema = validate_identifier(args.schema, kind="schema")
    baseline = as_utc(datetime.fromisoformat(args.since)) if args.since else None
    row = spark.sql(  # noqa: F821 - spark is provided by the Databricks runtime
        completed_run_sql(catalog, schema)
    ).collect()
    last_started = as_utc(row[0].last_started) if row else None
    now = datetime.now(timezone.utc)
    missed = missed_cadences(last_started, now, args.cadence_seconds, baseline=baseline)
    if should_alert(last_started, now, args.cadence_seconds, args.allowed_missed, baseline=baseline):
        raise RuntimeError(
            f"Membership snapshot stale: {missed} completed-run cadence(s) missed "
            f"since {last_started or f'baseline {baseline}'} (threshold "
            f"{args.allowed_missed}). The scheduled snapshot job has not completed "
            f"a run; check the job schedule and cluster."
        )
    print(
        f"Membership snapshot fresh: last completed run {last_started}, "
        f"{missed} cadence(s) since (threshold {args.allowed_missed})."
    )


if __name__ == "__main__":
    main()
