"""The dashboard's date presets, and where a day begins.

Every figure on the dashboard is a window over `placed_at`, so the window is
the report.  These tests pin the window itself rather than the money inside it,
because the bug they exist for was invisible in the totals: the presets were
derived from a UTC `now()` while `TIME_ZONE` is Asia/Dhaka, so "today" began at
06:00 local and, in the small hours, reached back into yesterday.  Nothing
failed -- the dashboard simply answered a different question than it was asked.

`freeze_time` is given a UTC instant throughout, because that is what the server
sees; the assertion is always about the *local* day it falls in.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal

import pytest
from django.utils import timezone
from freezegun import freeze_time

from core.exceptions import ValidationError
from reports.services import DateRange

DHAKA = "Asia/Dhaka"  # UTC+6, no DST


@pytest.fixture(autouse=True)
def dhaka(settings):
    """Pin the shop's timezone rather than inheriting the ambient one.

    The whole point of these tests is the gap between UTC and local, so a suite
    that happened to run in UTC would pass against the very bug they exist for.
    """
    settings.TIME_ZONE = DHAKA
    settings.USE_TZ = True


def _local(value: datetime) -> datetime:
    return timezone.localtime(value)


class TestPresetsStartOnTheLocalDay:
    """A preset boundary must land on midnight in the shop's timezone."""

    @freeze_time("2026-09-11T09:30:00Z")  # 15:30 Dhaka, same calendar day
    def test_today_starts_at_local_midnight_not_utc_midnight(self):
        span = DateRange.from_params({"range": "today"})
        start = _local(span.start)
        assert (start.hour, start.minute) == (0, 0)
        assert start.date() == date(2026, 9, 11)
        # The bug: UTC midnight is 06:00 Dhaka, so the night's trade vanished.
        assert start.utcoffset() == timedelta(hours=6)

    @freeze_time("2026-09-10T20:15:00Z")  # 02:15 Dhaka on the 11th
    def test_today_before_dawn_does_not_reach_into_yesterday(self):
        """The case that made the filter actively wrong, not merely narrow.

        At 02:15 Dhaka the UTC date is still the 10th, so a UTC-derived
        "today" started at 06:00 on the 10th and counted twenty hours of the
        previous day's trade as today's.
        """
        span = DateRange.from_params({"range": "today"})
        start = _local(span.start)
        assert start.date() == date(2026, 9, 11)
        assert (start.hour, start.minute) == (0, 0)
        assert span.start <= timezone.now()

    @freeze_time("2026-09-11T09:30:00Z")
    def test_yesterday_is_one_whole_local_day(self):
        """Both ends inside the 10th: every report filters with `__lte`, so an
        end of midnight-on-the-11th counted a 00:00:00 order twice."""
        span = DateRange.from_params({"range": "yesterday"})
        assert _local(span.start).date() == date(2026, 9, 10)
        assert _local(span.end).date() == date(2026, 9, 10)
        assert (_local(span.start).hour, _local(span.end).hour) == (0, 23)

    @freeze_time("2026-09-11T09:30:00Z")
    def test_yesterday_and_today_do_not_overlap(self):
        earlier = DateRange.from_params({"range": "yesterday"})
        later = DateRange.from_params({"range": "today"})
        assert earlier.end < later.start

    @freeze_time("2026-09-11T09:30:00Z")
    def test_year_starts_on_the_first_of_january_locally(self):
        span = DateRange.from_params({"range": "year"})
        start = _local(span.start)
        assert (start.year, start.month, start.day) == (2026, 1, 1)
        assert (start.hour, start.microsecond) == (0, 0)


class TestRollingPresetsCoverWholeDays:
    """`sales_over_time` buckets by `TruncDate`, so the window must too."""

    @pytest.mark.parametrize(("preset", "days"), [("7d", 7), ("30d", 30), ("90d", 90)])
    @freeze_time("2026-09-11T09:30:00Z")
    def test_covers_exactly_n_calendar_days_including_today(self, preset, days):
        span = DateRange.from_params({"range": preset})
        start = _local(span.start)
        assert (start.hour, start.minute, start.second) == (0, 0, 0)
        assert start.date() == date(2026, 9, 11) - timedelta(days=days - 1)
        # Whole days only: a rolling N*24h window drew N+1 bars, the first and
        # last of them part-days.
        assert (_local(span.end).date() - start.date()).days + 1 == days


