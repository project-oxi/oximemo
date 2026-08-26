//! Value model and primitives for the Bases-compatible expression engine
//! (spec 2026-08-25 §2). The later `expr` modules build on top of these
//! types: every later task imports `Value`, `DurationSpec`, the
//! promotion/parsing helpers, and `total_order` from here.

use std::cmp::Ordering;
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, UtcOffset};

/// Runtime value of an expression. Matches spec §2; serde is required
/// because Task 9's DTOs serialize `BaseCell` payloads through this
/// type. `Date` pins the wire to RFC 3339 (matching
/// `BaseClock.now_utc`) via `time`'s well-known serde — the crate's
/// default human-readable form would put a second date format
/// (`2025-01-01 00:00:00.0 +00:00:00`) on the same wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Value {
    Null,
    Bool(bool),
    Num(f64),
    Str(String),
    List(Vec<Value>),
    Date(#[serde(with = "time::serde::rfc3339")] OffsetDateTime),
    Duration(DurationSpec),
}

/// Calendar-aware duration. `time::Duration` cannot represent `1M` from
/// Jan 31 because months have variable length, so the engine keeps the two
/// axes separate: `calendar_months` for `y`/`M`, `fixed_millis` for the
/// rest (`w`/`d`/`h`/`m`/`s`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DurationSpec {
    pub calendar_months: i32,
    pub fixed_millis: i64,
}

// `time::Date` accepts years in `-9999..=9999`. We leave one year of
// headroom on both ends so `date_add` can always return a valid date
// after saturating, rather than panic.
const MIN_YEAR: i32 = -9998;
const MAX_YEAR: i32 = 9998;
const MIN_TOTAL_MONTHS: i64 = (MIN_YEAR as i64) * 12;
const MAX_TOTAL_MONTHS: i64 = (MAX_YEAR as i64) * 12 + 11;
static MIN_REP_UTC: LazyLock<OffsetDateTime> = LazyLock::new(|| {
    let d = Date::from_calendar_date(MIN_YEAR, Month::January, 1).expect("valid clamp date");
    d.with_hms(0, 0, 0).expect("0:00 is valid").assume_utc()
});
static MAX_REP_UTC: LazyLock<OffsetDateTime> = LazyLock::new(|| {
    let d = Date::from_calendar_date(MAX_YEAR, Month::December, 31).expect("valid clamp date");
    d.with_hms(23, 59, 59)
        .expect("23:59:59 is valid")
        .assume_utc()
});

/// Render a numeric `Value` for display. Integer-valued numbers omit the
/// decimal point so totals/counts render as `42`, not `42.0`. Used by
/// `group_string` (and any other surface that needs a stable textual
/// form of a numeric).
pub fn format_num(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// Stable, parser-lossless string form of any `Value` for grouping /
/// output. Numbers use `format_num`; NaN/inf pin to `null` to match the
/// engine's non-finite-as-error semantics. Used by `run_base` to bucket
/// rows for `groupBy` and to render the table view.
pub fn group_string(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Num(n) if n.is_finite() => format_num(*n),
        Value::Num(_) => "null".into(),
        Value::Str(s) => s.clone(),
        Value::List(items) => {
            let parts: Vec<String> = items.iter().map(group_string).collect();
            format!("[{}]", parts.join(", "))
        }
        Value::Date(d) => d.to_string(),
        Value::Duration(d) => format!("{}M{}ms", d.calendar_months, d.fixed_millis),
    }
}

/// Parse a duration literal: `"1w"`, `"2M"`, `"1y"`, `"3d"`, `"12h"`,
/// `"30m"`, `"10s"`. Units are case-sensitive: `M` is months, `m` is
/// minutes. A non-negative integer followed by a single unit; anything
/// else returns `None` (signed prefixes are rejected).
pub fn parse_duration_lit(s: &str) -> Option<DurationSpec> {
    let bytes = s.as_bytes();
    if bytes.len() < 2 {
        return None;
    }
    let split = bytes.split_at(bytes.len() - 1);
    // Reject any signed prefix: the grammar is unsigned integer + unit,
    // and a leading `-` would silently flip `calendar_months` into
    // i32::MIN territory when `date_add` multiplies by sign.
    if let Some(&first) = split.0.first()
        && (first == b'-' || first == b'+')
    {
        return None;
    }
    let n: i64 = std::str::from_utf8(split.0).ok()?.parse().ok()?;
    if n < 0 {
        return None;
    }
    let unit = split.1;
    let u = unit[0];
    let day_ms: i64 = 86_400_000;
    let hour_ms: i64 = 3_600_000;
    let min_ms: i64 = 60_000;
    let sec_ms: i64 = 1_000;
    match u {
        b'y' => Some(DurationSpec {
            calendar_months: (n * 12).try_into().ok()?,
            fixed_millis: 0,
        }),
        b'M' => Some(DurationSpec {
            calendar_months: n.try_into().ok()?,
            fixed_millis: 0,
        }),
        b'w' => Some(DurationSpec {
            calendar_months: 0,
            fixed_millis: n.checked_mul(7 * day_ms)?,
        }),
        b'd' => Some(DurationSpec {
            calendar_months: 0,
            fixed_millis: n.checked_mul(day_ms)?,
        }),
        b'h' => Some(DurationSpec {
            calendar_months: 0,
            fixed_millis: n.checked_mul(hour_ms)?,
        }),
        b'm' => Some(DurationSpec {
            calendar_months: 0,
            fixed_millis: n.checked_mul(min_ms)?,
        }),
        b's' => Some(DurationSpec {
            calendar_months: 0,
            fixed_millis: n.checked_mul(sec_ms)?,
        }),
        _ => None,
    }
}

