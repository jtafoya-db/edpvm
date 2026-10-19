"""Unit tests for :mod:`uc_tenant_provision` using mocked SDK clients.

These tests never touch a real Databricks account or workspace — every client
is a ``unittest.mock`` object, so the suite passes with no credentials and even
if ``databricks-sdk`` talks to nothing real.

The mocks deliberately model *realistic* SDK return shapes so that the tests
would FAIL against the previously-buggy code:

* ``warehouses.create()`` returns ``Wait[GetWarehouseResponse]`` (no ``.id``);
  only ``warehouses.create_and_wait()`` yields a ``GetWarehouseResponse`` with
  ``.id``. So a real warehouse id (needed for the CAN_MANAGE grant + schema
  tagging) is only available if the code calls ``create_and_wait``.
* SCIM group members are keyed by account user *id*, not email. Account users
  therefore have a distinct ``id`` vs ``user_name``, and the PATCH must carry
  the resolved id.
"""

import json
import os
import re
import sys
from unittest import mock

import pytest

# Make the sibling module importable without packaging.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import uc_tenant_provision as edp  # noqa: E402
from databricks.sdk import errors  # noqa: E402
from databricks.sdk.service import catalog, iam, sql  # noqa: E402
from databricks.sdk.service.sql import (  # noqa: E402
    GetWarehouseResponse,
    ServiceError,
    ServiceErrorCode,
)


def _uc_error(error_class_leaf, sdk_code=ServiceErrorCode.BAD_REQUEST):
    """A realistic StatementStatus.error: generic SDK code + ErrorClass in msg.

    Mirrors the live shape, where ``error_code`` is generic (BAD_REQUEST) and
    the specific UC code appears only as ``ErrorClass=<ns>.<CODE>`` in message.
    """

    return ServiceError(
        error_code=sdk_code,
        message=(
            f"[RequestId=abc ErrorClass=INVALID_PARAMETER_VALUE.{error_class_leaf}] "
            f"Tag value edp-test-jt is not allowed."
        ),
    )


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


def make_config(**overrides):
    base = dict(
        environment="edp-test",
        catalog="edp-test",
        group_name="edp-test-group",
        schema_name="analytics",
        warehouse_name="edp-test-wh",
        allpurpose_policy_name="edp-test-allpurpose",
        job_policy_name="edp-test-job",
        users=["alice@example.com", "bob@example.com"],
        access_level="readwrite",
        tenant="acme",
        domain="finance",
        dataset="ledger",
        pii="true",
        project="edp",
        workspace_id=1234567890,
        account_id="acct-123",
        admin_group="admins",
    )
    base.update(overrides)
    return edp.ProvisionConfig(**base)


def _fake_user_id(email):
    """Deterministic account user id for an email — distinct from the email."""

    return "uid-" + email


def _group(display_name, gid="200150", members=None, resource_type="Group"):
    g = mock.Mock()
    g.display_name = display_name
    g.id = gid  # numeric-ish string so int(group_id) works in assignment
    g.members = members or []
    # SCIM meta.resourceType: "Group" = account-level (valid UC owner);
    # "WorkspaceGroup" = reserved/workspace-local (invalid UC owner).
    g.meta.resource_type = resource_type
    return g


def _member(value):
    """A SCIM group member — ``value`` is an account user id (NOT an email)."""

    m = mock.Mock()
    m.value = value
    return m


def _user(uid, user_name):
    u = mock.Mock()
    u.id = uid
    u.user_name = user_name
    return u


def _wait_without_id():
    """Model warehouses.create() -> Wait[...]: has NO ``.id`` attribute."""

    return mock.Mock(spec=[])


def _stmt_response(state, error=None, statement_id="stmt-1"):
    """A realistic statement-execution / get-statement response."""

    resp = mock.Mock()
    resp.statement_id = statement_id
    resp.status.state = state
    resp.status.error = error
    return resp


def make_account_client(existing_group=None, known_users="any"):
    """AccountClient mock.

    ``known_users``:
      * ``"any"`` (default) — resolve any email to a deterministic user id.
      * a set/list of emails — only those resolve; others return no match.
    """

    ac = mock.Mock()
    ac.groups.list.return_value = [existing_group] if existing_group else []
    ac.groups.create.return_value = _group("edp-test-group", gid="200150")

    def _users_list(filter=None, **_kw):
        m = re.search(r'userName eq "([^"]+)"', filter or "")
        if not m:
            return []
        email = m.group(1)
        if known_users != "any" and email not in known_users:
            return []
        return [_user(_fake_user_id(email), email)]

    ac.users.list.side_effect = _users_list
    return ac


def make_workspace_client(
    group_exists=True,
    schema_exists=False,
    warehouse=None,
    policies=None,
):
    ws = mock.Mock()

    # groups: filter-aware so both verify_group_exists (tenant group, gated by
    # group_exists) and the admin_group principal preflight resolve correctly.
    # The tenant group presence follows group_exists; any other looked-up name
    # (e.g. the admin group) resolves as a valid ACCOUNT-LEVEL group by default.
    def _groups_list(filter=None, **_kw):
        m = re.search(r'displayName eq "([^"]+)"', filter or "")
        name = m.group(1) if m else None
        if name in (None, "edp-test-group"):
            return [_group("edp-test-group")] if group_exists else []
        return [_group(name, resource_type="Group")]

    ws.groups.list.side_effect = _groups_list

    # schemas.get raises NotFound unless the schema "exists"
    if schema_exists:
        ws.schemas.get.return_value = mock.Mock()
    else:
        ws.schemas.get.side_effect = errors.NotFound("nope")

    # warehouses — realistic return shapes
    ws.warehouses.list.return_value = [warehouse] if warehouse else []
    ws.warehouses.create.return_value = _wait_without_id()  # Wait[...] has no .id
    ws.warehouses.create_and_wait.return_value = GetWarehouseResponse(
        id="wh-new", name="edp-test-wh"
    )
    ws.warehouses.edit_and_wait.return_value = GetWarehouseResponse(
        id="wh-existing", name="edp-test-wh"
    )

    # cluster policies
    ws.cluster_policies.list.return_value = policies or []
    ws.cluster_policies.create.return_value = mock.Mock(policy_id="pol-new")

    # statement execution: succeed immediately (terminal) by default.
    ws.statement_execution.execute_statement.return_value = _stmt_response(
        sql.StatementState.SUCCEEDED
    )

    return ws


def existing_warehouse(wid="wh-existing", name="edp-test-wh", tags=None):
    return GetWarehouseResponse(id=wid, name=name, tags=tags)


def actions_by_step(ctx, step):
    return [a for a in ctx.actions if a.step == step]


def assert_no_writes(*clients):
    """Assert none of the mutating SDK methods were called on any client."""

    for c in clients:
        if c is None:
            continue
        for path in [
            "groups.create",
            "groups.patch",
            "workspace_assignment.update",
            "schemas.create",
            "grants.update",
            "warehouses.create",
            "warehouses.create_and_wait",
            "warehouses.edit_and_wait",
            "warehouses.update_permissions",
            "cluster_policies.create",
            "permissions.update",
            "statement_execution.execute_statement",
        ]:
            obj = c
            for part in path.split("."):
                obj = getattr(obj, part)
            assert not obj.called, f"unexpected write: {path}"


