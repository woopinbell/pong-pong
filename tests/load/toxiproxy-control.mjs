import { pathToFileURL } from "node:url";

const DEFAULT_API_URL = "http://127.0.0.1:8474";
const COMMANDS = new Set([
  "plan",
  "ensure",
  "reset",
  "db-latency",
  "db-down",
  "db-up",
  "edge-latency",
  "edge-reset",
  "edge-down",
  "edge-up"
]);

export function buildProxyDefinitions(environment = {}) {
  return [
    {
      name: "postgres",
      listen: environment.TOXIPROXY_POSTGRES_LISTEN || "0.0.0.0:15432",
      upstream: environment.TOXIPROXY_POSTGRES_UPSTREAM || "db:5432",
      enabled: true
    },
    {
      name: "edge",
      listen: environment.TOXIPROXY_EDGE_LISTEN || "0.0.0.0:18080",
      upstream: environment.TOXIPROXY_EDGE_UPSTREAM || "caddy:8080",
      enabled: true
    }
  ];
}

export function toxicForCommand(command, args = []) {
  if (command === "db-latency" || command === "edge-latency") {
    const latency = positiveInteger(args[0] ?? "250");
    const jitter = nonnegativeInteger(args[1] ?? "25");
    const proxy = command.startsWith("db-") ? "postgres" : "edge";
    return {
      proxy,
      toxic: {
        name: command,
        type: "latency",
        stream: "downstream",
        toxicity: 1,
        attributes: { latency, jitter }
      }
    };
  }
  if (command === "edge-reset") {
    return {
      proxy: "edge",
      toxic: {
        name: command,
        type: "reset_peer",
        stream: "downstream",
        toxicity: 1,
        attributes: { timeout: nonnegativeInteger(args[0] ?? "0") }
      }
    };
  }
  throw new RangeError(`command does not define a toxic: ${command}`);
}

export async function runCommand(command, args = [], environment = process.env) {
  if (!COMMANDS.has(command)) throw new RangeError(`unknown command: ${command}`);
  const apiUrl = (environment.TOXIPROXY_API_URL || DEFAULT_API_URL).replace(/\/$/, "");
  const proxies = buildProxyDefinitions(environment);
  if (command === "plan") return { apiUrl, proxies };

  await waitForApi(apiUrl);
  await ensureProxies(apiUrl, proxies);
  if (command === "ensure") return { apiUrl, proxies };
  if (command === "reset") {
    for (const proxy of proxies) {
      await removeAllToxics(apiUrl, proxy.name);
      await setEnabled(apiUrl, proxy.name, true);
    }
    return { reset: proxies.map((proxy) => proxy.name) };
  }
  if (command.endsWith("-down")) {
    const proxy = command.startsWith("db-") ? "postgres" : "edge";
    await setEnabled(apiUrl, proxy, false);
    return { proxy, enabled: false };
  }
  if (command.endsWith("-up")) {
    const proxy = command.startsWith("db-") ? "postgres" : "edge";
    await removeAllToxics(apiUrl, proxy);
    await setEnabled(apiUrl, proxy, true);
    return { proxy, enabled: true };
  }

  const planned = toxicForCommand(command, args);
  await removeAllToxics(apiUrl, planned.proxy);
  await requestJson(apiUrl, `/proxies/${planned.proxy}/toxics`, {
    method: "POST",
    body: planned.toxic
  });
  return planned;
}

async function waitForApi(apiUrl) {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await requestJson(apiUrl, "/version");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError ?? new Error("Toxiproxy API did not become ready");
}

async function ensureProxies(apiUrl, definitions) {
  const existing = await requestJson(apiUrl, "/proxies");
  for (const definition of definitions) {
    if (existing[definition.name]) {
      await requestJson(apiUrl, `/proxies/${definition.name}`, {
        method: "POST",
        body: definition
      });
    } else {
      await requestJson(apiUrl, "/proxies", { method: "POST", body: definition });
    }
  }
}

async function removeAllToxics(apiUrl, proxy) {
  const toxics = await requestJson(apiUrl, `/proxies/${proxy}/toxics`);
  for (const toxic of toxics) await removeToxic(apiUrl, proxy, toxic.name);
}

async function removeToxic(apiUrl, proxy, name) {
  await requestJson(apiUrl, `/proxies/${proxy}/toxics/${name}`, {
    method: "DELETE",
    allowNotFound: true
  });
}

async function setEnabled(apiUrl, proxy, enabled) {
  const current = await requestJson(apiUrl, `/proxies/${proxy}`);
  await requestJson(apiUrl, `/proxies/${proxy}`, {
    method: "POST",
    body: {
      name: current.name,
      listen: current.listen,
      upstream: current.upstream,
      enabled
    }
  });
}

async function requestJson(apiUrl, path, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (options.allowNotFound && response.status === 404) return null;
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`${options.method ?? "GET"} ${path} failed (${response.status}): ${detail}`);
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function positiveInteger(rawValue) {
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError("value must be a positive integer");
  return value;
}

function nonnegativeInteger(rawValue) {
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("value must be a nonnegative integer");
  return value;
}

const invokedAsScript = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsScript) {
  const [command = "plan", ...args] = process.argv.slice(2);
  runCommand(command, args)
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
