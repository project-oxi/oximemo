//! 변경 기록 (2026-11-11).
//!
//! 사람과 코딩 에이전트가 한 볼트를 같이 쓴다. 감시기가 정착시킨 볼트 변경을
//! 「어디서 왔는지」와 함께 남기고, git 자동 커밋을 근거로 비교 · 되돌리기를 준다.
//!
//! 출처는 관찰이지 인과가 아니다.
//! - `app` — 이 데스크톱 프로세스가 몇 초 안에 그 경로를 썼다 (`oximemo_core::self_writes`).
//! - `copilot` — 앱이 쓰지 않았고, 코파일럿 턴이 도는 중이거나 막 끝났다.
//!   턴 동안 다른 편집기로 사람이 고친 것도 여기 들어간다 — 막을 길이 없다.
//! - `external` — 그 밖. CLI 에이전트일 수도, 다른 편집기의 사람일 수도 있다.
//!
//! 구성: 위쪽은 Tauri · 파일을 모르는 순수 논리(단위 시험 대상),
//! 가운데는 볼트 · git 을 읽고 쓰는 관찰 · 되돌리기, 아래는 Tauri 명령.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

/// 파일에 남기는 최대 항목 수. 넘치면 가장 오래된 것부터 버린다.
pub const CAP: usize = 2000;
/// 자기 쓰기로 보는 창. 감시기 디바운스(기본 300 ms)에 느린 디스크 여유를 더했다.
pub const SELF_WRITE_WINDOW: Duration = Duration::from_secs(5);
/// 턴이 끝난 뒤에도 코파일럿 변경으로 보는 창. 프로세스가 끝나기 직전에 쓴
/// 파일은 감시기 디바운스가 지나서야 들어온다.
pub const TURN_GRACE: Duration = Duration::from_secs(2);
const DEFAULT_LIMIT: usize = 200;
const PROMPT_CHARS: usize = 80;
/// 저장을 이만큼 모아서 한 번에 쓴다. 저장 한 번에 JSON 전체를 다시 쓰므로
/// 변경 폭주(에이전트가 파일 수십 개를 고칠 때)마다 쓰면 디스크만 바쁘다.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(500);
/// git 정보가 없을 때 「새로 만든 파일」로 볼 생성 시각 창.
const BORN_RECENTLY: Duration = Duration::from_secs(60);

// --- 순수 논리 ---------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    App,
    Copilot,
    External,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Created,
    Modified,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnRef {
    pub id: String,
    pub prompt: String,
}

/// `api.ts` 의 `ChangeEntry` 와 한 글자도 다르지 않아야 한다.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChangeEntry {
    pub seq: u64,
    pub at: String,
    pub path: String,
    pub memo_id: Option<String>,
    pub title: Option<String>,
    pub kind: Kind,
    pub source: Source,
    pub turn: Option<TurnRef>,
    pub before_commit: Option<String>,
    pub seen: bool,
}

