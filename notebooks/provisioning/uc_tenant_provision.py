"""Unity Catalog tenant provisioning — pure, testable logic.

This module holds the *logic* for provisioning a per-tenant Unity Catalog
environment on Databricks (a tenant group with data access, a schema, a SQL
warehouse, and cluster policies, under an admin-owned governance model). It is
deliberately free of any notebook globals (``dbutils``, widgets, ``spark`` ...)
so it can be imported and unit tested with mocked SDK clients.

Design principles
-----------------
* **Injected clients.** Every function receives its ``AccountClient`` /
  ``WorkspaceClient`` (or the SQL statement-execution surface) as an argument.
  Nothing here constructs a client, reads a secret, or touches the network on
  import — the notebook wires the real clients, the tests wire mocks.
* **Get-or-create + converge.** Reads run unconditionally (they are safe);
  every *write* (create / update / patch / ALTER) is gated behind
  ``ctx.dry_run``. Existing resources are detected and re-used, grants and tags
  are re-applied so a second run converges to the same state.
* **One code path for plan and apply.** ``dry_run=True`` records the intended
  actions and performs zero writes; ``dry_run=False`` records the same actions
  and performs the writes. The recorded :class:`Action` list *is* the plan, so
  the plan is exactly what apply does — which is what makes it unit-testable.

The ordering (Section B account-plane first, then Section A workspace-plane)
and the individual steps mirror the provisioning notebook.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from databricks.sdk import errors
from databricks.sdk.service import catalog, compute, iam, sql

# ---------------------------------------------------------------------------
# Constants — grant privilege sets (grounded in databricks.sdk Privilege enum)
# ---------------------------------------------------------------------------

CATALOG_PRIVILEGES: List[catalog.Privilege] = [catalog.Privilege.USE_CATALOG]

SCHEMA_PRIVILEGES_READWRITE: List[catalog.Privilege] = [
    catalog.Privilege.USE_SCHEMA,
    catalog.Privilege.SELECT,
    catalog.Privilege.MODIFY,
    catalog.Privilege.CREATE_TABLE,
]

SCHEMA_PRIVILEGES_READ: List[catalog.Privilege] = [
    catalog.Privilege.USE_SCHEMA,
    catalog.Privilege.SELECT,
]

ACCESS_LEVEL_READWRITE = "readwrite"
ACCESS_LEVEL_READ = "read"

# The synthetic tag key required alongside the human tag keys. Its value always
# mirrors the ``tenant`` tag value.
TAG2_KEY = "tag2key"


# ---------------------------------------------------------------------------
# Config + plan primitives
# ---------------------------------------------------------------------------


@dataclass
class ProvisionConfig:
    """All provisioning inputs (what the notebook widgets collect)."""

    environment: str
    catalog: str
    group_name: str
    schema_name: str
    warehouse_name: str
    allpurpose_policy_name: str
    job_policy_name: str
    users: List[str] = field(default_factory=list)
    access_level: str = ACCESS_LEVEL_READWRITE

    # Governance: the account group that OWNS the provisioned per-tenant assets
    # (schema owner; warehouse IS_OWNER/CAN_MANAGE). Required at provision time —
    # blank fails loud. See :func:`validate_admin_group`.
    admin_group: str = ""

    # Tag values.
    tenant: str = ""
    domain: str = ""
    dataset: str = ""
    pii: str = ""
    project: str = ""

    # Warehouse sizing.
    cluster_size: str = "Small"
    auto_stop_mins: int = 10
    min_num_clusters: int = 1
    max_num_clusters: int = 1

    # Section B (account plane).
    account_id: str = ""
    workspace_id: int = 0

    def normalized_access_level(self) -> str:
        level = (self.access_level or "").strip().lower()
        return ACCESS_LEVEL_READ if level == ACCESS_LEVEL_READ else ACCESS_LEVEL_READWRITE

    def schema_full_name(self) -> str:
        return f"{self.catalog}.{self.schema_name}"


@dataclass
class Action:
    """A single intended action, recorded whether or not it is executed.

    ``write`` is ``True`` when this action *would mutate* state (create / grant
    / tag / assign). When it is ``False`` the action is a no-op observation such
    as "group already exists" — useful for a converged re-run plan.
    """

    step: str
    resource: str
    write: bool
    detail: Dict[str, Any] = field(default_factory=dict)
    executed: bool = False  # True only when actually applied (write & not dry_run)

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        if not self.write:
            verb = "SKIP  (exists)"
        elif self.executed:
            verb = "APPLY"
        else:
            verb = "PLAN "
        return f"[{verb}] {self.step}: {self.resource} {self.detail or ''}".rstrip()


@dataclass
class ProvisionContext:
    """Threads config + dry-run flag + accumulating plan through the steps."""

    config: ProvisionConfig
    dry_run: bool = True
    actions: List[Action] = field(default_factory=list)

    def record(
        self,
        step: str,
        resource: str,
        write: bool,
        detail: Optional[Dict[str, Any]] = None,
        executed: bool = False,
    ) -> Action:
        action = Action(
            step=step,
            resource=resource,
            write=write,
            detail=detail or {},
            executed=executed,
        )
        self.actions.append(action)
        return action

    @property
    def plan(self) -> List[Action]:
        return list(self.actions)


class ProvisioningError(RuntimeError):
    """Raised when provisioning cannot safely continue (e.g. missing group)."""


class SqlStatementError(ProvisioningError):
    """A failed SQL statement, preserving the SDK error structure.

    ``error_code`` is the SDK ``ServiceErrorCode`` (often a generic code such as
    ``BAD_REQUEST``); ``error_class`` is the specific Unity Catalog error-class
    leaf parsed from the message (e.g. ``UC_TAG_POLICY_VALUE_NOT_ALLOWED``).
    Callers classify on these rather than on substrings of the message.
    """

    def __init__(
        self,
        message: str,
        *,
        state: Any = None,
        error_code: Any = None,
        error_class: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.state = state
        self.error_code = error_code
        self.error_class = error_class


# ---------------------------------------------------------------------------
# derive_names — STUB for a future naming convention
# ---------------------------------------------------------------------------


def derive_names(config: ProvisionConfig) -> ProvisionConfig:
    """Placeholder for a future naming convention.

    Today this is an identity transform: it returns the manually supplied
    names unchanged. When a naming convention is adopted (e.g. deriving
    ``<env>_<tenant>_<domain>`` names), implement it here and the notebook /
    tests pick it up for free.
    """

    return config


def validate_admin_group(config: ProvisionConfig) -> None:
    """Fail loud when ``admin_group`` is blank.

    ``admin_group`` is the account group that OWNS the provisioned per-tenant
    assets, so provisioning cannot proceed (even as a dry-run plan) without it.
    """

    if not (config.admin_group or "").strip():
        raise ProvisioningError(
            "admin_group is required — set it to the account group that should "
            "own the provisioned assets."
        )


def validate_admin_group_principal(
    ctx: ProvisionContext, workspace_client: Any
) -> None:
    """Plan-phase preflight: ``admin_group`` must be a valid UC owner principal.

    Runs BEFORE any ownership transfer (and any write), so an admin learns in the
    dry-run/plan phase that the group can't own UC objects — without provisioning
    anything. Detection is a READ-ONLY SCIM lookup of the group's
    ``meta.resourceType`` (grounded live): account-level groups report
    ``"Group"`` and can own UC securables; reserved / workspace-local groups
    (e.g. ``admins``, ``users``) report ``"WorkspaceGroup"`` and cannot — a live
    probe confirmed ``OWNER TO `admins``` fails with PRINCIPAL_DOES_NOT_EXIST.

    This is a governance control, so it is **fail-closed** — it PASSES only on
    positive confirmation that the group is account-level:

    * ``meta.resourceType == "Group"`` (account-level) → PASS, proceed;
    * ``"WorkspaceGroup"`` (reserved / workspace-local) → fail loud;
    * the group does not resolve at all → fail loud;
    * missing / unknown / any other resourceType → fail loud (never silently
      pass).

    It never swallows unrelated errors — a failure of the underlying
    ``groups.list`` propagates.
    """

    cfg = ctx.config
    group = _find_group(workspace_client.groups, cfg.admin_group)
    if group is None:
        raise ProvisioningError(
            f"admin_group '{cfg.admin_group}' could not be resolved as a group in "
            "this workspace: it must be an account-level group assigned to the "
            "workspace. Create one in the account console (e.g. "
            "platform-admins) and set admin_group to it."
        )

    resource_type = _group_resource_type(group)
    if resource_type == _ACCOUNT_GROUP_RESOURCE_TYPE:
        # Positive confirmation: account-level group -> valid UC owner principal.
        ctx.record(
            "admin_group.preflight",
            cfg.admin_group,
            write=False,
            detail={"resource_type": resource_type},
        )
        return

    if resource_type == _WORKSPACE_LOCAL_RESOURCE_TYPE:
        raise ProvisioningError(
            f"admin_group '{cfg.admin_group}' cannot own Unity Catalog objects: "
            "it is a reserved workspace-local group. Set admin_group to an "
            "account-level group (create one in the account console, e.g. "
            "platform-admins)."
        )

    # Missing / unknown / unexpected resourceType: fail closed rather than
    # silently pass — we could not positively confirm an account-level group.
    seen = "absent" if resource_type is None else repr(resource_type)
    raise ProvisioningError(
        f"Could not confirm admin_group '{cfg.admin_group}' is an account-level "
        f"group (meta.resourceType={seen}). Provisioning requires an "
        "account-level group as the UC owner; verify the group is account-level."
    )


# ---------------------------------------------------------------------------
# Tag models
# ---------------------------------------------------------------------------


def build_schema_tags(config: ProvisionConfig) -> Dict[str, str]:
    """Tags for a UC schema — every human key plus ``tag2key`` == tenant."""

    return {
        "tenant": config.tenant,
        "domain": config.domain,
        "dataset": config.dataset,
        "pii": config.pii,
        "project": config.project,
        TAG2_KEY: config.tenant,
    }


def build_warehouse_tags(config: ProvisionConfig) -> Dict[str, str]:
    """Tags a SQL warehouse supports: tenant / project / environment / tag2key."""

    return {
        "tenant": config.tenant,
        "project": config.project,
        "environment": config.environment,
        TAG2_KEY: config.tenant,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _find_group(groups_api: Any, group_name: str) -> Optional[Any]:
    """Return the group whose displayName matches, else ``None``.

    Works for both ``AccountClient.groups`` and ``WorkspaceClient.groups`` —
    they share the SCIM list/filter surface.
    """

    result = groups_api.list(filter=f'displayName eq "{group_name}"')
    for group in result or []:
        if getattr(group, "display_name", None) == group_name:
            return group
    return None


def _member_ids(group: Any) -> List[str]:
    members = getattr(group, "members", None) or []
    ids = []
    for m in members:
        value = getattr(m, "value", None)
        if value is not None:
            ids.append(str(value))
    return ids


# SCIM ``meta.resourceType`` values (grounded from a live example-workspace read):
# account-level groups — the only valid Unity Catalog owner principals — report
# "Group"; reserved / workspace-local groups (e.g. ``admins``, ``users``) report
# "WorkspaceGroup" and CANNOT own UC securables (OWNER TO them fails with
# PRINCIPAL_DOES_NOT_EXIST, confirmed by live probe).
_ACCOUNT_GROUP_RESOURCE_TYPE = "Group"
_WORKSPACE_LOCAL_RESOURCE_TYPE = "WorkspaceGroup"


def _group_resource_type(group: Any) -> Optional[str]:
    """Return a SCIM group's ``meta.resourceType`` (read-only), or ``None``."""

    meta = getattr(group, "meta", None)
    if meta is None:
        return None
    return getattr(meta, "resource_type", None)


