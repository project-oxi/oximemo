//! Optional local Korean writing vectors derived from the pinned fastText source.

use anyhow::{Context, Result, ensure};
use flate2::read::GzDecoder;
use parking_lot::Mutex;
use reqwest::blocking::Client;
use reqwest::header::{ACCEPT_ENCODING, CONTENT_RANGE, RANGE};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, ErrorKind, Read, Seek, Write};
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{Manager, WebviewWindow};
use unicode_normalization::{UnicodeNormalization, is_nfc};

const SOURCE_URL: &str = "https://dl.fbaipublicfiles.com/fasttext/vectors-crawl/cc.ko.300.vec.gz";
const SOURCE_BYTES: usize = 1_267_506_825;
const DIMENSIONS: usize = 300;
const WORDS: [&str; 3] = [
    include_str!("../../public/ko-lexicon/words.txt"),
    include_str!("../../public/ko-lexicon/words-medium.txt"),
    include_str!("../../public/ko-lexicon/words-large.txt"),
];
const FILE_NAME: &str = "writing-lexicon-ko-v1.bin";
const PARTICLES: &[&str] = &[
    "으로부터",
    "에게서",
    "한테서",
    "께서는",
    "에서도",
    "이라고",
    "이라는",
    "으로",
    "에서",
    "에게",
    "한테",
    "까지",
    "부터",
    "처럼",
    "보다",
    "만큼",
    "이나",
    "라도",
    "하고",
    "은",
    "는",
    "이",
    "가",
    "을",
    "를",
    "의",
    "에",
    "와",
    "과",
    "도",
    "만",
    "로",
];

#[derive(
    Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Small,
    Medium,
    Large,
}

struct TierSpec {
    words: usize,
    scan_rows: usize,
    download_bytes: usize,
    source_sha: &'static str,
    rows_sha: &'static str,
}

impl Tier {
    const ALL: [Self; 3] = [Self::Small, Self::Medium, Self::Large];

    fn spec(self) -> &'static TierSpec {
        &[
            TierSpec {
                words: 20_056,
                scan_rows: 100_000,
                download_bytes: 100_000_000,
                source_sha: "d75849f2799035a6c8ac2cc03b57e44380ba2774555fc148c0067fee47995bef",
                rows_sha: "6a5f79ee917347a0629db6a2f0f875acdb46bea5e5f3d1e8eabc3fab35fa57c9",
            },
            TierSpec {
                words: 60_000,
                scan_rows: 200_000,
                download_bytes: 140_000_000,
                source_sha: "f59decda361ffe42fe68f22230d8c80817471dc9d2f38470688b501dfcd71e80",
                rows_sha: "88fc21d50254e978da1269f327c3d1e01d3d7c149934766085045d4bf4c048ba",
            },
            TierSpec {
                words: 200_000,
                scan_rows: 500_000,
                download_bytes: 335_000_000,
                source_sha: "95257449b4fa54f0108bbd9d4e6235511265f5269e994c6522b0a12992cf1e39",
                rows_sha: "f26c9519e1a7d64bb5c0e83112a112b6bb5ec03aef524266ade0dac06cadec9a",
            },
        ][self as usize]
    }

    fn row_bytes(self) -> usize {
        self.spec().words * DIMENSIONS
    }

    fn vocabulary(self) -> Vec<&'static str> {
        WORDS[..=self as usize]
            .iter()
            .flat_map(|words| words.lines())
            .collect()
    }
}

// The desktop app is single-instance. Downloads only take the mutation
// lock, so readers may keep querying the published tier until replacement.
struct Store {
    path: PathBuf,
    mutation: Mutex<()>,
    index: Mutex<Option<Arc<Lexicon>>>,
}