class TestCalendarMonths:
    """ "Last month" is August, not "the last thirty days"."""

    @freeze_time("2026-09-11T09:30:00Z")
    def test_month_starts_on_the_first_of_this_month(self):
        span = DateRange.from_params({"range": "month"})
        assert _local(span.start).date() == date(2026, 9, 1)

    @freeze_time("2026-09-11T09:30:00Z")
    def test_last_month_is_the_whole_previous_month(self):
        span = DateRange.from_params({"range": "last_month"})
        assert _local(span.start).date() == date(2026, 8, 1)
        assert _local(span.end).date() == date(2026, 8, 31)

    @freeze_time("2026-09-11T09:30:00Z")
    def test_last_month_does_not_overlap_this_month(self):
        assert (
            DateRange.from_params({"range": "last_month"}).end
            < DateRange.from_params({"range": "month"}).start
        )

    @freeze_time("2026-01-09T09:30:00Z")
    def test_last_month_crosses_the_year_boundary(self):
        span = DateRange.from_params({"range": "last_month"})
        assert _local(span.start).date() == date(2025, 12, 1)
        assert _local(span.end).date() == date(2025, 12, 31)

    @freeze_time("2026-03-15T09:30:00Z")
    def test_last_month_handles_a_short_february(self):
        """`today.replace(month=today.month - 1)` would raise on the 30th."""
        span = DateRange.from_params({"range": "last_month"})
        assert _local(span.start).date() == date(2026, 2, 1)
        assert _local(span.end).date() == date(2026, 2, 28)

    @freeze_time("2026-03-31T09:30:00Z")
    def test_last_month_from_a_day_february_does_not_have(self):
        span = DateRange.from_params({"range": "last_month"})
        assert _local(span.start).date() == date(2026, 2, 1)
        assert _local(span.end).date() == date(2026, 2, 28)


class TestFallbackAndCustomDates:
    @freeze_time("2026-09-11T09:30:00Z")
    def test_an_unknown_preset_falls_back_to_thirty_days_and_says_so(self):
        """It used to echo the caller's spelling onto a 30-day window."""
        span = DateRange.from_params({"range": "last-month"})
        assert span.label == "30d"
        assert _local(span.start).date() == date(2026, 8, 13)

    @freeze_time("2026-09-11T09:30:00Z")
    def test_a_missing_range_is_the_documented_default(self):
        assert DateRange.from_params({}).label == "30d"

    @freeze_time("2026-09-11T09:30:00Z")
    def test_custom_dates_agree_with_the_presets_about_where_a_day_ends(self):
        """The two controls used to disagree by six hours."""
        custom = DateRange.from_params({"date_from": "2026-09-11", "date_to": "2026-09-11"})
        preset = DateRange.from_params({"range": "today"})
        assert custom.start == preset.start
        assert _local(custom.end).date() == date(2026, 9, 11)
        assert _local(custom.end).hour == 23

    @freeze_time("2026-09-11T09:30:00Z")
    def test_an_unreadable_custom_date_is_refused_rather_than_ignored(self):
        """It used to fall through to the default thirty days.

        Silently dropping a filter shows more rows than were asked for and
        calls it an answer -- which is why `core.dates` raises, and why reports
        now go through it instead of keeping a second, laxer parser.
        """
        with pytest.raises(ValidationError):
            DateRange.from_params({"date_from": "not-a-date"})

    @freeze_time("2026-09-11T09:30:00Z")
    def test_a_custom_window_accepts_a_full_timestamp(self):
        """The admin's expense screen sends instants, not days."""
        span = DateRange.from_params(
            {"date_from": "2026-08-01T00:00:00+06:00", "date_to": "2026-08-31T23:59:59+06:00"}
        )
        assert span.label == "custom"
        assert _local(span.start).date() == date(2026, 8, 1)
        assert _local(span.end).date() == date(2026, 8, 31)


@pytest.mark.django_db
class TestTheSalesSeriesHasARowPerDay:
    """A quiet day must be flat on the axis, not missing from it.

    `sales_over_time` returned only days that traded, and the chart plots what
    it is given -- so a week with no sales drew as a straight line between the
    days either side of it, and a seven-day window could draw six points.
    """

    def test_every_day_in_the_window_is_present_even_with_no_sales(self, dhaka):
        from reports.services import dashboard

        span = DateRange.from_params({"range": "7d"})
        series = dashboard(date_range=span)["sales_over_time"]
        assert len(series) == 7
        days = [row["day"] for row in series]
        assert days == sorted(days)
        assert days[0] == timezone.localdate(span.start)
        assert days[-1] == timezone.localdate(span.end)

    def test_a_filled_day_reports_zero_rather_than_nothing(self, dhaka):
        """An empty shop sells nothing; it does not sell `None`."""
        from reports.services import dashboard

        series = dashboard(date_range=DateRange.from_params({"range": "7d"}))["sales_over_time"]
        quiet = [row for row in series if row["orders"] == 0]
        assert quiet, "expected at least one day with no orders in an empty database"
        for row in quiet:
            assert row["revenue"] == row["pos"] == row["online"] == Decimal("0.00")

    def test_a_very_wide_window_is_not_filled(self, dhaka):
        """The cap that stops a decade-long custom range returning 3,650 rows."""
        from reports.services import dashboard

        span = DateRange.from_params({"date_from": "2016-01-01", "date_to": "2026-09-11"})
        assert dashboard(date_range=span)["sales_over_time"] == []
