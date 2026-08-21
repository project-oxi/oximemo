//! Per-folder template loading and variable substitution (§5).
//!
//! A folder containing `TEMPLATE.md` (or `TEMPLATE.html`) applies that
//! template to new notes created in it. Variables like `{{date}}`,
//! `{{weekday}}`, `{{counter}}` are replaced at creation time. The template
//! files themselves are excluded from note listings.

use crate::paths::Paths;

/// Variables available in templates.
#[derive(Debug, Clone)]
pub struct TemplateCtx {
    pub date: String,
    pub weekday: String,
    pub time: String,
    pub year: String,
    pub month: String,
    pub day: String,
    pub counter: u32,
    pub folder: String,
}

/// Parse a strict `YYYY-MM-DD` string into a calendar date. Returns
/// `None` for wrong shapes or impossible dates (2026-13-01, 2026-02-30).
pub fn parse_iso_date(s: &str) -> Option<time::Date> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    for (i, c) in b.iter().enumerate() {
        if i != 4 && i != 7 && !c.is_ascii_digit() {
            return None;
        }
    }
    let year: i32 = s.get(0..4)?.parse().ok()?;
    let month: u8 = s.get(5..7)?.parse().ok()?;
    let day: u8 = s.get(8..10)?.parse().ok()?;
    time::Date::from_calendar_date(year, time::Month::try_from(month).ok()?, day).ok()
}

impl TemplateCtx {
    /// Build a context from the current time and folder info.
    pub fn now(folder: &str, counter: u32) -> Self {
        use time::OffsetDateTime;
        let now = OffsetDateTime::now_utc();
        let weekdays = ["월", "화", "수", "목", "금", "토", "일"];
        let weekday = weekdays[(now.weekday().number_from_monday() - 1) as usize];
        Self {
            date: format!(
                "{:04}-{:02}-{:02}",
                now.year(),
                now.month() as u8,
                now.day()
            ),
            weekday: weekday.to_string(),
            time: format!("{:02}:{:02}", now.hour(), now.minute()),
            year: now.year().to_string(),
            month: format!("{:02}", now.month() as u8),
            day: format!("{:02}", now.day()),
            counter,
            folder: folder.to_string(),
        }
    }

    /// Build a context for an explicit ISO date (daily notes spec §2).
    /// The caller supplies the *local* date — `now()` uses UTC, which
    /// is off by one day for KST evenings — and the weekday is derived
    /// from the date itself.
    pub fn for_date(date: &str, folder: &str, counter: u32) -> Self {
        let d = parse_iso_date(date).unwrap_or_else(|| time::Date::MIN);
        let weekdays = ["월", "화", "수", "목", "금", "토", "일"];
        let weekday = weekdays[(d.weekday().number_from_monday() - 1) as usize].to_string();
        Self {
            date: date.to_string(),
            weekday,
            time: String::new(),
            year: d.year().to_string(),
            month: format!("{:02}", d.month() as u8),
            day: format!("{:02}", d.day()),
            counter,
            folder: folder.to_string(),
        }
    }
}

/// Read a folder's template for the given format (`TEMPLATE.md` or
/// `TEMPLATE.html`; root template for `folder == ""`). Returns `None` if no
/// template exists. Frontmatter blocks (plain or comment-wrapped) are
/// stripped.
pub fn load_template(paths: &Paths, folder: &str, fmt: crate::memo::NoteFormat) -> Option<String> {
    let name = match fmt {
        crate::memo::NoteFormat::Markdown => crate::paths::TEMPLATE_NAME,
        crate::memo::NoteFormat::Html => crate::paths::TEMPLATE_HTML_NAME,
    };
    let path = if folder.is_empty() {
        paths.vault.join(name)
    } else {
        paths.vault.join(folder).join(name)
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            // Strip frontmatter if present (templates may carry blocks).
            let body = match fmt {
                crate::memo::NoteFormat::Markdown => strip_frontmatter(&text),
                crate::memo::NoteFormat::Html => match crate::html::split_frontmatter(&text) {
                    crate::html::HtmlFrontmatterSplit::Some { body, .. } => body.to_string(),
                    crate::html::HtmlFrontmatterSplit::None { body } => body.to_string(),
                },
            };
            if body.trim().is_empty() {
                None
            } else {
                Some(body)
            }
        }
        Err(_) => None,
    }
}

