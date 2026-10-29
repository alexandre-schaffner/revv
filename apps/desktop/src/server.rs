use crate::server_config::ServerConfig;
use std::{
	fs::{self, OpenOptions},
	io::{self, Read, Write},
	net::{SocketAddr, TcpStream},
	os::unix::process::CommandExt,
	process::{Child, Command, Stdio},
	sync::{
		mpsc::{self, Receiver, Sender},
		Mutex,
	},
	thread::{self, JoinHandle},
	time::{Duration, Instant},
};

const POLL_INTERVAL: Duration = Duration::from_millis(100);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_RESTARTS: usize = 3;

pub struct ServerProcess(Mutex<Option<(Sender<()>, JoinHandle<()>)>>);

impl ServerProcess {
	pub fn start(
		config: ServerConfig,
		on_failure: impl Fn(String) + Send + 'static,
	) -> io::Result<Self> {
		config.validate()?;
		let address = SocketAddr::from(([127, 0, 0, 1], config.port()?));
		// Never adopt or terminate a server belonging to another app/dev session.
		let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
		while TcpStream::connect_timeout(&address, POLL_INTERVAL).is_ok() {
			if Instant::now() >= deadline {
				return Err(io::Error::other(format!(
					"Port {} is already in use. Stop the other server and reopen Revv.",
					address.port()
				)));
			}
			thread::sleep(POLL_INTERVAL);
		}
		let (stop, commands) = mpsc::channel();
		let child = RunningServer::start(&config, address, &commands)?;
		let worker = thread::spawn(move || supervise(child, config, address, commands, on_failure));
		Ok(Self(Mutex::new(Some((stop, worker)))))
	}

	pub fn stop(&self) {
		if let Some((stop, worker)) = self.0.lock().expect("server lifecycle lock").take() {
			let _ = stop.send(());
			let _ = worker.join();
		}
	}
}

impl Drop for ServerProcess {
	fn drop(&mut self) {
		self.stop();
	}
}

struct RunningServer(Child);

impl RunningServer {
	fn start(
		config: &ServerConfig,
		address: SocketAddr,
		commands: &Receiver<()>,
	) -> io::Result<Self> {
		fs::create_dir_all(&config.log_dir)?;
		let log = |name| {
			OpenOptions::new()
				.create(true)
				.append(true)
				.open(config.log_dir.join(name))
		};
		let child = Command::new(&config.executable)
			.args(["run", "apps/server/src/index.ts"])
			.current_dir(&config.project_root)
			.envs(&config.env)
			.env("REVV_DESKTOP_PID", std::process::id().to_string())
			.stdin(Stdio::null())
			.stdout(log("server.out.log")?)
			.stderr(log("server.err.log")?)
			.process_group(0)
			.spawn()?;
		let mut server = Self(child);
		let deadline = Instant::now() + STARTUP_TIMEOUT;
		loop {
			if commands.try_recv().is_ok() {
				return Err(io::Error::new(
					io::ErrorKind::Interrupted,
					"Server startup cancelled",
				));
			}
			if let Some(status) = server.0.try_wait()? {
				return Err(io::Error::other(format!(
					"Revv server exited with {status}. See {}",
					config.log_dir.display()
				)));
			}
			if healthy(address) {
				return Ok(server);
			}
			if Instant::now() >= deadline {
				return Err(io::Error::new(
					io::ErrorKind::TimedOut,
					format!(
						"Revv server did not become ready. See {}",
						config.log_dir.display()
					),
				));
			}
			thread::sleep(POLL_INTERVAL);
		}
	}

	fn signal_group(&self, signal: i32) {
		// This group was created for this child and never contains the desktop app.
		unsafe {
			libc::kill(-(self.0.id() as i32), signal);
		}
	}
}

impl Drop for RunningServer {
	fn drop(&mut self) {
		self.signal_group(libc::SIGTERM);
		let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
		while matches!(self.0.try_wait(), Ok(None)) && Instant::now() < deadline {
			thread::sleep(POLL_INTERVAL);
		}
		// Descendants can outlive the server, including after a server crash.
		self.signal_group(libc::SIGKILL);
		let _ = self.0.wait();
	}
}

fn healthy(address: SocketAddr) -> bool {
	let Ok(mut stream) = TcpStream::connect_timeout(&address, POLL_INTERVAL) else {
		return false;
	};
	let _ = stream.set_read_timeout(Some(POLL_INTERVAL));
	let _ = stream.set_write_timeout(Some(POLL_INTERVAL));
	if stream
		.write_all(b"GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
		.is_err()
	{
		return false;
	}
	let mut response = [0; 256];
	match stream.read(&mut response) {
		Ok(n) => {
			response[..n].starts_with(b"HTTP/1.1 200 ")
				|| response[..n].starts_with(b"HTTP/1.0 200 ")
		}
		Err(_) => false,
	}
}

fn supervise(
	mut child: RunningServer,
	config: ServerConfig,
	address: SocketAddr,
	commands: Receiver<()>,
	on_failure: impl Fn(String),
) {
	let mut restarts = 0;
	loop {
		if !matches!(
			commands.recv_timeout(POLL_INTERVAL),
			Err(mpsc::RecvTimeoutError::Timeout)
		) {
			return;
		}
		match child.0.try_wait() {
			Ok(None) => continue,
			Ok(Some(status)) => eprintln!("Revv server exited with {status}"),
			Err(error) => {
				on_failure(error.to_string());
				return;
			}
		}
		drop(child);
		if restarts >= MAX_RESTARTS {
			on_failure(format!("The server stopped after {MAX_RESTARTS} restart attempts. See {}. Quit and reopen Revv to try again.", config.log_dir.display()));
			return;
		}
		restarts += 1;
		if !matches!(
			commands.recv_timeout(Duration::from_secs(1)),
			Err(mpsc::RecvTimeoutError::Timeout)
		) {
			return;
		}
		match RunningServer::start(&config, address, &commands) {
			Ok(restarted) => child = restarted,
			Err(error) if error.kind() == io::ErrorKind::Interrupted => return,
			Err(error) => {
				on_failure(error.to_string());
				return;
			}
		}
	}
}

#[cfg(test)]
#[path = "server_tests.rs"]
mod tests;
