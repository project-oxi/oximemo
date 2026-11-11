//! 이 프로세스가 최근에 쓴 볼트 경로 (2026-11-11, 변경 기록).
//!
//! 감시기는 「누가」 파일을 바꿨는지 모른다. 데스크톱 앱이 같은 볼트를 쓰는
//! CLI · 코딩 에이전트와 자기 쓰기를 가려내려면, 쓰기 직전에 경로를 여기
//! 적어 두고 감시기가 정착한 경로를 받을 때 「몇 초 안에 내가 썼는가」를
//! 물어야 한다.
//!
//! 프로세스 전역인 까닭: 실제 쓰기는 `Vault` 를 모르는 자유 함수
//! (`memo_pdc` · `pdc_documents` · `FileStore`)에서 일어난다. 함수마다
//! 등록부를 넘기면 모든 서명이 바뀐다. 「이 프로세스」가 기준이라 CLI 는
//! 같은 코어를 써도 자기 프로세스의 등록부에만 적힌다 — 앱 쪽에서는 자연히
//! 바깥 변경으로 보인다.
//!
//! 비용: 쓰기 한 번에 잠금 한 번 + 해시 삽입 한 번. 동작은 바꾸지 않는다
//! (기록만 하고, 실패할 일이 없다).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

/// 이 수를 넘으면 오래된 항목을 걷어 낸다. 감시기가 묻는 창은 몇 초이므로
/// 1분이 지난 항목은 쓸모가 없다.
const PRUNE_ABOVE: usize = 512;
const KEEP_FOR: Duration = Duration::from_secs(60);

fn registry() -> &'static Mutex<HashMap<PathBuf, Instant>> {
    static RECENT: OnceLock<Mutex<HashMap<PathBuf, Instant>>> = OnceLock::new();
    RECENT.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 경로 표기를 맞춘다. 코어는 `vault.join("a/b.md")` 처럼 `/` 를 섞어 쓰고
/// 감시기는 운영체제 구분자로 준다 — 구성 요소로 다시 잇지 않으면 같은
/// 파일이 다른 열쇠가 된다. Windows 는 대소문자를 가리지 않으므로 소문자로.
fn key(path: &Path) -> PathBuf {
    let joined: PathBuf = path.components().collect();
    #[cfg(windows)]
    {
        let s = joined.to_string_lossy();
        let s = s.strip_prefix(r"\?\").unwrap_or(&s);
        PathBuf::from(s.to_lowercase())
    }
    #[cfg(not(windows))]
    {
        joined
    }
}

/// 이 프로세스가 `path` 를 쓰기(만들기 · 고치기 · 지우기 · 옮기기) 직전에 부른다.
pub fn mark(path: &Path) {
    let now = Instant::now();
    let mut map = registry().lock();
    if map.len() > PRUNE_ABOVE {
        map.retain(|_, at| now.duration_since(*at) < KEEP_FOR);
    }
    map.insert(key(path), now);
}

/// 이 프로세스가 `path` 를 마지막으로 쓴 시각.
pub fn written_at(path: &Path) -> Option<Instant> {
    registry().lock().get(&key(path)).copied()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_separators_share_one_key() {
        let a = Path::new("vault").join("folder/note.md");
        let b = Path::new("vault").join("folder").join("note.md");
        mark(&a);
        assert!(written_at(&b).is_some());
    }
}
