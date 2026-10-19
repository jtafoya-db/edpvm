"""Pure reconciliation decisions for the group-membership snapshot job."""
import time
from typing import Callable, List, NamedTuple, Tuple, TypeVar

T = TypeVar("T")

class Member(NamedTuple):
    user_id: str
    email: str
    display_name: str

class ExistingMembership(NamedTuple):
    user_id: str
    removed: bool = False

class ReconcileResult(NamedTuple):
    upserts: Tuple[Member, ...]
    removals: Tuple[str, ...]
    skipped_non_users: Tuple[str, ...]
    removal_status: str

class SnapshotRunDecision(NamedTuple):
    status: str
    error: object
    messages: Tuple[str, ...]

def snapshot_run_status(groups_expected, groups_read):
    """A run succeeds only when a non-empty allowlist was read completely."""
    expected = set(groups_expected)
    read = set(groups_read)
    return "succeeded" if expected and expected.issubset(read) else "partial"

def finalize_snapshot_run(groups_expected, groups_read, original_error, messages):
    """Choose the persisted status and terminal error for one snapshot run."""
    if original_error is not None:
        return SnapshotRunDecision("failed", original_error, tuple(messages))
    status = snapshot_run_status(groups_expected, groups_read)
    if status == "succeeded":
        return SnapshotRunDecision(status, None, tuple(messages))
    error = RuntimeError(
        f"Membership snapshot incomplete: read {len(groups_read)} of "
        f"{len(groups_expected)} expected groups"
    )
    return SnapshotRunDecision(status, error, tuple(messages) + (str(error),))

def reconcile_group(existing: List[ExistingMembership], fetched_users: List[Member],
                    non_user_member_ids: List[str], *, fetch_complete: bool,
                    max_removals: int) -> ReconcileResult:
    """Return upserts/removals without I/O; removals fail closed."""
    fetched_ids = {member.user_id for member in fetched_users}
    removals = tuple(row.user_id for row in existing
                     if not row.removed and row.user_id not in fetched_ids)
    active_rows = any(not row.removed for row in existing)
    if not fetch_complete:
        status = "partial-fetch"
        removals = ()
    elif not fetched_users and active_rows:
        status = "zero-user-fetch"
        removals = ()
    elif len(removals) > max_removals:
        status = "mass-removal"
        removals = ()
    else:
        status = "applied"
    return ReconcileResult(tuple(fetched_users), removals, tuple(non_user_member_ids), status)

def classify_member_reference(reference: str) -> str:
    """Classify a SCIM $ref without treating an unknown shape as a non-user."""
    path = reference.split("?", 1)[0].rstrip("/")
    resource = path.rsplit("/", 2)[-2] if "/" in path else path.split("/", 1)[0]
    if resource == "Users":
        return "user"
    if resource in {"Groups", "ServicePrincipals"}:
        return "known-non-user"
    return "unresolved"

def validate_allowlist(groups):
    required = {"group_id", "group_name", "kind", "domain", "managed_by"}
    seen = set()
    for group in groups:
        missing = required - group.keys()
        if (missing or group.get("kind") not in {"domain", "dataset"}
                or group.get("managed_by") not in {"scim", "manual"}):
            raise ValueError(
                f"Invalid allowlist entry {group!r}; missing={sorted(missing)}"
            )
        if not all(str(group.get(field, "")).strip() for field in required):
            raise ValueError(f"Allowlist values must be non-empty: {group!r}")
        if group["group_id"] in seen:
            raise ValueError(f"Duplicate allowlist group_id: {group['group_id']}")
        seen.add(group["group_id"])
        # The snapshot reads through the workspace SCIM API, which also returns
        # workspace-local groups. Those are invisible to is_account_group_member()
        # (the #115 row-filter path), so snapshotting one would silently produce
        # rows no one can read. Until the Account Groups API path lands and can
        # verify scope automatically, require the operator to assert it per entry
        # and fail closed otherwise.
        if group.get("account_group") is not True:
            raise ValueError(
                f"Allowlist entry must set account_group: true (confirm it is an "
                f"account group, not workspace-local): {group!r}"
            )
        if (group["kind"] == "dataset"
                and (not group.get("dataset_tag") or group["managed_by"] != "manual")):
            raise ValueError("Dataset groups require dataset_tag and managed_by=manual")

def retry(call: Callable[[], T], is_retryable: Callable[[Exception], bool],
          attempts: int = 5, sleep: Callable[[float], None] = time.sleep) -> T:
    """Retry only exceptions explicitly identified by the SDK integration."""
    for attempt in range(attempts):
        try:
            return call()
        except Exception as error:
            if not is_retryable(error) or attempt == attempts - 1:
                raise
            sleep(2 ** attempt)
    raise AssertionError("retry loop exhausted")

def require_expected_principal(required: bool, expected: str, client) -> None:
    """Match /Me.user_name to the configured service-principal application ID."""
    if not required:
        return
    if not expected:
        raise RuntimeError("Production membership job requires an expected principal")
    actual = getattr(client.current_user.me(), "user_name", "") or ""
    if actual != expected:
        raise RuntimeError(
            f"Membership job principal mismatch: expected {expected!r}, got {actual!r}"
        )

def raise_for_warnings(messages: List[str]) -> None:
    """Fail after all groups are processed so Jobs failure notifications fire."""
    if messages:
        raise RuntimeError("snapshot warnings: " + "; ".join(messages))

def process_groups(groups, process_group: Callable[[object], List[str]]) -> None:
    """Process every configured group before escalating any collected warning."""
    warnings = []
    for group in groups:
        warnings.extend(process_group(group))
    raise_for_warnings(warnings)