# ---------------------------------------------------------------------------
# Section B — ACCOUNT plane (runs FIRST, skippable)
# ---------------------------------------------------------------------------


def ensure_group(ctx: ProvisionContext, account_client: Any) -> Optional[Any]:
    """Step 1 — get-or-create the account group. Idempotent."""

    cfg = ctx.config
    existing = _find_group(account_client.groups, cfg.group_name)
    if existing is not None:
        ctx.record(
            "group.create",
            cfg.group_name,
            write=False,
            detail={"group_id": getattr(existing, "id", None)},
        )
        return existing

    ctx.record("group.create", cfg.group_name, write=True, executed=not ctx.dry_run)
    if ctx.dry_run:
        return None
    return account_client.groups.create(display_name=cfg.group_name)


def assign_group_to_workspace(
    ctx: ProvisionContext, account_client: Any, group: Optional[Any]
) -> None:
    """Step 2 — assign the group to the workspace as USER."""

    cfg = ctx.config
    group_id = getattr(group, "id", None)
    ctx.record(
        "group.assign_workspace",
        cfg.group_name,
        write=True,
        detail={
            "workspace_id": cfg.workspace_id,
            "principal_id": group_id,
            "permissions": [iam.WorkspacePermission.USER.value],
        },
        executed=not ctx.dry_run,
    )
    if ctx.dry_run:
        return
    account_client.workspace_assignment.update(
        workspace_id=cfg.workspace_id,
        principal_id=int(group_id),
        permissions=[iam.WorkspacePermission.USER],
    )