# ---------------------------------------------------------------------------
# Dry-run / plan
# ---------------------------------------------------------------------------


def test_dry_run_produces_plan_and_no_writes():
    cfg = make_config()
    ac = make_account_client(existing_group=None)
    ws = make_workspace_client(group_exists=True, schema_exists=False)

    ctx = edp.provision(cfg, ws, ac, dry_run=True)

    # Plan is non-empty and every recorded write is un-executed in dry-run.
    assert ctx.actions
    assert all(not a.executed for a in ctx.actions)
    assert any(a.write for a in ctx.actions)

    # The steps we expect to appear in the plan.
    steps = {a.step for a in ctx.actions}
    assert {
        "group.create",
        "group.assign_workspace",
        "group.add_member",
        "schema.create",
        "grant.catalog",
        "grant.schema",
        "warehouse.create",
        "warehouse.grant",
        "policy.create",
        "policy.grant",
        "tag.schema",
        "schema.owner",     # planned ownership transfer
        "warehouse.owner",  # planned admin owner
    }.issubset(steps)

    # Planned ownership transfers are recorded as writes (not yet executed).
    schema_owner = actions_by_step(ctx, "schema.owner")[0]
    assert schema_owner.write is True and schema_owner.executed is False
    assert schema_owner.detail["admin_group"] == "admins"

    # Absolutely no writes hit the clients (reads like users.list are allowed).
    assert_no_writes(ac, ws)


def test_format_plan_renders():
    cfg = make_config()
    ctx = edp.provision(cfg, make_workspace_client(), make_account_client(), dry_run=True)
    text = edp.format_plan(ctx)
    assert "DRY-RUN" in text
    assert "group.create" in text


# ---------------------------------------------------------------------------
# Idempotency (get-or-create no-ops when the resource exists)
# ---------------------------------------------------------------------------


def test_group_get_or_create_noop_when_exists():
    cfg = make_config()
    existing = _group("edp-test-group", gid="grp-existing")
    ac = make_account_client(existing_group=existing)
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    group = edp.ensure_group(ctx, ac)

    ac.groups.create.assert_not_called()
    assert group is existing
    act = actions_by_step(ctx, "group.create")[0]
    assert act.write is False


def test_group_created_when_absent_on_apply():
    cfg = make_config()
    ac = make_account_client(existing_group=None)
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.ensure_group(ctx, ac)

    ac.groups.create.assert_called_once_with(display_name="edp-test-group")
    act = actions_by_step(ctx, "group.create")[0]
    assert act.write is True and act.executed is True


def test_schema_get_or_create_noop_when_exists():
    cfg = make_config()
    ws = make_workspace_client(schema_exists=True)
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.ensure_schema(ctx, ws)

    ws.schemas.create.assert_not_called()
    assert actions_by_step(ctx, "schema.create")[0].write is False


def test_schema_created_when_absent():
    cfg = make_config()
    ws = make_workspace_client(schema_exists=False)
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.ensure_schema(ctx, ws)

    ws.schemas.create.assert_called_once_with(
        name="analytics", catalog_name="edp-test"
    )


def test_warehouse_get_or_create_noop_when_exists():
    cfg = make_config()
    # existing warehouse whose tags already match -> no create, no re-tag edit
    existing = existing_warehouse(wid="wh-existing", tags=edp._endpoint_tags(cfg))
    ws = make_workspace_client(warehouse=existing)
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    wid = edp.ensure_warehouse(ctx, ws)

    ws.warehouses.create.assert_not_called()
    ws.warehouses.create_and_wait.assert_not_called()
    ws.warehouses.edit_and_wait.assert_not_called()
    assert wid == "wh-existing"
    assert actions_by_step(ctx, "warehouse.create")[0].write is False
    assert actions_by_step(ctx, "warehouse.retag")[0].write is False
    # permissions are still converged (grant re-applied)
    ws.warehouses.update_permissions.assert_called_once()


def test_policy_get_or_create_noop_when_exists():
    cfg = make_config()
    ap = mock.Mock(policy_id="pol-ap")
    ap.name = "edp-test-allpurpose"
    jp = mock.Mock(policy_id="pol-jp")
    jp.name = "edp-test-job"
    ws = make_workspace_client(policies=[ap, jp])
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.ensure_cluster_policies(ctx, ws)

    ws.cluster_policies.create.assert_not_called()
    # both policies still get their CAN_USE grant re-applied
    assert ws.permissions.update.call_count == 2


# ---------------------------------------------------------------------------
# Grant payloads — readwrite vs read
# ---------------------------------------------------------------------------


def test_grant_changes_readwrite():
    cfg = make_config(access_level="readwrite")
    changes = edp.build_grant_changes(cfg)

    assert changes["catalog"].principal == "edp-test-group"
    assert changes["catalog"].add == [catalog.Privilege.USE_CATALOG]
    assert changes["schema"].add == [
        catalog.Privilege.USE_SCHEMA,
        catalog.Privilege.SELECT,
        catalog.Privilege.MODIFY,
        catalog.Privilege.CREATE_TABLE,
    ]


def test_grant_changes_read():
    cfg = make_config(access_level="read")
    changes = edp.build_grant_changes(cfg)

    assert changes["schema"].add == [
        catalog.Privilege.USE_SCHEMA,
        catalog.Privilege.SELECT,
    ]
    # read must NOT include MODIFY / CREATE_TABLE
    assert catalog.Privilege.MODIFY not in changes["schema"].add
    assert catalog.Privilege.CREATE_TABLE not in changes["schema"].add


def test_grant_catalog_sql_readwrite():
    cfg = make_config(access_level="readwrite")
    stmt = edp.build_catalog_grant_sql(cfg)
    assert stmt == (
        "GRANT USE CATALOG ON CATALOG `edp-test` TO `edp-test-group`"
    )


def test_grant_schema_sql_readwrite_and_read():
    rw = edp.build_schema_grant_sql(make_config(access_level="readwrite"))
    assert rw == (
        "GRANT USE SCHEMA, SELECT, MODIFY, CREATE TABLE "
        "ON SCHEMA `edp-test`.`analytics` TO `edp-test-group`"
    )
    ro = edp.build_schema_grant_sql(make_config(access_level="read"))
    assert ro == (
        "GRANT USE SCHEMA, SELECT ON SCHEMA `edp-test`.`analytics` "
        "TO `edp-test-group`"
    )
    # read grant must NOT carry MODIFY / CREATE TABLE
    assert "MODIFY" not in ro and "CREATE TABLE" not in ro


def test_grant_permissions_executes_sql_grant_not_sdk_update():
    cfg = make_config(access_level="readwrite")
    ws = make_workspace_client()
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.grant_permissions(ctx, ws, warehouse_id="wh-live")

    # The buggy SDK path (grants.update with a SecurableType enum) is NOT used.
    ws.grants.update.assert_not_called()
    # Two SQL GRANTs executed on the warehouse: catalog then schema.
    assert ws.statement_execution.execute_statement.call_count == 2
    calls = ws.statement_execution.execute_statement.call_args_list
    assert calls[0].kwargs["warehouse_id"] == "wh-live"
    assert calls[0].kwargs["statement"].startswith("GRANT USE CATALOG ON CATALOG")
    assert calls[1].kwargs["statement"].startswith(
        "GRANT USE SCHEMA, SELECT, MODIFY, CREATE TABLE ON SCHEMA"
    )
    # No 'SecurableType.' text leaks into the wire statements.
    for call in calls:
        assert "SecurableType" not in call.kwargs["statement"]