impl Store {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            mutation: Mutex::new(()),
            index: Mutex::new(None),
        }
    }

    fn open(&self) -> Result<Option<(Tier, File)>> {
        match fs::symlink_metadata(&self.path) {
            Ok(metadata) => ensure!(metadata.is_file(), "Invalid Korean dictionary file"),
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
        let file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let bytes = file.metadata()?.len();
        let tier = Tier::ALL
            .into_iter()
            .find(|tier| bytes == tier.row_bytes() as u64)
            .context("Invalid Korean dictionary length")?;
        Ok(Some((tier, file)))
    }

    fn installed(&self) -> Result<Option<Tier>> {
        let Some((tier, file)) = self.open()? else {
            return Ok(None);
        };
        let mut digest = Sha256::new();
        let bytes = io::copy(&mut file.take(tier.row_bytes() as u64 + 1), &mut digest)?;
        ensure!(
            bytes == tier.row_bytes() as u64
                && format!("{:x}", digest.finalize()) == tier.spec().rows_sha,
            "Korean dictionary rows failed integrity verification"
        );
        Ok(Some(tier))
    }

    fn install(&self, tier: Tier) -> Result<()> {
        self.install_with(tier, || quantize_rows(download_prefix(tier)?, tier))
    }

    fn install_with(&self, tier: Tier, download: impl FnOnce() -> Result<Vec<u8>>) -> Result<()> {
        let _mutation = self.mutation.lock();
        let current = self.installed().ok().flatten();
        if current == Some(tier) {
            return Ok(());
        }
        let rows = if current.is_some_and(|current| current > tier) {
            let mut prefix = Vec::with_capacity(tier.row_bytes());
            File::open(&self.path)?
                .take(tier.row_bytes() as u64)
                .read_to_end(&mut prefix)?;
            prefix
        } else {
            download()?
        };
        // Verify the exact destination tier even when taking a local prefix.
        validate_rows(tier, &rows)?;
        let parent = self.path.parent().context("Invalid dictionary location")?;
        fs::create_dir_all(parent)?;
        let mut staged = tempfile::NamedTempFile::new_in(parent)?;
        staged.write_all(&rows)?;
        staged.as_file().sync_all()?;
        let mut index = self.index.lock();
        staged.persist(&self.path)?;
        *index = None;
        Ok(())
    }

    fn remove(&self) -> Result<()> {
        let _mutation = self.mutation.lock();
        let mut index = self.index.lock();
        match fs::remove_file(&self.path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        *index = None;
        Ok(())
    }

    fn snapshot(&self) -> Result<Option<Arc<Lexicon>>> {
        let mut index = self.index.lock();
        if let Some(cached) = index.as_ref() {
            return Ok(Some(Arc::clone(cached)));
        }
        let Some((tier, file)) = self.open()? else {
            return Ok(None);
        };
        let mut rows = Vec::with_capacity(tier.row_bytes());
        file.take(tier.row_bytes() as u64 + 1)
            .read_to_end(&mut rows)?;
        validate_rows(tier, &rows)?;
        let lexicon = Arc::new(Lexicon::new(tier.vocabulary(), rows));
        *index = Some(Arc::clone(&lexicon));
        Ok(Some(lexicon))
    }
}

static STORE: OnceLock<Store> = OnceLock::new();

fn store(window: &WebviewWindow) -> Result<&'static Store, String> {
    if window.label() != "main" {
        return Err("Korean dictionary requires the main window".into());
    }
    let path = window
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join(FILE_NAME);
    Ok(STORE.get_or_init(|| Store::new(path)))
}