def resolve_user_id(account_client: Any, email: str) -> Optional[str]:
    """Resolve an account user's SCIM ``id`` from its ``userName`` (email).

    SCIM group members are keyed by user *id*, not email, so both the
    existing-member comparison and the PATCH payload must use the resolved id.
    Returns ``None`` when no account user matches.
    """

    users = account_client.users.list(filter=f'userName eq "{email}"')
    for user in users or []:
        if getattr(user, "user_name", None) == email:
            uid = getattr(user, "id", None)
            return str(uid) if uid is not None else None
    return None


def add_users_to_group(
    ctx: ProvisionContext, account_client: Any, group: Optional[Any]
) -> None:
    """Step 3 — add ``users`` to the group, skipping current members.

    Each input email is resolved to its account user id; that id (not the
    email) is used for both the membership comparison and the SCIM PATCH
    ``value``. An email with no matching account user fails loud.
    """

    cfg = ctx.config
    if not cfg.users:
        return

    group_id = getattr(group, "id", None)
    existing_ids = set(_member_ids(group)) if group is not None else set()

    # Resolve every email to its account user id up front (fail loud on miss).
    resolved = []  # list of (email, user_id)
    for email in cfg.users:
        user_id = resolve_user_id(account_client, email)
        if user_id is None:
            raise ProvisioningError(
                f"User '{email}' was not found in the Databricks account. "
                "Add the user to the account (or correct the email) before "
                "provisioning."
            )
        resolved.append((email, user_id))

    to_add = [(email, uid) for email, uid in resolved if uid not in existing_ids]
    already = [(email, uid) for email, uid in resolved if uid in existing_ids]

    for email, uid in already:
        ctx.record("group.add_member", email, write=False, detail={"user_id": uid})

    if not to_add:
        return

    ctx.record(
        "group.add_member",
        ",".join(email for email, _ in to_add),
        write=True,
        detail={
            "members": [email for email, _ in to_add],
            "user_ids": [uid for _, uid in to_add],
            "group_id": group_id,
        },
        executed=not ctx.dry_run,
    )
    if ctx.dry_run:
        return

    operations = [
        iam.Patch(
            op=iam.PatchOp.ADD,
            path="members",
            value=[{"value": uid} for _, uid in to_add],
        )
    ]
    account_client.groups.patch(
        id=str(group_id),
        operations=operations,
        schemas=[iam.PatchSchema.URN_IETF_PARAMS_SCIM_API_MESSAGES_2_0_PATCH_OP],
    )


def run_account_section(ctx: ProvisionContext, account_client: Optional[Any]) -> Optional[Any]:
    """Section B orchestration. Returns the group (or ``None`` in dry-run/skip)."""

    if account_client is None:
        ctx.record(
            "section_b.skip",
            ctx.config.group_name,
            write=False,
            detail={"reason": "run_account_section disabled or SP secret absent"},
        )
        return None

    group = ensure_group(ctx, account_client)
    assign_group_to_workspace(ctx, account_client, group)
    add_users_to_group(ctx, account_client, group)
    return group


# ---------------------------------------------------------------------------
# Section A — WORKSPACE plane
# ---------------------------------------------------------------------------


def verify_group_exists(ctx: ProvisionContext, workspace_client: Any) -> None:
    """Ordering caveat — if Section B was skipped, the group must already exist.

    Section A grants reference the group by name; if it is absent we FAIL LOUD
    rather than silently create grants against a non-existent principal.
    """

    group = _find_group(workspace_client.groups, ctx.config.group_name)
    if group is None:
        raise ProvisioningError(
            f"Group '{ctx.config.group_name}' does not exist in this workspace. "
            "Run Section B (run_account_section=true) or pre-create/assign the "
            "group before running Section A."
        )
    ctx.record("group.verify", ctx.config.group_name, write=False)


def ensure_schema(ctx: ProvisionContext, workspace_client: Any) -> None:
    """Step 4 — get-or-create the schema in the catalog. Idempotent."""

    cfg = ctx.config
    full_name = cfg.schema_full_name()
    from databricks.sdk import errors  # local import keeps module import cheap

    try:
        workspace_client.schemas.get(full_name=full_name)
        ctx.record("schema.create", full_name, write=False)
        return
    except errors.NotFound:
        pass

    ctx.record("schema.create", full_name, write=True, executed=not ctx.dry_run)
    if ctx.dry_run:
        return
    workspace_client.schemas.create(name=cfg.schema_name, catalog_name=cfg.catalog)