#[derive(Debug, Serialize)]
pub struct ChangeDiff {
    pub before: Option<String>,
    pub after: Option<String>,
    pub revertible: bool,
    pub reason: Option<&'static str>,
    pub later_changes: usize,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
pub struct ChangeListReq {
    pub limit: Option<usize>,
    pub include_app: Option<bool>,
    pub turn: Option<String>,
    pub before_seq: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct RevertTurnResult {
    pub reverted: usize,
    pub skipped: usize,
}

/// 도는 중이거나 막 끝난 코파일럿 턴.
#[derive(Debug, Clone)]
pub struct TurnWindow {
    pub turn: TurnRef,
    pub ended: Option<Instant>,
}

impl TurnWindow {
    fn covers(&self, now: Instant) -> bool {
        match self.ended {
            None => true,
            Some(end) => now.saturating_duration_since(end) <= TURN_GRACE,
        }
    }
}

/// 출처를 가린다. 자기 쓰기가 턴보다 먼저다 — 턴 중에도 사용자가 앱에서
/// 고친 것은 코파일럿 몫이 아니다.
pub fn classify(
    now: Instant,
    self_written_at: Option<Instant>,
    turns: &[TurnWindow],
) -> (Source, Option<TurnRef>) {
    if self_written_at.is_some_and(|at| now.saturating_duration_since(at) <= SELF_WRITE_WINDOW) {
        return (Source::App, None);
    }
    // 겹친 턴(대화 · 제안)이 있으면 가장 늦게 시작한 턴에 붙인다.
    if let Some(w) = turns.iter().rev().find(|w| w.covers(now)) {
        return (Source::Copilot, Some(w.turn.clone()));
    }
    (Source::External, None)
}

/// 변경 직전 상태를 git 이 어떻게 아는가.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prior {
    /// HEAD 에 그 파일이 있다.
    InGit,
    /// git 은 켜져 있는데 HEAD 에 없다.
    NotInGit,
    /// git 이 꺼져 있다 · 자동 커밋이 꺼져 있다 · 저장소가 비었다.
    Unknown,
}

/// 종류를 정한다. `None` 이면 기록하지 않는다 (만들자마자 지운 임시 파일 ·
/// 같은 삭제의 중복 알림).
pub fn decide_kind(
    exists_now: bool,
    prior: Prior,
    last: Option<Kind>,
    born_recently: bool,
) -> Option<Kind> {
    if exists_now {
        if prior == Prior::InGit {
            return Some(Kind::Modified);
        }
        // 커밋 전에 또 바뀐 경우(아래 경쟁) · git 이 꺼진 경우: 기록이 기억하는 상태를 믿는다.
        match last {
            Some(Kind::Deleted) => return Some(Kind::Created),
            Some(_) => return Some(Kind::Modified),
            None => {}
        }
        match prior {
            Prior::NotInGit => Some(Kind::Created),
            _ if born_recently => Some(Kind::Created),
            _ => Some(Kind::Modified),
        }
    } else {
        if prior == Prior::InGit {
            return Some(Kind::Deleted);
        }
        match last {
            Some(Kind::Deleted) => None,
            Some(_) => Some(Kind::Deleted),
            None if prior == Prior::NotInGit => None,
            None => Some(Kind::Deleted),
        }
    }
}

/// 기록할 볼트 경로인가. 색인이 노트로 보는 것(`.md` · `.html`)만 —
/// 휴지통 · 첨부 · 숨김 폴더 · 서식 파일은 노트 변경이 아니다.
/// 휴지통으로 옮긴 노트는 원래 경로의 사라짐으로 이미 `deleted` 가 된다.
pub fn is_journaled(rel: &str) -> bool {
    if !(rel.ends_with(".md") || rel.ends_with(".html")) {
        return false;
    }
    let mut parts = rel.split('/');
    let first = parts.next().unwrap_or_default();
    if first == oximemo_core::paths::PDC_TRASH_DIR || first == oximemo_core::paths::ASSETS_DIR {
        return false;
    }
    if rel.split('/').any(|p| p.starts_with('.')) {
        return false;
    }
    let name = rel.rsplit('/').next().unwrap_or_default();
    name != oximemo_core::paths::TEMPLATE_NAME && name != oximemo_core::paths::TEMPLATE_HTML_NAME
}

/// 사용자가 보낸 첫 줄 남짓. 기록 목록의 턴 표시용.
pub fn prompt_head(message: &str) -> String {
    let flat: String = message.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(PROMPT_CHARS).collect();
    if flat.chars().count() > PROMPT_CHARS {
        out.push('…');
    }
    out
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Journal {
    next_seq: u64,
    /// 오래된 것이 앞.
    entries: VecDeque<ChangeEntry>,
}

impl Journal {
    /// `seq` 를 매겨 넣고 그 번호를 돌려준다.
    pub fn push(&mut self, mut entry: ChangeEntry) -> u64 {
        self.next_seq += 1;
        entry.seq = self.next_seq;
        self.entries.push_back(entry);
        while self.entries.len() > CAP {
            self.entries.pop_front();
        }
        self.next_seq
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn get(&self, seq: u64) -> Option<&ChangeEntry> {
        // seq 는 단조 증가라 이분 탐색이 된다.
        self.entries
            .binary_search_by_key(&seq, |e| e.seq)
            .ok()
            .map(|i| &self.entries[i])
    }

    pub fn last_for_path(&self, path: &str) -> Option<&ChangeEntry> {
        self.entries.iter().rev().find(|e| e.path == path)
    }

    pub fn has_turn_entry(&self, turn_id: &str, path: &str) -> bool {
        self.entries
            .iter()
            .rev()
            .any(|e| e.path == path && e.turn.as_ref().is_some_and(|t| t.id == turn_id))
    }

    pub fn list(&self, req: &ChangeListReq) -> Vec<ChangeEntry> {
        let limit = req.limit.unwrap_or(DEFAULT_LIMIT).min(CAP);
        let include_app = req.include_app.unwrap_or(false);
        self.entries
            .iter()
            .rev()
            .filter(|e| include_app || e.source != Source::App)
            .filter(|e| match &req.turn {
                Some(id) => e.turn.as_ref().is_some_and(|t| &t.id == id),
                None => true,
            })
            .filter(|e| req.before_seq.is_none_or(|b| e.seq < b))
            .take(limit)
            .cloned()
            .collect()
    }

    /// 같은 경로의 더 새 항목 수 — 되돌리면 그것들도 사라진다.
    pub fn later_changes(&self, seq: u64) -> usize {
        let Some(path) = self.get(seq).map(|e| e.path.clone()) else {
            return 0;
        };
        self.entries
            .iter()
            .filter(|e| e.seq > seq && e.path == path)
            .count()
    }

    /// 바뀐 것이 있으면 true.
    pub fn mark_seen(&mut self, paths: &[String]) -> bool {
        let set: HashSet<&str> = paths.iter().map(String::as_str).collect();
        let mut changed = false;
        for e in self.entries.iter_mut() {
            if !e.seen && set.contains(e.path.as_str()) {
                e.seen = true;
                changed = true;
            }
        }
        changed
    }

    /// 경로마다 가장 새 앱 밖 항목 중 아직 안 본 것. 새것이 앞.
    pub fn unseen(&self) -> Vec<ChangeEntry> {
        let mut done: HashSet<&str> = HashSet::new();
        let mut out = Vec::new();
        for e in self.entries.iter().rev() {
            if e.source == Source::App || !done.insert(e.path.as_str()) {
                continue;
            }
            if !e.seen {
                out.push(e.clone());
            }
        }
        out
    }

    /// 턴 되돌리기 계획. 경로마다 그 턴의 **가장 오래된** 항목을 고른다 —
    /// 그 항목의 `before_commit` · 종류가 턴 직전 상태다. 순서는 경로의
    /// 마지막 변경이 새로운 것부터.
    pub fn turn_revert_plan(&self, turn_id: &str) -> Vec<ChangeEntry> {
        let mut oldest: HashMap<&str, &ChangeEntry> = HashMap::new();
        let mut newest: HashMap<&str, u64> = HashMap::new();
        for e in &self.entries {
            if !e.turn.as_ref().is_some_and(|t| t.id == turn_id) {
                continue;
            }
            oldest.entry(e.path.as_str()).or_insert(e);
            newest.insert(e.path.as_str(), e.seq);
        }
        let mut plan: Vec<(u64, ChangeEntry)> = oldest
            .into_iter()
            .map(|(p, e)| (newest[p], e.clone()))
            .collect();
        plan.sort_by(|a, b| b.0.cmp(&a.0));
        plan.into_iter().map(|(_, e)| e).collect()
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        let mut j: Journal = serde_json::from_slice(bytes)?;
        // 손으로 고친 파일이 순서를 흐트러뜨려도 `get` 의 이분 탐색이 맞도록.
        j.entries.make_contiguous().sort_by_key(|e| e.seq);
        j.next_seq = j.next_seq.max(j.entries.back().map_or(0, |e| e.seq));
        while j.entries.len() > CAP {
            j.entries.pop_front();
        }
        Ok(j)
    }
}

pub fn revertible(entry: &ChangeEntry) -> bool {
    entry.before_commit.is_some() || entry.kind == Kind::Created
}

// --- 상태 · 저장 -------------------------------------------------------------

/// 앱 수명 동안 하나. 감시기 스레드 · 명령 · 코파일럿 턴이 함께 쓴다.
pub struct ChangeLog {
    journal: Mutex<Journal>,
    turns: Mutex<Vec<TurnWindow>>,
    /// 턴 끝의 대조로 먼저 넣은 (턴, 경로). 늦게 온 감시기 알림이 같은
    /// 변경을 한 번 더 넣지 않게 한 번 걸러 낸다.
    reconciled: Mutex<HashSet<(String, String)>>,
    saver: Option<mpsc::Sender<()>>,
}

impl ChangeLog {
    /// `file` 에서 읽고, 저장은 별도 스레드가 모아서 한다. 깨진 파일은
    /// 경고만 남기고 빈 기록으로 시작한다 — 기록 때문에 앱이 안 뜨면 안 된다.
    pub fn open(file: PathBuf) -> Arc<Self> {
        let journal = match std::fs::read(&file) {
            Ok(bytes) => Journal::from_bytes(&bytes).unwrap_or_else(|e| {
                tracing::warn!(error = %e, file = %file.display(), "change journal is corrupt; starting empty");
                Journal::default()
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Journal::default(),
            Err(e) => {
                tracing::warn!(error = %e, file = %file.display(), "change journal unreadable; starting empty");
                Journal::default()
            }
        };
        let (tx, rx) = mpsc::channel::<()>();
        let log = Arc::new(Self {
            journal: Mutex::new(journal),
            turns: Mutex::new(Vec::new()),
            reconciled: Mutex::new(HashSet::new()),
            saver: Some(tx),
        });
        let weak = Arc::downgrade(&log);
        let _ = std::thread::Builder::new()
            .name("oximemo-change-journal".into())
            .spawn(move || {
                while rx.recv().is_ok() {
                    std::thread::sleep(SAVE_DEBOUNCE);
                    while rx.try_recv().is_ok() {}
                    let Some(log) = weak.upgrade() else { break };
                    let bytes = log.journal.lock().to_bytes();
                    drop(log);
                    if let Err(e) = write_atomic(&file, &bytes) {
                        tracing::warn!(error = %e, file = %file.display(), "change journal save failed");
                    }
                }
            });
        log
    }

    #[cfg(test)]
    fn in_memory() -> Self {
        Self {
            journal: Mutex::new(Journal::default()),
            turns: Mutex::new(Vec::new()),
            reconciled: Mutex::new(HashSet::new()),
            saver: None,
        }
    }

    fn touch(&self) {
        if let Some(tx) = &self.saver {
            let _ = tx.send(());
        }
    }

    fn push(&self, entry: ChangeEntry) -> u64 {
        let seq = self.journal.lock().push(entry);
        self.touch();
        seq
    }

    pub fn list(&self, req: &ChangeListReq) -> Vec<ChangeEntry> {
        self.journal.lock().list(req)
    }

    pub fn get(&self, seq: u64) -> Option<ChangeEntry> {
        self.journal.lock().get(seq).cloned()
    }

    pub fn mark_seen(&self, paths: &[String]) -> bool {
        let changed = self.journal.lock().mark_seen(paths);
        if changed {
            self.touch();
        }
        changed
    }

    pub fn unseen(&self) -> Vec<ChangeEntry> {
        self.journal.lock().unseen()
    }

    /// 코파일럿 턴을 연다. 돌려받은 값이 떨어지면(오류 경로 포함) 턴이 닫히고
    /// 유예 창이 시작된다.
    pub fn begin_turn(self: &Arc<Self>, prompt: &str) -> TurnScope {
        let now = Instant::now();
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let turn = TurnRef {
            id: format!("turn-{millis}"),
            prompt: prompt_head(prompt),
        };
        let mut turns = self.turns.lock();
        turns.retain(|w| w.covers(now));
        // 같은 밀리초에 두 턴이 열려도 id 가 겹치지 않게.
        let mut turn = turn;
        while turns.iter().any(|w| w.turn.id == turn.id) {
            turn.id.push('x');
        }
        turns.push(TurnWindow {
            turn: turn.clone(),
            ended: None,
        });
        TurnScope {
            log: self.clone(),
            turn,
        }
    }

    fn end_turn(&self, id: &str) {
        let now = Instant::now();
        for w in self.turns.lock().iter_mut() {
            if w.turn.id == id && w.ended.is_none() {
                w.ended = Some(now);
            }
        }
    }

    fn classify_now(&self, self_written_at: Option<Instant>) -> (Source, Option<TurnRef>) {
        classify(Instant::now(), self_written_at, &self.turns.lock())
    }
}

pub struct TurnScope {
    log: Arc<ChangeLog>,
    pub turn: TurnRef,
}

impl Drop for TurnScope {
    fn drop(&mut self) {
        self.log.end_turn(&self.turn.id);
    }
}

fn write_atomic(file: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = file.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, file)
}

/// 기록 파일 위치. 공간마다 따로인 색인 폴더(볼트 밖)에 둔다 — 볼트 안에
/// 두면 감시기 · git 자동 커밋이 기록 자신을 또 기록한다.
pub fn journal_file(vault: &oximemo_core::Vault) -> PathBuf {
    vault.paths().index_dir.join("change-journal.json")
}

// --- 관찰 · 되돌리기 (볼트 · git) --------------------------------------------

fn now_rfc3339() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// 자동 커밋이 실제로 도는가. 꺼져 있으면 HEAD 는 낡은 상태라 「직전 상태」가 아니다.
fn git_tracks(vault: &oximemo_core::Vault, git: &oxi_vault_git::GitLayer) -> bool {
    git.is_enabled() && vault.with_config(|c| c.git.auto_commit)
}

/// HEAD 에 담긴 그 파일. (커밋, 내용).
///
/// 감시기가 경로를 git 소비자에게 넘기기 **전에** 부르므로 HEAD 는 이번 변경
/// 직전 상태다. 알려진 경쟁: 소비자가 앞선 변경을 커밋하기 전(250 ms 모으기
/// 포함)에 같은 파일이 또 바뀌면 HEAD 는 두 변경 이전이다 — 비교에 두 변경이
/// 함께 보이고 되돌리면 둘 다 사라진다. 드물고, 잃는 것이 없어 받아들인다.
fn head_state(
    vault: &oximemo_core::Vault,
    git: &oxi_vault_git::GitLayer,
    rel: &str,
) -> (Prior, Option<(String, Vec<u8>)>) {
    if !git_tracks(vault, git) {
        return (Prior::Unknown, None);
    }
    let Some(head) = git.log(1).ok().and_then(|l| l.into_iter().next()) else {
        return (Prior::Unknown, None);
    };
    match git.file_at_commit(rel, &head.hash) {
        Ok(bytes) => (Prior::InGit, Some((head.hash, bytes))),
        Err(_) => (Prior::NotInGit, None),
    }
}

fn memo_ref(
    vault: &oximemo_core::Vault,
    abs: &Path,
    rel: &str,
) -> Option<(String, Option<String>)> {
    let store = oximemo_core::store::files::FileStore::new(vault.paths().clone());
    let memo = store.read_memo(abs).ok().flatten()?;
    let title = oximemo_core::memo::NoteDto::from_memo(&memo, rel).title;
    Some((memo.id.0.to_string(), title))
}

fn born_recently(abs: &Path) -> bool {
    std::fs::metadata(abs)
        .and_then(|m| m.created())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age <= BORN_RECENTLY)
}

/// 한 경로의 정착된 변경을 관찰해 항목으로 만든다. `forced` 는 턴 끝 대조가
/// 출처를 정해 줄 때.
fn observe(
    log: &ChangeLog,
    vault: &oximemo_core::Vault,
    git: &oxi_vault_git::GitLayer,
    abs: &Path,
    forced: Option<(Source, Option<TurnRef>)>,
) -> Option<ChangeEntry> {
    let rel = vault.paths().relative_path(abs)?;
    if !is_journaled(&rel) {
        return None;
    }
    let (source, turn) =
        forced.unwrap_or_else(|| log.classify_now(oximemo_core::self_writes::written_at(abs)));
    let exists_now = abs.is_file();
    let (prior, head) = head_state(vault, git, &rel);
    if exists_now
        && let Some((_, before)) = &head
        && std::fs::read(abs).is_ok_and(|now| &now == before)
    {
        // 내용이 그대로다 (저장만 다시 함 · 이미 커밋된 변경의 늦은 알림).
        return None;
    }
    let last = log.journal.lock().last_for_path(&rel).cloned();
    let kind = decide_kind(
        exists_now,
        prior,
        last.as_ref().map(|e| e.kind),
        exists_now && born_recently(abs),
    )?;
    let (memo_id, title) = if exists_now {
        match memo_ref(vault, abs, &rel) {
            Some((id, title)) => (Some(id), title),
            None => (None, None),
        }
    } else {
        // 지운 노트는 휴지통 사본 → 앞선 기록 순으로 찾는다. 둘 다 없으면 비운다.
        let trash =
            oximemo_core::store::files::FileStore::new(vault.paths().clone()).trash_path(&rel);
        match memo_ref(vault, &trash, &rel) {
            Some((id, title)) => (Some(id), title),
            None => match &last {
                Some(e) => (e.memo_id.clone(), e.title.clone()),
                None => (None, None),
            },
        }
    };
    Some(ChangeEntry {
        seq: 0,
        at: now_rfc3339(),
        path: rel,
        memo_id,
        title,
        kind,
        seen: source == Source::App,
        source,
        turn,
        before_commit: head.map(|(hash, _)| hash),
    })
}

/// 감시기 콜백에서 부른다 — 색인 갱신 · git 소비자 전송보다 **먼저**.
/// 항목을 넣었으면 true.
pub fn record_from_watcher(
    log: &ChangeLog,
    vault: &oximemo_core::Vault,
    git: &oxi_vault_git::GitLayer,
    abs: &Path,
) -> bool {
    let Some(entry) = observe(log, vault, git, abs, None) else {
        return false;
    };
    if let Some(turn) = &entry.turn
        && log
            .reconciled
            .lock()
            .remove(&(turn.id.clone(), entry.path.clone()))
    {
        return false;
    }
    log.push(entry);
    true
}

/// 턴 끝 대조: 매니페스트 비교가 잡았는데 감시기가 못 잡은 노트를 넣는다
/// (감시기 시작 실패 · 감시 범위 밖 경로 따위). 넣은 수를 돌려준다.
pub fn reconcile_turn<'a>(
    log: &ChangeLog,
    vault: &oximemo_core::Vault,
    git: &oxi_vault_git::GitLayer,
    turn: &TurnRef,
    changed_ids: impl IntoIterator<Item = &'a str>,
) -> usize {
    let mut added = 0;
    for id in changed_ids {
        let Ok(id) = oximemo_core::memo::MemoId::parse(id) else {
            continue;
        };
        // 영구 삭제된 노트는 경로를 알 길이 없다.
        let Ok(memo) = vault.get_memo(id) else {
            continue;
        };
        let Some(rel) = vault
            .note_file_path(&memo)
            .and_then(|p| vault.paths().relative_path(&p))
        else {
            continue;
        };
        let rel = strip_trash(&rel).to_string();
        if log.journal.lock().has_turn_entry(&turn.id, &rel) {
            continue;
        }
        let abs = vault.paths().vault.join(&rel);
        if let Some(entry) = observe(
            log,
            vault,
            git,
            &abs,
            Some((Source::Copilot, Some(turn.clone()))),
        ) {
            log.reconciled
                .lock()
                .insert((turn.id.clone(), entry.path.clone()));
            log.push(entry);
            added += 1;
        }
    }
    added
}

fn strip_trash(rel: &str) -> &str {
    for dir in [
        oximemo_core::paths::TRASH_DIR,
        oximemo_core::paths::PDC_TRASH_DIR,
    ] {
        if let Some(rest) = rel.strip_prefix(dir).and_then(|r| r.strip_prefix('/')) {
            return rest;
        }
    }
    rel
}

pub fn diff(
    log: &ChangeLog,
    vault: &oximemo_core::Vault,
    git: &oxi_vault_git::GitLayer,
    seq: u64,
) -> Result<ChangeDiff, String> {
    let (entry, later_changes) = {
        let j = log.journal.lock();
        let entry = j
            .get(seq)
            .cloned()
            .ok_or_else(|| format!("change {seq} not found"))?;
        (entry, j.later_changes(seq))
    };
    let before = entry.before_commit.as_deref().and_then(|hash| {
        git.file_at_commit(&entry.path, hash)
            .ok()
            .map(|b| String::from_utf8_lossy(&b).into_owned())
    });
    let abs = vault.paths().vault.join(&entry.path);
    let after = std::fs::read(&abs)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).into_owned());
    let ok = revertible(&entry);
    let reason = if ok {
        None
    } else if !git_tracks(vault, git) {
        Some("git_off")
    } else {
        Some("no_history")
    };
    Ok(ChangeDiff {
        before,
        after,
        revertible: ok,
        reason,
        later_changes,
    })
}