def test_grant_permissions_fails_loud_without_warehouse_id():
    cfg = make_config()
    ws = make_workspace_client()
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    with pytest.raises(edp.ProvisioningError):
        edp.grant_permissions(ctx, ws, warehouse_id=None)
    ws.statement_execution.execute_statement.assert_not_called()


# ---------------------------------------------------------------------------
# Warehouse — PRO / non-serverless / CAN_MANAGE, realistic Wait shapes
# ---------------------------------------------------------------------------


def test_warehouse_create_uses_create_and_wait_with_pro_non_serverless():
    cfg = make_config(cluster_size="Medium", auto_stop_mins=15,
                      min_num_clusters=1, max_num_clusters=3)
    ws = make_workspace_client(warehouse=None)
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.ensure_warehouse(ctx, ws)

    # Must use create_and_wait (create() returns a Wait with no .id).
    ws.warehouses.create.assert_not_called()
    ws.warehouses.create_and_wait.assert_called_once()
    kwargs = ws.warehouses.create_and_wait.call_args.kwargs
    assert kwargs["warehouse_type"] == sql.CreateWarehouseRequestWarehouseType.PRO
    assert kwargs["enable_serverless_compute"] is False
    assert kwargs["cluster_size"] == "Medium"
    assert kwargs["auto_stop_mins"] == 15
    assert kwargs["max_num_clusters"] == 3
    assert isinstance(kwargs["tags"], sql.EndpointTags)


def test_warehouse_grant_can_manage_uses_resolved_id():
    cfg = make_config()
    ws = make_workspace_client(warehouse=None)
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    wid = edp.ensure_warehouse(ctx, ws)

    # id comes from create_and_wait's GetWarehouseResponse, not the Wait.
    assert wid == "wh-new"
    ws.warehouses.update_permissions.assert_called_once()
    kwargs = ws.warehouses.update_permissions.call_args.kwargs
    assert kwargs["warehouse_id"] == "wh-new"
    acl = kwargs["access_control_list"][0]
    assert acl.group_name == "edp-test-group"
    assert acl.permission_level == sql.WarehousePermissionLevel.CAN_MANAGE


def test_existing_warehouse_tags_converge_on_rerun():
    cfg = make_config()
    # existing warehouse with NO tags -> differs from desired -> must re-tag
    existing = existing_warehouse(wid="wh-existing", tags=None)
    ws = make_workspace_client(warehouse=existing)
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    wid = edp.ensure_warehouse(ctx, ws)

    ws.warehouses.create_and_wait.assert_not_called()
    ws.warehouses.edit_and_wait.assert_called_once()
    ekwargs = ws.warehouses.edit_and_wait.call_args.kwargs
    assert ekwargs["id"] == "wh-existing"
    assert isinstance(ekwargs["tags"], sql.EndpointTags)
    assert wid == "wh-existing"
    retag = actions_by_step(ctx, "warehouse.retag")[0]
    assert retag.write is True and retag.executed is True


def test_existing_warehouse_no_retag_when_tags_match():
    cfg = make_config()
    existing = existing_warehouse(wid="wh-existing", tags=edp._endpoint_tags(cfg))
    ws = make_workspace_client(warehouse=existing)
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.ensure_warehouse(ctx, ws)

    ws.warehouses.edit_and_wait.assert_not_called()
    assert actions_by_step(ctx, "warehouse.retag")[0].write is False


# ---------------------------------------------------------------------------
# Cluster policies — definitions + CAN_USE grant
# ---------------------------------------------------------------------------


def test_policy_definitions():
    cfg = make_config()
    defs = edp.build_policy_definitions(cfg)

    assert defs["all_purpose"]["cluster_type"] == {"type": "fixed", "value": "all-purpose"}
    assert defs["all_purpose"]["data_security_mode"] == {
        "type": "fixed",
        "value": "USER_ISOLATION",
    }
    assert defs["job"]["cluster_type"] == {"type": "fixed", "value": "job"}


def test_policy_create_serializes_definition_and_grants_can_use():
    cfg = make_config()
    ws = make_workspace_client(policies=[])
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.ensure_cluster_policies(ctx, ws)

    assert ws.cluster_policies.create.call_count == 2
    # definition passed as a JSON string
    first_def = ws.cluster_policies.create.call_args_list[0].kwargs["definition"]
    assert isinstance(first_def, str)
    parsed = json.loads(first_def)
    assert parsed["cluster_type"]["value"] == "all-purpose"

    # CAN_USE grant on cluster-policies object type
    assert ws.permissions.update.call_count == 2
    gkwargs = ws.permissions.update.call_args_list[0].kwargs
    assert gkwargs["request_object_type"] == "cluster-policies"
    acl = gkwargs["access_control_list"][0]
    assert acl.group_name == "edp-test-group"
    assert acl.permission_level == iam.PermissionLevel.CAN_USE


# ---------------------------------------------------------------------------
# Tags — tag2key == tenant, right keys per target
# ---------------------------------------------------------------------------


def test_schema_tags_include_all_keys_and_tag2key():
    cfg = make_config(tenant="acme")
    tags = edp.build_schema_tags(cfg)

    assert set(tags) == {"tenant", "domain", "dataset", "pii", "project", "tag2key"}
    assert tags["tag2key"] == "acme"
    assert tags["tag2key"] == tags["tenant"]


def test_warehouse_tags_keys_and_tag2key():
    cfg = make_config(tenant="acme", project="edp", environment="edp-test")
    tags = edp.build_warehouse_tags(cfg)

    assert set(tags) == {"tenant", "project", "environment", "tag2key"}
    assert tags["tag2key"] == "acme"
    # warehouse tags must NOT carry the schema-only keys
    assert "domain" not in tags
    assert "dataset" not in tags
    assert "pii" not in tags


def test_schema_tag_sql_shape():
    cfg = make_config()
    sql_stmt = edp.build_schema_tag_sql(cfg)
    assert sql_stmt.startswith("ALTER SCHEMA `edp-test`.`analytics` SET TAGS (")
    assert "'tag2key' = 'acme'" in sql_stmt


def test_apply_tags_executes_statement_on_warehouse():
    cfg = make_config()
    ws = make_workspace_client()
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.apply_tags(ctx, ws, warehouse_id="wh-123")

    ws.statement_execution.execute_statement.assert_called_once()
    kwargs = ws.statement_execution.execute_statement.call_args.kwargs
    assert kwargs["warehouse_id"] == "wh-123"
    assert kwargs["statement"].startswith("ALTER SCHEMA")


def test_apply_tags_fails_loud_without_warehouse_id():
    cfg = make_config()
    ws = make_workspace_client()
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    with pytest.raises(edp.ProvisioningError):
        edp.apply_tags(ctx, ws, warehouse_id=None)


def _failed_statement(error):
    """A statement-execution response in FAILED (terminal) state.

    ``error`` may be a ServiceError (realistic) or a plain string (fallback).
    """

    return _stmt_response(sql.StatementState.FAILED, error=error)


