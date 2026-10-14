// Dynasty Desk relay: signs in to MyFantasyLeague with the owner's account
// (from Netlify environment variables) and returns everything the app needs.
//
// Environment variables (Netlify > Site configuration > Environment variables):
//   MFL_USERNAME  your MFL login
//   MFL_PASSWORD  your MFL password
//   APP_PIN       any PIN you choose; the app asks for it once per device
//   MFL_YEAR      optional, defaults to 2026

export const config = { path: "/api/mfl" };

const YEAR = process.env.MFL_YEAR || "2026";
const API_HOST = "https://api.myfantasyleague.com";
const API = `${API_HOST}/${YEAR}`;
const UA = "DynastyDesk/1.0";
const NFL = ["ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GBP","HOU","IND","JAC","KCC","LAC","LAR","LVR","MIA","MIN","NEP","NOS","NYG","NYJ","PHI","PIT","SEA","SFO","TBB","TEN","WAS"];

let cookie = null; // reused while this function instance stays warm

// MFL returns a single object instead of a one-item list; normalize to arrays.
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

async function login() {
  const user = (process.env.MFL_USERNAME || "").trim(), pass = (process.env.MFL_PASSWORD || "").trim();
  if (!user || !pass) throw httpError(500, "MFL_USERNAME or MFL_PASSWORD isn't reaching the function. Check both are set for Production in Netlify, then redeploy.");
  const params = new URLSearchParams({ USERNAME: user, PASSWORD: pass, XML: "1" });
  const tryLogin = async (method) => {
    const res = await fetch(method === "GET" ? `${API}/login?${params}` : `${API}/login`, {
      method,
      headers: { "user-agent": UA, ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: method === "POST" ? params : undefined,
    });
    const text = await res.text();
    const fromBody = text.match(/cookie_value="([^"]+)"/)?.[1];
    const fromHeader = (res.headers?.get?.("set-cookie") || "").match(/MFL_USER_ID=([^;]+)/)?.[1];
    return { value: fromBody || fromHeader, text, status: res.status };
  };
  let r = await tryLogin("POST");
  if (!r.value) r = await tryLogin("GET");
  if (!r.value) {
    const said = r.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    throw httpError(401, `MFL login failed for username "${user}" (HTTP ${r.status}). MFL said: ${said || "nothing"}`);
  }
  cookie = r.value;
  return cookie;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function mfl(url, { auth = true, retry = true } = {}) {
  if (auth && !cookie) await login();
  const res = await fetch(url, {
    headers: { "user-agent": UA, ...(auth ? { cookie: `MFL_USER_ID=${cookie}` } : {}) },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw httpError(502, `MFL sent an unexpected reply (${res.status}).`); }
  if (data.error) {
    const msg = typeof data.error === "string" ? data.error : data.error.$t || JSON.stringify(data.error);
    if (auth && retry && /login|cookie|authorized|permission/i.test(msg)) {
      cookie = null;
      return mfl(url, { auth, retry: false });
    }
    throw httpError(502, `MFL: ${msg}`);
  }
  return data;
}

const exportUrl = (host, type, params = {}) =>
  `${host}/${YEAR}/export?` + new URLSearchParams({ TYPE: type, ...params, JSON: "1" });

// Your head-to-head matchup for the week: both teams' MFL starters, live points and time left.
async function liveFor(host, league, fid, week) {
  const side = (f) => ({
    id: f.id,
    score: f.score === "" || f.score == null ? null : +f.score,
    yet: +f.playersYetToPlay || 0,
    playing: +f.playersCurrentlyPlaying || 0,
    players: Object.fromEntries(arr(f.players?.player).map((p) => [p.id, {
      score: p.score === "" || p.score == null ? null : +p.score,
      secs: p.gameSecondsRemaining === "" || p.gameSecondsRemaining == null ? null : +p.gameSecondsRemaining,
      starter: p.status === "starter",
    }])),
  });
  try {
    const ls = await mfl(exportUrl(host, "liveScoring", { L: league, W: week, DETAILS: "1" }));
    for (const m of arr(ls.liveScoring?.matchup)) {
      const fs = arr(m.franchise), me = fs.find((f) => f.id === fid);
      if (me) { const opp = fs.find((f) => f.id !== fid); return { me: side(me), opp: opp ? side(opp) : null }; }
    }
  } catch { /* fall back to the schedule below */ }
  try {
    const sc = await mfl(exportUrl(host, "schedule", { L: league, W: week }));
    for (const ws of arr(sc.schedule?.weeklySchedule)) {
      for (const m of arr(ws.matchup)) {
        const fs = arr(m.franchise);
        if (fs.some((f) => f.id === fid)) {
          const opp = fs.find((f) => f.id !== fid);
          return { me: { id: fid, score: null, players: {} }, opp: opp ? { id: opp.id, score: null, players: {} } : null };
        }
      }
    }
  } catch { /* no matchup info */ }
  return null;
}

async function liveAll(week, list) {
  return Promise.all(list.map(async ({ id, host, fid }) => ({ id, live: await liveFor(host, id, fid, week) })));
}

async function loadWeek(week) {
  // Your leagues, with your franchise in each and the server MFL currently hosts it on.
  const my = await mfl(exportUrl(API_HOST, "myleagues", { FRANCHISE_NAMES: "1" }));
  const mine = arr(my.leagues?.league).map((l) => ({
    id: l.league_id,
    name: l.name,
    fid: l.franchise_id,
    host: (l.url || "").match(/^https?:\/\/[^/]+/)?.[0] || "https://api.myfantasyleague.com",
  }));
  if (!mine.length) throw httpError(404, `No ${YEAR} leagues found for this MFL account.`);

  const sched = await mfl(exportUrl(API_HOST, "nflSchedule", week ? { W: week } : {}), { auth: false });
  const wk = week || sched.nflSchedule?.week;
  const games = arr(sched.nflSchedule?.matchup).map((m) => {
    const [a, h] = arr(m.team);
    const away = a.isHome === "1" ? h : a, home = a.isHome === "1" ? a : h;
    const side = (t) => ({ id: t.id, passD: +t.passDefenseRank || null, rushD: +t.rushDefenseRank || null });
    return { kickoff: +m.kickoff, away: side(away), home: side(home) };
  });
  const playing = new Set(games.flatMap((g) => [g.away.id, g.home.id]));
  const byes = games.length ? NFL.filter((t) => !playing.has(t)) : [];

  const leagues = await Promise.all(
    mine.map(async (l) => {
      const [league, rosters, rules] = await Promise.all([
        mfl(exportUrl(l.host, "league", { L: l.id })),
        mfl(exportUrl(l.host, "rosters", { L: l.id, FRANCHISE: l.fid })),
        mfl(exportUrl(l.host, "rules", { L: l.id })),
      ]);
      const roster = arr(arr(rosters.rosters?.franchise)[0]?.player).map((p) => p.id);
      const live = await liveFor(l.host, l.id, l.fid, wk);
      const oppIds = live?.opp ? Object.keys(live.opp.players) : [];
      const projIds = [...new Set([...roster, ...oppIds])];
      const proj = {};
      await Promise.all(chunks(projIds, 250).map(async (c) => {
        const ps = await mfl(exportUrl(l.host, "projectedScores", { L: l.id, W: wk, PLAYERS: c.join(",") }));
        arr(ps.projectedScores?.playerScore).forEach((p) => { if (p.score !== "") proj[p.id] = +p.score; });
      }));
      const lg = league.league || {};
      const groups = arr(rules.rules?.positionRules);
      return {
        id: l.id,
        host: l.host,
        name: lg.name || l.name,
        fid: l.fid,
        starters: {
          count: +lg.starters?.count || 0,
          limits: Object.fromEntries(arr(lg.starters?.position).map((p) => {
            const [lo, hi] = String(p.limit).split("-").map(Number);
            return [p.name, [lo, hi ?? lo]];
          })),
        },
        partialLineupAllowed: lg.partialLineupAllowed === "YES",
        teBonus: groups.some((g) => g.positions === "TE"),
        franchises: arr(lg.franchises?.franchise).map((f) => ({
          id: f.id,
          name: String(f.name || "").replace(/<[^>]*>/g, "").trim(),
          faab: f.bbidAvailableBalance != null ? +f.bbidAvailableBalance : null,
          icon: (f.icon || f.logo || "").replace(/^http:\/\//, "https://") || null,
          waiver: +f.waiverSortOrder || null,
        })),
        faabLimit: +lg.bbidSeasonLimit || null,
        rosterSize: +lg.rosterSize || null,
        waiverType: lg.currentWaiverType || "",
        roster,
        proj,
        live,
      };
    })
  );

  const ids = [...new Set(leagues.flatMap((l) => [...l.roster, ...(l.live?.opp ? Object.keys(l.live.opp.players) : [])]))];
  const players = {};
  await Promise.all(chunks(ids, 300).map(async (c) => {
    const pl = await mfl(exportUrl(API_HOST, "players", { PLAYERS: c.join(",") }), { auth: false });
    arr(pl.players?.player).forEach((p) => {
      const [last, first] = String(p.name).split(", ");
      players[p.id] = { name: first ? `${first} ${last}` : p.name, pos: p.position, team: p.team, rookie: p.status === "R" };
    });
  }));

  const injuries = {};
  try {
    const inj = await mfl(exportUrl(API_HOST, "injuries", { W: wk }), { auth: false });
    arr(inj.injuries?.injury).forEach((i) => { injuries[i.id] = { status: i.status, details: i.details || "" }; });
  } catch { /* injuries are optional */ }

  return { year: YEAR, week: +wk, generated: Date.now(), games, byes, players, injuries, leagues };
}

async function submitLineup({ league, host, week, starters }) {
  if (!league || !week || !Array.isArray(starters) || !starters.length) throw httpError(400, "Missing league, week or starters.");
  if (!okHost(host)) throw httpError(400, "Unknown league server.");
  if (!cookie) await login();
  const send = () =>
    fetch(`${host}/${YEAR}/import`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, cookie: `MFL_USER_ID=${cookie}` },
      body: new URLSearchParams({ TYPE: "lineup", L: league, W: String(week), STARTERS: starters.join(",") }),
    }).then((r) => r.text());
  let reply = await send();
  if (/login|cookie|not authorized/i.test(reply) && !/<status>OK/i.test(reply)) { await login(); reply = await send(); }
  if (/<status>\s*OK/i.test(reply)) return { ok: true };
  const msg = reply.match(/<error>([\s\S]*?)<\/error>/i)?.[1] || reply.replace(/<[^>]+>/g, " ").trim().slice(0, 200);
  throw httpError(502, `MFL didn't accept the lineup: ${msg}`);
}

const okHost = (h) => /^https:\/\/[a-z0-9]+\.myfantasyleague\.com$/.test(h || "");
const chunks = (a, n) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function pending(host, league) {
  try {
    const p = await mfl(exportUrl(host, "pendingWaivers", { L: league }));
    // Collect every claim MFL lists for your franchise, whatever its exact shape.
    // MFL can pack several bids into one entry (e.g. "a_14_b,c_6_d"), so pull out every player_bid_drop it lists.
    const out = [];
    const walk = (x) => {
      if (typeof x === "string") { for (const m of x.matchAll(/(\d{3,6})_(\d+(?:\.\d+)?)_(\d{3,6}|0)/g)) out.push(m[0]); return; }
      if (Array.isArray(x)) return x.forEach(walk);
      if (x && typeof x === "object") Object.values(x).forEach(walk);
    };
    walk(p.pendingWaivers);
    return [...new Set(out)];
  } catch { return null; }
}

async function freeAgents({ league, host, week }) {
  if (!okHost(host)) throw httpError(400, "Unknown league server.");
  const fa = await mfl(exportUrl(host, "freeAgents", { L: league }));
  const ids = [];
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === "object") { if (typeof x.id === "string" && /^\d+$/.test(x.id)) ids.push(x.id); Object.values(x).forEach((v) => typeof v === "object" && walk(v)); }
  };
  walk(fa.freeAgents);
  const players = {}, wanted = new Set(ids);
  await Promise.all(chunks([...wanted], 300).map(async (c) => {
    const pl = await mfl(exportUrl(API_HOST, "players", { PLAYERS: c.join(",") }), { auth: false });
    arr(pl.players?.player).forEach((p) => {
      if (!wanted.has(p.id) || !["QB", "RB", "WR", "TE"].includes(p.position)) return;
      const [last, first] = String(p.name).split(", ");
      players[p.id] = { name: first ? `${first} ${last}` : p.name, pos: p.position, team: p.team, rookie: p.status === "R" };
    });
  }));
  const keep = Object.keys(players);
  const proj = {};
  await Promise.all(chunks(keep, 250).map(async (c) => {
    const ps = await mfl(exportUrl(host, "projectedScores", { L: league, W: week, PLAYERS: c.join(",") }));
    arr(ps.projectedScores?.playerScore).forEach((p) => { if (p.score !== "") proj[p.id] = +p.score; });
  }));
  return { league, week: +week, players, proj, pending: await pending(host, league) };
}