/// 한 항목을 되돌린다. 모든 쓰기는 자기 쓰기로 먼저 적는다 — 되돌리기가
/// 일으킨 감시기 알림이 `app` 으로 기록되도록.
pub fn revert_entry(
    vault: &oximemo_core::Vault,
    git: &oxi_vault_git::GitLayer,
    entry: &ChangeEntry,
) -> Result<(), String> {
    if !revertible(entry) {
        return Err(format!(
            "change {} cannot be reverted: the state before it is not in git history",
            entry.seq
        ));
    }
    let abs = vault.paths().vault.join(&entry.path);
    let store = oximemo_core::store::files::FileStore::new(vault.paths().clone());
    match entry.kind {
        Kind::Created => {
            if !abs.exists() {
                return Ok(());
            }
            // 보통의 삭제(휴지통)로 — 되돌리기도 되살릴 수 있어야 한다.
            match store.read_memo(&abs).ok().flatten() {
                Some(memo) => vault.delete_memo(memo.id).map_err(|e| e.to_string())?,
                None => {
                    store
                        .move_to_trash(&entry.path)
                        .map_err(|e| e.to_string())?;
                    vault.reindex_path(&abs);
                }
            }
        }
        Kind::Modified | Kind::Deleted => {
            let hash = entry.before_commit.as_deref().unwrap_or_default();
            // 휴지통으로 간 노트는 휴지통에서 되살린다. git 에서 다시 쓰면
            // 같은 id 의 사본이 휴지통에 남아 색인이 둘을 다툰다.
            if entry.kind == Kind::Deleted
                && !abs.exists()
                && let Some(id) = entry
                    .memo_id
                    .as_deref()
                    .and_then(|id| oximemo_core::memo::MemoId::parse(id).ok())
                && store.trash_path(&entry.path).exists()
            {
                vault.restore_memo(id).map_err(|e| e.to_string())?;
                return Ok(());
            }
            if !git.is_enabled() {
                return Err("git versioning is disabled for this vault".to_string());
            }
            if let Some(parent) = abs.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            oximemo_core::self_writes::mark(&abs);
            git.restore_file(&entry.path, hash)
                .map_err(|e| format!("restore failed: {e:#}"))?;
            vault.reindex_path(&abs);
        }
    }
    Ok(())
}