# --- _run_sql: polling to a terminal state ---


def test_run_sql_returns_on_immediate_success():
    ws = make_workspace_client()  # execute_statement returns SUCCEEDED by default
    edp._run_sql(ws, "GRANT USE CATALOG ON CATALOG `c` TO `g`", "wh-1")
    ws.statement_execution.get_statement.assert_not_called()  # no poll needed


def test_run_sql_polls_pending_running_then_succeeds():
    ws = make_workspace_client()
    ws.statement_execution.execute_statement.return_value = _stmt_response(
        sql.StatementState.PENDING
    )
    ws.statement_execution.get_statement.side_effect = [
        _stmt_response(sql.StatementState.RUNNING),
        _stmt_response(sql.StatementState.SUCCEEDED),
    ]

    edp._run_sql(ws, "GRANT ...", "wh-1", poll_interval_seconds=0)

    # Polled twice (RUNNING then SUCCEEDED) before returning.
    assert ws.statement_execution.get_statement.call_count == 2


def test_run_sql_polls_then_fails_loud_on_delayed_failure():
    ws = make_workspace_client()
    ws.statement_execution.execute_statement.return_value = _stmt_response(
        sql.StatementState.PENDING
    )
    ws.statement_execution.get_statement.side_effect = [
        _stmt_response(sql.StatementState.RUNNING),
        _stmt_response(sql.StatementState.FAILED, error="boom later"),
    ]

    with pytest.raises(edp.ProvisioningError) as exc:
        edp._run_sql(ws, "GRANT ...", "wh-1", poll_interval_seconds=0)
    assert "boom later" in str(exc.value)


def test_run_sql_fails_loud_on_canceled():
    ws = make_workspace_client()
    ws.statement_execution.execute_statement.return_value = _stmt_response(
        sql.StatementState.PENDING
    )
    ws.statement_execution.get_statement.side_effect = [
        _stmt_response(sql.StatementState.CANCELED),
    ]

    with pytest.raises(edp.ProvisioningError):
        edp._run_sql(ws, "GRANT ...", "wh-1", poll_interval_seconds=0)


def test_run_sql_fails_loud_on_overall_timeout():
    ws = make_workspace_client()
    # Never reaches a terminal state.
    ws.statement_execution.execute_statement.return_value = _stmt_response(
        sql.StatementState.RUNNING
    )
    ws.statement_execution.get_statement.return_value = _stmt_response(
        sql.StatementState.RUNNING
    )

    with pytest.raises(edp.ProvisioningError) as exc:
        edp._run_sql(ws, "GRANT ...", "wh-1",
                     poll_timeout_seconds=0, poll_interval_seconds=0)
    assert "did not finish" in str(exc.value)


def test_run_sql_raises_on_immediate_failed_state():
    ws = make_workspace_client()
    ws.statement_execution.execute_statement.return_value = _failed_statement("boom")
    with pytest.raises(edp.ProvisioningError):
        edp._run_sql(ws, "GRANT USE CATALOG ON CATALOG `c` TO `g`", "wh-1")


def test_run_sql_preserves_structured_error_code_and_class():
    ws = make_workspace_client()
    ws.statement_execution.execute_statement.return_value = _failed_statement(
        _uc_error("UC_TAG_POLICY_VALUE_NOT_ALLOWED")
    )
    with pytest.raises(edp.SqlStatementError) as exc:
        edp._run_sql(ws, "ALTER SCHEMA `c`.`s` SET TAGS ('tenant'='x')", "wh-1")

    # The SDK ServiceErrorCode (generic) is preserved...
    assert exc.value.error_code == ServiceErrorCode.BAD_REQUEST
    # ...and the specific UC error-class leaf is parsed onto the exception.
    assert exc.value.error_class == "UC_TAG_POLICY_VALUE_NOT_ALLOWED"
    assert exc.value.state == sql.StatementState.FAILED


# --- governed-tag: swallow ONLY the exact UC_TAG_POLICY_VALUE_NOT_ALLOWED ---


def test_apply_tags_value_not_allowed_is_non_fatal():
    cfg = make_config()
    ws = make_workspace_client()
    ws.statement_execution.execute_statement.return_value = _failed_statement(
        _uc_error("UC_TAG_POLICY_VALUE_NOT_ALLOWED")
    )
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.apply_tags(ctx, ws, warehouse_id="wh-123")  # does NOT raise

    assert actions_by_step(ctx, "tag.schema.blocked")
    assert not any(a.executed for a in actions_by_step(ctx, "tag.schema"))


def test_apply_tags_value_not_allowed_suffix_fails_loud():
    cfg = make_config()
    ws = make_workspace_client()
    # A SUFFIXED code must NOT be swallowed (exact match only).
    ws.statement_execution.execute_statement.return_value = _failed_statement(
        _uc_error("UC_TAG_POLICY_VALUE_NOT_ALLOWED_EXTRA")
    )
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    with pytest.raises(edp.ProvisioningError):
        edp.apply_tags(ctx, ws, warehouse_id="wh-123")


def test_apply_tags_other_tag_policy_code_fails_loud():
    cfg = make_config()
    ws = make_workspace_client()
    # A DIFFERENT UC_TAG_POLICY_* code must NOT be swallowed.
    ws.statement_execution.execute_statement.return_value = _failed_statement(
        _uc_error("UC_TAG_POLICY_KEY_NOT_ALLOWED")
    )
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    with pytest.raises(edp.ProvisioningError):
        edp.apply_tags(ctx, ws, warehouse_id="wh-123")


def test_apply_tags_generic_tag_policy_text_fails_loud():
    cfg = make_config()
    ws = make_workspace_client()
    # Generic 'tag policy' wording (no ErrorClass token) must fail loud.
    ws.statement_execution.execute_statement.return_value = _failed_statement(
        ServiceError(
            error_code=ServiceErrorCode.BAD_REQUEST,
            message="some tag policy problem occurred",
        )
    )
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    with pytest.raises(edp.ProvisioningError):
        edp.apply_tags(ctx, ws, warehouse_id="wh-123")


def test_apply_tags_value_not_allowed_fallback_token_when_unstructured():
    cfg = make_config()
    ws = make_workspace_client()
    # No structured error object -> classification falls back to word-boundary
    # token match on the message string (still non-fatal for the exact token).
    ws.statement_execution.execute_statement.return_value = _failed_statement(
        "ErrorClass=INVALID_PARAMETER_VALUE.UC_TAG_POLICY_VALUE_NOT_ALLOWED tag"
    )
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.apply_tags(ctx, ws, warehouse_id="wh-123")  # does NOT raise
    assert actions_by_step(ctx, "tag.schema.blocked")


def test_apply_tags_non_policy_error_still_fails_loud():
    cfg = make_config()
    ws = make_workspace_client()
    ws.statement_execution.execute_statement.return_value = _failed_statement(
        _uc_error("SOME_OTHER_ERROR")
    )
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    with pytest.raises(edp.ProvisioningError):
        edp.apply_tags(ctx, ws, warehouse_id="wh-123")


# --- identifier / value escaping in emitted SQL ---


def test_sql_value_escaping():
    cfg = make_config(project="a'b")
    stmt = edp.build_schema_tag_sql(cfg)
    assert "'project' = 'a''b'" in stmt