async function submitBid({ league, host, add, bid, drop }) {
  if (!okHost(host)) throw httpError(400, "Unknown league server.");
  const amt = Number(bid);
  if (!/^\d+$/.test(String(add)) || !Number.isInteger(amt) || amt < 0) throw httpError(400, "Pick a player and a whole-dollar bid.");
  if (drop && !/^\d+$/.test(String(drop))) throw httpError(400, "Unknown drop player.");
  if (!cookie) await login();
  const send = () =>
    fetch(`${host}/${YEAR}/import`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, cookie: `MFL_USER_ID=${cookie}` },
      body: new URLSearchParams({ TYPE: "blindBidWaiverRequest", L: league, PICKS: `${add}_${amt}_${drop || "0000"}` }),
    }).then((r) => r.text());
  let reply = await send();
  if (/login|cookie|not authorized/i.test(reply) && !/<status>OK/i.test(reply)) { await login(); reply = await send(); }
  if (!/<status>\s*OK/i.test(reply)) {
    const msg = reply.match(/<error>([\s\S]*?)<\/error>/i)?.[1] || reply.replace(/<[^>]+>/g, " ").trim().slice(0, 200);
    throw httpError(502, `MFL didn't accept the bid: ${msg}`);
  }
  return { ok: true, pending: await pending(host, league) };
}