/// Parse an ISO-8601-ish date literal. Accepts `YYYY-MM-DD`,
/// `YYYY-MM-DD HH:MM`, `YYYY-MM-DD HH:MM:SS`, and full RFC 3339. When no
/// offset is present the time is treated as UTC — this matches the spec's
/// "pinned system-local UTC offset" semantics (`now()` produces UTC, but
/// the request supplies a local offset used by `date_add`).
#[allow(deprecated)]
pub fn parse_date_ish(s: &str) -> Option<OffsetDateTime> {
    use time::format_description::well_known::Rfc3339;
    if let Ok(d) = OffsetDateTime::parse(s, &Rfc3339) {
        return Some(d);
    }
    let date_fmt = time::format_description::parse("[year]-[month]-[day]").ok()?;
    if let Ok(date) = Date::parse(s, &date_fmt) {
        return Some(date.with_hms(0, 0, 0).ok()?.assume_utc());
    }
    let dt_fmt =
        time::format_description::parse("[year]-[month]-[day] [hour]:[minute]:[second]").ok()?;
    if let Ok(dt) = PrimitiveDateTime::parse(s, &dt_fmt) {
        return Some(dt.assume_utc());
    }
    let dt_min_fmt =
        time::format_description::parse("[year]-[month]-[day] [hour]:[minute]").ok()?;
    if let Ok(dt) = PrimitiveDateTime::parse(s, &dt_min_fmt) {
        return Some(dt.assume_utc());
    }
    None
}

/// Contextual promotion to `Num`: existing numerics pass through, numeric
/// strings parse losslessly, anything else fails.
pub fn promote_num(v: &Value) -> Option<f64> {
    match v {
        Value::Num(n) => Some(*n),
        Value::Str(s) => s.parse::<f64>().ok(),
        _ => None,
    }
}

/// Contextual promotion to `Date`: existing dates pass through, ISO-ish
/// strings parse, anything else fails.
pub fn promote_date(v: &Value) -> Option<OffsetDateTime> {
    match v {
        Value::Date(d) => Some(*d),
        Value::Str(s) => parse_date_ish(s),
        _ => None,
    }
}

/// Add a duration to an instant. Calendar months are applied first (with
/// end-of-month clamping per spec §2) using the request's local UTC
/// offset; then the fixed millisecond axis is applied in milliseconds.
/// Both axes saturate to the nearest representable `OffsetDateTime`
/// instead of panicking — `parse_duration_lit` accepts values whose
/// combination can overflow `time::Date`'s year range or `Duration`'s
/// millisecond span, and the engine must convert overflow into a clamped
/// date rather than a process abort.
pub fn date_add(
    d: OffsetDateTime,
    dur: &DurationSpec,
    sign: i32,
    local: UtcOffset,
) -> OffsetDateTime {
    debug_assert!(sign == 1 || sign == -1);
    let after_months = if dur.calendar_months != 0 {
        add_calendar_months(d, dur.calendar_months, sign, local)
    } else {
        d
    };
    if dur.fixed_millis == 0 {
        after_months
    } else {
        let offset_ms = dur.fixed_millis.saturating_mul(sign as i64);
        after_months
            .checked_add(time::Duration::milliseconds(offset_ms))
            .unwrap_or(clamp_extremum(local, offset_ms >= 0))
    }
}

fn clamp_extremum(local: UtcOffset, positive: bool) -> OffsetDateTime {
    let base = if positive { *MAX_REP_UTC } else { *MIN_REP_UTC };
    base.to_offset(local)
}

