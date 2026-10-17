const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const HOST = "127.0.0.1";
const DEFAULT_PORT = 18789;
const ROOT_DIR = path.resolve(__dirname, "..");
const BACKEND_DIR = path.join(ROOT_DIR, "backend");
const CACHE_DIR = path.join(BACKEND_DIR, ".cache");
const PID_FILE = path.join(CACHE_DIR, "backend.pid");

readNativeMessage()
  .then(handleMessage)
  .then(writeNativeMessage)
  .catch((error) => {
    writeNativeMessage({
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
  });

function resolvePort(message) {
  const fromMessage = Number(message && message.port);
  if (Number.isInteger(fromMessage) && fromMessage > 0 && fromMessage <= 65535) {
    return fromMessage;
  }
  const fromEnv = Number(process.env.YLD_BACKEND_PORT);
  if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= 65535) {
    return fromEnv;
  }
  return DEFAULT_PORT;
}

async function handleMessage(message) {
  const action = message && message.action;
  const port = resolvePort(message);

  if (action === "status") {
    return getStatus(port);
  }

  if (action === "start") {
    return startBackend(port);
  }

  if (action === "stop") {
    return stopBackend(port);
  }

  throw new Error(`Unknown native host action: ${action || "missing"}`);
}

async function getStatus(port) {
  const health = await fetchHealth(port);
  return {
    ok: true,
    running: Boolean(health),
    port,
    health,
  };
}

async function startBackend(port) {
  const existing = await fetchHealth(port);
  if (existing) {
    return {
      ok: true,
      running: true,
      alreadyRunning: true,
      port,
      health: existing,
    };
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const child = spawn(process.execPath, ["server.js"], {
    cwd: BACKEND_DIR,
    detached: true,
    env: {
      ...process.env,
      PORT: String(port),
      HOST,
    },
    stdio: "ignore",
    windowsHide: true,
  });

  child.unref();
  fs.writeFileSync(PID_FILE, String(child.pid), "utf8");

  const health = await waitForHealth(port, 12000);
  if (!health) {
    throw new Error(`Backend did not become healthy on http://${HOST}:${port}/api/health.`);
  }

  return {
    ok: true,
    running: true,
    started: true,
    pid: child.pid,
    port,
    health,
  };
}

async function stopBackend(port) {
  const shutdown = await requestShutdown(port);
  const pid = readPid();
  let stopped = Boolean(shutdown);

  if (!shutdown && pid) {
    try {
      process.kill(pid);
      stopped = true;
    } catch (_error) {
      stopped = false;
    }
  }

  try {
    fs.rmSync(PID_FILE, { force: true });
  } catch (_error) {}

  await sleep(600);
  const health = await fetchHealth(port);

  return {
    ok: true,
    running: Boolean(health),
    stopped,
    shutdown,
    pid,
    port,
    health,
  };
}

async function requestShutdown(port) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    const response = await fetch(`http://${HOST}:${port}/api/server/shutdown`, {
      method: "POST",
      signal: controller.signal,
    });
    clearTimeout(timer);
    return response.ok;
  } catch (_error) {
    return false;
  }
}

function readPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (_error) {
    return null;
  }
}

async function waitForHealth(port, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const health = await fetchHealth(port);
    if (health) {
      return health;
    }
    await sleep(300);
  }
  return null;
}

async function fetchHealth(port) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    const response = await fetch(`http://${HOST}:${port}/api/health`, {
      signal: controller.signal,
      cache: "no-store",
    });
    clearTimeout(timer);

    if (!response.ok) {
      return null;
    }
    return response.json();
  } catch (_error) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readNativeMessage() {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const finish = (error, value) => {
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("error", onError);
      process.stdin.removeListener("end", onEnd);
      process.stdin.pause();
      if (error) reject(error);
      else resolve(value);
    };
    const onError = (error) => finish(error);
    const onEnd = () => finish(new Error("Native message was truncated."));
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length === 0 || length > 1024 * 1024) {
        finish(new Error("Invalid native message length."));
        return;
      }
      if (buffer.length < length + 4) return;
      try {
        finish(null, JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")));
      } catch (error) {
        finish(new Error(`Native message JSON parse failed: ${error.message}`));
      }
    };
    // Chrome keeps stdin open while waiting for the response. Parse a complete
    // length-prefixed frame immediately instead of waiting for EOF.
    process.stdin.on("data", onData);
    process.stdin.on("error", onError);
    process.stdin.on("end", onEnd);
  });
}

function writeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}
