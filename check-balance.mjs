import "dotenv/config";
import crypto from "crypto";

function buildJWT(method, path) {
  const apiKey     = process.env.COINBASE_API_KEY;
  const privateKey = process.env.COINBASE_PRIVATE_KEY.replace(/\\n/g, "\n");
  const now   = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString("hex");
  const uri   = `${method} api.coinbase.com${path}`;
  const header  = Buffer.from(JSON.stringify({ alg: "ES256", kid: apiKey, nonce })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: apiKey, iss: "cdp", nbf: now, exp: now + 120, uri })).toString("base64url");
  const sigInput = `${header}.${payload}`;
  const keyObject = crypto.createPrivateKey(privateKey);
  const sig = crypto.sign("SHA256", Buffer.from(sigInput), {
    key: keyObject, dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${sigInput}.${sig}`;
}

// Fetch all pages of accounts
async function fetchAllAccounts() {
  let all = [];
  let cursor = "";
  let page = 0;
  const basePath = "/api/v3/brokerage/accounts";
  while (true) {
    const query = `?limit=250${cursor ? `&cursor=${cursor}` : ""}`;
    const res  = await fetch(`https://api.coinbase.com${basePath}${query}`, {
      headers: { Authorization: `Bearer ${buildJWT("GET", basePath)}` },
    });
    const data = await res.json();
    all = all.concat(data.accounts || []);
    page++;
    if (!data.has_next || !data.cursor) break;
    cursor = data.cursor;
    if (page > 10) break; // safety
  }
  console.log(`Fetched ${all.length} accounts across ${page} page(s)\n`);
  return all;
}

const accounts = await fetchAllAccounts();

const usdBal = accounts
  .filter(a => a.currency === "USDC" || a.currency === "USD")
  .reduce((sum, a) => sum + parseFloat(a.available_balance?.value || 0), 0);

console.log("=== COINBASE LIVE BALANCES ===\n");
const COINS = ["BTC","ETH","SOL","LINK","DOGE","AKT","USD","USDC"];
for (const base of COINS) {
  const bal = accounts
    .filter(a => a.currency === base)
    .reduce((max, a) => Math.max(max, parseFloat(a.available_balance?.value || 0)), 0);
  const hold = accounts
    .filter(a => a.currency === base)
    .reduce((sum, a) => sum + parseFloat(a.hold?.value || 0), 0);
  if (bal > 0 || hold > 0) console.log(`  ${base.padEnd(6)} avail=${bal}  hold=${hold}`);
}
console.log(`\n  USD+USDC total: $${usdBal.toFixed(2)}`);

console.log(`\nAll accounts with any value:`);
for (const a of accounts) {
  const v = parseFloat(a.available_balance?.value || 0);
  const h = parseFloat(a.hold?.value || 0);
  if (v > 0.000001 || h > 0.01) {
    console.log(`  ${a.currency.padEnd(8)} avail=${v}  hold=${h}  type=${a.type || a.account_type}`);
  }
}
