const express = require("express");
const { ethers } = require("ethers");
const { Redis } = require("@upstash/redis");

const BURNER_ADDRESS = process.env.BURNER_CONTRACT_ADDRESS;
const PORT = process.env.PORT || 3000;

if (!BURNER_ADDRESS) {
  console.error("Missing BURNER_CONTRACT_ADDRESS env var.");
  process.exit(1);
}
if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN env vars.");
  process.exit(1);
}

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const BURNER_ABI = ["event GregsBurned(address indexed burner, uint256[] tokenIds, uint256 timestamp)"];
const iface = new ethers.Interface(BURNER_ABI);

const TIERS = [
  { min: 50, label: "Colored Custom Greg" },
  { min: 25, label: "B/W Custom Greg" },
  { min: 10, label: "Inverse Greg" }
];

function tierLabel(n) {
  const t = TIERS.find(function(t) { return n >= t.min; });
  return t ? t.label : null;
}

async function loadBurns() {
  const data = await redis.get("burns");
  if (!data) return [];
  if (Array.isArray(data)) return data;
  try { return JSON.parse(data); } catch { return []; }
}

async function saveBurns(burns) {
  await redis.set("burns", JSON.stringify(burns));
}

async function loadUsernames() {
  const data = await redis.get("usernames");
  if (!data) return {};
  if (typeof data === "object" && !Array.isArray(data)) return data;
  try { return JSON.parse(data); } catch { return {}; }
}

async function saveUsernames(u) {
  await redis.set("usernames", JSON.stringify(u));
}

async function addBurn(entry) {
  const burns = await loadBurns();
  if (burns.some(function(b) { return b.txHash === entry.txHash; })) return;
  burns.unshift(entry);
  await saveBurns(burns);
  console.log("[burn] " + entry.burner + " burned " + entry.tokenIds.length + " Greg(s)");
}

async function buildLeaderboard() {
  const burns = await loadBurns();
  const usernames = await loadUsernames();
  const totals = {};
  for (let i = 0; i < burns.length; i++) {
    const b = burns[i];
    const key = b.burner.toLowerCase();
    if (!totals[key]) totals[key] = { address: b.burner, total: 0, txCount: 0 };
    totals[key].total += b.tokenIds.length;
    totals[key].txCount++;
  }
  return Object.values(totals).map(function(e) {
    const u = usernames[e.address.toLowerCase()];
    return {
      address: e.address,
      total: e.total,
      txCount: e.txCount,
      username: u ? (u.username || u) : null,
      keeperGreg: u ? (u.keeperGreg || null) : null
    };
  }).sort(function(a, b) { return b.total - a.total; });
}

const app = express();
app.use(express.json());

app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/api/burns", async function(req, res) {
  try {
    const burns = await loadBurns();
    const usernames = await loadUsernames();
    const enriched = burns.map(function(b) {
      const u = usernames[b.burner.toLowerCase()];
      return Object.assign({}, b, { username: u ? (u.username || null) : null });
    });
    res.json(enriched);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/leaderboard", async function(req, res) {
  try { res.json(await buildLeaderboard()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/webhook", async function(req, res) {
  try {
    const block = req.body && req.body.event && req.body.event.data && req.body.event.data.block;
    const logs = (block && block.logs) ? block.logs : [];
    const blockNum = block ? block.number : null;
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        if (parsed && parsed.name === "GregsBurned") {
          await addBurn({
            burner: parsed.args.burner,
            tokenIds: parsed.args.tokenIds.map(function(id) { return Number(id); }),
            timestamp: new Date(Number(parsed.args.timestamp) * 1000).toISOString(),
            txHash: log.transaction.hash,
            block: blockNum
          });
        }
      } catch (e) { /* not our event, skip */ }
    }
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e.message);
    res.sendStatus(500);
  }
});