def test_tag_sql_escapes_backtick_identifiers_and_quote_values():
    cfg = make_config(catalog="cat`x", schema_name="sch`z", tenant="a'b")
    stmt = edp.build_schema_tag_sql(cfg)
    # backticks doubled in identifiers
    assert "ALTER SCHEMA `cat``x`.`sch``z` SET TAGS (" in stmt
    # single quotes doubled in the (tenant + tag2key) values
    assert "'tenant' = 'a''b'" in stmt
    assert "'tag2key' = 'a''b'" in stmt


def test_grant_sql_escapes_backtick_identifiers():
    cfg = make_config(catalog="cat`x", schema_name="sch`z", group_name="grp`y")
    cat = edp.build_catalog_grant_sql(cfg)
    sch = edp.build_schema_grant_sql(cfg)
    assert cat == "GRANT USE CATALOG ON CATALOG `cat``x` TO `grp``y`"
    assert sch == (
        "GRANT USE SCHEMA, SELECT, MODIFY, CREATE TABLE "
        "ON SCHEMA `cat``x`.`sch``z` TO `grp``y`"
    )


# ---------------------------------------------------------------------------
# Membership — resolve emails to account user ids (SCIM)
# ---------------------------------------------------------------------------


def test_resolve_user_id_returns_id_not_email():
    ac = make_account_client()
    uid = edp.resolve_user_id(ac, "alice@example.com")
    assert uid == _fake_user_id("alice@example.com")
    assert uid != "alice@example.com"


def test_add_users_patch_carries_resolved_user_ids():
    cfg = make_config(users=["alice@example.com", "bob@example.com"])
    group = _group("edp-test-group", gid="200150", members=[])
    ac = make_account_client(existing_group=group)
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.add_users_to_group(ctx, ac, group)

    ac.groups.patch.assert_called_once()
    ops = ac.groups.patch.call_args.kwargs["operations"]
    values = [v["value"] for v in ops[0].value]
    # PATCH carries resolved account user IDs, NOT the raw emails.
    assert values == [
        _fake_user_id("alice@example.com"),
        _fake_user_id("bob@example.com"),
    ]
    assert "alice@example.com" not in values


def test_add_users_skips_existing_members_by_id():
    cfg = make_config(users=["alice@example.com", "carol@example.com"])
    # alice is already a member — keyed by her account user id, not email.
    existing = _group(
        "edp-test-group",
        gid="200150",
        members=[_member(_fake_user_id("alice@example.com"))],
    )
    ac = make_account_client(existing_group=existing)
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.add_users_to_group(ctx, ac, existing)

    ac.groups.patch.assert_called_once()
    ops = ac.groups.patch.call_args.kwargs["operations"]
    added_values = [v["value"] for v in ops[0].value]
    # alice skipped (already a member by id); only carol added, by her id.
    assert added_values == [_fake_user_id("carol@example.com")]


def test_add_users_fails_loud_on_unknown_email():
    cfg = make_config(users=["ghost@example.com"])
    group = _group("edp-test-group", gid="200150", members=[])
    # Only alice is a known account user; ghost resolves to nothing.
    ac = make_account_client(existing_group=group, known_users={"alice@example.com"})
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    with pytest.raises(edp.ProvisioningError) as excinfo:
        edp.add_users_to_group(ctx, ac, group)

    assert "ghost@example.com" in str(excinfo.value)
    ac.groups.patch.assert_not_called()


# ---------------------------------------------------------------------------
# Workspace-assignment payload
# ---------------------------------------------------------------------------


def test_workspace_assignment_payload():
    cfg = make_config()
    group = _group("edp-test-group", gid="200150")
    ac = make_account_client(existing_group=group)
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.assign_group_to_workspace(ctx, ac, group)

    ac.workspace_assignment.update.assert_called_once()
    kwargs = ac.workspace_assignment.update.call_args.kwargs
    assert kwargs["workspace_id"] == cfg.workspace_id
    assert kwargs["principal_id"] == 200150  # resolved group id, as int
    assert kwargs["permissions"] == [iam.WorkspacePermission.USER]


# ---------------------------------------------------------------------------
# Section-B-first ordering (full order) then Section A
# ---------------------------------------------------------------------------


def test_section_b_full_order_then_section_a():
    cfg = make_config()
    ac = make_account_client(existing_group=None)
    ws = make_workspace_client(group_exists=True)

    ctx = edp.provision(cfg, ws, ac, dry_run=True)
    steps = [a.step for a in ctx.actions]

    def idx(step):
        return next(i for i, s in enumerate(steps) if s == step)

    # Section B, in order: create group -> assign to workspace -> add members
    assert idx("group.create") < idx("group.assign_workspace") < idx("group.add_member")
    # ...then Section A starts (schema).
    assert idx("group.add_member") < idx("schema.create")
    # Warehouse is provisioned before grants (grants run as SQL on the warehouse).
    assert idx("schema.create") < idx("warehouse.create") < idx("grant.catalog")
    # Ownership transfers run LAST — after tenant grants and tags.
    assert idx("grant.schema") < idx("schema.owner")
    assert idx("tag.schema") < idx("schema.owner")
    assert idx("warehouse.grant") < idx("warehouse.owner")
    # schema.owner + warehouse.owner are the final two workspace actions.
    assert idx("schema.owner") == len(steps) - 2
    assert idx("warehouse.owner") == len(steps) - 1


# ---------------------------------------------------------------------------
# Skip Section B when no SP / account client
# ---------------------------------------------------------------------------


def test_section_b_skipped_when_no_account_client():
    cfg = make_config()
    ws = make_workspace_client(group_exists=True)  # group pre-exists in workspace

    ctx = edp.provision(cfg, ws, account_client=None, dry_run=True)

    steps = {a.step for a in ctx.actions}
    assert "section_b.skip" in steps
    # No account-plane writes were even recorded as writes.
    assert not actions_by_step(ctx, "group.assign_workspace")
    # Section A still verified the group exists.
    assert actions_by_step(ctx, "group.verify")


def test_section_b_skip_still_runs_section_a_apply():
    cfg = make_config(users=[])
    ws = make_workspace_client(group_exists=True, schema_exists=False)

    ctx = edp.provision(cfg, ws, account_client=None, dry_run=False)

    # Section A writes happened; no account client means no account writes.
    ws.schemas.create.assert_called_once()
    ws.grants.update.assert_not_called()  # grants go through SQL now
    ws.warehouses.create_and_wait.assert_called_once()
    # 2 SQL GRANTs + 1 schema tag ALTER + 1 schema OWNER TO = 4 executions.
    assert ws.statement_execution.execute_statement.call_count == 4
    statements = [c.kwargs["statement"] for c in
                  ws.statement_execution.execute_statement.call_args_list]
    assert any(s.startswith("ALTER SCHEMA") and "OWNER TO" in s for s in statements)
    # Ownership is recorded as the final schema step + warehouse admin owner.
    assert actions_by_step(ctx, "schema.owner")
    assert actions_by_step(ctx, "warehouse.owner")


# ---------------------------------------------------------------------------
# Fail-loud when group missing (Section B skipped, group absent)
# ---------------------------------------------------------------------------