// --- Tauri 명령 --------------------------------------------------------------

pub mod commands {
    use tauri::{AppHandle, Emitter, State};

    use super::{ChangeDiff, ChangeEntry, ChangeListReq, RevertTurnResult};
    use crate::AppState;

    pub const RECORDED_EVENT: &str = "changes:recorded";

    #[tauri::command(async)]
    pub fn changes_list(
        state: State<'_, AppState>,
        req: Option<ChangeListReq>,
    ) -> Vec<ChangeEntry> {
        state.changes.list(&req.unwrap_or_default())
    }

    #[tauri::command(async)]
    pub fn changes_diff(state: State<'_, AppState>, seq: u64) -> Result<ChangeDiff, String> {
        super::diff(&state.changes, &state.vault, &state.git, seq)
    }

    #[tauri::command(async)]
    pub fn changes_revert(
        app: AppHandle,
        state: State<'_, AppState>,
        seq: u64,
    ) -> Result<(), String> {
        let entry = state
            .changes
            .get(seq)
            .ok_or_else(|| format!("change {seq} not found"))?;
        super::revert_entry(&state.vault, &state.git, &entry)?;
        let _ = app.emit("memos:changed", ());
        let _ = app.emit(RECORDED_EVENT, ());
        Ok(())
    }

    #[tauri::command(async)]
    pub fn changes_revert_turn(
        app: AppHandle,
        state: State<'_, AppState>,
        turn_id: String,
    ) -> Result<RevertTurnResult, String> {
        let plan = state.changes.journal.lock().turn_revert_plan(&turn_id);
        let mut out = RevertTurnResult {
            reverted: 0,
            skipped: 0,
        };
        for entry in &plan {
            match super::revert_entry(&state.vault, &state.git, entry) {
                Ok(()) => out.reverted += 1,
                Err(e) => {
                    tracing::warn!(error = %e, path = %entry.path, "turn revert skipped a change");
                    out.skipped += 1;
                }
            }
        }
        if out.reverted > 0 {
            let _ = app.emit("memos:changed", ());
        }
        let _ = app.emit(RECORDED_EVENT, ());
        Ok(out)
    }

