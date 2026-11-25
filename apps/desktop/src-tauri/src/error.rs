use serde::Serialize;
use stomp_protocol::ProtocolError;

#[derive(Debug, Clone, Serialize)]
pub struct IpcError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl IpcError {
    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "internal".to_string(),
            message: message.into(),
            retryable: false,
        }
    }

    pub fn no_device(message: impl Into<String>) -> Self {
        Self {
            code: "no_device".to_string(),
            message: message.into(),
            retryable: true,
        }
    }
}

impl From<ProtocolError> for IpcError {
    fn from(error: ProtocolError) -> Self {
        let (code, retryable) = match &error {
            ProtocolError::NotConnected => ("not_connected", true),
            ProtocolError::Timeout => ("timeout", true),
            ProtocolError::ConnectionClosed => ("connection_closed", true),
            ProtocolError::Protocol(_) => ("protocol", false),
            ProtocolError::AuthenticationRequired(_) => ("auth_required", false),
            ProtocolError::UploadRejected(_) => ("rejected", false),
            ProtocolError::InvalidRequest(_) => ("invalid_request", false),
            ProtocolError::Unsupported(_) => ("unsupported", false),
            ProtocolError::Io(_) => ("io", true),
        };
        Self {
            code: code.to_string(),
            message: error.to_string(),
            retryable,
        }
    }
}

pub type IpcResult<T> = Result<T, IpcError>;
