// Greg Burn Dashboard Server
// Storage:  Upstash Redis — persists across Railway redeploys
// Ingestion: Alchemy GraphQL webhook → POST /api/webhook
// Fallback:  on-chain backfill at startup if Redis is empty
//
// Required Railway env vars:
//   REDIS_URL                — provided automatically by Railway's Upstash integration
//   ALCHEMY_RPC_URL          — e.g. https://eth-mainnet.g.alchemy.com/v2/yourkey
//   BURNER_CONTRACT_ADDRESS  — deployed GregBurner contract address
//   DEPLOY_BLOCK             — block the GregBurner contract was deployed at (for backfill)
//   PORT                     — optional, defaults to 3000

const express = require("express");
const { ethers } = require("ethers");
const { Redis } = require("@upstash/redis");

const RPC_URL        = process.env.ALCHEMY_RPC_URL;
const BURNER_ADDRESS = (process.env.BURNER_CONTRACT_ADDRESS || "").toLowerCase();
const DEPLOY_BLOCK   = process.env.DEPLOY_BLOCK ? Number(process.env.DEPLOY_BLOCK) : 0;
const PORT           = process.env.PORT || 3000;

if (!RPC_URL || !BURNER_ADDRESS) {
  console.error("Missing ALCHEMY_RPC_URL or BURNER_CONTRACT_ADDRESS. Exiting.");
  process.exit(1);
}
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN. Exiting.");
  process.exit(1);
}

// ---- Redis client ----
// Uses Upstash REST API — works via UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN env vars
const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN
});

const BURNS_KEY     = "greg:burns";      // Redis list  — each item is JSON
const USERNAMES_KEY = "greg:usernames";  // Redis hash  — { address: username }
const PINS_KEY      = "greg:pins";       // Redis list  — each item is JSON

// ---- Storage helpers ----

async function loadBurns() {
  const items = await redis.lrange(BURNS_KEY, 0, -1);
  return items.map(s => typeof s === "object" && s !== null ? s : JSON.parse(s));
}

async function saveBurn(entry) {
  const existing = await loadBurns();
  if (existing.some(b => b.txHash === entry.txHash)) return false;
  await redis.lpush(BURNS_KEY, JSON.stringify(entry));
  console.log(`[burn] ${entry.burner} burned ${entry.tokenIds.length} Greg(s): ${entry.tokenIds.join(", ")}`);
  return true;
}

async function loadUsernames() {
  return (await redis.hgetall(USERNAMES_KEY)) || {};
}

async function saveUsername(address, username) {
  await redis.hset(USERNAMES_KEY, { [address.toLowerCase()]: username });
}

async function loadPins() {
  const items = await redis.lrange(PINS_KEY, 0, -1);
  return items.map(s => typeof s === "object" && s !== null ? s : JSON.parse(s));
}

async function savePin(pin) {
  await redis.rpush(PINS_KEY, JSON.stringify(pin));
}

// ---- Leaderboard ----

const UPGRADE_TIERS = [
  { min: 100, label: "Commissioned Greg",   color: "#e2a63b", bg: "#2a1e0a" },
  { min:  50, label: "Colored Custom Greg", color: "#4caf80", bg: "#0f2a1a" },
  { min:  25, label: "B/W Custom Greg",     color: "#a78bfa", bg: "#1a1030" },
  { min:  15, label: "Holofoil Greg",       color: "#ff80f4", bg: "#1a0524" },
  { min:  10, label: "Inverse Greg",        color: "#5b8def", bg: "#0f1a30" },
];

function badge(total) {
  const t = UPGRADE_TIERS.find(u => total >= u.min);
  return t ? { label: t.label, tier: t.min, color: t.color, bg: t.bg } : null;
}

async function buildLeaderboard() {
  const [burns, usernames] = await Promise.all([loadBurns(), loadUsernames()]);
  const totals = {};
  for (const b of burns) {
    const key = b.burner.toLowerCase();
    if (!totals[key]) totals[key] = { address: b.burner, total: 0, txCount: 0 };
    totals[key].total += b.tokenIds.length;
    totals[key].txCount++;
  }
  return Object.values(totals)
    .map(e => ({ ...e, username: usernames[e.address.toLowerCase()] || null, badge: badge(e.total) }))
    .sort((a, b) => b.total - a.total);
}