/// Replace all `{{variable}}` tokens in the template with values from ctx.
pub fn apply_template(template: &str, ctx: &TemplateCtx) -> String {
    template
        .replace("{{date}}", &ctx.date)
        .replace("{{weekday}}", &ctx.weekday)
        .replace("{{time}}", &ctx.time)
        .replace("{{year}}", &ctx.year)
        .replace("{{month}}", &ctx.month)
        .replace("{{day}}", &ctx.day)
        .replace("{{counter}}", &ctx.counter.to_string())
        .replace("{{folder}}", &ctx.folder)
}

/// Count non-template note files (`.md` + `.html`) in a folder (for
/// `{{counter}}`).
pub fn count_notes(paths: &Paths, folder: &str) -> u32 {
    let dir = if folder.is_empty() {
        paths.vault.clone()
    } else {
        paths.vault.join(folder)
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let mut count = 0u32;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_note = name.ends_with(".md") || name.ends_with(".html");
        if is_note
            && name != crate::paths::TEMPLATE_NAME
            && name != crate::paths::TEMPLATE_HTML_NAME
            && name != crate::paths::CONFIG_NAME
            && name != crate::paths::LEGACY_CONFIG_NAME
        {
            count += 1;
        }
    }
    count
}

/// Strip `+++...+++` frontmatter from template text, keeping only the body.
fn strip_frontmatter(text: &str) -> String {
    let first_line = text.lines().next().unwrap_or("").trim_end_matches('\r');
    if first_line != "+++" {
        return text.to_string();
    }
    let after_first = text.find('\n').map(|i| &text[i + 1..]).unwrap_or("");
    if let Some(end) = after_first.find("\n+++") {
        let body_start = end + 4; // skip "\n+++"
        let body = &after_first[body_start..];
        // Drop leading blank line.
        body.trim_start_matches('\n').to_string()
    } else {
        text.to_string()
    }
}

/// Check whether a body is "empty" (untitled + no real content) and thus
/// should get a template applied. Title derivation is format-aware.
pub fn is_blank_body(fmt: crate::memo::NoteFormat, body: &str) -> bool {
    body.trim().is_empty()
        || crate::memo::note_title(fmt, body).is_none() && body.lines().count() <= 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_replaces_all_vars() {
        let ctx = TemplateCtx {
            date: "2026-08-13".into(),
            weekday: "수".into(),
            time: "14:30".into(),
            year: "2026".into(),
            month: "08".into(),
            day: "13".into(),
            counter: 4,
            folder: "diary".into(),
        };
        let result = apply_template(
            "# {{date}} {{weekday}}\n\nChapter {{counter}} in {{folder}}",
            &ctx,
        );
        assert_eq!(result, "# 2026-08-13 수\n\nChapter 4 in diary");
    }

    #[test]
    fn unknown_vars_preserved() {
        let ctx = TemplateCtx::now("", 1);
        let result = apply_template("Hello {{name}}", &ctx);
        assert_eq!(result, "Hello {{name}}");
    }

    #[test]
    fn strip_frontmatter_from_template() {
        let with_fm = "+++\ncustom = true\n+++\n\n# {{date}}";
        assert_eq!(strip_frontmatter(with_fm), "# {{date}}");
    }

    #[test]
    fn no_frontmatter_preserved() {
        let plain = "# {{date}} {{weekday}}";
        assert_eq!(strip_frontmatter(plain), "# {{date}} {{weekday}}");
    }

    #[test]
    fn parse_iso_date_strict() {
        assert!(parse_iso_date("2026-08-21").is_some());
        assert!(parse_iso_date("2026-13-01").is_none()); // month
        assert!(parse_iso_date("2026-00-10").is_none());
        assert!(parse_iso_date("2026-02-30").is_none()); // day
        assert!(parse_iso_date("21-08-2026").is_none());
        assert!(parse_iso_date("2026-8-21").is_none()); // zero-padded only
        assert!(parse_iso_date("").is_none());
    }

    #[test]
    fn for_date_uses_caller_date_and_derives_weekday() {
        // 2026-08-21 is a Friday.
        let ctx = TemplateCtx::for_date("2026-08-21", "daily", 3);
        assert_eq!(ctx.date, "2026-08-21");
        assert_eq!(ctx.weekday, "금");
        assert_eq!(ctx.year, "2026");
        assert_eq!(ctx.month, "08");
        assert_eq!(ctx.day, "21");
        assert_eq!(ctx.counter, 3);
        assert_eq!(ctx.folder, "daily");
        // Weekday rotation: 2026-08-23 is a Sunday.
        assert_eq!(TemplateCtx::for_date("2026-08-23", "", 1).weekday, "일");
    }
}
