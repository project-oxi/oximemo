# Daily Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One note per day (`{daily.folder}/{YYYY-MM-DD}.md`), created on demand through the existing per-folder template mechanism, with a persistent sidebar mini-calendar (dots on days with notes, click = open-or-create) and a Today smart-collection button.

**Architecture:** `Vault::open_daily(date)` is the authoritative, idempotent create-or-open (adopts existing files at the canonical path; creation applies the folder template with a caller-supplied local date, then normalizes the H1 to the ISO date so the filename is deterministic). The frontend adds a `Calendar` component fed by a folder-scoped memo listing; dots derive from note paths. Daily notes are ordinary notes — no special index.

**Tech Stack:** Rust (oximemo-core, Tauri v2 commands), React + TanStack Query + Zustand, lucide-react icons. Browser fallback (localStorage) is a first-class verification surface.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-21-daily-notes-design.md` — every task traces to a §.
- New i18n keys go into `ko.ts` AND `en.ts` in the same commit (§5).
- No `window.confirm` (Tauri WKWebView no-op).
- Gates: `CARGO_TARGET_DIR=/Volumes/MERCURY/PROJECTS/oximemo/target cargo test --workspace` + `cargo fmt --all -- --check` + `cd apps/desktop && bun run build`.
- English Conventional Commits (`feat:`, `test:`, `docs:`).
- Existing code conventions: `CoreError::other(...)` for string errors; commands return `Result<NoteDto, String>` and emit `memos:changed`; browser fallback mirrors IPC semantics in `tauri.ts` `browserInvoke` switch.
- Frontend E2E runs headless against `bun run dev` (:5173) via the browser device; localStorage seed keys `oximemo:memos:v3` / `oximemo:folders:v1`. Fresh browser locale is **English** — assert English strings.

---

### Task 1: `[daily]` config section (core + TS type)

**Files:**
- Modify: `crates/oximemo-core/src/config.rs` (add `DailyConfig` after `BrainConfig` block ~line 61; `VaultConfig` field; `Default` impl ~line 37; `config_json` ~line 215)
- Modify: `apps/desktop/src/lib/types.ts:129-133` (Config interface)
- Test: `crates/oximemo-core/src/config.rs` `mod tests`

**Interfaces:**
- Produces: `crate::config::DailyConfig { enabled: bool, folder: String }` (Default: `true`, `"daily"`); `VaultConfig.daily: DailyConfig`; `config_json()` output gains `"daily": {enabled, folder}` — later tasks read it via `with_config(|c| c.daily.folder.clone())` (Rust) and `configQ.data?.daily` (TS).

- [ ] **Step 1: Write the failing test** — in `config.rs` `mod tests`, after `brain_section_defaults_and_roundtrip`:

```rust
    #[test]
    fn daily_section_defaults_and_overrides() {
        let c = VaultConfig::default();
        assert!(c.daily.enabled);
        assert_eq!(c.daily.folder, "daily");

        // Round-trips through TOML.
        let s = c.to_toml().unwrap();
        let back: VaultConfig = toml::from_str(&s).unwrap();
        assert_eq!(back.daily.folder, "daily");

        // Explicit override wins.
        let t = r#"
[daily]
enabled = false
folder = "journal"
"#;
        let c2: VaultConfig = toml::from_str(t).unwrap();
        assert!(!c2.daily.enabled);
        assert_eq!(c2.daily.folder, "journal");

        // Exposed via config_json for the frontend.
        let json = c.config_json();
        assert_eq!(json["daily"]["enabled"], serde_json::json!(true));
        assert_eq!(json["daily"]["folder"], serde_json::json!("daily"));
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CARGO_TARGET_DIR=/Volumes/MERCURY/PROJECTS/oximemo/target cargo test -p oximemo-core daily_section -- --nocapture`
Expected: FAIL — no field `daily` on `VaultConfig`.

- [ ] **Step 3: Implement** — in `config.rs`:

After the `BrainConfig` `Default` impl (~line 61), add:

```rust
/// Daily notes (spec 2026-08-21 §1). `folder` is vault-relative; the
/// folder is auto-created by the first note's write.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct DailyConfig {
    pub enabled: bool,
    pub folder: String,
}