// ---- Ethers / ABI ----

const GREG_CONTRACT  = process.env.GREG_CONTRACT_ADDRESS || "";
const DEAD_ADDRESS   = "0x000000000000000000000000000000000000dead";
const EVENT_TOPIC    = "0xe9bb3ec3c082662a89d457da26cd1f229d550c605d50491098bdc4d1adb30bb8";
const DEPLOY_BLOCK_HEX = "0x" + Number(DEPLOY_BLOCK).toString(16);

// Alchemy provider — used for live event listening only
const provider = new ethers.JsonRpcProvider(RPC_URL);
const BURNER_ABI = ["event GregsBurned(address indexed burner, uint256[] tokenIds, uint256 timestamp)"];
const iface    = new ethers.Interface(BURNER_ABI);
const contract = new ethers.Contract(BURNER_ADDRESS, BURNER_ABI, provider);

// ABI decode GregsBurned data: (uint256[] tokenIds, uint256 timestamp)
function decodeEventData(data) {
  const hex = data.startsWith("0x") ? data.slice(2) : data;
  const timestamp = parseInt(hex.slice(64, 128), 16);
  const numTokens = parseInt(hex.slice(128, 192), 16);
  const tokenIds = [];
  for (let i = 0; i < numTokens; i++) {
    tokenIds.push(parseInt(hex.slice(192 + i * 64, 256 + i * 64), 16));
  }
  return { tokenIds, timestamp };
}

async function alchemyRpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

// ---- Backfill via alchemy_getAssetTransfers (no eth_getLogs block-range limit) ----

async function backfill() {
  const existing = await loadBurns();
  if (existing.length > 0) {
    console.log(`Redis has ${existing.length} burns — skipping backfill.`);
    return;
  }
  if (!GREG_CONTRACT) {
    console.warn("GREG_CONTRACT_ADDRESS not set — skipping backfill. Webhook will handle new burns.");
    return;
  }
  console.log("Backfilling via alchemy_getAssetTransfers (no block-range limit)...");

  // Find all ERC-721 transfers of Greg tokens to the dead address
  let allTransfers = [], pageKey;
  do {
    const params = {
      fromBlock: DEPLOY_BLOCK_HEX,
      toBlock: "latest",
      toAddress: DEAD_ADDRESS,
      contractAddresses: [GREG_CONTRACT],
      category: ["erc721"],
      withMetadata: false,
      excludeZeroValue: true,
      maxCount: "0x3e8"
    };
    if (pageKey) params.pageKey = pageKey;
    const res = await alchemyRpc("alchemy_getAssetTransfers", [params]);
    allTransfers = allTransfers.concat(res.transfers || []);
    pageKey = res.pageKey;
  } while (pageKey);

  const uniqueTxHashes = [...new Set(allTransfers.map(t => t.hash))];
  console.log(`Found ${uniqueTxHashes.length} burn transaction(s).`);

  let count = 0;
  for (const txHash of uniqueTxHashes) {
    const receipt = await alchemyRpc("eth_getTransactionReceipt", [txHash]);
    if (!receipt) continue;
    const burnLog = receipt.logs.find(l =>
      l.address.toLowerCase() === BURNER_ADDRESS &&
      l.topics[0] === EVENT_TOPIC
    );
    if (!burnLog) continue;
    const burner = "0x" + burnLog.topics[1].slice(26);
    const { tokenIds, timestamp } = decodeEventData(burnLog.data);
    const saved = await saveBurn({
      burner, tokenIds,
      timestamp: new Date(timestamp * 1000).toISOString(),
      txHash, block: parseInt(receipt.blockNumber, 16)
    });
    if (saved) count++;
  }
  console.log(`Backfill complete — ${count} burns saved to Redis.`);
}

// ---- Live listener ----

function listenLive() {
  contract.on("GregsBurned", async (burner, tokenIds, timestamp, event) => {
    await saveBurn({
      burner,
      tokenIds:  tokenIds.map(id => Number(id)),
      timestamp: new Date(Number(timestamp) * 1000).toISOString(),
      txHash:    event.log.transactionHash,
      block:     event.log.blockNumber
    });
  });
  console.log("Listening for live GregsBurned events...");
}