def test_fail_loud_when_group_missing_and_section_b_skipped():
    cfg = make_config()
    ws = make_workspace_client(group_exists=False)

    with pytest.raises(edp.ProvisioningError) as excinfo:
        edp.provision(cfg, ws, account_client=None, dry_run=True)

    assert "does not exist" in str(excinfo.value)
    # It failed before touching schema/grants.
    ws.schemas.create.assert_not_called()
    ws.grants.update.assert_not_called()


def test_group_present_via_section_b_skips_verify():
    cfg = make_config()
    ac = make_account_client(existing_group=_group("edp-test-group"))
    ws = make_workspace_client(group_exists=False)  # not in workspace list...

    # ...but Section B ran, so verify_group_exists is not called and no error.
    ctx = edp.provision(cfg, ws, ac, dry_run=True)
    assert not actions_by_step(ctx, "group.verify")


# ---------------------------------------------------------------------------
# Full apply-path end-to-end (realistic SDK shapes throughout)
# ---------------------------------------------------------------------------


def test_full_apply_path_end_to_end():
    cfg = make_config(users=["alice@example.com"])
    ac = make_account_client(existing_group=None)  # group gets created
    ws = make_workspace_client(
        group_exists=True, schema_exists=False, warehouse=None, policies=[]
    )

    ctx = edp.provision(cfg, ws, ac, dry_run=False)

    # --- account plane (Section B) ---
    ac.groups.create.assert_called_once()
    ac.workspace_assignment.update.assert_called_once()
    assign = ac.workspace_assignment.update.call_args.kwargs
    assert assign["principal_id"] == 200150
    assert assign["permissions"] == [iam.WorkspacePermission.USER]
    ac.groups.patch.assert_called_once()
    patch_values = [v["value"] for v in ac.groups.patch.call_args.kwargs["operations"][0].value]
    assert patch_values == [_fake_user_id("alice@example.com")]  # resolved id, not email

    # --- workspace plane (Section A) ---
    ws.schemas.create.assert_called_once()
    ws.grants.update.assert_not_called()  # the buggy SDK enum path is gone
    ws.warehouses.create.assert_not_called()           # not the bare Wait call
    ws.warehouses.create_and_wait.assert_called_once()  # the fix
    # update_permissions called twice: tenant CAN_MANAGE + admin IS_OWNER.
    assert ws.warehouses.update_permissions.call_count == 2
    for call in ws.warehouses.update_permissions.call_args_list:
        assert call.kwargs["warehouse_id"] == "wh-new"
    levels = [
        c.kwargs["access_control_list"][0].permission_level
        for c in ws.warehouses.update_permissions.call_args_list
    ]
    assert sql.WarehousePermissionLevel.CAN_MANAGE in levels  # tenant
    assert sql.WarehousePermissionLevel.IS_OWNER in levels     # admin
    assert ws.cluster_policies.create.call_count == 2
    assert ws.permissions.update.call_count == 2

    # 2 SQL GRANTs + 1 schema tag ALTER + 1 schema OWNER TO, all on wh-new.
    assert ws.statement_execution.execute_statement.call_count == 4
    for call in ws.statement_execution.execute_statement.call_args_list:
        assert call.kwargs["warehouse_id"] == "wh-new"
    statements = [c.kwargs["statement"] for c in ws.statement_execution.execute_statement.call_args_list]
    assert any(s.startswith("GRANT USE CATALOG ON CATALOG") for s in statements)
    assert any(s.startswith("GRANT USE SCHEMA") for s in statements)
    assert any(s.startswith("ALTER SCHEMA") and "SET TAGS" in s for s in statements)
    assert any(s.startswith("ALTER SCHEMA") and "OWNER TO" in s for s in statements)

    # admin group owns: schema OWNER TO + warehouse IS_OWNER recorded.
    assert actions_by_step(ctx, "schema.owner")[0].detail["admin_group"] == "admins"

    # Every recorded write action is marked executed on the apply path.
    assert all(a.executed for a in ctx.actions if a.write)


# ---------------------------------------------------------------------------
# Ownership — admin-owned governance model
# ---------------------------------------------------------------------------


def _schema_info(owner):
    info = mock.Mock()
    info.owner = owner
    return info


def test_build_schema_owner_sql_quotes_hyphenated_group():
    cfg = make_config(catalog="example_catalog", schema_name="jt_analysts",
                      admin_group="edp-test-jt-analysts")
    assert edp.build_schema_owner_sql(cfg) == (
        "ALTER SCHEMA `example_catalog`.`jt_analysts` "
        "OWNER TO `edp-test-jt-analysts`"
    )


def test_build_schema_owner_sql_escapes_backticks():
    cfg = make_config(catalog="cat`x", schema_name="sch`z", admin_group="adm`n")
    assert edp.build_schema_owner_sql(cfg) == (
        "ALTER SCHEMA `cat``x`.`sch``z` OWNER TO `adm``n`"
    )


def test_transfer_schema_ownership_executes_alter_when_owner_differs():
    cfg = make_config(admin_group="admins")
    ws = make_workspace_client()
    ws.schemas.get.side_effect = None
    ws.schemas.get.return_value = _schema_info("jt@example.com")  # not admins
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.transfer_schema_ownership(ctx, ws, warehouse_id="wh-1")

    stmts = [c.kwargs["statement"]
             for c in ws.statement_execution.execute_statement.call_args_list]
    assert any("OWNER TO `admins`" in s for s in stmts)
    action = actions_by_step(ctx, "schema.owner")[0]
    assert action.write is True and action.executed is True
    assert action.detail["current_owner"] == "jt@example.com"


def test_transfer_schema_ownership_skips_when_already_admin_owned():
    cfg = make_config(admin_group="admins")
    ws = make_workspace_client()
    ws.schemas.get.side_effect = None
    ws.schemas.get.return_value = _schema_info("admins")  # already owned
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.transfer_schema_ownership(ctx, ws, warehouse_id="wh-1")

    # No ALTER OWNER TO executed (idempotent no-op).
    ws.statement_execution.execute_statement.assert_not_called()
    assert actions_by_step(ctx, "schema.owner")[0].write is False


def test_transfer_schema_ownership_fails_loud_on_insufficient_privilege():
    cfg = make_config(admin_group="admins")
    ws = make_workspace_client()
    ws.schemas.get.side_effect = None
    ws.schemas.get.return_value = _schema_info("someone-else")
    # The ALTER OWNER TO SQL fails with the specific PERMISSION_DENIED class ->
    # actionable runner-privilege message.
    ws.statement_execution.execute_statement.return_value = _failed_statement(
        _uc_error("PERMISSION_DENIED")
    )
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    with pytest.raises(edp.ProvisioningError) as exc:
        edp.transfer_schema_ownership(ctx, ws, warehouse_id="wh-1")
    assert "metastore admin or a member of 'admins'" in str(exc.value)


def test_transfer_schema_ownership_surfaces_unrelated_error_not_privilege():
    # A non-privilege, non-principal SQL failure (e.g. a syntax/parse error)
    # must surface the real error, NOT be mislabelled as a runner-privilege issue.
    cfg = make_config(admin_group="admins")
    ws = make_workspace_client()
    ws.schemas.get.side_effect = None
    ws.schemas.get.return_value = _schema_info("someone-else")
    ws.statement_execution.execute_statement.return_value = _failed_statement(
        _uc_error("PARSE_SYNTAX_ERROR")
    )
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    with pytest.raises(edp.SqlStatementError) as exc:
        edp.transfer_schema_ownership(ctx, ws, warehouse_id="wh-1")
    msg = str(exc.value)
    # The real error surfaces; no misleading metastore-admin guidance.
    assert "PARSE_SYNTAX_ERROR" in msg
    assert "metastore admin" not in msg
    assert "not a valid Unity Catalog principal" not in msg


