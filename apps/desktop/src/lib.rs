use tauri::{
	http::{header, Response, StatusCode},
	menu::{Menu, MenuItem, PredefinedMenuItem},
	tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
	AppHandle, Manager, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

mod server;
mod server_config;

const ARTIFACT_HOST_HTML: &str = include_str!("../../web/static/artifact-host.html");

/// The artifact-host CSP is authored in artifact-host.html's
/// `<meta http-equiv="Content-Security-Policy">` tag and served as a header too:
/// the header, unlike the meta tag, survives the host's `document.write`.
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
		// Must be the first plugin registered. A relaunch while Revv sits in the
		// tray lands here instead of starting a second server and PollScheduler.
		.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
			if !argv.iter().any(|arg| arg == "--hidden") {
				show_main_window(app);
			}
		}))
		.plugin(tauri_plugin_deep_link::init())
		.plugin(tauri_plugin_dialog::init())
		.plugin(tauri_plugin_opener::init())
		// Launch-on-login is opt-in from Settings. Only the login launcher
		// passes `--hidden`, so a login launch stays in the tray.
		.plugin(tauri_plugin_autostart::init(
			tauri_plugin_autostart::MacosLauncher::LaunchAgent,
			Some(vec!["--hidden"]),
		))
		// Endpoint, signing key, and install mode live in tauri.conf.json →
		// plugins.updater; the frontend drives check/install.
		.plugin(tauri_plugin_updater::Builder::new().build())
		// macOS swaps the .app bundle in place but leaves the running process
		// alone; the frontend's post-install `relaunch()` needs this plugin, or
		// a good update looks like a failed one.
		.plugin(tauri_plugin_process::init());

	#[cfg(debug_assertions)]
	let builder = builder.plugin(tauri_plugin_mcp_bridge::init());

	builder
		.setup(|app| {
			let override_path = std::env::var_os("REVV_DESKTOP_SERVER_CONFIG");
			if !cfg!(dev) || override_path.is_some() {
				let home = app.path().home_dir()?;
				let config = match override_path {
					Some(path) => server_config::ServerConfig::load(std::path::Path::new(&path)),
					None => server_config::load_installed(&home),
				};
				let handle = app.handle().clone();
				let server = config.and_then(|config| {
					let executable = std::env::current_exe()?;
					let executable_dir = executable
						.parent()
						.ok_or_else(|| std::io::Error::other("App executable has no directory"))?;
					let command = server::ServerCommand::bundled(executable_dir, &config, &home)?;
					server::ServerProcess::start(command, config, move |message| {
						handle
							.dialog()
							.message(message)
							.title("Revv server stopped")
							.kind(MessageDialogKind::Error)
							.show(|_| {});
					})
				});
				match server {
					Ok(server) => {
						app.manage(server);
					}
					Err(error) => {
						app.dialog()
							.message(error.to_string())
							.title("Could not start Revv")
							.kind(MessageDialogKind::Error)
							.blocking_show();
						return Err(error.into());
					}
				}
			}
			// `app.exit(0)` bypasses the close-to-tray interception below, so
			// Quit stops the embedded server too.
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

			// The window starts `visible: false` (tauri.conf.json) so it doesn't
			// flash before the tray is wired up.
			let launched_hidden = std::env::args().any(|arg| arg == "--hidden");
			if !launched_hidden {
				show_main_window(app.handle());
			}

			Ok(())
		})
		// Closing the window hides it to the tray; the server keeps syncing PRs
		// until the user quits from the tray menu.
		.on_window_event(|window, event| {
			if let WindowEvent::CloseRequested { api, .. } = event {
				if window.label() == "main" {
					let _ = window.hide();
					api.prevent_close();
				}
			}
		})
		.build(tauri::generate_context!())
		.expect("error while building Revv")
		.run(|app, event| {
			if let tauri::RunEvent::Exit = event {
				if let Some(server) = app.try_state::<server::ServerProcess>() {
					server.stop();
				}
			}
		});
}