#[tauri::command]
pub async fn writing_lexicon_installed(window: WebviewWindow) -> Result<Option<Tier>, String> {
    let store = store(&window)?;
    tokio::task::spawn_blocking(move || store.installed().map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn install_writing_lexicon(window: WebviewWindow, tier: Tier) -> Result<(), String> {
    let store = store(&window)?;
    tokio::task::spawn_blocking(move || store.install(tier).map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn remove_writing_lexicon(window: WebviewWindow) -> Result<(), String> {
    let store = store(&window)?;
    tokio::task::spawn_blocking(move || store.remove().map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn lookup_writing_lexicon(
    window: WebviewWindow,
    word: String,
) -> Result<Option<RelatedWords>, String> {
    let store = store(&window)?;
    // Normal words are short. Reject oversized IPC inputs before indexing.
    if word.len() > 256 {
        return Ok(None);
    }
    tokio::task::spawn_blocking(move || {
        store
            .snapshot()
            .map(|index| index.and_then(|index| index.lookup(&word)))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn validate_rows(tier: Tier, bytes: &[u8]) -> Result<()> {
    ensure!(
        bytes.len() == tier.row_bytes()
            && format!("{:x}", Sha256::digest(bytes)) == tier.spec().rows_sha,
        "Korean dictionary rows failed integrity verification"
    );
    Ok(())
}

fn download_prefix(tier: Tier) -> Result<File> {
    let spec = tier.spec();
    let range_end = spec.download_bytes - 1;
    let expected_range = format!("bytes 0-{range_end}/{SOURCE_BYTES}");
    let client = Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(1800))
        .build()?;
    let mut response = client
        .get(SOURCE_URL)
        .header(RANGE, format!("bytes=0-{range_end}"))
        .header(ACCEPT_ENCODING, "identity")
        .send()?;
    ensure!(
        response.status() == reqwest::StatusCode::PARTIAL_CONTENT
            && response
                .headers()
                .get(CONTENT_RANGE)
                .is_some_and(|header| { header.as_bytes() == expected_range.as_bytes() })
            && response.content_length() == Some(spec.download_bytes as u64),
        "Unexpected fastText range response"
    );

    let mut compressed = tempfile::tempfile()?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut remaining = spec.download_bytes;
    while remaining > 0 {
        let limit = remaining.min(buffer.len());
        let count = response.read(&mut buffer[..limit])?;
        ensure!(count > 0, "Incomplete fastText range");
        compressed.write_all(&buffer[..count])?;
        digest.update(&buffer[..count]);
        remaining -= count;
    }
    ensure!(response.read(&mut [0])? == 0, "Oversized fastText range");
    ensure!(
        format!("{:x}", digest.finalize()) == spec.source_sha,
        "fastText source failed integrity verification"
    );
    compressed.rewind()?;
    Ok(compressed)
}

fn quantize_rows(source: impl Read, tier: Tier) -> Result<Vec<u8>> {
    let spec = tier.spec();
    let words: HashMap<_, _> = tier
        .vocabulary()
        .into_iter()
        .enumerate()
        .map(|(index, word)| (word, index))
        .collect();
    ensure!(
        words.len() == spec.words,
        "Invalid Korean dictionary vocabulary"
    );
    let mut reader = BufReader::new(GzDecoder::new(source));
    let mut header = String::new();
    reader.read_line(&mut header)?;
    ensure!(
        header.split_ascii_whitespace().eq(["2000000", "300"]),
        "Unexpected fastText dimensions"
    );
    let mut rows = vec![0; tier.row_bytes()];
    let mut found = vec![false; spec.words];
    let mut line = Vec::new();
    // The SHA-verified range intentionally ends before the gzip trailer.
    for _ in 0..spec.scan_rows {
        line.clear();
        ensure!(
            reader.read_until(b'\n', &mut line)? > 0 && line.ends_with(b"\n"),
            "Incomplete fastText rows"
        );
        let Some(separator) = line.iter().position(|byte| *byte == b' ') else {
            continue;
        };
        let word = String::from_utf8_lossy(&line[..separator]);
        let Some(&index) = words.get(word.as_ref()).or_else(|| {
            if is_nfc(&word) {
                None
            } else {
                words.get(word.nfc().collect::<String>().as_str())
            }
        }) else {
            continue;
        };
        if found[index] {
            continue;
        }

        let mut values = [0.0; DIMENSIONS];
        let mut columns = std::str::from_utf8(&line[separator + 1..])?.split_ascii_whitespace();
        for value in &mut values {
            *value = columns
                .next()
                .context("Incomplete fastText vector")?
                .parse::<f64>()?;
        }
        ensure!(
            columns.next().is_none() && values.iter().all(|value| value.is_finite()),
            "Invalid fastText vector"
        );
        let peak = values.iter().map(|value| value.abs()).fold(0.0, f64::max);
        ensure!(peak > 0.0, "Empty fastText vector");
        for (offset, value) in values.into_iter().enumerate() {
            rows[index * DIMENSIONS + offset] =
                (value / peak * 127.0).round_ties_even() as i8 as u8;
        }
        found[index] = true;
    }
    ensure!(
        found.into_iter().all(|row| row),
        "Incomplete Korean dictionary"
    );
    Ok(rows)
}

#[derive(Debug, serde::Serialize)]
pub struct RelatedWords {
    headword: &'static str,
    words: Vec<&'static str>,
}

struct Lexicon {
    words: Vec<&'static str>,
    rows: Vec<u8>,
    index: HashMap<&'static str, usize>,
    headwords: Vec<usize>,
    norms: Vec<f64>,
}

impl Lexicon {
    fn new(words: Vec<&'static str>, rows: Vec<u8>) -> Self {
        let index: HashMap<_, _> = words
            .iter()
            .copied()
            .enumerate()
            .map(|(row, word)| (word, row))
            .collect();
        let headwords = words
            .iter()
            .enumerate()
            .map(|(row, word)| Self::headword(&index, word).unwrap_or(row))
            .collect();
        let norms = rows
            .chunks_exact(DIMENSIONS)
            .map(|row| {
                f64::from(
                    row.iter()
                        .map(|value| i32::from(*value as i8).pow(2))
                        .sum::<i32>(),
                )
                .sqrt()
            })
            .collect();
        Self {
            words,
            rows,
            index,
            headwords,
            norms,
        }
    }

    fn headword(index: &HashMap<&str, usize>, query: &str) -> Option<usize> {
        let exact = index.get(query).copied();
        if let Some(bare) = PARTICLES
            .iter()
            .find_map(|suffix| query.strip_suffix(suffix))
            && let Some(&row) = index.get(bare)
            && (bare.chars().nth(1).is_some() || exact.is_none())
        {
            return Some(row);
        }
        exact
    }

    fn lookup(&self, input: &str) -> Option<RelatedWords> {
        const LIMIT: usize = 12;
        let normalized: String = input.nfc().collect();
        let query = normalized.trim_matches(|ch: char| !('가'..='힣').contains(&ch));
        let source = Self::headword(&self.index, query)?;
        let norm = self.norms[source];
        if norm == 0.0 {
            return None;
        }
        let source_row = &self.rows[source * DIMENSIONS..(source + 1) * DIMENSIONS];
        let mut top = Vec::<(usize, f64)>::with_capacity(LIMIT);
        for (row, vector) in self.rows.chunks_exact(DIMENSIONS).enumerate() {
            let word = self.headwords[row];
            let row_norm = self.norms[row];
            if word == source || row_norm == 0.0 {
                continue;
            }
            let dot = vector
                .iter()
                .zip(source_row)
                .map(|(&a, &b)| i32::from(a as i8) * i32::from(b as i8))
                .sum::<i32>();
            let score = f64::from(dot) / (norm * row_norm);
            if score < 0.25 || (top.len() == LIMIT && score <= top[LIMIT - 1].1) {
                continue;
            }
            if let Some(existing) = top.iter().position(|&(candidate, _)| candidate == word) {
                if score <= top[existing].1 {
                    continue;
                }
                top.remove(existing);
            }
            let at = top.partition_point(|&(_, existing_score)| existing_score >= score);
            if top.len() == LIMIT {
                top.pop();
            }
            top.insert(at, (word, score));
        }
        Some(RelatedWords {
            headword: self.words[source],
            words: top.into_iter().map(|(row, _)| self.words[row]).collect(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_normalizes_particles_and_deduplicates_headwords() {
        let words = vec!["고요", "침묵", "침묵의", "정적", "도로", "문장"];
        let mut rows = vec![0; words.len() * DIMENSIONS];
        for (index, values) in [[100, 0], [80, 10], [90, 0], [80, 40], [0, 100], [0, 100]]
            .into_iter()
            .enumerate()
        {
            rows[index * DIMENSIONS..index * DIMENSIONS + 2].copy_from_slice(&values);
        }
        let lexicon = Lexicon::new(words, rows);
        let result = lexicon.lookup("‘고요를’").unwrap();
        assert_eq!(result.headword, "고요");
        assert_eq!(result.words, ["침묵", "정적"]);
        assert_eq!(lexicon.lookup("문장을").unwrap().headword, "문장");
        assert!(lexicon.lookup("찾을수없는단어").is_none());
    }

    #[test]
    #[ignore = "downloads pinned fastText ranges"]
    fn live_install_switch_and_remove() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let store = Store::new(dir.path().join(FILE_NAME));

        // Pre-tier installations are raw Small rows at the same path.
        let small = quantize_rows(download_prefix(Tier::Small)?, Tier::Small)?;
        fs::write(&store.path, small)?;
        assert_eq!(store.installed()?, Some(Tier::Small));
        let old = store.snapshot()?.unwrap();
        assert!(old.lookup("고요").unwrap().words.contains(&"침묵"));
        assert!(old.lookup("바다").unwrap().words.contains(&"바닷가"));
        assert_eq!(old.lookup("문장을").unwrap().headword, "문장");

        assert!(
            store
                .install_with(Tier::Medium, || anyhow::bail!("interrupted download"))
                .is_err()
        );
        assert!(
            store
                .install_with(Tier::Medium, || Ok(vec![0; Tier::Medium.row_bytes()]))
                .is_err()
        );
        assert_eq!(store.installed()?, Some(Tier::Small));
        assert!(Arc::ptr_eq(&old, &store.snapshot()?.unwrap()));

        for tier in [Tier::Medium, Tier::Large] {
            store.install(tier)?;
            assert_eq!(store.installed()?, Some(tier));
            let snapshot = store.snapshot()?.unwrap();
            assert!(!Arc::ptr_eq(&old, &snapshot));
            assert_eq!(snapshot.words.len(), tier.spec().words);
            assert_eq!(snapshot.lookup("문장을").unwrap().headword, "문장");
        }
        for tier in [Tier::Medium, Tier::Small] {
            store.install_with(tier, || panic!("downgrades use verified installed rows"))?;
            assert_eq!(store.installed()?, Some(tier));
            assert_eq!(store.snapshot()?.unwrap().words.len(), tier.spec().words);
        }

        store.remove()?;
        store.remove()?;
        assert_eq!(store.installed()?, None);
        assert!(store.snapshot()?.is_none());
        assert!(old.lookup("고요").is_some());
        Ok(())
    }
}