def test_transfer_schema_ownership_fails_loud_when_admin_group_not_uc_principal():
    # Grounded from a live run: OWNER TO the reserved workspace 'admins' group
    # returns PRINCIPAL_DOES_NOT_EXIST — a distinct, actionable failure.
    cfg = make_config(admin_group="admins")
    ws = make_workspace_client()
    ws.schemas.get.side_effect = None
    ws.schemas.get.return_value = _schema_info("someone-else")
    ws.statement_execution.execute_statement.return_value = _failed_statement(
        _uc_error("PRINCIPAL_DOES_NOT_EXIST")
    )
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    with pytest.raises(edp.ProvisioningError) as exc:
        edp.transfer_schema_ownership(ctx, ws, warehouse_id="wh-1")
    msg = str(exc.value)
    assert "not a valid Unity Catalog principal" in msg
    assert "ACCOUNT-LEVEL" in msg


def test_transfer_schema_ownership_dry_run_records_no_write():
    cfg = make_config(admin_group="admins")
    ws = make_workspace_client()
    ws.schemas.get.side_effect = None
    ws.schemas.get.return_value = _schema_info("someone-else")
    ctx = edp.ProvisionContext(config=cfg, dry_run=True)

    edp.transfer_schema_ownership(ctx, ws, warehouse_id=None)

    ws.statement_execution.execute_statement.assert_not_called()
    action = actions_by_step(ctx, "schema.owner")[0]
    assert action.write is True and action.executed is False


def test_set_warehouse_owner_is_owner_success():
    cfg = make_config(admin_group="admins")
    ws = make_workspace_client()
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.set_warehouse_owner(ctx, ws, warehouse_id="wh-1")

    ws.warehouses.update_permissions.assert_called_once()
    kwargs = ws.warehouses.update_permissions.call_args.kwargs
    assert kwargs["warehouse_id"] == "wh-1"
    acl = kwargs["access_control_list"][0]
    assert acl.group_name == "admins"
    assert acl.permission_level == sql.WarehousePermissionLevel.IS_OWNER
    assert actions_by_step(ctx, "warehouse.owner")[0].detail["applied"] == "IS_OWNER"


# The real message the warehouse API returns when rejecting group IS_OWNER
# (grounded from a live example-workspace run). NOTE: the SDK raises this as
# errors.NotImplemented (HTTP 501), NOT BadRequest.
_WH_IS_OWNER_REJECTION = (
    "PATCH requests for warehouse e5501bf9753ba4cf with owner permissions are "
    "not supported currently, please use PUT request with full set of "
    "permissions instead."
)


def test_set_warehouse_owner_falls_back_to_can_manage_when_is_owner_rejected():
    cfg = make_config(admin_group="admins")
    ws = make_workspace_client()
    # First call (IS_OWNER) rejected with the REAL error (NotImplemented + the
    # real message); the fallback CAN_MANAGE call then succeeds.
    ws.warehouses.update_permissions.side_effect = [
        errors.NotImplemented(_WH_IS_OWNER_REJECTION),
        mock.Mock(),
    ]
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    edp.set_warehouse_owner(ctx, ws, warehouse_id="wh-1")

    assert ws.warehouses.update_permissions.call_count == 2
    first = ws.warehouses.update_permissions.call_args_list[0].kwargs[
        "access_control_list"][0]
    second = ws.warehouses.update_permissions.call_args_list[1].kwargs[
        "access_control_list"][0]
    assert first.permission_level == sql.WarehousePermissionLevel.IS_OWNER
    assert second.permission_level == sql.WarehousePermissionLevel.CAN_MANAGE
    action = actions_by_step(ctx, "warehouse.owner")[0]
    assert action.detail["applied"] == "CAN_MANAGE"
    assert "not accepted" in action.detail["note"]


def test_set_warehouse_owner_propagates_unrelated_bad_request():
    # A BadRequest whose message is NOT the IS_OWNER-unsupported rejection must
    # propagate — no silent CAN_MANAGE fallback.
    cfg = make_config(admin_group="admins")
    ws = make_workspace_client()
    ws.warehouses.update_permissions.side_effect = errors.BadRequest(
        "some unrelated bad request about cluster size"
    )
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    with pytest.raises(errors.BadRequest):
        edp.set_warehouse_owner(ctx, ws, warehouse_id="wh-1")
    # Only the IS_OWNER attempt was made — no fallback CAN_MANAGE call.
    ws.warehouses.update_permissions.assert_called_once()
    assert not actions_by_step(ctx, "warehouse.owner")


def test_set_warehouse_owner_propagates_unrelated_not_implemented():
    # An UNRELATED NotImplemented (same type as the real rejection but a
    # different message) must propagate — the fallback is gated on the message,
    # not the type, so it must not fire here.
    cfg = make_config(admin_group="admins")
    ws = make_workspace_client()
    ws.warehouses.update_permissions.side_effect = errors.NotImplemented(
        "some unrelated not-implemented feature"
    )
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    with pytest.raises(errors.NotImplemented):
        edp.set_warehouse_owner(ctx, ws, warehouse_id="wh-1")
    ws.warehouses.update_permissions.assert_called_once()
    assert not actions_by_step(ctx, "warehouse.owner")


def test_set_warehouse_owner_propagates_unrelated_error():
    # A non-BadRequest SDK error (e.g. NotFound / rate-limit / 5xx) must
    # propagate unchanged — never fall back to CAN_MANAGE.
    cfg = make_config(admin_group="admins")
    ws = make_workspace_client()
    ws.warehouses.update_permissions.side_effect = errors.NotFound(
        "warehouse not found"
    )
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    with pytest.raises(errors.NotFound):
        edp.set_warehouse_owner(ctx, ws, warehouse_id="wh-1")
    ws.warehouses.update_permissions.assert_called_once()
    assert not actions_by_step(ctx, "warehouse.owner")


def test_set_warehouse_owner_fails_loud_on_insufficient_privilege():
    cfg = make_config(admin_group="admins")
    ws = make_workspace_client()
    ws.warehouses.update_permissions.side_effect = errors.PermissionDenied(
        "principal is not a workspace admin"
    )
    ctx = edp.ProvisionContext(config=cfg, dry_run=False)

    with pytest.raises(edp.ProvisioningError) as exc:
        edp.set_warehouse_owner(ctx, ws, warehouse_id="wh-1")
    assert "workspace admin" in str(exc.value)
    # Failed loud on the privilege error — did NOT silently fall back.
    ws.warehouses.update_permissions.assert_called_once()


def test_set_warehouse_owner_dry_run_no_write():
    cfg = make_config(admin_group="admins")
    ws = make_workspace_client()
    ctx = edp.ProvisionContext(config=cfg, dry_run=True)

    edp.set_warehouse_owner(ctx, ws, warehouse_id=None)

    ws.warehouses.update_permissions.assert_not_called()
    action = actions_by_step(ctx, "warehouse.owner")[0]
    assert action.write is True and action.executed is False


