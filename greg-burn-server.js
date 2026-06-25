// Greg Burn Dashboard
// Watches the GregBurner contract for GregsBurned events and lists them.
// Also manages the username registry and leaderboard.
//
// Required env vars:
//   ALCHEMY_RPC_URL          - e.g. https://eth-mainnet.g.alchemy.com/v2/yourkey
//   BURNER_CONTRACT_ADDRESS  - deployed GregBurner contract address
//   DEPLOY_BLOCK             - block number GregBurner was deployed at (for backfill on startup)
//   PORT                     - optional, defaults to 3000

const express = require("express");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC_URL = process.env.ALCHEMY_RPC_URL;
const BURNER_ADDRESS = process.env.BURNER_CONTRACT_ADDRESS;
const DEPLOY_BLOCK = process.env.DEPLOY_BLOCK ? Number(process.env.DEPLOY_BLOCK) : 0;
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, "burns.json");
const USERNAMES_FILE = path.join(__dirname, "usernames.json");

if (!RPC_URL || !BURNER_ADDRESS) {
  console.error("Missing ALCHEMY_RPC_URL or BURNER_CONTRACT_ADDRESS env vars. See README.");
  process.exit(1);
}

const BURNER_ABI = [
  "event GregsBurned(address indexed burner, uint256[] tokenIds, uint256 timestamp)"
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const contract = new ethers.Contract(BURNER_ADDRESS, BURNER_ABI, provider);

// ---- Storage helpers ----

function loadBurns() {
  if (!fs.existsSync(DB_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch { return []; }
}

function saveBurns(burns) {
  fs.writeFileSync(DB_FILE, JSON.stringify(burns, null, 2));
}

function loadUsernames() {
  if (!fs.existsSync(USERNAMES_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USERNAMES_FILE, "utf8")); } catch { return {}; }
}

function saveUsernames(map) {
  fs.writeFileSync(USERNAMES_FILE, JSON.stringify(map, null, 2));
}

function addBurn(entry) {
  const burns = loadBurns();
  if (burns.some(b => b.txHash === entry.txHash)) return;
  burns.unshift(entry);
  saveBurns(burns);
  console.log(`[burn] ${entry.burner} burned ${entry.tokenIds.length} Greg(s): ${entry.tokenIds.join(", ")}`);
}

// ---- Leaderboard helpers ----

const UPGRADE_TIERS = [
  { min: 100, label: "Commissioned Greg",    color: "#e2a63b", bg: "#2a1e0a" },
  { min:  50, label: "Colored Custom Greg",  color: "#4caf80", bg: "#0f2a1a" },
  { min:  25, label: "B/W Custom Greg",      color: "#a78bfa", bg: "#1a1030" },
  { min:  10, label: "Inverse Greg",         color: "#5b8def", bg: "#0f1a30" },
];

function BADGE(total) {
  const t = UPGRADE_TIERS.find(u => total >= u.min);
  if (!t) return null;
  return { label: t.label, tier: t.min, color: t.color, bg: t.bg };
}

function tierForBurn(count) {
  const t = UPGRADE_TIERS.find(u => count >= u.min);
  return t ? t.label : null;
}

function buildLeaderboard() {
  const burns = loadBurns();
  const usernames = loadUsernames();
  const totals = {};
  for (const b of burns) {
    const key = b.burner.toLowerCase();
    if (!totals[key]) totals[key] = { address: b.burner, total: 0, txCount: 0 };
    totals[key].total += b.tokenIds.length;
    totals[key].txCount++;
  }
  return Object.values(totals)
    .map(e => {
      const u = usernames[e.address.toLowerCase()];
      return {
        ...e,
        username: u ? (u.username || u) : null,
        keeperGreg: u ? (u.keeperGreg || null) : null,
        badge: BADGE(e.total)
      };
    })
    .sort((a, b) => b.total - a.total);
}

// ---- Event ingestion ----

async function backfill() {
  console.log(`Backfilling GregsBurned events from block ${DEPLOY_BLOCK}...`);
  const latest = await provider.getBlockNumber();
  const CHUNK = 10;
  for (let from = DEPLOY_BLOCK; from <= latest; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, latest);
    const events = await contract.queryFilter(contract.filters.GregsBurned(), from, to);
    for (const ev of events) {
      addBurn({
        burner: ev.args.burner,
        tokenIds: ev.args.tokenIds.map(id => Number(id)),
        timestamp: new Date(Number(ev.args.timestamp) * 1000).toISOString(),
        txHash: ev.transactionHash,
        block: ev.blockNumber
      });
    }
  }
  console.log("Backfill complete.");
}

function listenLive() {
  contract.on("GregsBurned", async (burner, tokenIds, timestamp, event) => {
    addBurn({
      burner,
      tokenIds: tokenIds.map(id => Number(id)),
      timestamp: new Date(Number(timestamp) * 1000).toISOString(),
      txHash: event.log.transactionHash,
      block: event.log.blockNumber
    });
  });
  console.log("Listening for live GregsBurned events...");
}

// ---- Express app ----

const app = express();
app.use(express.json());

// CORS — allow the burn page (any origin) to hit this API
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ---- API endpoints ----

// GET /api/burns  — raw event list
app.get("/api/burns", (req, res) => {
  res.json(loadBurns());
});

// GET /api/leaderboard  — aggregated, ranked, with usernames + badges
app.get("/api/leaderboard", (req, res) => {
  res.json(buildLeaderboard());
});

// POST /api/register  — claim a username for a wallet that has burns
// Body: { address, username, keeperGreg? }
app.post("/api/register", (req, res) => {
  const { address, username, keeperGreg } = req.body || {};
  if (!address || !username) {
    return res.status(400).json({ error: "address and username are required." });
  }

  const trimmed = username.trim().replace(/[^\w\-. ]/g, "").slice(0, 32);
  if (!trimmed) return res.status(400).json({ error: "Invalid username." });

  // Only allow registration if this address has actually burned
  const burns = loadBurns();
  const hasBurns = burns.some(b => b.burner.toLowerCase() === address.toLowerCase());
  if (!hasBurns) {
    return res.status(403).json({ error: "No burns found for this address." });
  }

  const usernames = loadUsernames();
  const key = address.toLowerCase();
  usernames[key] = { username: trimmed, keeperGreg: keeperGreg || null };
  saveUsernames(usernames);
  console.log(`[username] ${address} registered as "${trimmed}"${keeperGreg ? `, keeper Greg: #${keeperGreg}` : ""}`);
  res.json({ ok: true, username: trimmed });
});

// ---- Dashboard page ----

app.get("/", (req, res) => {
  const burns = loadBurns();
  const board = buildLeaderboard();

  const badgeHtml = (b) => b
    ? `<span style="display:inline-block;padding:2px 8px;border-radius:99px;font-size:0.75rem;font-weight:700;background:${b.bg};color:${b.color};margin-left:6px;">${b.label}</span>`
    : "";

  const leaderRows = board.map((e, i) => `
    <tr>
      <td style="color:#9a9a9a;">#${i + 1}</td>
      <td>${e.username ? `<strong>${e.username}</strong>` : `<span style="color:#555;">—</span>`}${badgeHtml(e.badge)}</td>
      <td><a href="https://etherscan.io/address/${e.address}" target="_blank">${e.address.slice(0,6)}…${e.address.slice(-4)}</a></td>
      <td>${e.total}</td>
      <td>${e.txCount}</td>
      <td>${e.keeperGreg ? `<a href="https://opensea.io/assets/ethereum/${BURNER_ADDRESS}/${e.keeperGreg}" target="_blank">#${e.keeperGreg}</a>` : `<span style="color:#555;">—</span>`}</td>
    </tr>`).join("");

  const burnRows = burns.map(b => {
    const tier = tierForBurn(b.tokenIds.length);
    const t    = UPGRADE_TIERS.find(u => b.tokenIds.length >= u.min);
    const pill = t
      ? `<span style="display:inline-block;padding:2px 7px;border-radius:99px;font-size:0.72rem;font-weight:700;background:${t.bg};color:${t.color};margin-left:6px;">${t.label}</span>`
      : "";
    return `
    <tr>
      <td>${new Date(b.timestamp).toLocaleString()}</td>
      <td><a href="https://etherscan.io/address/${b.burner}" target="_blank">${b.burner.slice(0,6)}…${b.burner.slice(-4)}</a></td>
      <td>${b.tokenIds.length}${pill}</td>
      <td style="font-size:0.8rem;color:#9a9a9a;">${b.tokenIds.join(", ")}</td>
      <td><a href="https://etherscan.io/tx/${b.txHash}" target="_blank">↗</a></td>
    </tr>`;
  }).join("");

  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="30" />
  <title>Greg Burn Dashboard</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #111317; color: #f0f0f0; padding: 30px; max-width: 900px; }
    h1 { margin-bottom: 4px; }
    h2 { font-size: 1rem; color: #9a9a9a; margin: 36px 0 10px; text-transform: uppercase; letter-spacing: 0.05em; }
    p.sub { color: #9a9a9a; margin-top: 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px; border-bottom: 1px solid #2a2d34; font-size: 0.9rem; }
    th { color: #9a9a9a; font-weight: 600; }
    a { color: #5b8def; text-decoration: none; }
  </style>
</head>
<body>
  <h1>Greg Burn Dashboard</h1>
  <p class="sub">Auto-refreshes every 30s.</p>

  <h2>Leaderboard</h2>
  <table>
    <tr><th>Rank</th><th>Username</th><th>Wallet</th><th>Total Burned</th><th>Txs</th><th>Keeper Greg</th></tr>
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

backfill().then(listenLive);

app.listen(PORT, () => console.log(`Dashboard running on http://localhost:${PORT}`));