    #[tauri::command(async)]
    pub fn changes_mark_seen(app: AppHandle, state: State<'_, AppState>, paths: Vec<String>) {
        if state.changes.mark_seen(&paths) {
            let _ = app.emit(RECORDED_EVENT, ());
        }
    }

    #[tauri::command(async)]
    pub fn changes_unseen(state: State<'_, AppState>) -> Vec<ChangeEntry> {
        state.changes.unseen()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(path: &str, kind: Kind, source: Source, turn: Option<&str>) -> ChangeEntry {
        ChangeEntry {
            seq: 0,
            at: "2026-11-11T00:00:00Z".into(),
            path: path.into(),
            memo_id: None,
            title: None,
            kind,
            source,
            turn: turn.map(|id| TurnRef {
                id: id.into(),
                prompt: "p".into(),
            }),
            before_commit: Some(format!("c-{path}-{kind:?}")),
            seen: source == Source::App,
        }
    }

    fn window(id: &str, ended: Option<Instant>) -> TurnWindow {
        TurnWindow {
            turn: TurnRef {
                id: id.into(),
                prompt: "p".into(),
            },
            ended,
        }
    }

    #[test]
    fn self_write_inside_window_is_app_even_during_turn() {
        let now = Instant::now();
        let turns = [window("t1", None)];
        let (s, t) = classify(now, Some(now - Duration::from_secs(2)), &turns);
        assert_eq!(s, Source::App);
        assert!(t.is_none());
    }

    #[test]
    fn stale_self_write_falls_through() {
        let now = Instant::now();
        let Some(old) = now.checked_sub(Duration::from_secs(6)) else {
            return;
        };
        assert_eq!(classify(now, Some(old), &[]).0, Source::External);
    }

    #[test]
    fn running_turn_and_grace_are_copilot() {
        let now = Instant::now();
        let (s, t) = classify(now, None, &[window("t1", None)]);
        assert_eq!(s, Source::Copilot);
        assert_eq!(t.unwrap().id, "t1");
        let ended = now - Duration::from_secs(1);
        assert_eq!(
            classify(now, None, &[window("t2", Some(ended))]).0,
            Source::Copilot
        );
    }

    #[test]
    fn after_grace_is_external() {
        let now = Instant::now();
        let Some(ended) = now.checked_sub(Duration::from_secs(3)) else {
            return;
        };
        let (s, t) = classify(now, None, &[window("t1", Some(ended))]);
        assert_eq!(s, Source::External);
        assert!(t.is_none());
    }

    #[test]
    fn latest_overlapping_turn_wins() {
        let now = Instant::now();
        let turns = [window("old", None), window("new", None)];
        assert_eq!(classify(now, None, &turns).1.unwrap().id, "new");
    }

    #[test]
    fn kind_decisions() {
        assert_eq!(
            decide_kind(true, Prior::InGit, None, false),
            Some(Kind::Modified)
        );
        assert_eq!(
            decide_kind(true, Prior::NotInGit, None, false),
            Some(Kind::Created)
        );
        assert_eq!(
            decide_kind(true, Prior::NotInGit, Some(Kind::Created), false),
            Some(Kind::Modified)
        );
        assert_eq!(
            decide_kind(true, Prior::Unknown, Some(Kind::Deleted), false),
            Some(Kind::Created)
        );
        assert_eq!(
            decide_kind(true, Prior::Unknown, None, true),
            Some(Kind::Created)
        );
        assert_eq!(
            decide_kind(true, Prior::Unknown, None, false),
            Some(Kind::Modified)
        );
        assert_eq!(
            decide_kind(false, Prior::InGit, None, false),
            Some(Kind::Deleted)
        );
        assert_eq!(decide_kind(false, Prior::NotInGit, None, false), None);
        assert_eq!(
            decide_kind(false, Prior::NotInGit, Some(Kind::Created), false),
            Some(Kind::Deleted)
        );
        assert_eq!(
            decide_kind(false, Prior::Unknown, Some(Kind::Deleted), false),
            None
        );
    }

    #[test]
    fn journaled_paths() {
        assert!(is_journaled("a/b.md"));
        assert!(is_journaled("page.html"));
        assert!(!is_journaled("_trash/a.md"));
        assert!(!is_journaled(".trash/a.md"));
        assert!(!is_journaled("a/.hidden/b.md"));
        assert!(!is_journaled("_assets/x.md"));
        assert!(!is_journaled("a/TEMPLATE.md"));
        assert!(!is_journaled("views/x.query"));
        assert!(!is_journaled("oximemo.toml"));
    }

    #[test]
    fn revert_turn_uses_oldest_entry_per_path_newest_path_first() {
        let mut j = Journal::default();
        j.push(entry("a.md", Kind::Created, Source::Copilot, Some("t1")));
        j.push(entry("b.md", Kind::Modified, Source::Copilot, Some("t1")));
        j.push(entry("a.md", Kind::Modified, Source::Copilot, Some("t1")));
        j.push(entry("c.md", Kind::Modified, Source::Copilot, Some("t2")));
        j.push(entry("b.md", Kind::Deleted, Source::Copilot, Some("t1")));
        let plan = j.turn_revert_plan("t1");
        let got: Vec<(&str, Kind, u64)> = plan
            .iter()
            .map(|e| (e.path.as_str(), e.kind, e.seq))
            .collect();
        // b 의 마지막 변경(5)이 a 의 마지막 변경(3)보다 새롭다. 각 경로는 가장 오래된 항목.
        assert_eq!(
            got,
            vec![("b.md", Kind::Modified, 2), ("a.md", Kind::Created, 1)]
        );
    }

    #[test]
    fn cap_drops_oldest() {
        let mut j = Journal::default();
        for i in 0..(CAP + 5) {
            j.push(entry(
                &format!("n{i}.md"),
                Kind::Modified,
                Source::External,
                None,
            ));
        }
        assert_eq!(j.len(), CAP);
        assert!(j.get(5).is_none());
        assert!(j.get(6).is_some());
        assert_eq!(
            j.get((CAP + 5) as u64).unwrap().path,
            format!("n{}.md", CAP + 4)
        );
    }

    #[test]
    fn unseen_is_latest_non_app_per_path() {
        let mut j = Journal::default();
        j.push(entry("a.md", Kind::Modified, Source::External, None)); // 1
        j.push(entry("a.md", Kind::Modified, Source::Copilot, Some("t"))); // 2
        j.push(entry("a.md", Kind::Modified, Source::App, None)); // 3 앱 — 건너뜀
        j.push(entry("b.md", Kind::Created, Source::External, None)); // 4
        j.push(entry("c.md", Kind::Created, Source::App, None)); // 5
        let seqs: Vec<u64> = j.unseen().iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![4, 2]);
        assert!(j.mark_seen(&["a.md".into()]));
        let seqs: Vec<u64> = j.unseen().iter().map(|e| e.seq).collect();
        assert_eq!(seqs, vec![4]);
        assert!(!j.mark_seen(&["a.md".into()]));
    }

