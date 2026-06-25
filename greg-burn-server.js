const express = require("express");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const BURNER_ADDRESS = process.env.BURNER_CONTRACT_ADDRESS;
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "burns.json");
const USERNAMES_FILE = path.join(__dirname, "usernames.json");

if (!BURNER_ADDRESS) {
  console.error("Missing BURNER_CONTRACT_ADDRESS env var.");
  process.exit(1);
}

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

function loadBurns() {
  if (!fs.existsSync(DB_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) { return []; }
}

function saveBurns(b) {
  fs.writeFileSync(DB_FILE, JSON.stringify(b, null, 2));
}

function loadUsernames() {
  if (!fs.existsSync(USERNAMES_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USERNAMES_FILE, "utf8")); } catch (e) { return {}; }
}

function saveUsernames(u) {
  fs.writeFileSync(USERNAMES_FILE, JSON.stringify(u, null, 2));
}

function addBurn(entry) {
  const burns = loadBurns();
  if (burns.some(function(b) { return b.txHash === entry.txHash; })) return;
  burns.unshift(entry);
  saveBurns(burns);
  console.log("[burn] " + entry.burner + " burned " + entry.tokenIds.length + " Greg(s)");
}

function buildLeaderboard() {
  const burns = loadBurns();
  const usernames = loadUsernames();
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

app.get("/api/burns", function(req, res) {
  res.json(loadBurns());
});

app.get("/api/leaderboard", function(req, res) {
  res.json(buildLeaderboard());
});

app.post("/api/webhook", function(req, res) {
  try {
    const block = req.body && req.body.event && req.body.event.data && req.body.event.data.block;
    const logs = (block && block.logs) ? block.logs : [];
    const blockNum = block ? block.number : null;
    for (let i = 0; i < logs.length; i++) {
      const log = logs[i];
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        if (parsed && parsed.name === "GregsBurned") {
          addBurn({
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

app.post("/api/register", function(req, res) {
  const body = req.body || {};
  const address = body.address;
  const username = body.username;
  const keeperGreg = body.keeperGreg;
  if (!address || !username) {
    return res.status(400).json({ error: "address and username required." });
  }
  const trimmed = username.trim().replace(/[^\w\-. ]/g, "").slice(0, 32);
  if (!trimmed) return res.status(400).json({ error: "Invalid username." });
  const burns = loadBurns();
  const hasBurns = burns.some(function(b) { return b.burner.toLowerCase() === address.toLowerCase(); });
  if (!hasBurns) return res.status(403).json({ error: "No burns found for this address." });
  const usernames = loadUsernames();
  usernames[address.toLowerCase()] = { username: trimmed, keeperGreg: keeperGreg || null };
  saveUsernames(usernames);
  console.log("[username] " + address + " => " + trimmed + (keeperGreg ? ", keeper: #" + keeperGreg : ""));
  res.json({ ok: true, username: trimmed });
});

app.get("/", function(req, res) {
  const board = buildLeaderboard();
  const burns = loadBurns();
  const rows = board.map(function(e, i) {
    return "<tr><td>#" + (i + 1) + "</td><td>" + (e.username || "—") + "</td><td>" + e.address.slice(0, 6) + "…" + e.address.slice(-4) + "</td><td>" + e.total + "</td><td>" + (e.keeperGreg ? "#" + e.keeperGreg : "—") + "</td></tr>";
  }).join("");
  const burnRows = burns.map(function(b) {
    return "<tr><td>" + new Date(b.timestamp).toLocaleString() + "</td><td>" + b.burner.slice(0, 6) + "…" + b.burner.slice(-4) + "</td><td>" + b.tokenIds.length + " (" + (tierLabel(b.tokenIds.length) || "—") + ")</td><td>" + b.tokenIds.join(", ") + "</td><td><a href='https://etherscan.io/tx/" + b.txHash + "' target='_blank'>↗</a></td></tr>";
  }).join("");
  res.send("<!DOCTYPE html><html><head><meta charset='utf-8'/><meta http-equiv='refresh' content='30'/><title>Greg Burn Dashboard</title><style>body{font-family:sans-serif;background:#111;color:#f0f0f0;padding:30px;max-width:900px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #2a2d34;font-size:.9rem}th{color:#9a9a9a}a{color:#5b8def;text-decoration:none}h2{color:#9a9a9a;font-size:1rem;text-transform:uppercase;margin:36px 0 10px}</style></head><body><h1>Greg Burn Dashboard</h1><h2>Leaderboard</h2><table><tr><th>#</th><th>Username</th><th>Wallet</th><th>Burned</th><th>Keeper Greg</th></tr>" + (rows || "<tr><td colspan='5'>No burns yet.</td></tr>") + "</table><h2>All Burns (" + burns.length + ")</h2><table><tr><th>Time</th><th>Burner</th><th>Count</th><th>Token IDs</th><th>Tx</th></tr>" + (burnRows || "<tr><td colspan='5'>No burns yet.</td></tr>") + "</table></body></html>");
});

app.listen(PORT, function() {
  console.log("Dashboard running on port " + PORT);
});
