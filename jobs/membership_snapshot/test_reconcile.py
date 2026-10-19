import unittest
from reconcile import (
    ExistingMembership, Member, classify_member_reference, reconcile_group, retry,
    finalize_snapshot_run, process_groups, require_expected_principal,
    snapshot_run_status, validate_allowlist,
)

def member(user_id: str) -> Member:
    return Member(user_id, f"{user_id}@example.gov", user_id.title())

class ReconcileGroupTest(unittest.TestCase):
    def test_snapshot_run_succeeds_only_after_every_expected_group_is_read(self):
        self.assertEqual(snapshot_run_status(["g1", "g2"], ["g1", "g2"]), "succeeded")
        self.assertEqual(snapshot_run_status(["g1", "g2"], ["g1"]), "partial")
        self.assertEqual(snapshot_run_status(["g1"], []), "partial")
        self.assertEqual(snapshot_run_status([], []), "partial")

    def test_finalize_empty_snapshot_records_partial_and_fails_the_job(self):
        result = finalize_snapshot_run([], [], None, [])
        self.assertEqual(result.status, "partial")
        self.assertIsInstance(result.error, RuntimeError)
        self.assertEqual(
            result.messages,
            ("Membership snapshot incomplete: read 0 of 0 expected groups",),
        )

    def test_finalize_partial_snapshot_records_counts_and_fails_the_job(self):
        result = finalize_snapshot_run(["g1", "g2"], ["g1"], None, [])
        self.assertEqual(result.status, "partial")
        self.assertIsInstance(result.error, RuntimeError)
        self.assertEqual(
            result.messages,
            ("Membership snapshot incomplete: read 1 of 2 expected groups",),
        )

    def test_adds_new_users(self):
        result = reconcile_group([], [member("u1")], [], fetch_complete=True, max_removals=2)
        self.assertEqual(result.upserts, (member("u1"),))
    def test_removes_missing_active_users(self):
        result = reconcile_group([ExistingMembership("u1"), ExistingMembership("u2")],
                                 [member("u1")], [], fetch_complete=True, max_removals=2)
        self.assertEqual(result.removals, ("u2",))
    def test_readds_removed_user_by_upserting_it(self):
        result = reconcile_group([ExistingMembership("u1", True)], [member("u1")], [],
                                 fetch_complete=True, max_removals=2)
        self.assertEqual(result.upserts, (member("u1"),))
        self.assertEqual(result.removals, ())
    def test_partial_fetch_leaves_missing_users_untouched(self):
        result = reconcile_group(
            [ExistingMembership("u1")], [], [], fetch_complete=False, max_removals=2
        )
        self.assertEqual((result.removals, result.removal_status), ((), "partial-fetch"))
    def test_non_user_members_are_skipped_and_reported(self):
        result = reconcile_group([], [member("u1")], ["group:g1", "service-principal:sp1"],
                                 fetch_complete=True, max_removals=2)
        self.assertEqual(result.skipped_non_users, ("group:g1", "service-principal:sp1"))
    def test_mass_removal_guard_leaves_rows_untouched(self):
        result = reconcile_group([ExistingMembership("u1"), ExistingMembership("u2"),
                                  ExistingMembership("u3")], [member("u1")], [],
                                 fetch_complete=True, max_removals=1)
        self.assertEqual((result.removals, result.removal_status), ((), "mass-removal"))
    def test_zero_user_fetch_with_active_rows_refuses_removals(self):
        result = reconcile_group([ExistingMembership("u1")], [], [],
                                 fetch_complete=True, max_removals=10)
        self.assertEqual((result.removals, result.removal_status), ((), "zero-user-fetch"))
    def test_missing_or_unknown_member_refs_are_unresolved(self):
        self.assertEqual(classify_member_reference(""), "unresolved")
        self.assertEqual(classify_member_reference("Widgets/w1"), "unresolved")
        self.assertEqual(classify_member_reference("Groups/g1"), "known-non-user")
        self.assertEqual(classify_member_reference("ServicePrincipals/sp1"), "known-non-user")
        self.assertEqual(classify_member_reference("Users/u1"), "user")
        self.assertEqual(
            classify_member_reference("https://host/api/2.0/preview/scim/v2/Users/123"),
            "user",
        )
    def test_threshold_boundary_allows_exactly_max_removals(self):
        result = reconcile_group(
            [ExistingMembership("u1"), ExistingMembership("u2"),
             ExistingMembership("u3")], [member("u1")], [],
            fetch_complete=True, max_removals=2,
        )
        self.assertEqual((result.removals, result.removal_status), (("u2", "u3"), "applied"))
    def test_empty_group_warns_repeatedly_while_active_rows_are_preserved(self):
        existing = [ExistingMembership("u1")]
        first = reconcile_group(existing, [], [], fetch_complete=True, max_removals=10)
        second = reconcile_group(existing, [], [], fetch_complete=True, max_removals=10)
        self.assertEqual(first.removal_status, "zero-user-fetch")
        self.assertEqual(second.removal_status, "zero-user-fetch")
    def test_retry_uses_typed_predicate_and_backoff(self):
        class FakeThrottle(Exception):
            pass
        attempts, sleeps = [], []
        def flaky():
            attempts.append(True)
            if len(attempts) < 3:
                raise FakeThrottle()
            return "ok"
        result = retry(flaky, lambda error: isinstance(error, FakeThrottle),
                       sleep=sleeps.append)
        self.assertEqual((result, len(attempts), sleeps), ("ok", 3, [1, 2]))
    def test_allowlist_rejects_duplicate_ids_and_empty_names(self):
        base = {"group_id": "g1", "group_name": "Group", "kind": "domain",
                "domain": "domain-a", "managed_by": "manual", "account_group": True}
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            validate_allowlist([base, dict(base)])
        with self.assertRaisesRegex(ValueError, "non-empty"):
            validate_allowlist([dict(base, group_name="")])
    def test_allowlist_requires_account_group_assertion(self):
        base = {"group_id": "g1", "group_name": "Group", "kind": "domain",
                "domain": "domain-a", "managed_by": "manual", "account_group": True}
        validate_allowlist([base])  # the asserted account group is accepted
        with self.assertRaisesRegex(ValueError, "account_group"):
            validate_allowlist([{k: v for k, v in base.items() if k != "account_group"}])
        with self.assertRaisesRegex(ValueError, "account_group"):
            validate_allowlist([dict(base, account_group=False)])
    def test_production_identity_guard_reads_user_name_from_sdk_shaped_client(self):
        class Identity:
            def __init__(self, user_name):
                self.user_name = user_name
        class CurrentUser:
            def __init__(self, user_name):
                self.identity = Identity(user_name)
            def me(self):
                return self.identity
        class FakeClient:
            def __init__(self, user_name):
                self.current_user = CurrentUser(user_name)
        require_expected_principal(True, "application-id", FakeClient("application-id"))
        with self.assertRaisesRegex(RuntimeError, "mismatch"):
            require_expected_principal(True, "application-id", FakeClient("human@example.gov"))
        with self.assertRaisesRegex(RuntimeError, "expected principal"):
            require_expected_principal(True, "", FakeClient("application-id"))
    def test_guarded_group_does_not_stop_later_group_write_before_failure(self):
        class FakeClient:
            def __init__(self):
                self.writes = []
            def process(self, group):
                self.writes.append(group)
                return [f"{group} guarded"] if group == "g1" else []
        client = FakeClient()
        with self.assertRaisesRegex(RuntimeError, "g1 guarded"):
            process_groups(["g1", "g2"], client.process)
        self.assertEqual(client.writes, ["g1", "g2"])

if __name__ == "__main__":
    unittest.main()