    #[test]
    fn list_filters_and_pages() {
        let mut j = Journal::default();
        j.push(entry("a.md", Kind::Modified, Source::App, None));
        j.push(entry("b.md", Kind::Modified, Source::Copilot, Some("t1")));
        j.push(entry("c.md", Kind::Modified, Source::External, None));
        let seqs = |v: Vec<ChangeEntry>| v.iter().map(|e| e.seq).collect::<Vec<_>>();
        assert_eq!(seqs(j.list(&ChangeListReq::default())), vec![3, 2]);
        let all = ChangeListReq {
            include_app: Some(true),
            ..Default::default()
        };
        assert_eq!(seqs(j.list(&all)), vec![3, 2, 1]);
        let turn = ChangeListReq {
            turn: Some("t1".into()),
            ..Default::default()
        };
        assert_eq!(seqs(j.list(&turn)), vec![2]);
        let page = ChangeListReq {
            include_app: Some(true),
            before_seq: Some(3),
            limit: Some(1),
            ..Default::default()
        };
        assert_eq!(seqs(j.list(&page)), vec![2]);
        assert_eq!(j.later_changes(1), 0);
    }

    #[test]
    fn persistence_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("sub").join("change-journal.json");
        let mut j = Journal::default();
        j.push(entry("a.md", Kind::Created, Source::Copilot, Some("t1")));
        j.push(entry("b.md", Kind::Deleted, Source::External, None));
        write_atomic(&file, &j.to_bytes()).unwrap();
        let back = Journal::from_bytes(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(back, j);
        // 번호는 이어진다.
        let mut back = back;
        assert_eq!(
            back.push(entry("c.md", Kind::Modified, Source::App, None)),
            3
        );
    }

