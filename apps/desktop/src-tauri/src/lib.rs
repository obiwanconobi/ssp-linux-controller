mod actor;
mod commands;
mod error;
mod state;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let state = AppState::default();
    let demo = std::env::args().any(|argument| argument == "--demo")
        || std::env::var("STOMPSTATION_DEMO")
            .map(|value| {
                matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "1" | "true" | "yes" | "on"
                )
            })
            .unwrap_or(false);
    state
        .demo_allowed
        .store(demo, std::sync::atomic::Ordering::SeqCst);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(|app| {
            let state = tauri::Manager::state::<AppState>(app);
            state.actor.attach_app(app.handle().clone());
            if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
                match window.url() {
                    Ok(url) => eprintln!("StompStation window URL: {url}"),
                    Err(error) => eprintln!("StompStation window URL unavailable: {error}"),
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap,
            commands::list_serial_ports,
            commands::discover_wifi,
            commands::connect,
            commands::auto_connect,
            commands::disconnect,
            commands::get_snapshot,
            commands::refresh,
            commands::select_block,
            commands::set_control,
            commands::set_block,
            commands::set_preset,
            commands::save_preset,
            commands::rename_preset,
            commands::edit_chain,
            commands::set_master,
            commands::set_eq_band,
            commands::set_eq_type,
            commands::set_eq_enabled,
            commands::set_alias,
            commands::factory_reset,
            commands::preflight_upload,
            commands::begin_upload,
            commands::cancel_upload,
            commands::delete_list_item,
            commands::tuner_open,
            commands::tuner_poll,
            commands::tuner_close,
            commands::copy_diagnostics,
            commands::scan_captures,
        ])
        .run(tauri::generate_context!())
        .expect("error while running StompStation");
}