def build_grant_changes(config: ProvisionConfig) -> Dict[str, catalog.PermissionsChange]:
    """Return the additive PermissionsChange for catalog and schema.

    Kept separate so tests can assert the exact privilege payloads for
    ``readwrite`` vs ``read``.
    """

    if config.normalized_access_level() == ACCESS_LEVEL_READ:
        schema_privs = list(SCHEMA_PRIVILEGES_READ)
    else:
        schema_privs = list(SCHEMA_PRIVILEGES_READWRITE)

    return {
        "catalog": catalog.PermissionsChange(
            principal=config.group_name, add=list(CATALOG_PRIVILEGES)
        ),
        "schema": catalog.PermissionsChange(
            principal=config.group_name, add=schema_privs
        ),
    }


_SQL_TERMINAL_STATES = (
    sql.StatementState.SUCCEEDED,
    sql.StatementState.FAILED,
    sql.StatementState.CANCELED,
    sql.StatementState.CLOSED,
)

# The SDK ``ServiceErrorCode`` on a UC governed-tag rejection is generic (e.g.
# BAD_REQUEST); the specific code is embedded in the message as
# ``ErrorClass=<NAMESPACE>.<CODE>``. This extracts the trailing <CODE> leaf.
_ERROR_CLASS_RE = re.compile(r"ErrorClass=([A-Za-z0-9_.]+)")


def _parse_error_class(message: Optional[str]) -> Optional[str]:
    """Return the trailing UC error-class code from a message, if present.

    e.g. ``[... ErrorClass=INVALID_PARAMETER_VALUE.UC_TAG_POLICY_VALUE_NOT_ALLOWED]``
    -> ``"UC_TAG_POLICY_VALUE_NOT_ALLOWED"``.
    """

    if not message:
        return None
    match = _ERROR_CLASS_RE.search(message)
    if not match:
        return None
    return match.group(1).rsplit(".", 1)[-1]


def _run_sql(
    workspace_client: Any,
    statement: str,
    warehouse_id: str,
    poll_timeout_seconds: float = 300.0,
    poll_interval_seconds: float = 2.0,
) -> Any:
    """Execute a SQL statement synchronously to a TERMINAL state, failing loud.

    ``execute_statement(wait_timeout="30s")`` may still return with the
    statement PENDING or RUNNING; treating that as success would report a grant
    / tag done while it is still running (or before it fails). So we poll
    ``get_statement`` until the statement reaches a terminal state
    (SUCCEEDED / FAILED / CANCELED / CLOSED), then:

    * return only on SUCCEEDED,
    * raise :class:`SqlStatementError` (preserving the structured
      ``error_code`` / ``error_class``) on FAILED / CANCELED / CLOSED,
    * raise on overall timeout.
    """

    resp = workspace_client.statement_execution.execute_statement(
        statement=statement,
        warehouse_id=warehouse_id,
        wait_timeout="30s",
    )
    statement_id = getattr(resp, "statement_id", None)
    status = getattr(resp, "status", None)
    state = getattr(status, "state", None)

    deadline = time.monotonic() + poll_timeout_seconds
    while state not in _SQL_TERMINAL_STATES:
        if time.monotonic() >= deadline:
            raise SqlStatementError(
                f"SQL statement did not finish within {poll_timeout_seconds:.0f}s "
                f"(last state {state}): {statement!r}",
                state=state,
            )
        time.sleep(poll_interval_seconds)
        resp = workspace_client.statement_execution.get_statement(statement_id)
        status = getattr(resp, "status", None)
        state = getattr(status, "state", None)

    if state != sql.StatementState.SUCCEEDED:
        error = getattr(status, "error", None)
        error_code = getattr(error, "error_code", None)
        message = getattr(error, "message", None)
        raise SqlStatementError(
            f"SQL statement failed ({state}): {statement!r} -> {error}",
            state=state,
            error_code=error_code,
            error_class=_parse_error_class(message),
        )
    return resp


def _quote_ident(name: str) -> str:
    """Backtick-quote a SQL identifier, escaping embedded backticks."""

    return "`" + (name or "").replace("`", "``") + "`"


def _sql_privilege_list(privileges: List[catalog.Privilege]) -> str:
    """Render Privilege enums as UC SQL keywords (``USE_CATALOG`` -> ``USE CATALOG``)."""

    return ", ".join(p.value.replace("_", " ") for p in privileges)


def build_catalog_grant_sql(config: ProvisionConfig) -> str:
    """``GRANT <privs> ON CATALOG <catalog> TO `<group>``` (idempotent in UC)."""

    changes = build_grant_changes(config)
    privs = _sql_privilege_list(changes["catalog"].add)
    return (
        f"GRANT {privs} ON CATALOG {_quote_ident(config.catalog)} "
        f"TO {_quote_ident(config.group_name)}"
    )


def build_schema_grant_sql(config: ProvisionConfig) -> str:
    """``GRANT <privs> ON SCHEMA <catalog>.<schema> TO `<group>``` (idempotent)."""

    changes = build_grant_changes(config)
    privs = _sql_privilege_list(changes["schema"].add)
    return (
        f"GRANT {privs} ON SCHEMA "
        f"{_quote_ident(config.catalog)}.{_quote_ident(config.schema_name)} "
        f"TO {_quote_ident(config.group_name)}"
    )


def grant_permissions(
    ctx: ProvisionContext, workspace_client: Any, warehouse_id: Optional[str]
) -> None:
    """Grants: catalog USE_CATALOG; schema per access_level.

    Applied via UC **SQL GRANT** run through the statement-execution API on the
    provisioned warehouse — version-independent and consistent with how schema
    tags are applied. This sidesteps a serialization defect in the SDK
    ``grants.update`` path parameter, where a ``SecurableType`` enum interpolates
    into the URL as ``SecurableType.CATALOG`` and the server rejects the
    normalized ``SECURABLETYPE.CATALOG``. GRANT is idempotent in Unity Catalog,
    so re-runs converge without error.
    """

    cfg = ctx.config
    changes = build_grant_changes(cfg)
    catalog_sql = build_catalog_grant_sql(cfg)
    schema_sql = build_schema_grant_sql(cfg)

    ctx.record(
        "grant.catalog",
        cfg.catalog,
        write=True,
        detail={
            "privileges": [p.value for p in changes["catalog"].add],
            "statement": catalog_sql,
        },
        executed=not ctx.dry_run,
    )
    ctx.record(
        "grant.schema",
        cfg.schema_full_name(),
        write=True,
        detail={
            "access_level": cfg.normalized_access_level(),
            "privileges": [p.value for p in changes["schema"].add],
            "statement": schema_sql,
        },
        executed=not ctx.dry_run,
    )
    if ctx.dry_run:
        return

    if warehouse_id is None:
        raise ProvisioningError(
            "Cannot apply UC grants: no warehouse id available for statement "
            "execution."
        )
    _run_sql(workspace_client, catalog_sql, warehouse_id)
    _run_sql(workspace_client, schema_sql, warehouse_id)