    #[test]
    fn corrupt_file_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("change-journal.json");
        std::fs::write(&file, b"{not json").unwrap();
        let log = ChangeLog::open(file);
        assert!(log.list(&ChangeListReq::default()).is_empty());
    }

    #[test]
    fn open_saves_in_background() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("change-journal.json");
        let log = ChangeLog::open(file.clone());
        log.push(entry("a.md", Kind::Created, Source::External, None));
        let deadline = Instant::now() + Duration::from_secs(5);
        while !file.exists() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        drop(log);
        let back = Journal::from_bytes(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(back.len(), 1);
    }

    #[test]
    fn turn_scope_closes_turn_on_drop() {
        let log = Arc::new(ChangeLog::in_memory());
        let scope = log.begin_turn("첫 줄\n둘째 줄");
        assert_eq!(scope.turn.prompt, "첫 줄 둘째 줄");
        assert_eq!(log.classify_now(None).0, Source::Copilot);
        let id = scope.turn.id.clone();
        drop(scope);
        let turns = log.turns.lock();
        assert!(turns.iter().any(|w| w.turn.id == id && w.ended.is_some()));
    }

    #[test]
    fn prompt_is_capped() {
        let long = "가".repeat(100);
        let head = prompt_head(&long);
        assert_eq!(head.chars().count(), PROMPT_CHARS + 1);
    }
}