// One blind-bid import call. REPLACE=1 swaps out every pending claim for this one.
async function bbidImport(host, league, pick, replace) {
  if (!cookie) await login();
  const params = { TYPE: "blindBidWaiverRequest", L: league, PICKS: pick };
  if (replace) params.REPLACE = "1";
  const send = () =>
    fetch(`${host}/${YEAR}/import`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, cookie: `MFL_USER_ID=${cookie}` },
      body: new URLSearchParams(params),
    }).then((r) => r.text());
  let reply = await send();
  if (/login|cookie|not authorized/i.test(reply) && !/<status>OK/i.test(reply)) { await login(); reply = await send(); }
  if (/<status>\s*OK/i.test(reply)) return null;
  return reply.match(/<error>([\s\S]*?)<\/error>/i)?.[1] || reply.replace(/<[^>]+>/g, " ").trim().slice(0, 200) || "no reply";
}

// Make your pending claims exactly `picks` (each "addId_bid_dropId"): replace with the first, then add the rest.
const normPick = (s) => { const m = String(s).match(/(\d+)_([\d.]+)_(\d+)/); return m ? `${+m[1]}_${+m[2]}_${+m[3]}` : String(s); };
async function setClaims({ league, host, picks }) {
  if (!okHost(host)) throw httpError(400, "Unknown league server.");
  if (!Array.isArray(picks) || picks.some((p) => !/^\d+_\d+_\d+$/.test(p))) throw httpError(400, "Claims must look like player_bid_drop.");
  let error = null;
  if (!picks.length) {
    error = await bbidImport(host, league, "", true);
  } else {
    for (let i = 0; i < picks.length && !error; i++) error = await bbidImport(host, league, picks[i], i === 0);
  }
  const now = await pending(host, league);
  const want = picks.map(normPick).sort().join("|");
  const matched = now != null && now.map(normPick).sort().join("|") === want;
  return { ok: !error && matched, matched, error, pending: now, wanted: picks };
}

