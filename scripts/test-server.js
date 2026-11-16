const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aibox-webapp-server-"));
const dataDir = path.join(testRoot, "data");
const distDir = path.join(testRoot, "dist");
const monitorDir = path.join(testRoot, "monitor");
const port = 32_000 + Math.floor(Math.random() * 10_000);
const upstreamPort = port + 1;
const upstreamRequests = [];
let simState = "offline";
let simSampleTs = 1000;

const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  upstreamRequests.push(`${url.pathname}?${url.search}`);
  if (url.pathname === "/api/fleet") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([
      { machine: "aibox-td08", links: { LAN: { sample: { ts: Date.now() / 1000, state: "online", severity: 0 }, stale: false } }, collection: { machine: "aibox-td08", cursor: 5, collected: Date.now() / 1000, error: null } },
      { machine: "vtas-aibox1", links: { USB: { sample: { ts: simSampleTs, state: simState, severity: 0 }, stale: false } }, collection: null },
      { machine: "unknown-box", links: {}, collection: null },
    ]));
    return;
  }
  if (url.pathname === "/api/history") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([{ machine: "aibox-td08", link: "LAN", ts: 1, kind: "measurement" }]));
    return;
  }
  if (url.pathname === "/api/export.csv") {
    res.writeHead(200, { "Content-Type": "text/csv" });
    res.end("machine,link\n");
    return;
  }
  res.writeHead(404);
  res.end();
});
upstream.listen(upstreamPort, "127.0.0.1");

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
fs.mkdirSync(monitorDir, { recursive: true });
fs.writeFileSync(path.join(distDir, "index.html"), "<!doctype html><title>Test dashboard</title>");
fs.writeFileSync(path.join(distDir, "assets", "test.css"), "body{}\n");
fs.writeFileSync(path.join(dataDir, "connectivity-waiting.json"), JSON.stringify({
  "aibox-td07": { id: "td07", ip: "100.64.0.6", label: "Tàu TD-07", reason: "Awaiting SSH" },
}));

const server = childProcess.spawn(process.execPath, [path.join(rootDir, "scripts", "server.js")], {
  cwd: rootDir,
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(port),
    AIBOX_MONITOR_ROOT: monitorDir,
    AIBOX_WEBAPP_DATA_DIR: dataDir,
    AIBOX_WEBAPP_DIST_DIR: distDir,
    AIBOX_CONNECTIVITY_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });

