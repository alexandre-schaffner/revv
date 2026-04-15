use tauri::{Emitter, Listener, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            let handle = app.handle().clone();
            app.listen("deep-link://new-url", move |event: tauri::Event| {
                // The plugin serialises URLs as a JSON array: ["rev://auth/callback?token=…"]
                // Parse the array and emit each URL as a plain string so the webview
                // can do a simple `new URL(event.payload)` without extra JSON parsing.
                if let Ok(urls) = serde_json::from_str::<Vec<String>>(event.payload()) {
                    for url in urls {
                        if let Some(window) = handle.get_webview_window("main") {
                            let _ = window.emit("deep-link-url", url);
                        }
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Rev");
}