def _find_warehouse(workspace_client: Any, name: str) -> Optional[Any]:
    for wh in workspace_client.warehouses.list() or []:
        if getattr(wh, "name", None) == name:
            return wh
    return None


def _endpoint_tags(config: ProvisionConfig) -> sql.EndpointTags:
    pairs = [
        sql.EndpointTagPair(key=k, value=v)
        for k, v in build_warehouse_tags(config).items()
    ]
    return sql.EndpointTags(custom_tags=pairs)


def _existing_warehouse_tags(warehouse: Any) -> Dict[str, str]:
    """Read an existing warehouse's tags into a plain ``{key: value}`` dict."""

    tags = getattr(warehouse, "tags", None)
    if tags is None:
        return {}
    pairs = getattr(tags, "custom_tags", None) or []
    result: Dict[str, str] = {}
    for pair in pairs:
        key = getattr(pair, "key", None)
        if key is not None:
            result[key] = getattr(pair, "value", None)
    return result


def ensure_warehouse(ctx: ProvisionContext, workspace_client: Any) -> Optional[str]:
    """Step 6 — get-or-create a classic PRO warehouse, grant group CAN_MANAGE.

    Returns the warehouse id (needed later for schema tag SQL), or ``None`` in
    dry-run when the warehouse does not yet exist.
    """

    cfg = ctx.config
    existing = _find_warehouse(workspace_client, cfg.warehouse_name)
    warehouse_id = getattr(existing, "id", None) if existing is not None else None
    desired_tags = build_warehouse_tags(cfg)

    create_detail = {
        "warehouse_type": sql.CreateWarehouseRequestWarehouseType.PRO.value,
        "enable_serverless_compute": False,
        "cluster_size": cfg.cluster_size,
        "auto_stop_mins": cfg.auto_stop_mins,
        "min_num_clusters": cfg.min_num_clusters,
        "max_num_clusters": cfg.max_num_clusters,
        "tags": desired_tags,
    }

    if existing is not None:
        ctx.record("warehouse.create", cfg.warehouse_name, write=False,
                   detail={"warehouse_id": warehouse_id})
        # Converge tags on re-run: edit the warehouse only when they differ.
        current_tags = _existing_warehouse_tags(existing)
        if current_tags != desired_tags:
            ctx.record("warehouse.retag", cfg.warehouse_name, write=True,
                       detail={"tags": desired_tags}, executed=not ctx.dry_run)
            if not ctx.dry_run:
                # edit_and_wait returns GetWarehouseResponse (has .id).
                workspace_client.warehouses.edit_and_wait(
                    id=warehouse_id,
                    name=cfg.warehouse_name,
                    warehouse_type=sql.CreateWarehouseRequestWarehouseType.PRO,
                    enable_serverless_compute=False,
                    cluster_size=cfg.cluster_size,
                    auto_stop_mins=cfg.auto_stop_mins,
                    min_num_clusters=cfg.min_num_clusters,
                    max_num_clusters=cfg.max_num_clusters,
                    tags=_endpoint_tags(cfg),
                )
        else:
            ctx.record("warehouse.retag", cfg.warehouse_name, write=False,
                       detail={"tags": desired_tags})
    else:
        ctx.record("warehouse.create", cfg.warehouse_name, write=True,
                   detail=create_detail, executed=not ctx.dry_run)
        if not ctx.dry_run:
            # create() returns Wait[GetWarehouseResponse] (no .id);
            # create_and_wait() returns GetWarehouseResponse (has .id).
            created = workspace_client.warehouses.create_and_wait(
                name=cfg.warehouse_name,
                warehouse_type=sql.CreateWarehouseRequestWarehouseType.PRO,
                enable_serverless_compute=False,
                cluster_size=cfg.cluster_size,
                auto_stop_mins=cfg.auto_stop_mins,
                min_num_clusters=cfg.min_num_clusters,
                max_num_clusters=cfg.max_num_clusters,
                tags=_endpoint_tags(cfg),
            )
            warehouse_id = getattr(created, "id", None)

    # Grant the group CAN_MANAGE (which includes use + restart).
    ctx.record(
        "warehouse.grant",
        cfg.warehouse_name,
        write=True,
        detail={
            "group": cfg.group_name,
            "permission_level": sql.WarehousePermissionLevel.CAN_MANAGE.value,
        },
        executed=not ctx.dry_run,
    )
    if not ctx.dry_run and warehouse_id is not None:
        workspace_client.warehouses.update_permissions(
            warehouse_id=warehouse_id,
            access_control_list=[
                sql.WarehouseAccessControlRequest(
                    group_name=cfg.group_name,
                    permission_level=sql.WarehousePermissionLevel.CAN_MANAGE,
                )
            ],
        )

    return warehouse_id


def build_policy_definitions(config: ProvisionConfig) -> Dict[str, Dict[str, Any]]:
    """Return the two cluster-policy definition dicts (pre-``json.dumps``).

    * all-purpose SHARED: ``cluster_type`` fixed ``all-purpose`` and
      ``data_security_mode`` fixed ``USER_ISOLATION``.
    * basic JOB: ``cluster_type`` fixed ``job``.
    """

    return {
        "all_purpose": {
            "cluster_type": {"type": "fixed", "value": "all-purpose"},
            "data_security_mode": {"type": "fixed", "value": "USER_ISOLATION"},
        },
        "job": {
            "cluster_type": {"type": "fixed", "value": "job"},
        },
    }