function request(method, requestPath, options = {}) {
  const body = options.body === undefined
    ? null
    : Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body));
  const headers = { ...(options.headers || {}) };
  if (body && headers["Content-Length"] === undefined) headers["Content-Length"] = String(body.length);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: requestPath, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        body: Buffer.concat(chunks).toString("utf8"),
        headers: res.headers,
        status: res.statusCode,
      }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function removeTree(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) removeTree(entryPath);
    else fs.unlinkSync(entryPath);
  }
  fs.rmdirSync(targetPath);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await request("GET", "/tv");
      if (response.status === 200) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Server did not start. ${serverOutput}`);
}

async function run() {
  await waitForServer();

  let response = await request("GET", "/api/notes");
  assert.strictEqual(response.status, 200);
  assert.deepStrictEqual(JSON.parse(response.body), {});
  assert.strictEqual(response.headers["x-content-type-options"], "nosniff");

  response = await request("POST", "/api/notes", {
    body: JSON.stringify({ key: "tv:board", creator: "TV test", content: "Shared handoff note" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.strictEqual(response.status, 200);
  const tvNote = JSON.parse(response.body)[0];
  assert.strictEqual(tvNote.content, "Shared handoff note");
  assert.ok(tvNote.id);
  assert.ok(Number.isFinite(Date.parse(tvNote.createdAt)));
  response = await request("GET", "/api/notes");
  assert.strictEqual(JSON.parse(response.body)["tv:board"][0].id, tvNote.id);
  response = await request("DELETE", `/api/notes?key=tv%3Aboard&noteId=${encodeURIComponent(tvNote.id)}`);
  assert.strictEqual(response.status, 200);
  response = await request("GET", "/api/notes");
  assert.strictEqual(JSON.parse(response.body)["tv:board"], undefined);

  response = await request("POST", "/api/notes", { body: "{}" });
  assert.strictEqual(response.status, 415);

  response = await request("POST", "/api/notes", {
    body: "not-json",
    headers: { "Content-Type": "application/json" },
  });
  assert.strictEqual(response.status, 400);

  response = await request("POST", "/api/notes", {
    body: JSON.stringify({ key: "__proto__", creator: "Test", content: "Reserved key remains data" }),
    headers: { "Content-Type": "application/json" },
  });
  assert.strictEqual(response.status, 200);
  assert.strictEqual(JSON.parse(response.body).length, 1);

  response = await request("PUT", "/api/layout", {
    body: JSON.stringify({ aiboxOrder: ["100.64.0.1"], cameraOrder: {}, networkOrder: ["th09-lan", "giaminh-lan"], junk: true }),
    headers: { "Content-Type": "application/json" },
  });
  assert.strictEqual(response.status, 200);
  const layoutAfterPut = JSON.parse(response.body);
  assert.deepStrictEqual(layoutAfterPut.aiboxOrder, ["100.64.0.1"]);
  assert.deepStrictEqual(layoutAfterPut.networkOrder, ["th09-lan", "giaminh-lan"]);
  assert.deepStrictEqual(Object.keys(layoutAfterPut).sort(), ["aiboxOrder", "cameraOrder", "networkOrder"]);

  response = await request("GET", "/api/missing");
  assert.strictEqual(response.status, 404);
  assert.strictEqual(JSON.parse(response.body).error, "API endpoint not found");

  response = await request("GET", "/bad%");
  assert.strictEqual(response.status, 400);

  response = await request("HEAD", "/");
  assert.strictEqual(response.status, 302);
  assert.strictEqual(response.headers.location, "/tv");
  assert.strictEqual(response.body, "");

  response = await request("GET", "/?display=wall");
  assert.strictEqual(response.status, 302);
  assert.strictEqual(response.headers.location, "/tv?display=wall");
  assert.strictEqual(response.headers["cache-control"], "no-store");
  for (const route of ["/tv", "/overview", "/fleet", "/connectivity"]) {
    response = await request("GET", route);
    assert.strictEqual(response.status, 200, route);
    assert.ok(response.body.includes("Test dashboard"), route);
  }

  response = await request("GET", "/aibox-data.json");
  assert.strictEqual(response.status, 503);

  response = await request("GET", "/assets/test.css");
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers["cache-control"], "public, max-age=31536000, immutable");

  const snapshotDir = path.join(dataDir, "camera-snapshots", "kimhoa", "192.168.1.121");
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(path.join(snapshotDir, "main-1000.jpg"), Buffer.from("older"));
  fs.writeFileSync(path.join(snapshotDir, "main-2000.jpg"), Buffer.from("newest"));
  fs.utimesSync(path.join(snapshotDir, "main-1000.jpg"), new Date(1000), new Date(1000));
  fs.utimesSync(path.join(snapshotDir, "main-2000.jpg"), new Date(2000), new Date(2000));

  response = await request("GET", "/camera-snapshots/kimhoa/192.168.1.121.jpg");
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers["content-type"], "image/jpeg");
  assert.strictEqual(response.headers["cache-control"], "no-store, max-age=0");
  assert.strictEqual(response.body, "newest");

  response = await request("GET", "/camera-snapshots/kimhoa/192.168.1.121.1.jpg");
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.body, "older");

  response = await request("GET", "/camera-snapshots/kimhoa/192.168.1.121.5.jpg");
  assert.strictEqual(response.status, 404);

  response = await request("GET", "/camera-snapshots/kimhoa/192.168.1.999.jpg");
  assert.strictEqual(response.status, 404);

  response = await request("GET", "/camera-snapshots/kimhoa/not-an-ip.jpg");
  assert.strictEqual(response.status, 404);

  response = await request("GET", "/api/connectivity/fleet");
  assert.strictEqual(response.status, 200);
  const connectivityFleet = JSON.parse(response.body);
  assert.strictEqual(connectivityFleet.available, true);
  const enrolled = connectivityFleet.machines.find((machine) => machine.machine === "aibox-td08");
  assert.strictEqual(enrolled.id, "td08");
  assert.strictEqual(enrolled.ip, "100.64.0.27");
  assert.strictEqual(enrolled.enrolled, true);
  const restored = connectivityFleet.machines.find((machine) => machine.machine === "vtas-aibox1");
  assert.strictEqual(restored.id, "poseidon");
  assert.strictEqual(restored.ip, "100.64.0.45");
  assert.strictEqual(restored.enrolled, true);
  assert.strictEqual(restored.usbOfflineSince, 1000, "SIM outage starts at first offline sample");
  simSampleTs = 2000;
  response = await request("GET", "/api/connectivity/fleet");
  assert.strictEqual(JSON.parse(response.body).machines.find((machine) => machine.machine === "vtas-aibox1").usbOfflineSince, 1000, "SIM outage start persists");
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "sim-outages.json"), "utf8")), { "100.64.0.45": { since: 1000, machine: "vtas-aibox1" } });
  simState = "online";
  response = await request("GET", "/api/connectivity/fleet");
  assert.strictEqual(JSON.parse(response.body).machines.find((machine) => machine.machine === "vtas-aibox1").usbOfflineSince, undefined);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "sim-outages.json"), "utf8")), {}, "SIM outage cleared on recovery");
  simState = "offline";
  assert.strictEqual(connectivityFleet.machines.find((machine) => machine.machine === "unknown-box").enrolled, false);
  assert.deepStrictEqual(connectivityFleet.waitingMachines, [
    { machine: "aibox-td07", id: "td07", ip: "100.64.0.6", label: "Tàu TD-07" },
  ]);

  response = await request("GET", "/api/connectivity/history?machine=td08&limit=999999&minimum_severity=9");
  assert.strictEqual(response.status, 200);
  assert.strictEqual(JSON.parse(response.body)[0].machine, "aibox-td08");
  const historyRequest = upstreamRequests.find((entry) => entry.startsWith("/api/history"));
  assert.ok(historyRequest.includes("machine=aibox-td08"));
  assert.ok(historyRequest.includes("limit=10000"));
  assert.ok(historyRequest.includes("minimum_severity=3"));

  await request("GET", "/api/connectivity/history?machine=td08&kind=incident,gap,bogus&offset=200&limit=100");
  const pagedRequest = upstreamRequests.filter((entry) => entry.startsWith("/api/history")).pop();
  assert.ok(pagedRequest.includes("kind=incident%2Cgap"), `expected comma kinds, got ${pagedRequest}`);
  assert.ok(pagedRequest.includes("offset=200"));
  assert.ok(pagedRequest.includes("limit=100"));

  response = await request("GET", "/api/connectivity/history?machine=does-not-exist");
  assert.strictEqual(response.status, 400);

  response = await request("GET", "/api/connectivity/history?machine=100.64.0.27");
  assert.strictEqual(response.status, 200);
  assert.strictEqual(JSON.parse(response.body)[0].machine, "aibox-td08");

  response = await request("GET", "/api/connectivity/export.csv?machine=td08");
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers["content-type"], "text/csv; charset=utf-8");
  assert.ok(response.headers["content-disposition"].includes("attachment"));
  assert.strictEqual(response.body, "machine,link\n");

  response = await request("POST", "/api/notes", {
    body: Buffer.alloc(100_001, "a"),
    headers: { "Content-Type": "application/json" },
  });
  assert.strictEqual(response.status, 413);

  const notesPath = path.join(dataDir, "notes.json");
  fs.writeFileSync(notesPath, "invalid json\n");
  response = await request("GET", "/api/notes");
  assert.strictEqual(response.status, 500);
  assert.strictEqual(fs.readFileSync(notesPath, "utf8"), "invalid json\n");

  upstream.close();
  await new Promise((resolve) => setTimeout(resolve, 60));
  response = await request("GET", "/api/connectivity/fleet");
  assert.strictEqual(response.status, 502);
  assert.strictEqual(JSON.parse(response.body).error, "Connectivity collection unavailable");
}

run().then(() => {
  console.log("server regression checks passed");
}).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  server.kill("SIGTERM");
  try { upstream.close(); } catch (_) {}
  removeTree(testRoot);
});
