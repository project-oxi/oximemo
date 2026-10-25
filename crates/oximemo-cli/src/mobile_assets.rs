//! Read-only attachment transport. Paths are resolved relative to a known note.
use anyhow::{Result, bail};
use oximemo_core::{Paths, pdc_documents};
use oximemo_sync::Attachment;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Read,
    path::{Component, Path},
};

pub fn read(paths: &Paths, note: &str, reference: &str) -> Result<Attachment> {
    pdc_documents::read_document(paths, note)?;
    let mut expected = None;
    let relative = if let Some(digest) = reference.strip_prefix("pdc://asset/sha256/") {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            bail!("invalid asset digest");
        }
        expected = Some(digest);
        format!(".pdc/assets/sha256/{}/{digest}", &digest[..2])
    } else {
        if reference.contains([':', '\\', '?', '#', '%']) || reference.starts_with('/') {
            bail!("unsupported attachment reference");
        }
        let parent = Path::new(note).parent().unwrap_or(Path::new(""));
        parent.join(reference).to_string_lossy().into_owned()
    };
    let mut parts = Vec::new();
    for part in Path::new(&relative).components() {
        match part {
            Component::Normal(p) => parts.push(p),
            Component::CurDir => (),
            Component::ParentDir => {
                if parts.pop().is_none() {
                    bail!("attachment escapes vault");
                }
            }
            _ => bail!("absolute attachment path"),
        }
    }
    let root = fs::canonicalize(&paths.vault)?;
    let mut path = root.clone();
    for part in parts {
        path.push(part);
        if fs::symlink_metadata(&path)?.file_type().is_symlink() {
            bail!("attachment symlinks are not served");
        }
    }
    if !path.starts_with(&root) || !path.is_file() {
        bail!("attachment unavailable");
    }
    // Private vault state and document sources have their own transport APIs.
    let rel = path.strip_prefix(&root)?;
    if expected.is_none()
        && rel
            .components()
            .any(|p| p.as_os_str().to_string_lossy().starts_with('.'))
    {
        bail!("private vault path");
    }
    let mut bytes = Vec::new();
    fs::File::open(&path)?
        .take(oximemo_sync::MAX_ATTACHMENT as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > oximemo_sync::MAX_ATTACHMENT {
        bail!("mobile attachment limit is 8 MiB");
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if expected.is_some_and(|value| value != digest) {
        bail!("asset digest mismatch");
    }
    Ok(Attachment {
        name: path.file_name().unwrap().to_string_lossy().into_owned(),
        sha256: digest,
        bytes,
    })
}