def _find_cluster_policy(workspace_client: Any, name: str) -> Optional[Any]:
    for policy in workspace_client.cluster_policies.list() or []:
        if getattr(policy, "name", None) == name:
            return policy
    return None


def _ensure_one_policy(
    ctx: ProvisionContext,
    workspace_client: Any,
    policy_name: str,
    definition: Dict[str, Any],
) -> None:
    cfg = ctx.config
    existing = _find_cluster_policy(workspace_client, policy_name)
    policy_id = getattr(existing, "policy_id", None) if existing is not None else None

    if existing is not None:
        ctx.record("policy.create", policy_name, write=False,
                   detail={"policy_id": policy_id, "definition": definition})
    else:
        ctx.record("policy.create", policy_name, write=True,
                   detail={"definition": definition}, executed=not ctx.dry_run)
        if not ctx.dry_run:
            created = workspace_client.cluster_policies.create(
                name=policy_name, definition=json.dumps(definition)
            )
            policy_id = getattr(created, "policy_id", None)

    ctx.record(
        "policy.grant",
        policy_name,
        write=True,
        detail={
            "group": cfg.group_name,
            "permission_level": iam.PermissionLevel.CAN_USE.value,
        },
        executed=not ctx.dry_run,
    )
    if not ctx.dry_run and policy_id is not None:
        workspace_client.permissions.update(
            request_object_type="cluster-policies",
            request_object_id=policy_id,
            access_control_list=[
                iam.AccessControlRequest(
                    group_name=cfg.group_name,
                    permission_level=iam.PermissionLevel.CAN_USE,
                )
            ],
        )


def ensure_cluster_policies(ctx: ProvisionContext, workspace_client: Any) -> None:
    """Step 7 — get-or-create both cluster policies and grant group CAN_USE."""

    cfg = ctx.config
    definitions = build_policy_definitions(cfg)
    _ensure_one_policy(ctx, workspace_client, cfg.allpurpose_policy_name,
                       definitions["all_purpose"])
    _ensure_one_policy(ctx, workspace_client, cfg.job_policy_name,
                       definitions["job"])


def build_schema_tag_sql(config: ProvisionConfig) -> str:
    """Build the ``ALTER SCHEMA ... SET TAGS`` statement for the schema tags.

    Identifiers (catalog / schema) are backtick-quoted via :func:`_quote_ident`
    and tag keys/values are single-quote-escaped string literals, so names with
    embedded backticks or quotes can't break or inject into the statement.
    """

    tags = build_schema_tags(config)
    pairs = ", ".join(
        f"'{_escape_sql(k)}' = '{_escape_sql(v)}'" for k, v in tags.items()
    )
    return (
        f"ALTER SCHEMA "
        f"{_quote_ident(config.catalog)}.{_quote_ident(config.schema_name)} "
        f"SET TAGS ({pairs})"
    )


def _escape_sql(value: str) -> str:
    return (value or "").replace("'", "''")


# The one governed-tag rejection we treat as non-fatal: a governed tag key's
# value is not in the policy's allowed list. This is an environment governance
# constraint, not a provisioning defect. Every OTHER error — including other
# UC_TAG_POLICY_* codes (e.g. ..._EXTRA, ..._KEY_NOT_ALLOWED) and generic
# "tag policy" text — must fail loud.
_TAG_POLICY_VALUE_NOT_ALLOWED = "UC_TAG_POLICY_VALUE_NOT_ALLOWED"

# Word-boundary fallback so a suffixed code like ``..._EXTRA`` never matches
# (underscore is a word char, so ``\b`` does not fire between ALLOWED and _EXTRA).
_TAG_POLICY_VALUE_NOT_ALLOWED_RE = re.compile(
    r"\b" + re.escape(_TAG_POLICY_VALUE_NOT_ALLOWED) + r"\b"
)


def _is_tag_policy_error(exc: Exception) -> bool:
    """True only for the exact ``UC_TAG_POLICY_VALUE_NOT_ALLOWED`` rejection.

    Prefers the structured error class parsed onto :class:`SqlStatementError`
    (exact equality). If that isn't populated (older SDK/runtime), falls back to
    a word-boundary match on the message — never a bare substring ``in``.
    """

    error_class = getattr(exc, "error_class", None)
    if error_class is not None:
        return error_class == _TAG_POLICY_VALUE_NOT_ALLOWED
    return bool(_TAG_POLICY_VALUE_NOT_ALLOWED_RE.search(str(exc)))


def apply_tags(
    ctx: ProvisionContext, workspace_client: Any, warehouse_id: Optional[str]
) -> None:
    """Step 8 — tag the schema via UC SQL.

    Warehouse tags are set/converged as ``EndpointTags`` in
    :func:`ensure_warehouse` (create or edit); here we set the *schema* tags via
    statement-execution against the provisioned warehouse.

    A UC governed-tag *policy* rejection is reported and skipped (non-fatal) so
    the rest of provisioning still completes and re-runs stay clean; any other
    SQL failure fails loud.
    """

    cfg = ctx.config
    statement = build_schema_tag_sql(cfg)

    if ctx.dry_run:
        ctx.record(
            "tag.schema",
            cfg.schema_full_name(),
            write=True,
            detail={"tags": build_schema_tags(cfg), "statement": statement},
            executed=False,
        )
        return

    if warehouse_id is None:
        raise ProvisioningError(
            "Cannot apply schema tags: no warehouse id available for "
            "statement execution."
        )

    try:
        _run_sql(workspace_client, statement, warehouse_id)
    except ProvisioningError as exc:
        if _is_tag_policy_error(exc):
            ctx.record(
                "tag.schema.blocked",
                cfg.schema_full_name(),
                write=False,
                detail={
                    "reason": "Unity Catalog tag policy restricts a governed "
                    "tag key/value",
                    "error": str(exc),
                },
            )
            print(
                "WARNING: schema tags NOT applied — a Unity Catalog tag policy "
                "restricts one or more governed tag keys/values (e.g. 'tenant'). "
                "Register the allowed values for those tag keys (or remove the "
                "policy), then re-run. All other provisioning steps completed."
            )
            return
        raise

    ctx.record(
        "tag.schema",
        cfg.schema_full_name(),
        write=True,
        detail={"tags": build_schema_tags(cfg), "statement": statement},
        executed=True,
    )


