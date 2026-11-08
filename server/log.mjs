// One line per event, human readable in the console and greppable in the file.
// stdout carries the live feed; the file keeps history across restarts.
import fs from "node:fs";
import path from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const stamp = (date = new Date()) => {
  const p = (value, width = 2) => String(value).padStart(width, "0");
  return (
    date.getFullYear() +
    "-" + p(date.getMonth() + 1) +
    "-" + p(date.getDate()) +
    " " + p(date.getHours()) +
    ":" + p(date.getMinutes()) +
    ":" + p(date.getSeconds()) +
    "." + p(date.getMilliseconds(), 3)
  );
};

// Keep one line per event even when a message carries newlines, and bound the
// size so a stack trace cannot flood the console or the log file.
function text(value, limit = 400) {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean.length > limit ? clean.slice(0, limit) + "…" : clean;
}

function fields(data) {
  if (!data) return "";
  const out = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = typeof value === "string" ? text(value, 300) : value;
  }
  if (!Object.keys(out).length) return "";
  let json = "";
  try {
    json = JSON.stringify(out);
  } catch {
    return "";
  }
  return " " + (json.length > 1200 ? json.slice(0, 1200) + "…" : json);
}

// Appending synchronously keeps the console feed and the file in step even when
// the process is killed, and avoids holding a Windows file handle between lines.
function createSink(file, maxBytes, keep) {
  let written = 0;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    written = fs.existsSync(file) ? fs.statSync(file).size : 0;
  } catch {}
  const rotate = () => {
    try {
      for (let index = keep - 1; index >= 1; index--) {
        const from = file + "." + index;
        if (fs.existsSync(from)) fs.renameSync(from, file + "." + (index + 1));
      }
      if (fs.existsSync(file)) fs.renameSync(file, file + ".1");
    } catch {}
    written = 0;
  };
  return {
    write(line) {
      const bytes = Buffer.byteLength(line) + 1;
      if (maxBytes > 0 && written + bytes > maxBytes) rotate();
      try {
        fs.appendFileSync(file, line + "\n", { mode: 0o600 });
        written += bytes;
      } catch {
        // Logging must never take the service down.
      }
    },
    close() {},
  };
}

export function createLogger({
  level = "info",
  file = null,
  mirror = true,
  maxBytes = 5 * 1024 * 1024,
  keep = 5,
  scope = "web",
} = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const sink = file && threshold < LEVELS.silent ? createSink(file, maxBytes, keep) : null;

  const make = (name) => {
    const emit = (type, message, data) => {
      if (LEVELS[type] < threshold) return;
      const line =
        stamp() +
        " " + type.toUpperCase().padEnd(5) +
        " " + name.padEnd(14) +
        " " + text(message) +
        fields(data);
      if (mirror) {
        try {
          (type === "error" || type === "warn" ? process.stderr : process.stdout).write(line + "\n");
        } catch {}
      }
      sink?.write(line);
    };
    return {
      level,
      file,
      scope: name,
      enabled: (type) => (LEVELS[type] ?? 100) >= threshold,
      debug: (message, data) => emit("debug", message, data),
      info: (message, data) => emit("info", message, data),
      warn: (message, data) => emit("warn", message, data),
      error: (message, data) => emit("error", message, data),
      child: (child) => make(name ? name + ":" + child : String(child)),
      close: () => sink?.close(),
    };
  };
  return make(String(scope));
}

export const silentLogger = {
  level: "silent",
  file: null,
  scope: "silent",
  enabled: () => false,
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
  close() {},
};

export const logLevels = Object.keys(LEVELS);