// ---- Express ----

const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---- Alchemy webhook (GraphQL custom webhook) ----
// Point your Alchemy webhook to: https://greg-burner1-production.up.railway.app/api/webhook

app.post("/api/webhook", express.json({ limit: "2mb" }), async (req, res) => {
  try {
    const logs = req.body?.event?.data?.block?.logs || [];
    for (const log of logs) {
      if ((log.account?.address || "").toLowerCase() !== BURNER_ADDRESS) continue;
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === "GregsBurned") {
          await saveBurn({
            burner:    parsed.args.burner,
            tokenIds:  parsed.args.tokenIds.map(id => Number(id)),
            timestamp: new Date(Number(parsed.args.timestamp) * 1000).toISOString(),
            txHash:    log.transaction?.hash,
            block:     log.transaction?.blockNumber
          });
        }
      } catch (e) {
        console.error("[webhook] log decode error:", e.message);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[webhook] error:", e);
    res.status(500).json({ error: e.message });
  }
});

// ---- API endpoints ----

app.get("/api/burns", async (req, res) => {
  const [burns, usernames, keepers] = await Promise.all([
    loadBurns(),
    loadUsernames(),
    redis.hgetall("greg:keepers")
  ]);
  const parse = s => (typeof s === "object" && s !== null) ? s : JSON.parse(s);
  const keeperMap = keepers || {};
  const enriched = burns.map(b => {
    const k = keeperMap[b.txHash] ? parse(keeperMap[b.txHash]) : {};
    return {
      ...b,
      username:      usernames[b.burner.toLowerCase()] ?? null,
      keeperGreg:    k.keeperGreg    ?? b.keeperGreg    ?? null,
      customRequest: k.customRequest ?? b.customRequest ?? null
    };
  });
  res.json(enriched);
});

// POST /api/keepergreg — saves keeper Greg + optional username in one shot
app.post("/api/keepergreg", express.json(), async (req, res) => {
  const { txHash, keeperGreg, customRequest, username, address } = req.body || {};
  if (!txHash || keeperGreg == null) return res.status(400).json({ error: "txHash and keeperGreg required." });
  const entry = { keeperGreg: Number(keeperGreg), customRequest: (customRequest || "").toString().trim().slice(0, 280) || null };
  await redis.hset("greg:keepers", { [txHash]: JSON.stringify(entry) });
  // Save username at the same time if provided — no separate /api/register call needed
  if (username && address) {
    const trimmed = username.trim().replace(/[^\w\-. ]/g, "").slice(0, 32);
    if (trimmed) await redis.hset(USERNAMES_KEY, { [address.toLowerCase()]: trimmed });
  }
  console.log(`[keeper] tx ${txHash.slice(0,10)}… → Greg #${keeperGreg}${username ? ` | user: ${username}` : ""}`);
  res.json({ ok: true });
});

// Debug: inspect raw Redis state — remove or protect before going public
app.get("/api/debug/keepers", async (req, res) => {
  const raw = await redis.hgetall("greg:keepers");
  res.json(raw || {});
});
app.get("/api/debug/usernames", async (req, res) => {
  const raw = await redis.hgetall(USERNAMES_KEY);
  res.json(raw || {});
});

app.get("/api/leaderboard", async (req, res) => {
  res.json(await buildLeaderboard());
});

app.get("/api/pins", async (req, res) => {
  res.json(await loadPins());
});

app.post("/api/pins", express.json(), async (req, res) => {
  const { lat, lng, message, name } = req.body || {};
  if (typeof lat !== "number" || typeof lng !== "number" ||
      lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: "Invalid coordinates." });
  }
  const msg = (message || "").toString().trim().slice(0, 120);
  const nm  = (name || "").toString().trim().replace(/[<>"'&]/g, "").slice(0, 32);
  if (!msg) return res.status(400).json({ error: "Message required." });
  const pin = { id: Date.now(), lat, lng, message: msg, name: nm || null, timestamp: new Date().toISOString() };
  await savePin(pin);
  console.log(`[pin] ${nm || "anon"} at ${lat.toFixed(3)},${lng.toFixed(3)}`);
  res.json({ ok: true, pin });
});