# ---------------------------------------------------------------------------
# Ownership (admin-owned governance) — runs LAST so the running principal keeps
# authority to finish creates / grants / tags before ownership moves away.
# ---------------------------------------------------------------------------

# UC error class when OWNER TO names a principal the metastore can't resolve —
# e.g. the reserved workspace 'admins' group or any workspace-local group. Only
# account-level groups are valid UC owner principals.
_PRINCIPAL_DOES_NOT_EXIST = "PRINCIPAL_DOES_NOT_EXIST"

# UC error class for a genuine permission denial (schema OWNER TO by a principal
# that is neither the owner, a metastore admin, nor holds MANAGE). Only this is
# reported as a runner-privilege problem — every other SQL failure surfaces as-is.
_PERMISSION_DENIED = "PERMISSION_DENIED"

# The warehouse permissions API rejects group IS_OWNER with this message
# (grounded from a live example-workspace run):
#   "PATCH requests for warehouse <id> with owner permissions are not supported
#    currently, please use PUT request with full set of permissions instead."
# NOTE (grounded): the SDK raises this as errors.NotImplemented (HTTP 501), NOT
# BadRequest — so a type-only match would MISS it. There is no distinct
# structured error_code either, so the only reliable, narrow signal is a stable
# substring of the message. We therefore gate the CAN_MANAGE fallback on this
# exact substring (excluding permission errors, handled separately); every other
# error — including unrelated NotImplemented/BadRequest/NotFound/5xx — propagates.
_WAREHOUSE_IS_OWNER_UNSUPPORTED = "owner permissions are not supported"


def build_schema_owner_sql(config: ProvisionConfig) -> str:
    """``ALTER SCHEMA <cat>.<sch> OWNER TO `<admin_group>``` (idempotent).

    Uses :func:`_quote_ident` so hyphenated group names (e.g.
    ``tenant-analysts``) and any embedded backticks are quoted safely.
    """

    return (
        f"ALTER SCHEMA "
        f"{_quote_ident(config.catalog)}.{_quote_ident(config.schema_name)} "
        f"OWNER TO {_quote_ident(config.admin_group)}"
    )


def read_schema_owner(workspace_client: Any, full_name: str) -> Optional[str]:
    """Return the schema's current owner, or ``None`` if it doesn't exist yet.

    A structured metastore read (``schemas.get().owner``) — no warehouse
    required — used for the ownership-transfer idempotency check.
    """

    try:
        info = workspace_client.schemas.get(full_name=full_name)
    except errors.NotFound:
        return None
    return getattr(info, "owner", None)


def transfer_schema_ownership(
    ctx: ProvisionContext, workspace_client: Any, warehouse_id: Optional[str]
) -> None:
    """FINAL schema step — transfer ownership to the admin group.

    Idempotent: reads the current owner first and SKIPs when it is already the
    admin group (so an admin-group member can re-run cleanly). Runs after schema
    create + tag + tenant grants. Fails loud on insufficient privilege.
    """

    cfg = ctx.config
    full_name = cfg.schema_full_name()
    statement = build_schema_owner_sql(cfg)
    current_owner = read_schema_owner(workspace_client, full_name)

    if current_owner is not None and current_owner == cfg.admin_group:
        ctx.record(
            "schema.owner",
            full_name,
            write=False,
            detail={"owner": current_owner, "admin_group": cfg.admin_group},
        )
        return

    ctx.record(
        "schema.owner",
        full_name,
        write=True,
        detail={
            "current_owner": current_owner,
            "admin_group": cfg.admin_group,
            "statement": statement,
        },
        executed=not ctx.dry_run,
    )
    if ctx.dry_run:
        return

    if warehouse_id is None:
        raise ProvisioningError(
            "Cannot transfer schema ownership: no warehouse id available for "
            "statement execution."
        )
    try:
        _run_sql(workspace_client, statement, warehouse_id)
    except SqlStatementError as exc:
        error_class = getattr(exc, "error_class", None)
        if error_class == _PRINCIPAL_DOES_NOT_EXIST:
            # The admin group is not a valid UC principal (e.g. the reserved
            # workspace 'admins' group, or any workspace-local group). Distinct
            # from a privilege problem — fail loud with the right remedy.
            raise ProvisioningError(
                f"Cannot transfer schema ownership: admin_group "
                f"'{cfg.admin_group}' is not a valid Unity Catalog principal. It "
                "must be an ACCOUNT-LEVEL group — the reserved workspace 'admins' "
                "group and workspace-local groups are NOT valid UC owners. Create "
                "the admin group at the account level (via Section B / an account "
                "admin) and re-run."
            ) from exc
        if error_class == _PERMISSION_DENIED:
            # Only a genuine permission denial gets the runner-privilege remedy.
            raise ProvisioningError(
                f"Failed to transfer schema ownership to '{cfg.admin_group}': the "
                "principal running this notebook must be a metastore admin or a "
                f"member of '{cfg.admin_group}'. Add yourself to "
                f"'{cfg.admin_group}' (or run as metastore admin) and re-run. "
                f"Underlying error: {exc}"
            ) from exc
        # Anything else (syntax/parse error, timeout, warehouse failure, other UC
        # errors) is NOT a privilege problem — surface the real error unchanged
        # rather than mislabelling it as a runner-authority issue.
        raise