app.post("/api/keepergreg", async function(req, res) {
  try {
    const body = req.body || {};
    const txHash = body.txHash;
    const keeperGreg = body.keeperGreg;
    const customRequest = body.customRequest;
    if (!txHash || !keeperGreg) return res.status(400).json({ error: "txHash and keeperGreg required." });
    const burns = await loadBurns();
    const burn = burns.find(function(b) { return b.txHash === txHash; });
    if (!burn) return res.status(404).json({ error: "Burn not found yet." });
    burn.keeperGreg = Number(keeperGreg);
    if (customRequest) burn.customRequest = customRequest.trim().slice(0, 500);
    await saveBurns(burns);
    console.log("[keepergreg] tx=" + txHash.slice(0, 10) + " keeper=#" + keeperGreg + (customRequest ? " req=" + customRequest.slice(0, 30) : ""));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/register", async function(req, res) {
  try {
    const body = req.body || {};
    const address = body.address;
    const username = body.username;
    const keeperGreg = body.keeperGreg;
    if (!address || !username) return res.status(400).json({ error: "address and username required." });
    const trimmed = username.trim().replace(/[^\w\-. ]/g, "").slice(0, 32);
    if (!trimmed) return res.status(400).json({ error: "Invalid username." });
    const burns = await loadBurns();
    const hasBurns = burns.some(function(b) { return b.burner.toLowerCase() === address.toLowerCase(); });
    if (!hasBurns) return res.status(403).json({ error: "No burns found for this address." });
    const usernames = await loadUsernames();
    usernames[address.toLowerCase()] = { username: trimmed, keeperGreg: keeperGreg || null };
    await saveUsernames(usernames);
    console.log("[username] " + address + " => " + trimmed + (keeperGreg ? ", keeper: #" + keeperGreg : ""));
    res.json({ ok: true, username: trimmed });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/", async function(req, res) {
  try {
    const board = await buildLeaderboard();
    const burns = await loadBurns();
    const rows = board.map(function(e, i) {
      return "<tr><td>#" + (i + 1) + "</td><td>" + (e.username || "—") + "</td><td>" + e.address.slice(0, 6) + "…" + e.address.slice(-4) + "</td><td>" + e.total + "</td><td>" + (e.keeperGreg ? "#" + e.keeperGreg : "—") + "</td></tr>";
    }).join("");
    const burnRows = burns.map(function(b) {
      return "<tr><td>" + new Date(b.timestamp).toLocaleString() + "</td><td>" + b.burner.slice(0, 6) + "…" + b.burner.slice(-4) + "</td><td>" + b.tokenIds.length + " (" + (tierLabel(b.tokenIds.length) || "—") + ")</td><td>" + (b.keeperGreg ? "#" + b.keeperGreg : "—") + "</td><td><a href='https://etherscan.io/tx/" + b.txHash + "' target='_blank'>↗</a></td></tr>";
    }).join("");
    res.send("<!DOCTYPE html><html><head><meta charset='utf-8'/><meta http-equiv='refresh' content='30'/><title>Greg Burn Dashboard</title><style>body{font-family:sans-serif;background:#111;color:#f0f0f0;padding:30px;max-width:900px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #2a2d34;font-size:.9rem}th{color:#9a9a9a}a{color:#5b8def;text-decoration:none}h2{color:#9a9a9a;font-size:1rem;text-transform:uppercase;margin:36px 0 10px}</style></head><body><h1>Greg Burn Dashboard</h1><h2>Leaderboard</h2><table><tr><th>#</th><th>Username</th><th>Wallet</th><th>Burned</th><th>Keeper Greg</th></tr>" + (rows || "<tr><td colspan='5'>No burns yet.</td></tr>") + "</table><h2>All Burns (" + burns.length + ")</h2><table><tr><th>Time</th><th>Burner</th><th>Count</th><th>Keeper</th><th>Tx</th></tr>" + (burnRows || "<tr><td colspan='5'>No burns yet.</td></tr>") + "</table></body></html>");
  } catch (e) { res.status(500).send("Error: " + e.message); }
});

app.listen(PORT, function() {
  console.log("Dashboard running on port " + PORT);
});