impl Default for DailyConfig {
    fn default() -> Self {
        Self { enabled: true, folder: "daily".into() }
    }
}
```

`VaultConfig` struct: add field after `brain`:

```rust
    /// Daily notes section (spec 2026-08-21 §1).
    pub daily: DailyConfig,
```

`Default for VaultConfig`: add `daily: DailyConfig::default(),`.

`config_json()`: add `"daily": self.daily,` after the `"brain"` line.

In `apps/desktop/src/lib/types.ts`, `Config` interface (~line 129, next to `brain?`):

```ts
  daily?: { enabled?: boolean; folder?: string };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CARGO_TARGET_DIR=/Volumes/MERCURY/PROJECTS/oximemo/target cargo test -p oximemo-core daily_section`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/oximemo-core/src/config.rs apps/desktop/src/lib/types.ts
git commit -m "feat(core): [daily] config section with enabled/folder defaults"
```

---

### Task 2: `TemplateCtx::for_date` + ISO date parsing

**Files:**
- Modify: `crates/oximemo-core/src/template.rs` (impl block after `now`, ~line 46; helper near top; tests in existing `mod tests`)
- Test: `crates/oximemo-core/src/template.rs`

**Interfaces:**
- Produces: `pub fn parse_iso_date(s: &str) -> Option<time::Date>` (strict `YYYY-MM-DD`, calendar-validated) and `pub fn TemplateCtx::for_date(date: &str, folder: &str, counter: u32) -> TemplateCtx` — consumed by Task 3.

- [ ] **Step 1: Write the failing test** — in `template.rs` `mod tests`:

```rust
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `CARGO_TARGET_DIR=/Volumes/MERCURY/PROJECTS/oximemo/target cargo test -p oximemo-core for_date -- --nocapture`
Expected: FAIL — `for_date` / `parse_iso_date` not defined.

- [ ] **Step 3: Implement** — in `template.rs`, free function above `TemplateCtx`:

```rust
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
```

Inside `impl TemplateCtx`, after `now`:

```rust
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `CARGO_TARGET_DIR=/Volumes/MERCURY/PROJECTS/oximemo/target cargo test -p oximemo-core for_date parse_iso`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/oximemo-core/src/template.rs
git commit -m "feat(core): TemplateCtx::for_date with strict ISO date parsing"
```

---

### Task 3: `Vault::open_daily` — idempotent create-or-open

**Files:**
- Modify: `crates/oximemo-core/src/vault.rs` (new method after `create_note_auto`, ~line 658; tests in `mod tests`)
- Test: `crates/oximemo-core/src/vault.rs`

**Interfaces:**
- Consumes: `DailyConfig` (Task 1), `parse_iso_date` + `TemplateCtx::for_date` (Task 2), existing `create_note`, `get_memo`, `with_redb`, `idx.export_since(None)`, `idx.get(id)`, `record.path`, `record.deleted`.
- Produces: `pub fn open_daily(&self, date: &str) -> Result<Memo>` — consumed by Task 4's command.

- [ ] **Step 1: Write the failing tests** — in `vault.rs` `mod tests` (near `create_note_auto_follows_folder_template`):

```rust
    #[test]
    fn open_daily_creates_then_is_idempotent() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        let m1 = v.open_daily("2026-08-21").unwrap();
        assert_eq!(m1.body.lines().next(), Some("# 2026-08-21"));
        let rec = v.with_redb(|i| i.get(m1.id)).unwrap().unwrap();
        assert_eq!(rec.path, "daily/2026-08-21.md");
        // Re-open returns the SAME note, never a duplicate.
        let m2 = v.open_daily("2026-08-21").unwrap();
        assert_eq!(m1.id, m2.id);
    }

    #[test]
    fn open_daily_applies_template_with_caller_date() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("daily").unwrap();
        std::fs::write(
            v.paths().vault.join("daily/TEMPLATE.md"),
            "# {{date}} {{weekday}}\n\n- ",
        )
        .unwrap();
        let m = v.open_daily("2026-08-21").unwrap();
        assert_eq!(m.body.lines().next(), Some("# 2026-08-21 금"));
    }

    #[test]
    fn open_daily_normalizes_nonmatching_template_h1() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("daily").unwrap();
        // Template H1 is NOT the date — the note must still land at the
        // canonical path (deterministic filename, spec §2).
        std::fs::write(v.paths().vault.join("daily/TEMPLATE.md"), "# 일지\n\n내용").unwrap();
        let m = v.open_daily("2026-08-21").unwrap();
    }
    #[test]
    fn open_daily_respects_configured_folder() {
        // tmp_vault opens with default config; write the toml BEFORE
        // opening so Vault::open loads the override.
        let dir = tempfile::TempDir::new().unwrap();
        std::fs::write(
            dir.path().join("oximemo.toml"),
            "[daily]\nfolder = \"journal\"\n",
        )
        .unwrap();
        let v = Vault::open(Some(dir.path())).unwrap();
        v.ensure_initialized().unwrap();
        let m = v.open_daily("2026-08-21").unwrap();
        let rec = v.with_redb(|i| i.get(m.id)).unwrap().unwrap();
        assert_eq!(rec.path, "journal/2026-08-21.md");
        let _ = dir; // keep alive
    }

    #[test]
    fn open_daily_rejects_invalid_dates() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        assert!(v.open_daily("21-08-2026").is_err());
        assert!(v.open_daily("2026-13-01").is_err());
        assert!(v.open_daily("").is_err());
    }

    #[test]
    fn open_daily_adopts_existing_file() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        let manual = v
            .create_note("daily", "# 2026-08-21\n수동으로 만든 파일".into(), crate::memo::NoteFormat::Markdown)
            .unwrap();
        let m = v.open_daily("2026-08-21").unwrap();
        assert_eq!(m.id, manual.id, "must adopt, not duplicate");
    }

    #[test]
    fn open_daily_html_template_folder() {
        let (_t, v) = tmp_vault();
        v.ensure_initialized().unwrap();
        v.create_folder("daily").unwrap();
        std::fs::write(v.paths().vault.join("daily/TEMPLATE.html"), "<h1>일지</h1>").unwrap();
        let m = v.open_daily("2026-08-21").unwrap();
        let rec = v.with_redb(|i| i.get(m.id)).unwrap().unwrap();
        assert_eq!(rec.path, "daily/2026-08-21.html");
        assert!(m.body.contains("<h1>2026-08-21</h1>"));
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `CARGO_TARGET_DIR=/Volumes/MERCURY/PROJECTS/oximemo/target cargo test -p oximemo-core open_daily`
Expected: FAIL — no method `open_daily`.

- [ ] **Step 3: Implement** — in `vault.rs` after `create_note_auto`:

```rust
    /// Open (or create) the daily note for `date` (`YYYY-MM-DD`),
    /// daily-notes spec 2026-08-21 §2. Idempotent: an existing note at
    /// `{daily.folder}/{date}.md|html` is returned as-is, so manual
    /// files with matching names are adopted. Creation applies the
    /// folder template with the caller's local date, then normalizes
    /// the H1 to the date so the filename is deterministic.
    pub fn open_daily(&self, date: &str) -> Result<Memo> {
        if crate::template::parse_iso_date(date).is_none() {
            return Err(CoreError::other("invalid date, expected YYYY-MM-DD"));
        }
        let folder = self.with_config(|c| c.daily.folder.clone());
        let md_path = format!("{folder}/{date}.md");
        let html_path = format!("{folder}/{date}.html");
        let hit = self.with_redb(|idx| {
            Ok(idx
                .export_since(None)?
                .into_iter()
                .find(|r| !r.deleted && (r.path == md_path || r.path == html_path)))
        })?;
        if let Some(rec) = hit {
            return self.get_memo(rec.id);
        }
        // Format follows the folder's templates (create_note_auto rule).
        let md_t = crate::template::load_template(&self.paths, &folder, crate::memo::NoteFormat::Markdown);
        let html_t = crate::template::load_template(&self.paths, &folder, crate::memo::NoteFormat::Html);
        let fmt = if html_t.is_some() && md_t.is_none() {
            crate::memo::NoteFormat::Html
        } else {
            crate::memo::NoteFormat::Markdown
        };
        let body = match md_t.or(html_t) {
            Some(tmpl) => {
                let counter = crate::template::count_notes(&self.paths, &folder) + 1;
                let ctx = crate::template::TemplateCtx::for_date(date, &folder, counter);
                let applied = crate::template::apply_template(&tmpl, &ctx);
                normalize_daily_h1(fmt, &applied, date)
            }
            None => format!("# {date}\n"),
        };
        self.create_note(&folder, body, fmt)
    }
```

Free function near the bottom of `vault.rs` (above `mod tests`):

```rust
/// Force the daily note's derived title to the ISO date so
/// `write_note` derives the canonical filename (spec §2). Templates
/// whose H1 is something else (`# 일지`) keep their body underneath.
fn normalize_daily_h1(fmt: crate::memo::NoteFormat, body: &str, date: &str) -> String {
    if crate::memo::note_title(fmt, body).as_deref() == Some(date) {
        return body.to_string();
    }
    match fmt {
        crate::memo::NoteFormat::Markdown => format!("# {date}\n\n{body}"),
        crate::memo::NoteFormat::Html => format!("<h1>{date}</h1>\n{body}"),
    }
}
```

Implementation notes:
- `create_note` skips its own template pass because the body is non-blank (H1 present).
- If the private `paths` field is not accessible from tests, add nothing — use whatever accessor exists (`v.paths()`); check `pub fn paths(&self)` near the top of `impl Vault` (used by CLI code as `vault.paths()` in `commands.rs`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `CARGO_TARGET_DIR=/Volumes/MERCURY/PROJECTS/oximemo/target cargo test -p oximemo-core open_daily`
Expected: 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/oximemo-core/src/vault.rs
git commit -m "feat(core): Vault::open_daily — idempotent daily-note create-or-open"
```

---

### Task 4: Tauri command `open_daily_note`

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (command after `create_memo` ~line 581; register in `generate_handler!`)

**Interfaces:**
- Consumes: `Vault::open_daily` (Task 3).
- Produces: IPC `open_daily_note(date: string) -> NoteDto` (camelCase arg binding is automatic; emits `memos:changed`) — consumed by Task 5.

- [ ] **Step 1: Add the command** (after `create_memo`):

```rust
    #[tauri::command]
    pub fn open_daily_note(
        state: State<'_, AppState>,
        app: AppHandle,
        date: String,
    ) -> Result<oximemo_core::memo::NoteDto, String> {
        let memo = state.vault.open_daily(&date).map_err(|e| e.to_string())?;
        let _ = app.emit("memos:changed", ());
        Ok(state.vault.note_dto(&memo))
    }
```

- [ ] **Step 2: Register** — add `open_daily_note,` to the `generate_handler![...]` list next to `create_memo,` (find the macro invocation with `commands::create_memo`).

- [ ] **Step 3: Build to verify**

Run: `CARGO_TARGET_DIR=/Volumes/MERCURY/PROJECTS/oximemo/target cargo build -p oximemo`
Expected: compiles clean (thin wrapper; semantics covered by Task 3 tests).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(desktop): open_daily_note Tauri command"
```

---

### Task 5: Frontend API + browser fallback

**Files:**
- Modify: `apps/desktop/src/lib/api.ts` (export after `createMemo` ~line 66)
- Modify: `apps/desktop/src/lib/tauri.ts` (`browserInvoke` switch case near `create_memo` ~line 261)

**Interfaces:**
- Consumes: IPC `open_daily_note` (Task 4); fallback store helpers `loadStore`/`saveStore`/`emitBrowser`/`fakeHash`, type `Memo`, `deriveTitle`, `extractTags` (existing in tauri.ts).
- Produces: `openDailyNote(date: string): Promise<Memo>` — consumed by Task 7.

- [ ] **Step 1: api.ts export** (after `createMemo`):

```ts
/** Open (create if missing) the daily note for an ISO date (YYYY-MM-DD). */
export async function openDailyNote(date: string) {
  return invoke<Memo>("open_daily_note", { date });
}
```

Add `openDailyNote` to the doc comment's command list at the top if one is maintained. Ensure `Memo` is already imported in api.ts (it is, line 17).

- [ ] **Step 2: tauri.ts fallback case** (in `browserInvoke` switch, after `create_memo`):

```ts
    case "open_daily_note": {
      const date = args?.date as string;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date).getTime())) {
        throw new Error("invalid date, expected YYYY-MM-DD");
      }
      // Browser fallback: default daily folder, no file template access.
      const folder = "daily";
      const store = loadStore();
      const hit = Object.values(store).find(
        (n) =>
          !n.deleted_at &&
          (n.path === `${folder}/${date}.md` || n.path === `${folder}/${date}.html`),
      );
      if (hit) return hit;
      const now = new Date().toISOString();
      const memo: Memo = {
        id: crypto.randomUUID(),
        created_at: now,
        updated_at: now,
        hash: fakeHash(),
        favorite: false,
        folder,
        path: `${folder}/${date}.md`,
        format: "markdown",
        title: date,
        tags: [],
        body: `# ${date}\n`,
        deleted_at: null,
      };
      store[memo.id] = memo;
      saveStore(store);
      emitBrowser("memos:changed");
      return memo;
    }