def set_warehouse_owner(
    ctx: ProvisionContext, workspace_client: Any, warehouse_id: Optional[str]
) -> None:
    """Attempt admin-group IS_OWNER on the warehouse; fall back to CAN_MANAGE.

    Databricks does not clearly document group ``IS_OWNER`` for warehouses, so
    if the API rejects it we FALL BACK to admin-group ``CAN_MANAGE`` and log
    which was applied. Uses ``update_permissions`` (additive) so the tenant's
    CAN_MANAGE is preserved. Insufficient privilege (not a workspace admin)
    fails loud.
    """

    cfg = ctx.config
    admin = cfg.admin_group

    if ctx.dry_run:
        ctx.record(
            "warehouse.owner",
            cfg.warehouse_name,
            write=True,
            detail={
                "admin_group": admin,
                "attempt": "IS_OWNER (fall back to CAN_MANAGE if rejected)",
            },
            executed=False,
        )
        return

    if warehouse_id is None:
        raise ProvisioningError(
            "Cannot set warehouse owner: no warehouse id available."
        )

    def _apply(level: sql.WarehousePermissionLevel) -> None:
        workspace_client.warehouses.update_permissions(
            warehouse_id=warehouse_id,
            access_control_list=[
                sql.WarehouseAccessControlRequest(
                    group_name=admin, permission_level=level
                )
            ],
        )

    privilege_msg = (
        f"Failed to set the admin group '{admin}' as warehouse owner: the "
        "principal running this notebook must be a workspace admin. Run as a "
        "workspace admin and re-run."
    )

    try:
        _apply(sql.WarehousePermissionLevel.IS_OWNER)
    except (errors.PermissionDenied, errors.Unauthenticated) as exc:
        raise ProvisioningError(privilege_msg) from exc
    except errors.DatabricksError as is_owner_exc:
        # Fall back to CAN_MANAGE ONLY for the specific 'group IS_OWNER not
        # supported' rejection, identified by a stable substring of its message.
        # We gate on the message (not the exception type) because the SDK raises
        # this as NotImplemented — not BadRequest — so a type match would miss
        # it (verified live). Any other error (NotFound, rate-limit, 5xx, an
        # unrelated NotImplemented/BadRequest) does NOT contain this substring
        # and is re-raised unchanged — no silent fallback.
        if _WAREHOUSE_IS_OWNER_UNSUPPORTED not in str(is_owner_exc):
            raise
        try:
            _apply(sql.WarehousePermissionLevel.CAN_MANAGE)
        except (errors.PermissionDenied, errors.Unauthenticated) as exc:
            raise ProvisioningError(privilege_msg) from exc
        note = (
            "group IS_OWNER not accepted by API; applied CAN_MANAGE to admin "
            "group instead"
        )
        ctx.record(
            "warehouse.owner",
            cfg.warehouse_name,
            write=True,
            detail={
                "admin_group": admin,
                "applied": sql.WarehousePermissionLevel.CAN_MANAGE.value,
                "note": note,
                "is_owner_error": str(is_owner_exc),
            },
            executed=True,
        )
        print(f"NOTE: warehouse ownership — {note}.")
        return

    ctx.record(
        "warehouse.owner",
        cfg.warehouse_name,
        write=True,
        detail={
            "admin_group": admin,
            "applied": sql.WarehousePermissionLevel.IS_OWNER.value,
            "note": "admin group set as warehouse IS_OWNER",
        },
        executed=True,
    )
    print("NOTE: warehouse ownership — admin group set as warehouse IS_OWNER.")


def run_workspace_section(
    ctx: ProvisionContext, workspace_client: Any, section_b_ran: bool
) -> None:
    """Section A orchestration.

    Ownership transfers run LAST (after every create / grant / tag) so the
    running principal keeps authority to finish the earlier steps before
    ownership moves to the admin group.
    """

    if not section_b_ran:
        # The group must already exist (grants reference it by name).
        verify_group_exists(ctx, workspace_client)

    ensure_schema(ctx, workspace_client)
    # Warehouse is provisioned before grants because UC grants are applied via
    # SQL GRANT executed through the warehouse's statement-execution endpoint.
    warehouse_id = ensure_warehouse(ctx, workspace_client)
    grant_permissions(ctx, workspace_client, warehouse_id)
    ensure_cluster_policies(ctx, workspace_client)
    apply_tags(ctx, workspace_client, warehouse_id)

    # Ownership LAST: schema OWNER TO admin group, then warehouse admin owner.
    transfer_schema_ownership(ctx, workspace_client, warehouse_id)
    set_warehouse_owner(ctx, workspace_client, warehouse_id)


# ---------------------------------------------------------------------------
# Top-level orchestration
# ---------------------------------------------------------------------------


def provision(
    config: ProvisionConfig,
    workspace_client: Any,
    account_client: Optional[Any] = None,
    dry_run: bool = True,
) -> ProvisionContext:
    """Run the full provisioning flow and return the context (holding the plan).

    Section B (account plane) runs first and is skipped when
    ``account_client`` is ``None`` (i.e. ``run_account_section`` disabled or the
    SP secret is absent). Section A (workspace plane) always runs; if Section B
    was skipped it first verifies the group exists and fails loud otherwise.
    """

    config = derive_names(config)
    # admin_group owns the provisioned assets — required even to build the plan.
    validate_admin_group(config)
    ctx = ProvisionContext(config=config, dry_run=dry_run)

    # Preflight (read-only, plan phase): fail loud NOW if admin_group can't own
    # UC objects, before any write and before the later ownership transfer.
    validate_admin_group_principal(ctx, workspace_client)

    section_b_ran = account_client is not None
    run_account_section(ctx, account_client)
    run_workspace_section(ctx, workspace_client, section_b_ran=section_b_ran)
    return ctx


def format_plan(ctx: ProvisionContext) -> str:
    """Render the plan as a human-readable, printable block."""

    mode = "DRY-RUN (no writes)" if ctx.dry_run else "APPLY"
    lines = [f"=== UC tenant provisioning plan [{mode}] ==="]
    for i, action in enumerate(ctx.actions, 1):
        lines.append(f"{i:>2}. {action}")
    writes = sum(1 for a in ctx.actions if a.write)
    lines.append(f"--- {len(ctx.actions)} actions, {writes} would write ---")
    return "\n".join(lines)