export default async (req) => {
  const pin = process.env.APP_PIN;
  if (!pin) return json(500, { error: "APP_PIN is not set in Netlify." });
  if (req.headers.get("x-app-pin") !== pin) return json(401, { error: "Wrong PIN." });
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body.action === "lineup") return json(200, await submitLineup(body));
      if (body.action === "bid") return json(200, await submitBid(body));
      if (body.action === "claims") return json(200, await setClaims(body));
      return json(400, { error: "Unknown action." });
    }
    const q = new URL(req.url).searchParams;
    const w = q.get("w");
    if (q.get("action") === "live") {
      if (!/^\d{1,2}$/.test(w || "")) return json(400, { error: "Missing week." });
      const list = (q.get("leagues") || "").split(",").map((s) => { const [id, host, fid] = s.split("~"); return { id, host, fid }; })
        .filter((x) => /^\d+$/.test(x.id) && okHost(x.host) && /^\d{4}$/.test(x.fid));
      if (!list.length) return json(400, { error: "No leagues given." });
      return json(200, { week: +w, at: Date.now(), leagues: await liveAll(w, list) });
    }
    if (q.get("action") === "fa") {
      if (!/^\d+$/.test(q.get("L") || "") || !/^\d{1,2}$/.test(w || "")) return json(400, { error: "Missing league or week." });
      return json(200, await freeAgents({ league: q.get("L"), host: q.get("host"), week: w }));
    }
    return json(200, await loadWeek(w && /^\d{1,2}$/.test(w) ? w : null));
  } catch (e) {
    return json(e.status || 500, { error: e.message || "Something went wrong talking to MFL." });
  }
};