fn add_calendar_months(
    d: OffsetDateTime,
    months: i32,
    sign: i32,
    local: UtcOffset,
) -> OffsetDateTime {
    let months = months.saturating_mul(sign);
    let local_dt = d.to_offset(local);
    let date = local_dt.date();
    let (mut y, mut m, day) = date.to_calendar_date();
    let total = y as i64 * 12 + (m as u8 as i64 - 1) + months as i64;
    if total >= MAX_TOTAL_MONTHS {
        return clamp_extremum(local, true);
    }
    if total <= MIN_TOTAL_MONTHS {
        return clamp_extremum(local, false);
    }
    let new_total_y = total.div_euclid(12);
    let new_m0 = total.rem_euclid(12) as u8;
    y = new_total_y as i32;
    m = Month::try_from(new_m0 + 1).expect("rem_euclid fits 0..12");
    let dim = days_in_month(y, m);
    let new_day = day.min(dim);
    match Date::from_calendar_date(y, m, new_day) {
        Ok(new_date) => {
            let new_pdt = new_date
                .with_hms(local_dt.hour(), local_dt.minute(), local_dt.second())
                .expect("hms within range");
            new_pdt.assume_offset(local)
        }
        Err(_) => {
            // Defensive: should be unreachable given the saturation above,
            // but if a leap-year boundary slips through, clamp rather than
            // panic.
            if y >= MAX_YEAR {
                clamp_extremum(local, true)
            } else {
                clamp_extremum(local, false)
            }
        }
    }
}

fn days_in_month(year: i32, month: Month) -> u8 {
    match month {
        Month::January
        | Month::March
        | Month::May
        | Month::July
        | Month::August
        | Month::October
        | Month::December => 31,
        Month::April | Month::June | Month::September | Month::November => 30,
        Month::February => {
            if is_leap(year) {
                29
            } else {
                28
            }
        }
    }
}

