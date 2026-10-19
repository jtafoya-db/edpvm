import unittest
from datetime import datetime, timedelta, timezone

from monitor import as_utc, completed_run_sql, missed_cadences, should_alert, validate_identifier

CADENCE = 900  # 15 minutes
NOW = datetime(2026, 10, 5, 12, 0, 0, tzinfo=timezone.utc)


def ago(seconds: int) -> datetime:
    return NOW - timedelta(seconds=seconds)


class MissedCadencesTest(unittest.TestCase):
    def test_never_successful_schedule_first_offset_counts_go_live(self):
        self.assertEqual(
            missed_cadences(None, NOW + timedelta(minutes=7), CADENCE, baseline=NOW),
            1,
        )

    def test_no_run_and_no_baseline_is_unknown(self):
        self.assertIsNone(missed_cadences(None, NOW, CADENCE))

    def test_fresh_run_within_one_cadence_counts_zero(self):
        self.assertEqual(missed_cadences(ago(CADENCE - 1), NOW, CADENCE), 0)

    def test_fractional_interval_does_not_count_until_elapsed(self):
        self.assertEqual(missed_cadences(ago(CADENCE + 1), NOW, CADENCE), 1)

    def test_exact_two_cadence_boundary_counts_one(self):
        # At exactly two cadences the second refresh is firing *now*, not yet
        # missed. Counting it would false-fire a same-cadence monitor.
        self.assertEqual(missed_cadences(ago(2 * CADENCE), NOW, CADENCE), 1)

    def test_just_past_two_cadences_counts_two(self):
        self.assertEqual(missed_cadences(ago(2 * CADENCE + 1), NOW, CADENCE), 2)

    def test_clock_skew_future_run_counts_zero(self):
        self.assertEqual(missed_cadences(NOW + timedelta(seconds=30), NOW, CADENCE), 0)

    def test_non_positive_cadence_rejected(self):
        with self.assertRaises(ValueError):
            missed_cadences(ago(CADENCE), NOW, 0)

    def test_baseline_used_when_no_run_has_completed(self):
        # Empty table: count from the configured baseline instead of staying silent.
        self.assertEqual(missed_cadences(None, NOW, CADENCE, baseline=ago(3 * CADENCE + 1)), 4)

    def test_naive_timestamp_does_not_raise(self):
        # Spark TIMESTAMP columns arrive timezone-naive; subtracting an aware now
        # must not raise and must be interpreted as UTC.
        naive = (NOW - timedelta(seconds=2 * CADENCE + 1)).replace(tzinfo=None)
        self.assertEqual(missed_cadences(naive, NOW, CADENCE), 2)


class ShouldAlertTest(unittest.TestCase):
    def test_never_successful_schedule_alerts_at_second_offset_check(self):
        check = NOW + timedelta(minutes=22)
        self.assertEqual(missed_cadences(None, check, CADENCE, baseline=NOW), 2)
        self.assertTrue(should_alert(None, check, CADENCE, baseline=NOW))

    def test_schedule_boundaries_exclude_opportunity_firing_now(self):
        for minutes, misses in ((0, 0), (15, 1), (30, 2)):
            with self.subTest(minutes=minutes):
                self.assertEqual(
                    missed_cadences(None, NOW + timedelta(minutes=minutes),
                                    CADENCE, baseline=NOW),
                    misses,
                )

    def test_successful_schedule_counts_only_subsequent_opportunities(self):
        for minutes, misses in ((7, 0), (15, 0), (22, 1), (30, 1), (37, 2)):
            with self.subTest(minutes=minutes):
                check = NOW + timedelta(minutes=minutes)
                self.assertEqual(missed_cadences(NOW, check, CADENCE), misses)
                self.assertEqual(should_alert(NOW, check, CADENCE), misses >= 2)

    def test_empty_table_no_baseline_fails_closed(self):
        # No completed run and no baseline: cannot prove freshness, so alert.
        self.assertTrue(should_alert(None, NOW, CADENCE))

    def test_empty_table_within_grace_of_baseline_does_not_alert(self):
        self.assertFalse(should_alert(None, NOW, CADENCE, baseline=ago(7 * 60)))

    def test_empty_table_two_cadences_past_baseline_alerts(self):
        self.assertTrue(should_alert(None, NOW, CADENCE, baseline=ago(2 * CADENCE + 10)))

    def test_one_missed_cadence_does_not_alert(self):
        self.assertFalse(should_alert(ago(CADENCE + 10), NOW, CADENCE))

    def test_exact_two_cadence_boundary_does_not_alert(self):
        self.assertFalse(should_alert(ago(2 * CADENCE), NOW, CADENCE))

    def test_just_past_two_cadences_alerts(self):
        self.assertTrue(should_alert(ago(2 * CADENCE + 10), NOW, CADENCE))

    def test_threshold_is_configurable(self):
        self.assertFalse(should_alert(ago(2 * CADENCE + 10), NOW, CADENCE, allowed_missed=3))
        self.assertTrue(should_alert(ago(3 * CADENCE + 10), NOW, CADENCE, allowed_missed=3))


class AsUtcTest(unittest.TestCase):
    def test_none_passes_through(self):
        self.assertIsNone(as_utc(None))

    def test_naive_assumed_utc(self):
        naive = datetime(2026, 10, 5, 12, 0, 0)
        self.assertEqual(as_utc(naive), NOW)

    def test_aware_converted_to_utc(self):
        eastern = timezone(timedelta(hours=-5))
        aware = datetime(2026, 10, 5, 7, 0, 0, tzinfo=eastern)
        self.assertEqual(as_utc(aware), NOW)


class ValidateIdentifierTest(unittest.TestCase):
    def test_completed_run_query_requires_every_expected_group(self):
        sql = completed_run_sql("catalog", "membership")
        self.assertEqual(
            sql,
            "SELECT max(started_at) AS last_started "
            "FROM `catalog`.`membership`.`snapshot_runs` "
            "WHERE status = 'succeeded' AND size(groups_expected) > 0 "
            "AND size(array_except(groups_expected, groups_read)) = 0",
        )

    def test_accepts_plain_identifier(self):
        self.assertEqual(validate_identifier("edp_vending", kind="catalog"), "edp_vending")

    def test_rejects_injection_attempt(self):
        with self.assertRaises(ValueError):
            validate_identifier("a`.`b` WHERE 1=1--", kind="schema")

    def test_rejects_leading_digit(self):
        with self.assertRaises(ValueError):
            validate_identifier("1catalog", kind="catalog")

    def test_rejects_non_string(self):
        with self.assertRaises(ValueError):
            validate_identifier(None, kind="catalog")


if __name__ == "__main__":
    unittest.main()