def test_admin_group_required_fail_loud_apply():
    cfg = make_config(admin_group="")
    ws = make_workspace_client(group_exists=True)
    with pytest.raises(edp.ProvisioningError) as exc:
        edp.provision(cfg, ws, account_client=None, dry_run=False)
    assert "admin_group is required" in str(exc.value)
    # Failed before any workspace write.
    ws.schemas.create.assert_not_called()


def test_admin_group_required_fail_loud_dry_run():
    cfg = make_config(admin_group="   ")  # whitespace only
    ws = make_workspace_client(group_exists=True)
    with pytest.raises(edp.ProvisioningError) as exc:
        edp.provision(cfg, ws, account_client=None, dry_run=True)
    assert "admin_group is required" in str(exc.value)


def test_tenant_schema_grants_have_no_manage():
    # Governance option B: tenant gets data grants only, never MANAGE.
    for level in ("readwrite", "read"):
        changes = edp.build_grant_changes(make_config(access_level=level))
        assert catalog.Privilege.MANAGE not in changes["schema"].add
        assert catalog.Privilege.MANAGE not in changes["catalog"].add
    # The emitted schema-grant SQL carries no MANAGE keyword either.
    assert "MANAGE" not in edp.build_schema_grant_sql(
        make_config(access_level="readwrite")
    )


# ---------------------------------------------------------------------------
# admin_group principal preflight (workspace-local vs account-level)
# ---------------------------------------------------------------------------


def _ws_with_admin_group(resource_type):
    """Workspace client whose admin group 'admins' has the given resourceType."""

    ws = make_workspace_client(group_exists=True)

    def _groups_list(filter=None, **_kw):
        m = re.search(r'displayName eq "([^"]+)"', filter or "")
        name = m.group(1) if m else None
        if name in (None, "edp-test-group"):
            return [_group("edp-test-group")]
        if name == "admins":
            return [_group("admins", resource_type=resource_type)]
        return []

    ws.groups.list.side_effect = _groups_list
    return ws


def test_admin_group_preflight_fails_loud_for_workspace_local_group():
    # 'admins' resolves as a WorkspaceGroup -> cannot own UC objects -> fail loud
    # in the PLAN phase (dry-run) with the actionable message, zero writes.
    cfg = make_config(admin_group="admins")
    ws = _ws_with_admin_group("WorkspaceGroup")

    with pytest.raises(edp.ProvisioningError) as exc:
        edp.provision(cfg, ws, account_client=None, dry_run=True)

    msg = str(exc.value)
    assert "cannot own Unity Catalog objects" in msg
    assert "reserved workspace-local group" in msg
    assert "account-level group" in msg
    # Zero writes: no schema/warehouse/grant/tag mutations were attempted.
    assert_no_writes(ws)


def test_admin_group_preflight_passes_for_account_level_group():
    # 'edp-platform-admins' resolves as an account-level Group -> preflight
    # passes and provisioning proceeds unchanged (records the read-only step).
    cfg = make_config(admin_group="edp-platform-admins")
    ws = make_workspace_client(group_exists=True, schema_exists=False)

    ctx = edp.provision(cfg, ws, account_client=None, dry_run=True)

    pre = actions_by_step(ctx, "admin_group.preflight")
    assert len(pre) == 1
    assert pre[0].write is False
    assert pre[0].detail["resource_type"] == "Group"
    # Normal plan still produced (schema/grants/owner steps present).
    steps = {a.step for a in ctx.actions}
    assert {"schema.create", "grant.schema", "schema.owner"}.issubset(steps)


def test_admin_group_preflight_fails_loud_when_group_not_found():
    # admin_group does not resolve as a group at all -> fail loud, no writes.
    cfg = make_config(admin_group="does-not-exist")
    ws = make_workspace_client(group_exists=True)

    def _groups_list(filter=None, **_kw):
        m = re.search(r'displayName eq "([^"]+)"', filter or "")
        name = m.group(1) if m else None
        if name in (None, "edp-test-group"):
            return [_group("edp-test-group")]
        return []  # admin group not found

    ws.groups.list.side_effect = _groups_list

    with pytest.raises(edp.ProvisioningError) as exc:
        edp.provision(cfg, ws, account_client=None, dry_run=True)
    assert "could not be resolved as a group" in str(exc.value)
    assert_no_writes(ws)


def test_admin_group_preflight_does_not_swallow_unrelated_errors():
    # If the underlying groups.list read fails, that error must PROPAGATE — the
    # preflight only classifies workspace-local/not-found, never swallows.
    cfg = make_config(admin_group="admins")
    ws = make_workspace_client(group_exists=True)
    ws.groups.list.side_effect = errors.InternalError("scim backend down")

    with pytest.raises(errors.InternalError):
        edp.provision(cfg, ws, account_client=None, dry_run=True)
    assert_no_writes(ws)


def test_admin_group_preflight_fails_loud_for_unknown_resource_type():
    # Fail-CLOSED: a resolvable group whose resourceType is missing/unknown (i.e.
    # not the positively-confirmed "Group") must FAIL LOUD, not silently pass.
    cfg = make_config(admin_group="mystery-group")
    ws = make_workspace_client(group_exists=True)

    def _groups_list(filter=None, **_kw):
        m = re.search(r'displayName eq "([^"]+)"', filter or "")
        name = m.group(1) if m else None
        if name in (None, "edp-test-group"):
            return [_group("edp-test-group")]
        return [_group(name, resource_type=None)]  # missing/unknown type

    ws.groups.list.side_effect = _groups_list

    with pytest.raises(edp.ProvisioningError) as exc:
        edp.provision(cfg, ws, account_client=None, dry_run=True)
    msg = str(exc.value)
    assert "Could not confirm admin_group 'mystery-group'" in msg
    assert "meta.resourceType=absent" in msg
    assert "account-level group" in msg
    # Zero writes in the plan phase.
    assert_no_writes(ws)


def test_admin_group_preflight_fails_loud_for_unexpected_resource_type():
    # An unexpected (non-Group, non-WorkspaceGroup) resourceType also fails loud,
    # and the message names exactly what was seen.
    cfg = make_config(admin_group="weird-group")
    ws = make_workspace_client(group_exists=True)

    def _groups_list(filter=None, **_kw):
        m = re.search(r'displayName eq "([^"]+)"', filter or "")
        name = m.group(1) if m else None
        if name in (None, "edp-test-group"):
            return [_group("edp-test-group")]
        return [_group(name, resource_type="ServicePrincipalGroup")]

    ws.groups.list.side_effect = _groups_list

    with pytest.raises(edp.ProvisioningError) as exc:
        edp.provision(cfg, ws, account_client=None, dry_run=True)
    assert "meta.resourceType='ServicePrincipalGroup'" in str(exc.value)
    assert_no_writes(ws)


# ---------------------------------------------------------------------------
# derive_names stub
# ---------------------------------------------------------------------------


def test_derive_names_is_identity():
    cfg = make_config()
    out = edp.derive_names(cfg)
    assert out.group_name == cfg.group_name
    assert out.schema_name == cfg.schema_name
    assert out.warehouse_name == cfg.warehouse_name
