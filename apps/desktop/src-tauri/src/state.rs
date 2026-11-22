use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::actor::ActorHandle;

#[derive(Clone)]
pub struct AppState {
    /// Single owner of the device transport, command queue, poller, and
    /// reconnect scheduler.
    pub actor: ActorHandle,
    /// The simulator/browser board is only auto-loaded when the app is started
    /// with `--demo` or `STOMPSTATION_DEMO=1`.
    pub demo_allowed: Arc<AtomicBool>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            actor: ActorHandle::spawn(),
            demo_allowed: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl AppState {
    pub fn is_connected(&self) -> bool {
        self.actor.is_connected()
    }
}