app.post("/api/register", express.json(), async (req, res) => {
  const { address, username } = req.body || {};
  if (!address || !username) return res.status(400).json({ error: "address and username required." });
  const trimmed = username.trim().replace(/[^\w\-. ]/g, "").slice(0, 32);
  if (!trimmed) return res.status(400).json({ error: "Invalid username." });
  const burns = await loadBurns();
  if (!burns.some(b => b.burner.toLowerCase() === address.toLowerCase())) {
    return res.status(403).json({ error: "No burns found for this address." });
  }
  await saveUsername(address, trimmed);
  console.log(`[username] ${address} → "${trimmed}"`);
  res.json({ ok: true, username: trimmed });
});

// ---- Dashboard page ----

app.get("/", async (req, res) => {
  const [burns, board] = await Promise.all([loadBurns(), buildLeaderboard()]);
  const badgeHtml = b => b
    ? `<span style="display:inline-block;padding:2px 8px;border-radius:99px;font-size:.75rem;font-weight:700;background:${b.bg};color:${b.color};margin-left:6px;">${b.label}</span>`
    : "";
  const leaderRows = board.map((e, i) => `
    <tr>
      <td style="color:#9a9a9a;">#${i + 1}</td>
      <td>${e.username ? `<strong>${e.username}</strong>` : `<span style="color:#555;">—</span>`}${badgeHtml(e.badge)}</td>
      <td><a href="https://etherscan.io/address/${e.address}" target="_blank">${e.address.slice(0,6)}…${e.address.slice(-4)}</a></td>
      <td>${e.total}</td>
      <td>${e.txCount}</td>
    </tr>`).join("");
  const burnRows = burns.map(b => {
    const t = UPGRADE_TIERS.find(u => b.tokenIds.length >= u.min);
    const pill = t
      ? `<span style="padding:2px 7px;border-radius:99px;font-size:.72rem;font-weight:700;background:${t.bg};color:${t.color};margin-left:6px;">${t.label}</span>`
      : "";
    return `
    <tr>
      <td>${new Date(b.timestamp).toLocaleString()}</td>
      <td><a href="https://etherscan.io/address/${b.burner}" target="_blank">${b.burner.slice(0,6)}…${b.burner.slice(-4)}</a></td>
      <td>${b.tokenIds.length}${pill}</td>
      <td style="font-size:.8rem;color:#9a9a9a;">${b.tokenIds.join(", ")}</td>
      <td><a href="https://etherscan.io/tx/${b.txHash}" target="_blank">↗</a></td>
    </tr>`;
  }).join("");
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta http-equiv="refresh" content="30"/>
  <title>Greg Burn Dashboard</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #111317; color: #f0f0f0; padding: 30px; max-width: 900px; }
    h1 { margin-bottom: 4px; }
    h2 { font-size: 1rem; color: #9a9a9a; margin: 36px 0 10px; text-transform: uppercase; letter-spacing: .05em; }
    p.sub { color: #9a9a9a; margin-top: 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px; border-bottom: 1px solid #2a2d34; font-size: .9rem; }
    th { color: #9a9a9a; font-weight: 600; }
    a { color: #5b8def; text-decoration: none; }
  </style>
</head>
<body>
  <h1>Greg Burn Dashboard</h1>
  <p class="sub">Storage: Redis · Auto-refreshes every 30s.</p>
  <h2>Leaderboard</h2>
  <table>
    <tr><th>Rank</th><th>Username</th><th>Wallet</th><th>Total Burned</th><th>Txs</th></tr>
    ${leaderRows || "<tr><td colspan='5' style='color:#555;'>No burns yet.</td></tr>"}
  </table>
  <h2>All Burn Events (${burns.length})</h2>
  <table>
    <tr><th>Time</th><th>Burner</th><th>Count</th><th>Token IDs</th><th>Tx</th></tr>
    ${burnRows || "<tr><td colspan='5' style='color:#555;'>No burns yet.</td></tr>"}
  </table>
</body>
</html>`);
});

// ---- Start ----

backfill()
  .then(listenLive)
  .catch(err => console.error("Startup error:", err));

app.listen(PORT, () => console.log(`Dashboard running on http://localhost:${PORT}`));
