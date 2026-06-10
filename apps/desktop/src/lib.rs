use tauri::{
	http::{header, Response, StatusCode},
	menu::{Menu, MenuItem, PredefinedMenuItem},
	tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
	AppHandle, Manager, WindowEvent,
};

const ARTIFACT_HOST_HTML: &str = include_str!("../../web/static/artifact-host.html");

/// Single source of truth for the artifact-host CSP is the
/// `<meta http-equiv="Content-Security-Policy" content="…">` tag inside
/// artifact-host.html. We extract it from the compiled-in HTML and serve it as
/// an HTTP header too — the header (unlike the meta tag) survives the host's
/// `document.write`, so it is the durable enforcement. Deriving it here instead
/// of duplicating the literal keeps the header and the meta from drifting.
fn artifact_host_csp() -> &'static str {
	const FALLBACK: &str = "default-src 'none'";
	let html = ARTIFACT_HOST_HTML;
	let Some(marker) = html.find("Content-Security-Policy") else {
		return FALLBACK;
	};
	let tail = &html[marker..];
	let Some(rel_start) = tail.find("content=\"") else {
		return FALLBACK;
	};
	let start = marker + rel_start + "content=\"".len();
	match html[start..].find('"') {
		Some(len) => &html[start..start + len],
		None => FALLBACK,
	}
}

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
		.register_uri_scheme_protocol("artifact", |_ctx, request| {
			let path = request.uri().path();
			if path == "/" || path == "/artifact-host.html" {
				Response::builder()
					.header(header::CONTENT_TYPE, "text/html; charset=utf-8")
					.header(header::CONTENT_SECURITY_POLICY, artifact_host_csp())
					.body(ARTIFACT_HOST_HTML.as_bytes().to_vec())
					.expect("artifact host response should be valid")
			} else {
				Response::builder()
					.status(StatusCode::NOT_FOUND)
					.header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
					.body(b"not found".to_vec())
					.expect("artifact not-found response should be valid")
			}
		})
		// Single-instance must be the first plugin registered. If a second
		// copy of Revv is launched (e.g. the user clicks the app icon while
		// it's already running in the tray), this fires in the existing
		// process instead of spawning a duplicate. Critical for tray-app
		// UX — without it, every launch would start another PollScheduler.
		.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
			show_main_window(app);
		}))
		.plugin(tauri_plugin_deep_link::init())
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_opener::init())
		// Registered so the frontend can toggle launch-on-login via the
		// `plugin:autostart|enable` / `disable` / `is_enabled` IPC commands.
		// No automatic behavior — users opt in explicitly from Settings.
		//
		// `--hidden` is appended to the login launcher so we can distinguish
		// autostart-triggered launches from manual ones: on login we keep
		// the window in the tray (Slack/Linear convention), on a manual
		// launch we surface it. See setup() below.
		.plugin(tauri_plugin_autostart::init(
			tauri_plugin_autostart::MacosLauncher::LaunchAgent,
			Some(vec!["--hidden"]),
		))
		// Background auto-update: the updater plugin is a pure passthrough.
		// The endpoint, signing key, and install mode all live in
		// tauri.conf.json → plugins.updater; the frontend drives the actual
		// check/install loop via `@tauri-apps/plugin-updater`.
		.plugin(tauri_plugin_updater::Builder::new().build());

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

			// Surface the main window on launch. The window is configured
			// with `visible: false` in tauri.conf.json to prevent a flash
			// before setup finishes wiring up the tray; we make the call
			// here so the UI appears alongside (not instead of) the tray.
			//
			// Skip when `--hidden` is in argv: that arg is only passed by
			// the autostart LaunchAgent, so a login-triggered launch stays
			// in the tray while a manual launch opens the window.
			let launched_hidden = std::env::args().any(|arg| arg == "--hidden");
			if !launched_hidden {
				show_main_window(app.handle());
			}

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