fn is_leap(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// Total order across `Value` variants. Spec §2: after contextual
/// promotion, values sort `Bool < Num < Date < Str < List < Null`. Strings
/// compare with case-sensitive Unicode scalar order; lists compare by
/// first member (empty list sorts before any non-empty list).
pub fn total_order(a: &Value, b: &Value) -> Ordering {
    fn rank(v: &Value) -> u8 {
        match v {
            Value::Bool(_) => 0,
            Value::Num(_) => 1,
            Value::Date(_) => 2,
            Value::Str(_) => 3,
            Value::List(_) => 4,
            Value::Duration(_) => 5,
            Value::Null => 6,
        }
    }
    let ra = rank(a);
    let rb = rank(b);
    if ra != rb {
        return ra.cmp(&rb);
    }
    match (a, b) {
        (Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        (Value::Num(x), Value::Num(y)) => x.partial_cmp(y).unwrap_or(Ordering::Equal),
        (Value::Date(x), Value::Date(y)) => x.cmp(y),
        (Value::Str(x), Value::Str(y)) => x.cmp(y),
        (Value::List(x), Value::List(y)) => list_cmp(x, y),
        (Value::Duration(x), Value::Duration(y)) => x
            .calendar_months
            .cmp(&y.calendar_months)
            .then(x.fixed_millis.cmp(&y.fixed_millis)),
        _ => Ordering::Equal,
    }
}

fn list_cmp(a: &[Value], b: &[Value]) -> Ordering {
    for (x, y) in a.iter().zip(b.iter()) {
        match total_order(x, y) {
            Ordering::Equal => continue,
            ord => return ord,
        }
    }
    a.len().cmp(&b.len())
}
/// Stable, lowercase kind name for [`Value`] (spec §2:
/// `null|bool|number|string|list|date|duration`). Used by the
/// `typeof()` function and by runtime error messages that name the
/// unexpected operand type.
pub fn type_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "bool",
        Value::Num(_) => "number",
        Value::Str(_) => "string",
        Value::List(_) => "list",
        Value::Date(_) => "date",
        Value::Duration(_) => "duration",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    #[test]
    fn duration_literals() {
        assert_eq!(
            parse_duration_lit("1w"),
            Some(DurationSpec {
                calendar_months: 0,
                fixed_millis: 7 * 86_400_000
            })
        );
        assert_eq!(
            parse_duration_lit("2M"),
            Some(DurationSpec {
                calendar_months: 2,
                fixed_millis: 0
            })
        );
        assert_eq!(
            parse_duration_lit("1y"),
            Some(DurationSpec {
                calendar_months: 12,
                fixed_millis: 0
            })
        );
        assert_eq!(
            parse_duration_lit("30m"),
            Some(DurationSpec {
                calendar_months: 0,
                fixed_millis: 1_800_000
            })
        );
        assert_eq!(parse_duration_lit("1x"), None);
        assert_eq!(parse_duration_lit("w"), None);
    }

    #[test]
    fn duration_literal_rejects_signed_prefix() {
        // Grammar is unsigned integer + single unit; signed prefixes are
        // rejected so `parse_duration_lit` cannot produce a DurationSpec
        // whose `calendar_months` field would overflow i32 when sign is
        // applied inside `date_add`.
        assert_eq!(parse_duration_lit("-1d"), None);
        assert_eq!(parse_duration_lit("+1d"), None);
        assert_eq!(parse_duration_lit("-2147483648M"), None);
    }

    #[test]
    fn month_arithmetic_clamps() {
        let jan31 = datetime!(2025-01-31 0:00 UTC);
        let feb = date_add(
            jan31,
            &parse_duration_lit("1M").unwrap(),
            1,
            time::UtcOffset::UTC,
        );
        assert_eq!(feb, datetime!(2025-02-28 0:00 UTC)); // 2025 not a leap year
        let leap = date_add(
            datetime!(2024-01-31 0:00 UTC),
            &parse_duration_lit("1M").unwrap(),
            1,
            time::UtcOffset::UTC,
        );
        assert_eq!(leap, datetime!(2024-02-29 0:00 UTC));
    }

    #[test]
    fn date_add_does_not_panic_on_extreme_durations() {
        // 100,000 years overflows `time::Date`'s year range, but
        // `parse_duration_lit` accepts it. `date_add` must saturate, not
        // panic on either axis.
        let now = datetime!(2025-01-01 0:00 UTC);
        let huge_years = parse_duration_lit("100000y").unwrap();
        let _ = date_add(now, &huge_years, 1, time::UtcOffset::UTC);
        let _ = date_add(now, &huge_years, -1, time::UtcOffset::UTC);

        // Same on the millisecond axis.
        let huge_days = parse_duration_lit("100000000000d").unwrap();
        let _ = date_add(now, &huge_days, 1, time::UtcOffset::UTC);
        let _ = date_add(now, &huge_days, -1, time::UtcOffset::UTC);
    }

    #[test]
    fn promotion() {
        assert_eq!(promote_num(&Value::Str("12.5".into())), Some(12.5));
        assert_eq!(promote_num(&Value::Bool(true)), None);
        assert!(promote_date(&Value::Str("2025-04-01".into())).is_some());
        assert!(promote_date(&Value::Str("책".into())).is_none());
    }

    #[test]
    fn total_order_ranking() {
        let mut v = [
            Value::Null,
            Value::Str("b".into()),
            Value::List(vec![]),
            Value::Num(9.0),
            Value::Bool(false),
            Value::Bool(true),
        ];
        v.sort_by(total_order);
        assert!(matches!(v[0], Value::Bool(false)));
        assert!(matches!(v[5], Value::Null));
    }

    #[test]
    fn format_num_renders_integers_without_decimal() {
        assert_eq!(format_num(42.0), "42");
        assert_eq!(format_num(0.0), "0");
        assert_eq!(format_num(-7.0), "-7");
        assert_eq!(format_num(12.5), "12.5");
        assert_eq!(format_num(-0.25), "-0.25");
    }

    #[test]
    fn group_string_uses_format_num() {
        // Count/group surfaces rely on this: a row with `Num(9.0)` and a
        // row with `Str("9")` must bucket identically.
        assert_eq!(group_string(&Value::Num(9.0)), "9");
        assert_eq!(group_string(&Value::Num(0.0)), "0");
        assert_eq!(group_string(&Value::Num(12.5)), "12.5");
        assert_eq!(group_string(&Value::Null), "null");
        assert_eq!(group_string(&Value::Bool(true)), "true");
        assert_eq!(group_string(&Value::Bool(false)), "false");
        assert_eq!(group_string(&Value::Str("hi".into())), "hi");
        assert_eq!(
            group_string(&Value::List(vec![Value::Num(1.0), Value::Num(2.0)])),
            "[1, 2]"
        );
        // NaN/inf pin to "null" to match non-finite-as-error semantics.
        assert_eq!(group_string(&Value::Num(f64::NAN)), "null");
        assert_eq!(group_string(&Value::Num(f64::INFINITY)), "null");
    }

    /// The wire carries ONE date format: RFC 3339, same as
    /// `BaseClock.now_utc`. The old default serde form
    /// (`2025-01-01 00:00:00.0 +00:00:00`) would have forced Plan B's
    /// frontend to parse two formats (whole-branch review finding).
    #[test]
    fn date_value_wire_is_rfc3339_and_round_trips() {
        let dt = datetime!(2025-04-01 13:05:09.5 +09:00);
        let s = serde_json::to_string(&Value::Date(dt)).expect("serialize");
        assert_eq!(s, "{\"Date\":\"2025-04-01T13:05:09.5+09:00\"}");
        let back: Value = serde_json::from_str(&s).expect("deserialize");
        assert_eq!(back, Value::Date(dt));
        // UTC form ends in Z, matching clock.now_utc exactly.
        let utc = serde_json::to_string(&Value::Date(datetime!(2025-04-01 0:00 UTC)))
            .expect("serialize utc");
        assert_eq!(utc, "{\"Date\":\"2025-04-01T00:00:00Z\"}");
    }
}