```

Match the surrounding code's exact helpers — if the store value type is `Memo` directly this compiles as-is; otherwise adapt names to neighbors in the same switch.

- [ ] **Step 3: Typecheck via build**

Run: `cd apps/desktop && bun run build`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/lib/api.ts apps/desktop/src/lib/tauri.ts
git commit -m "feat(desktop): openDailyNote API with browser fallback"
```

---

### Task 6: Date utils + `Calendar` component

**Files:**
- Create: `apps/desktop/src/lib/dates.ts`
- Create: `apps/desktop/src/components/Calendar.tsx`
- Test: manual render check in Task 7's E2E (pure presentational component; logic lives in `dates.ts` — unit-verify via E2E assertions on data attributes)

**Interfaces:**
- Produces (`dates.ts`): `todayLocalISO(): string`; `addMonths(y: number, m: number, delta: number): { year: number; month: number }` (m is 1–12, wraps); `monthGrid(y: number, m: number): { date: string; day: number; inMonth: boolean }[]` (Sunday-first, covers the month, exactly the weeks needed); `weekdayLabels(locale: string): string[]` (Intl short, rotated Sunday-first); `monthTitle(y: number, m: number, locale: string): string` (e.g. "2026년 8월" / "August 2026").
- Produces (`Calendar.tsx`): `export function Calendar({ dates, today, locale, onSelect }: { dates: Set<string>; today: string; locale: string; onSelect: (date: string) => void })` — internal viewed-month state (defaults to `today`'s month); DOM hooks for E2E: container `data-daily-calendar`, month title `data-daily-title`, nav `data-daily-prev`/`data-daily-next`, day buttons `data-daily-day="<ISO>"`, dot `<i data-daily-dot>`.

- [ ] **Step 1: Write `dates.ts`**

```ts
/**
 * Local-time date math for the daily-notes calendar (spec 2026-08-21 §3).
 * Never uses UTC — "today" must match the user's wall clock.
 */

/** Local ISO date (YYYY-MM-DD) for now. */
export function todayLocalISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Month arithmetic on {year, month(1-12)}, wrapping across years. */
export function addMonths(y: number, m: number, delta: number): { year: number; month: number } {
  const zero = y * 12 + (m - 1) + delta;
  return { year: Math.floor(zero / 12), month: (zero % 12) + 1 };
}

/** Sunday-first grid of days covering month `m`, exactly the weeks
 * needed (4–6 rows). Out-of-month cells carry inMonth: false. */
export function monthGrid(y: number, m: number): { date: string; day: number; inMonth: boolean }[] {
  const first = new Date(y, m - 1, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay()); // back to Sunday
  const daysInMonth = new Date(y, m, 0).getDate();
  const cells = Math.ceil((first.getDay() + daysInMonth) / 7) * 7;
  const out: { date: string; day: number; inMonth: boolean }[] = [];
  for (let i = 0; i < cells; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push({
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      day: d.getDate(),
      inMonth: d.getMonth() === m - 1,
    });
  }
  return out;
}

/** Short weekday labels starting Sunday, via Intl. */
export function weekdayLabels(locale: string): string[] {
  // 2023-01-01 is a Sunday.
  const fmt = new Intl.DateTimeFormat(locale, { weekday: "short" });
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + i)));
}

/** Month title like "2026년 8월" (ko) / "August 2026" (en). */
export function monthTitle(y: number, m: number, locale: string): string {
  const fmt = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" });
  return fmt.format(new Date(y, m - 1, 1));
}
```

- [ ] **Step 2: Write `Calendar.tsx`** — match the sidebar's existing visual grammar (`text-[10px]` section labels, `rounded-md`, tokens like `bg-surface-muted`, `text-text-muted`, `text-text-subtle`, primary fill `bg-interactive-primary text-interactive-primary-foreground`):

```tsx
/**
 * Mini month calendar for daily notes (spec 2026-08-21 §3): dots on
 * days that have a note, today highlighted, click = open-or-create.
 * Pure presentational + local viewed-month state; data comes in via
 * the `dates` set.
 */
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { addMonths, monthGrid, monthTitle, weekdayLabels } from "../lib/dates";

export function Calendar({
  dates,
  today,
  locale,
  onSelect,
}: {
  /** ISO dates that have a daily note. */
  dates: Set<string>;
  /** Today's ISO date (local). */
  today: string;
  locale: string;
  onSelect: (date: string) => void;
}) {
  const t = new Date();
  const [viewed, setViewed] = useState({ year: t.getFullYear(), month: t.getMonth() + 1 });
  const cells = monthGrid(viewed.year, viewed.month);
  const todayMonth = { year: t.getFullYear(), month: t.getMonth() + 1 };
  const atToday =
    viewed.year === todayMonth.year && viewed.month === todayMonth.month;

  return (
    <div data-daily-calendar className="px-1 pb-1 pt-0.5 select-none">
      <div className="flex items-center justify-between px-1 pb-1">
        <span data-daily-title className="text-[11px] font-semibold text-text">
          {monthTitle(viewed.year, viewed.month, locale)}
        </span>
        <span className="flex items-center gap-0.5">
          <button
            type="button"
            data-daily-prev
            aria-label="previous month"
            onClick={() => setViewed(addMonths(viewed.year, viewed.month, -1))}
            className="grid size-5 place-items-center rounded-[var(--button-radius)] text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text"
          >
            <ChevronLeft size={12} />
          </button>
          <button
            type="button"
            data-daily-next
            aria-label="next month"
            onClick={() => setViewed(addMonths(viewed.year, viewed.month, 1))}
            className="grid size-5 place-items-center rounded-[var(--button-radius)] text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text"
          >
            <ChevronRight size={12} />
          </button>
        </span>
      </div>
      <div className="grid grid-cols-7">
        {weekdayLabels(locale).map((w) => (
          <span key={w} className="pb-0.5 text-center text-[9px] text-text-subtle">
            {w}
          </span>
        ))}
        {cells.map((c) => {
          const isToday = c.date === today;
          const has = dates.has(c.date);
          return (
            <button
              key={c.date}
              type="button"
              data-daily-day={c.date}
              onClick={() => onSelect(c.date)}
              className={`relative mx-auto grid size-[22px] place-items-center rounded-[var(--button-radius)] text-[11px] transition-colors duration-150 ${
                isToday
                  ? "bg-interactive-primary font-semibold text-interactive-primary-foreground"
                  : c.inMonth
                    ? "text-text-muted hover:bg-surface-muted hover:text-text"
                    : "text-text-subtle/50 hover:bg-surface-muted"
              }`}
            >
              {c.day}
              {has && (
                <i
                  data-daily-dot
                  aria-hidden
                  className={`absolute bottom-[1px] left-1/2 size-[3px] -translate-x-1/2 rounded-full ${
                    isToday ? "bg-interactive-primary-foreground" : "bg-text-subtle"
                  }`}
                />
              )}
            </button>
          );
        })}
      </div>
      {!atToday && (
        <button
          type="button"
          onClick={() => setViewed(todayMonth)}
          className="mt-1 w-full rounded-[var(--button-radius)] px-1 py-0.5 text-[10px] text-text-subtle transition-colors duration-150 hover:bg-surface-muted hover:text-text"
        >
          ← Today
        </button>
      )}
    </div>
  );
}
```

("← Today" is locale-neutral; `atToday` guards it from appearing on the default view.)

- [ ] **Step 3: Build**

Run: `cd apps/desktop && bun run build`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/lib/dates.ts apps/desktop/src/components/Calendar.tsx
git commit -m "feat(desktop): local-date utils and mini month calendar component"
```

---

### Task 7: Sidebar integration + i18n

**Files:**
- Modify: `apps/desktop/src/components/Sidebar.tsx` (Today button in FAVORITES after Gallery ~line 126; DAILY section between FAVORITES pins and RECENTS ~line 140; `openDaily` handler near `openFolder`)
- Modify: `apps/desktop/src/lib/locales/ko.ts` (near `recents_section`, line ~94)
- Modify: `apps/desktop/src/lib/locales/en.ts` (matching line)

**Interfaces:**
- Consumes: `Calendar` (Task 6), `openDailyNote` (Task 5), `todayLocalISO` (Task 6), config `daily` section (Task 1), `useUI` (`select`, `setView`, `setError`), `listMemos(null, 500, { folder })`.
- Produces: complete user-facing feature.

- [ ] **Step 1: i18n keys** — `ko.ts` after `recents_section`:

```ts
  today_note: "오늘의 노트",
  daily_section: "데일리",
```

`en.ts` after `recents_section`:

```ts
  today_note: "Today's Note",
  daily_section: "Daily",
```

- [ ] **Step 2: Sidebar wiring**

Imports (add to existing import lines):

```ts
import { CalendarDays } from "lucide-react";   // merge into the lucide import
import { openDailyNote, listMemos } from "../lib/api";  // merge into api import; listMemos may be new here
import { todayLocalISO } from "../lib/dates";
import { Calendar } from "./Calendar";
```

Inside `Sidebar` (component body), after the `pins` const:

```ts
  const dailyCfg = configQ.data?.daily;
  const dailyEnabled = dailyCfg?.enabled !== false; // absent = default true
  const dailyFolder = dailyCfg?.folder || "daily";
  const locale = useI18n((s) => s.locale); // i18n.tsx exposes {locale, setLocale, t} via useI18n(); a selector works — or destructure `const { t, locale } = useI18n()` in the existing call at the top
  const dailyQ = useQuery({
    queryKey: ["memos", "daily", dailyFolder],
    queryFn: () => listMemos(null, 500, { folder: dailyFolder }),
    enabled: dailyEnabled,
  });
  const dailyDates = new Set(
    (dailyQ.data?.items ?? [])
      .filter((n) => n.path.startsWith(`${dailyFolder}/`))
      .map((n) => n.path.match(/(\d{4}-\d{2}-\d{2})\.(md|html)$/)?.[1])
      .filter((d): d is string => Boolean(d)),
  );

  const openDaily = (date: string) => {
    openDailyNote(date)
      .then((n) => {
        setView("memos");
        select(n.id);
      })
      .catch((e) => setError(String(e).split("\n")[0]));
  };
```

JSX — Today button inside FAVORITES, after the Gallery button (same button grammar as Gallery):

```tsx
      {dailyEnabled && (
        <button
          type="button"
          onClick={() => openDaily(todayLocalISO())}
          className="mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-text-muted hover:bg-surface-muted"
        >
          <CalendarDays size={14} /> {t.today_note}
        </button>
      )}
```

DAILY section between the `pins.map` block and the RECENTS block:

```tsx
      {dailyEnabled && (
        <>
          <div className="mt-3 flex items-center px-3">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-text-subtle">
              {t.daily_section}
            </span>
          </div>
          <div className="px-2 pt-1">
            <Calendar dates={dailyDates} today={todayLocalISO()} locale={locale} onSelect={openDaily} />
          </div>
        </>
      )}
```

Check before writing: how `useI18n` exposes the locale (grep `useI18n` usage in `i18n.tsx` — existing components read locale for Intl; reuse that exact accessor). If no locale accessor exists, add one to the i18n context.

- [ ] **Step 3: Build**

Run: `cd apps/desktop && bun run build`
Expected: green.

- [ ] **Step 4: Browser E2E (fallback surface)**

Start dev server (hub, name `findernav-dev`, `bun run dev` in `apps/desktop`, ready log `Local:.*http`), then headless browser against `:5173`:

1. Seed `oximemo:memos:v3` with two memos: one at `daily/2026-08-19.md` (path `"daily/2026-08-19.md"`, title `"2026-08-19"`), one elsewhere; `oximemo:folders:v1` `["daily"]`; reload.
2. Assert: `[data-daily-calendar]` exists; `[data-daily-title]` shows current month (English locale, e.g. `/August 2026/`); exactly one `[data-daily-dot]`, on `[data-daily-day="2026-08-19"]`; today's cell has the primary background (class assert `bg-interactive-primary`).
3. Click `[data-daily-day="<today>"]` → assert a `[role="dialog"]` opened; localStorage store now contains path `daily/<today>.md` with body `# <today>`.
4. Click another empty day (e.g. `<today> + 2 days`, navigate via `[data-daily-next]` if needed) → new note created; click the dotted day `2026-08-19` → opens, and the store still has exactly ONE memo with that path (no duplicate).
5. Click the Today button (aria/text "Today's Note") → today's note opens.
6. `enabled = false` case: seed `oximemo:memos:v3` normally, set config override — the fallback reads no config, so verify gating in the real shell path only via code review + unit assertion that `dailyEnabled` derives from `configQ.data?.daily?.enabled !== false`. Browser: skip (fallback has no config surface). Instead assert the default (visible) which step 2 covers.

Record results; fix and re-run on failure.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/Sidebar.tsx apps/desktop/src/components/Calendar.tsx apps/desktop/src/lib/locales/ko.ts apps/desktop/src/lib/locales/en.ts
git commit -m "feat(desktop): sidebar daily section — Today button and mini calendar"
```

---

### Task 8: Full gates + docs

**Files:**
- Modify: `README.md` (daily notes paragraph near the template/`TEMPLATE.md` docs, ~line 169)
- Modify: `CHANGELOG.md` (Unreleased entry)

- [ ] **Step 1: Gates**

Run:
```bash
CARGO_TARGET_DIR=/Volumes/MERCURY/PROJECTS/oximemo/target cargo test --workspace
CARGO_TARGET_DIR=/Volumes/MERCURY/PROJECTS/oximemo/target cargo fmt --all -- --check
cd apps/desktop && bun run build
```
Expected: all tests pass (149 + new), fmt clean, build green.

- [ ] **Step 2: README paragraph** (after the template/HTML paragraph ~line 169):

```markdown
### Daily notes

A persistent sidebar calendar (DAILY section) opens — or creates — one note per day in the `[daily]` folder (`oximemo.toml`: `enabled`, `folder`, default `daily`). Notes are titled by ISO date (`2026-08-21.md`), so they are ordinary notes: searchable, taggable, movable. A `TEMPLATE.md` in the daily folder seeds new entries (`{{date}}`, `{{weekday}}`, … are filled with the *local* date); if the template's heading isn't the date, the date heading is prepended so filenames stay deterministic. Days with a note show a dot; past and future days can be created (backfilling and planning). Set `enabled = false` to hide the sidebar section and Today button.
```

- [ ] **Step 3: CHANGELOG entry** — add to Unreleased:

```markdown
- **Daily notes** — sidebar DAILY section: mini month calendar (dots on
  days with notes, click = open-or-create, past/future backfill) plus a
  "Today's Note" smart-collection button. Notes live in `[daily].folder`
  (default `daily`) titled by ISO date; the folder's `TEMPLATE.md` seeds
  new entries with local-date variables. `Vault::open_daily` is the
  idempotent create-or-open; `[daily] enabled = false` hides the UI.
```

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: daily notes in README and CHANGELOG"
```

---

## Self-Review (done at plan time)

- **Spec coverage:** §1 config+data model → T1, T3 (folder auto-create via existing `write_note`); §2 backend → T2, T3, T4; §3 sidebar → T6, T7 (+i18n §5 in T7); §4 fallback → T5; §6 tests → T1–T3 Rust, T7 E2E; launch auto-open/weekly/word-count explicitly out of scope. ✓
- **Type consistency:** `open_daily(&str) -> Result<Memo>` (T3) ↔ command (T4) ↔ `openDailyNote(date): Promise<Memo>` (T5) ↔ `onSelect(date: string)` (T6) ↔ `openDaily` (T7). `dates: Set<string>` consistent T6↔T7. `data-daily-*` hooks identical in T6 code and T7 assertions.
- **Placeholders:** none — every code step carries verbatim code; formerly-uncertain helpers were pinned at plan time (`v.paths()` accessor, `Vault::open` + pre-written toml for config override, `useI18n()` → `{locale, setLocale, t}`).
