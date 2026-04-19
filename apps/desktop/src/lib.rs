use tauri::{
	menu::{Menu, MenuItem, PredefinedMenuItem},
	tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
	AppHandle, Manager, WindowEvent,
};

/// Show, unminimize, and focus the main window. Called from tray menu
/// interactions, tray left-clicks, and the single-instance handler (when
/// the user re-launches Revv while it's already running in the tray).
fn show_main_window(app: &AppHandle) {
	if let Some(window) = app.get_webview_window("main") {
		let _ = window.unminimize();
		let _ = window.show();
		let _ = window.set_focus();
	}
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
	let builder = tauri::Builder::default()
		// Single-instance must be the first plugin registered. If a second
		// copy of Revv is launched (e.g. the user clicks the app icon while
		// it's already running in the tray), this fires in the existing
		// process instead of spawning a duplicate. Critical for tray-app
		// UX — without it, every launch would start another PollScheduler.
		.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
			show_main_window(app);
		}))
		.plugin(tauri_plugin_deep_link::init())
		.plugin(tauri_plugin_opener::init())
		// Registered so the frontend can toggle launch-on-login via the
		// `plugin:autostart|enable` / `disable` / `is_enabled` IPC commands.
		// No automatic behavior — users opt in explicitly from Settings.
		.plugin(tauri_plugin_autostart::init(
			tauri_plugin_autostart::MacosLauncher::LaunchAgent,
			None,
		));

	// Shadow-rebind under debug only; release builds skip this entirely,
	// so the binding above never needs `mut` and produces no warning.
	#[cfg(debug_assertions)]
	let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

	builder
		.setup(|app| {
			// Tray menu: [ Open Revv | --- | Quit Revv ].
			// `Open Revv` and left-clicking the tray icon both surface the
			// window. `Quit Revv` calls `app.exit(0)` which bypasses the
			// close-to-tray interception below and fully terminates the
			// process (stopping the embedded server and PollScheduler).
			let open_item = MenuItem::with_id(app, "open", "Open Revv", true, None::<&str>)?;
			let separator = PredefinedMenuItem::separator(app)?;
			let quit_item = MenuItem::with_id(app, "quit", "Quit Revv", true, None::<&str>)?;
			let menu = Menu::with_items(app, &[&open_item, &separator, &quit_item])?;

			let icon = app
				.default_window_icon()
				.cloned()
				.expect("bundle.icon must be configured in tauri.conf.json");

			TrayIconBuilder::with_id("main-tray")
				.icon(icon)
				.tooltip("Revv")
				.menu(&menu)
				// Left-click surfaces the window; right-click opens the menu
				// (platform-native). This matches Slack / Linear / 1Password.
				.show_menu_on_left_click(false)
				.on_menu_event(|app, event| match event.id.as_ref() {
					"open" => show_main_window(app),
					"quit" => app.exit(0),
					_ => {}
				})
				.on_tray_icon_event(|tray, event| {
					if let TrayIconEvent::Click {
						button: MouseButton::Left,
						button_state: MouseButtonState::Up,
						..
					} = event
					{
						show_main_window(tray.app_handle());
					}
				})
				.build(app)?;

			Ok(())
		})
		// Intercept the window's close button and hide to tray instead of
		// exiting. The Bun/Elysia server keeps running with PollScheduler
		// syncing PRs in the background; the window is just a view on top
		// of it. Users quit the whole app explicitly via the tray menu.
		.on_window_event(|window, event| {
			if let WindowEvent::CloseRequested { api, .. } = event {
				if window.label() == "main" {
					let _ = window.hide();
					api.prevent_close();
				}
			}
		})
		.run(tauri::generate_context!())
		.expect("error while running Revv");
}
