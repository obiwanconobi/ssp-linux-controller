use thiserror::Error;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("transport is not open")]
    NotConnected,
    #[error("the device did not answer in time")]
    Timeout,
    #[error("the device closed the connection")]
    ConnectionClosed,
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("authentication required: {0}")]
    AuthenticationRequired(String),
    #[error("upload rejected: {0}")]
    UploadRejected(String),
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    #[error("unsupported by this firmware: {0}")]
    Unsupported(String),
    #[error("I/O error: {0}")]
    Io(String),
}

pub type Result<T> = std::result::Result<T, ProtocolError>;
