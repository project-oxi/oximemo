use thiserror::Error;

/// Stable error classes used by CLI and desktop callers.
#[derive(Debug, Error)]
#[error("{message}")]
pub struct SessionError {
    pub kind: SessionErrorKind,
    message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionErrorKind {
    InvalidInput,
    NotFound,
    IdempotencyConflict,
    ExternalChangeConflict,
    ProviderFailure,
    ProcessingBusy,
    StorageFailure,
}

impl SessionError {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(SessionErrorKind::InvalidInput, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(SessionErrorKind::NotFound, message)
    }

    pub fn idempotency_conflict(message: impl Into<String>) -> Self {
        Self::new(SessionErrorKind::IdempotencyConflict, message)
    }

    pub fn external_change(message: impl Into<String>) -> Self {
        Self::new(SessionErrorKind::ExternalChangeConflict, message)
    }

    pub fn provider(message: impl Into<String>) -> Self {
        Self::new(SessionErrorKind::ProviderFailure, message)
    }

    pub fn busy() -> Self {
        Self::new(SessionErrorKind::ProcessingBusy, "processing lock is held")
    }

    pub fn storage() -> Self {
        Self::new(
            SessionErrorKind::StorageFailure,
            "session storage operation failed",
        )
    }

    fn new(kind: SessionErrorKind, message: impl Into<String>) -> Self {
        let mut message = message.into();
        if message.chars().count() > 240 {
            message = message.chars().take(239).collect::<String>() + "…";
        }
        Self { kind, message }
    }
}

impl serde::Serialize for SessionError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(serde::Serialize)]
        struct Wire<'a> {
            kind: SessionErrorKind,
            message: &'a str,
        }
        Wire {
            kind: self.kind,
            message: &self.message,
        }
        .serialize(serializer)
    }
}

impl From<rusqlite::Error> for SessionError {
    fn from(_: rusqlite::Error) -> Self {
        Self::storage()
    }
}

impl From<std::io::Error> for SessionError {
    fn from(error: std::io::Error) -> Self {
        match error.kind() {
            std::io::ErrorKind::NotFound => Self::not_found("session input was not found"),
            std::io::ErrorKind::PermissionDenied => Self::invalid("session input is inaccessible"),
            _ => Self::storage(),
        }
    }
}
