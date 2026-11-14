// Dynasty Desk relay: signs in to MyFantasyLeague with the owner's account
// (from Netlify environment variables) and returns everything the app needs.
//
// Environment variables (Netlify > Site configuration > Environment variables):
//   MFL_USERNAME  your MFL login
//   MFL_PASSWORD  your MFL password
//   APP_PIN       any PIN you choose; the app asks for it once per device
//   MFL_YEAR      optional, defaults to 2026

import { createHash, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/mfl" };

// Shown in the app's footer so you can tell which version of this file is deployed.
const VERSION = "v37";

const YEAR = process.env.MFL_YEAR || "2026";
const API_HOST = "https://api.myfantasyleague.com";
const API = `${API_HOST}/${YEAR}`;
const UA = "DynastyDesk/1.0";
const NFL = ["ARI","ATL","BAL","BUF","CAR","CHI","CIN","CLE","DAL","DEN","DET","GBP","HOU","IND","JAC","KCC","LAC","LAR","LVR","MIA","MIN","NEP","NOS","NYG","NYJ","PHI","PIT","SEA","SFO","TBB","TEN","WAS"];

let cookie = null; // reused while this function instance stays warm

// ---- Go easy on MFL ----
// MFL answers 429 ("too many requests") when calls come too fast, so every call goes
// through one gate: at most 2 at a time, spaced out, with a short wait and one retry on 429.
// Read-only exports are also kept for a while (while this instance stays warm), and a saved
// copy is served if MFL is limiting us.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let active = 0, nextAt = 0;
const queue = [];
async function gate() {
  while (active >= 2) await new Promise((r) => queue.push(r));
  active++;
  const wait = nextAt - Date.now();
  nextAt = Math.max(Date.now(), nextAt) + 120;
  if (wait > 0) await sleep(wait);
}
function release() { active--; const w = queue.shift(); if (w) w(); }
const FETCH_MS = 10e3; // give up on any single MFL call after 10 seconds
const SLOW = "MFL took too long to answer. Try again in a moment.";
const LIMITED = "MFL is limiting how often the app can ask for data right now. Give it a minute or two, then refresh.";
async function mflFetch(url, opts = {}) {
  for (let attempt = 0; ; attempt++) {
    await gate();
    let res;
    try { res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), ...opts }); }
    catch (e) { if (e?.name === "TimeoutError" || e?.name === "AbortError") throw httpError(504, SLOW); throw e; }
    finally { release(); }
    if (res.status !== 429) return res;
    if (attempt >= 1) throw httpError(429, LIMITED);
    const ra = +res.headers?.get?.("retry-after");
    await sleep(Math.min(2000, ra > 0 ? ra * 1000 : 1500));
  }
}
const CACHE = new Map();
// How long each kind of read stays fresh (ms). Live scores stay short; slow-changing data longer.
const TTL = { futureDraftPicks: 30 * 60e3, myleagues: 6 * 3600e3, nflSchedule: 90e3, league: 20 * 60e3, rules: 12 * 3600e3, rosters: 60e3,
  projectedScores: 20 * 60e3, players: 6 * 3600e3, injuries: 10 * 60e3, liveScoring: 25e3, schedule: 10 * 60e3,
  leagueStandings: 10 * 60e3, freeAgents: 3 * 60e3, pendingWaivers: 0, transactions: 10 * 60e3,
  weeklyResults: 10 * 60e3, playerScores: 30 * 60e3 }; // v37: game logs

// Netlify Blobs: a small key-value store that survives between requests, so slow-changing MFL data
// (players, rules, schedule, projections) and the photo ID table don't have to be fetched again on
// every cold start. Optional: if the package isn't available, everything still works from memory.
let blobs;
async function blobStore() {
  if (blobs !== undefined) return blobs;
  try { const { getStore } = await import("@netlify/blobs"); blobs = getStore("dynasty-desk-cache"); }
  catch { blobs = null; }
  return blobs;
}
const blobKey = (s) => createHash("sha256").update(s).digest("hex");
async function blobGet(key) { const b = await blobStore(); if (!b) return null; try { return await b.get(blobKey(key), { type: "json" }); } catch { return null; } }
async function blobSet(key, value) { const b = await blobStore(); if (!b) return; try { await b.setJSON(blobKey(key), value); } catch { /* optional */ } }
const ttlFor = (url) => TTL[new URL(url).searchParams.get("TYPE")] ?? 0;

// MFL returns a single object instead of a one-item list; normalize to arrays.
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-dd-version": VERSION,
      ...((process.env.APP_PIN || "").length < 8 ? { "x-dd-pin-weak": "1" } : {}),
    },
  });

// ---- PIN guard ----
// Compare PINs in constant time, slow down every wrong guess, and lock an address out for
// 15 minutes after 5 wrong PINs in 10 minutes. (Counts live while this function instance is
// warm, so this mostly slows guessing down; a PIN of 8+ characters is what really keeps people out.)
const samePin = (a, b) => {
  const h = (x) => createHash("sha256").update(String(x)).digest();
  return timingSafeEqual(h(a), h(b));
};
const misses = new Map();
const lockedUntil = (ip) => { const m = misses.get(ip); return m && m.until > Date.now() ? m.until : 0; };
function missed(ip) {
  const now = Date.now();
  let m = misses.get(ip);
  if (!m || now - m.first > 10 * 60e3) m = { n: 0, first: now, until: 0 };
  if (++m.n >= 5) m.until = now + 15 * 60e3;
  misses.set(ip, m);
}

// One login at a time: concurrent callers share the same attempt. After a failed login, further
// attempts wait LOGIN_BACKOFF so a wrong password doesn't hammer MFL (and risk a lockout).
let loginP = null, loginFail = null;
const LOGIN_BACKOFF = 30e3;
function login() {
  if (loginP) return loginP;
  if (loginFail && Date.now() - loginFail.t < LOGIN_BACKOFF) return Promise.reject(httpError(loginFail.status, loginFail.message));
  loginP = doLogin()
    .then((v) => { loginFail = null; return v; }, (e) => { loginFail = { t: Date.now(), status: e.status || 401, message: e.message }; throw e; })
    .finally(() => { loginP = null; });
  return loginP;
}
async function doLogin() {
  const user = (process.env.MFL_USERNAME || "").trim(), pass = (process.env.MFL_PASSWORD || "").trim();
  if (!user || !pass) throw httpError(500, "MFL_USERNAME or MFL_PASSWORD isn't reaching the function. Check both are set for Production in Netlify, then redeploy.");
  const params = new URLSearchParams({ USERNAME: user, PASSWORD: pass, XML: "1" });
  // POST only: the password never goes in a URL (where it could end up in logs).
  const res = await mflFetch(`${API}/login`, {
    method: "POST",
    headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded" },
    body: params,
  });
  const text = await res.text();
  const fromBody = text.match(/cookie_value="([^"]+)"/)?.[1];
  const fromHeader = (res.headers?.get?.("set-cookie") || "").match(/MFL_USER_ID=([^;]+)/)?.[1];
  const r = { value: fromBody || fromHeader, text, status: res.status };
  if (!r.value) {
    const said = r.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160);
    throw httpError(401, `MFL login failed for username "${user}" (HTTP ${r.status}). MFL said: ${said || "nothing"}`);
  }
  cookie = r.value;
  rejected = null;
  cookieSaved = false;
  await blobSet("mfl-session", { t: Date.now(), c: cookie, u: userTag() });
  return cookie;
}

// v36: the MFL sign-in is also kept in the server's private storage (Netlify Blobs, the same place as the
// cache), so when Netlify starts this function fresh it reuses the sign-in instead of logging in to MFL
// first. If MFL ever turns the saved sign-in down, the function signs in again and saves the new one.
const SESSION_TTL = 7 * 24 * 3600e3;
let rejected = null, cookieSaved = false; // cookieSaved: the sign-in came from storage, not from a login just now
// MFL's wording for "you're not signed in" varies, so a reply like that (or any error while using a stored
// sign-in) gets one fresh login and one retry.
const AUTH_RE = /login|log in|logged|sign in|signed in|cookie|authori[sz]|permission|session|credential/i;
const userTag = () => createHash("sha256").update((process.env.MFL_USERNAME || "").trim().toLowerCase()).digest("hex").slice(0, 16);
let sessionP = null;
function session() {
  if (cookie) return Promise.resolve(cookie);
  // Calls that arrive together on a cold start share one look at storage (and at most one login).
  return sessionP ||= (async () => {
    const s = await blobGet("mfl-session");
    if (s && s.c && s.c !== rejected && s.u === userTag() && Date.now() - s.t < SESSION_TTL) { cookie = s.c; cookieSaved = true; return cookie; }
    return login();
  })().finally(() => { sessionP = null; });
}
// MFL said this sign-in is no good: forget it here and don't pick it up from storage again.
function dropSession(used) { if (cookie === used) cookie = null; rejected = used; }

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function mfl(url, { auth = true, retry = true, fresh = false } = {}) {
  const ttl = fresh ? 0 : ttlFor(url), durable = ttlFor(url) >= 5 * 60e3;
  let hit = CACHE.get(url);
  if (hit && Date.now() - hit.t < ttl) return hit.v;
  if (!hit && durable) { hit = await blobGet(url); if (hit) { CACHE.set(url, hit); if (Date.now() - hit.t < ttl) return hit.v; } }
  try {
    const data = await mflRaw(url, { auth, retry });
    if (ttlFor(url)) { const e = { t: Date.now(), v: data }; CACHE.set(url, e); if (durable) await blobSet(url, e); }
    return data;
  } catch (e) {
    if (hit && (e.status === 429 || e.status === 502 || e.status === 504)) return hit.v; // MFL busy: use the copy we have
    throw e;
  }
}

async function mflRaw(url, { auth = true, retry = true } = {}) {
  if (auth) await session();
  const used = cookie;
  const res = await mflFetch(url, {
    headers: { "user-agent": UA, ...(auth ? { cookie: `MFL_USER_ID=${cookie}` } : {}) },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { throw httpError(502, `MFL sent an unexpected reply (${res.status}).`); }
  if (data.error) {
    const msg = typeof data.error === "string" ? data.error : data.error.$t || JSON.stringify(data.error);
    if (auth && retry && (cookieSaved || AUTH_RE.test(msg))) {
      dropSession(used);
      return mflRaw(url, { auth, retry: false });
    }
    throw httpError(502, `MFL: ${msg}`);
  }
  return data;
}

const exportUrl = (host, type, params = {}) =>
  `${host}/${YEAR}/export?` + new URLSearchParams({ TYPE: type, ...params, JSON: "1" });

// After a write (lineup, bid, claims), forget this league's cached live scores, rosters and pending
// claims so the next read comes straight from MFL instead of showing the old lineup for a while.
const BUST = new Set(["liveScoring", "rosters", "pendingWaivers"]);
function bustLeague(league) {
  for (const k of CACHE.keys()) {
    try { const q = new URL(k).searchParams; if (q.get("L") === String(league) && BUST.has(q.get("TYPE"))) CACHE.delete(k); } catch { /* not a URL */ }
  }
}

// League servers come from MFL's own myleagues list; only accept real MFL hosts, always over https.
function leagueHost(url) {
  const h = String(url || "").match(/^https?:\/\/[^/]+/i)?.[0]?.toLowerCase().replace(/^http:/, "https:");
  return okHost(h) ? h : API_HOST;
}

// Your head-to-head matchup for the week: both teams' MFL starters, live points and time left.
async function liveFor(host, league, fid, week, fresh = false) {
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
    const ls = await mfl(exportUrl(host, "liveScoring", { L: league, W: week, DETAILS: "1" }), { fresh });
    const ms = arr(ls.liveScoring?.matchup);
    // Every matchup in the league this week (just teams, scores and players left), for the league scoreboard.
    const all = ms.map((m) => arr(m.franchise).map((f) => ({ id: f.id, score: f.score === "" || f.score == null ? null : +f.score, yet: +f.playersYetToPlay || 0, playing: +f.playersCurrentlyPlaying || 0 })));
    for (const m of ms) {
      const fs = arr(m.franchise), me = fs.find((f) => f.id === fid);
      if (me) { const opp = fs.find((f) => f.id !== fid); return { me: side(me), opp: opp ? side(opp) : null, all }; }
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

async function liveAll(week, list, fresh = false) {
  // One league failing never takes the others down with it.
  const rs = await Promise.allSettled(list.map(({ id, host, fid }) => liveFor(host, id, fid, week, fresh)));
  return rs.map((r, i) => ({ id: list[i].id, live: r.status === "fulfilled" ? r.value : null }));
}

// Headshots: MFL has no player photos, so look up each player's Sleeper and ESPN IDs in
// DynastyProcess's public ID table (matched by MFL ID). Kept for a day; photos are optional.
const IDS_URL = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/db_playerids.csv";
let idTable = null;
async function photoIds() {
  if (idTable && Date.now() - idTable.t < 24 * 3600e3) return idTable.map;
  const saved = await blobGet("photo-ids");
  if (saved && Date.now() - saved.t < 24 * 3600e3) { idTable = { t: saved.t, map: new Map(saved.m) }; return idTable.map; }
  try {
    const res = await fetch(IDS_URL, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return idTable?.map || null;
    const lines = (await res.text()).split("\n");
    const head = lines[0].split(","), iM = head.indexOf("mfl_id"), iS = head.indexOf("sleeper_id"), iE = head.indexOf("espn_id");
    const ok = (v) => v && v !== "NA" && /^\d+$/.test(v);
    const map = new Map();
    for (let i = 1; i < lines.length; i++) {
      const c = lines[i].split(",", Math.max(iM, iS, iE) + 1);
      if (ok(c[iM]) && (ok(c[iS]) || ok(c[iE]))) map.set(c[iM], { s: ok(c[iS]) ? c[iS] : null, e: ok(c[iE]) ? c[iE] : null });
    }
    idTable = { t: Date.now(), map };
    await blobSet("photo-ids", { t: idTable.t, m: [...map] });
    return map;
  } catch { return idTable?.map || null; }
}

// v36: MFL's whole player list (names, positions, teams, rookie flags, birthdays) in one call, kept for 6 hours
// in memory and in Blobs and shared by every screen. Before, each screen looked its players up in batches of 300,
// which was a whole extra round of MFL calls on the main load, Free agents, Rankings and winning bids.
const PLAYERS_TTL = 6 * 3600e3;
let playerDB = null, playerDBP = null;
function allPlayers() {
  if (playerDB && Date.now() - playerDB.t < PLAYERS_TTL) return Promise.resolve(playerDB.m);
  if (playerDBP) return playerDBP;
  playerDBP = (async () => {
    const saved = await blobGet("players-db-v1");
    if (saved?.m && Date.now() - saved.t < PLAYERS_TTL) { playerDB = saved; return saved.m; }
    try {
      const pl = await mflRaw(exportUrl(API_HOST, "players", { DETAILS: "1" }), { auth: false });
      const m = {};
      for (const p of arr(pl.players?.player)) {
        if (!p?.id) continue;
        const [last, first] = String(p.name || "").split(", ");
        m[p.id] = [first ? `${first} ${last}` : String(p.name || ""), p.position || "", p.team || "", p.status === "R" ? 1 : 0, +p.birthdate || 0];
      }
      if (Object.keys(m).length < 500) throw httpError(502, "MFL sent a short player list.");
      playerDB = { t: Date.now(), m };
      await blobSet("players-db-v1", playerDB);
      return m;
    } catch (e) {
      const old = playerDB || saved;
      if (old?.m) return old.m; // an older copy beats nothing; names rarely change
      throw e;
    }
  })().finally(() => { playerDBP = null; });
  return playerDBP;
}
const ageOf = (b) => (+b ? Math.round((Date.now() / 1000 - +b) / 31557600 * 10) / 10 : null);
// Player info for these MFL ids from the shared list. Ids it doesn't have (a player added in the last few hours)
// are looked up directly when fill is on; if the shared list can't load at all, everything is looked up directly.
async function playersFor(ids, { fill = true, details = false } = {}) {
  const out = {}, missing = [];
  let db = null;
  try { db = await allPlayers(); } catch { /* look them up directly below */ }
  for (const id of ids) {
    const x = db?.[id];
    if (x) out[id] = { name: x[0], pos: x[1], team: x[2], rookie: !!x[3], age: ageOf(x[4]) };
    else missing.push(id);
  }
  if (missing.length && (fill || !db)) {
    await Promise.all(chunks(missing, 300).map(async (c) => {
      const pl = await mfl(exportUrl(API_HOST, "players", { PLAYERS: c.join(","), ...(details ? { DETAILS: "1" } : {}) }), { auth: false });
      arr(pl.players?.player).forEach((p) => {
        const [last, first] = String(p.name || "").split(", ");
        out[p.id] = { name: first ? `${first} ${last}` : p.name, pos: p.position, team: p.team, rookie: p.status === "R", age: ageOf(p.birthdate) };
      });
    }));
  }
  return out;
}

// v37: each NFL game with its score and clock when MFL has them (scores are null before kickoff).
const numOrNull = (v) => (v === "" || v == null || !isFinite(+v) ? null : +v);
function gamesOf(sched) {
  return arr(sched?.nflSchedule?.matchup).map((m) => {
    const [a, h] = arr(m.team);
    if (!a || !h) return null;
    const away = a.isHome === "1" ? h : a, home = a.isHome === "1" ? a : h;
    const side = (t) => ({ id: t.id, passD: +t.passDefenseRank || null, rushD: +t.rushDefenseRank || null, score: numOrNull(t.score) });
    return { kickoff: +m.kickoff, secs: numOrNull(m.gameSecondsRemaining), away: side(away), home: side(home) };
  }).filter(Boolean);
}

const validWeek = (w) => /^\d{1,2}$/.test(w || "") && +w >= 1 && +w <= 18;
async function loadWeek(week, fresh = false) {
  const photosP = photoIds(); // runs alongside the MFL calls
  allPlayers().catch(() => null); // v36: start loading the shared player list now; it's used at the end
  // Your leagues, with your franchise in each and the server MFL currently hosts it on.
  // v36: your leagues, the NFL schedule and (for another week) the current week are read at the same time.
  const [my, sched, curW] = await Promise.all([
    mfl(exportUrl(API_HOST, "myleagues", { FRANCHISE_NAMES: "1" })),
    mfl(exportUrl(API_HOST, "nflSchedule", week ? { W: week } : {}), { auth: false }),
    week ? mfl(exportUrl(API_HOST, "nflSchedule", {}), { auth: false }).then((s) => +s.nflSchedule?.week || null, () => null) : null,
  ]);
  const mine = arr(my.leagues?.league).map((l) => ({
    id: l.league_id,
    name: l.name,
    fid: l.franchise_id,
    host: leagueHost(l.url),
  }));
  if (!mine.length) throw httpError(404, `No ${YEAR} leagues found for this MFL account.`);

  const wk = week || sched.nflSchedule?.week;
  // v34: the app can show any week 1-18, so it also needs to know which week is the current one.
  // Asking for a past or future week costs one extra (cached) schedule read; if that read fails the app
  // falls back to the current week it saw last.
  const current = week ? curW : +wk;
  const injP = injuryMap(wk); // v36: started now instead of after everything else
  const games = gamesOf(sched);
  const playing = new Set(games.flatMap((g) => [g.away.id, g.home.id]));
  const byes = games.length ? NFL.filter((t) => !playing.has(t)) : [];

  const settled = await Promise.allSettled(
    mine.map(async (l) => {
      // v36: live scoring is read together with the league, roster and rules (it was a second round before).
      const [league, rosters, rules, live] = await Promise.all([
        mfl(exportUrl(l.host, "league", { L: l.id })),
        mfl(exportUrl(l.host, "rosters", { L: l.id, FRANCHISE: l.fid }), { fresh }),
        mfl(exportUrl(l.host, "rules", { L: l.id })),
        liveFor(l.host, l.id, l.fid, wk, fresh),
      ]);
      const roster = arr(arr(rosters.rosters?.franchise)[0]?.player).map((p) => p.id);
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
        teBonus: tePremium(groups),
        ppr: pprOf(groups),
        recWR: perCatch(groups, "WR"), // exact points per catch, for Marquee
        recTE: perCatch(groups, "TE"),
        franchises: arr(lg.franchises?.franchise).map((f) => ({
          id: f.id,
          name: String(f.name || "").replace(/<[^>]*>/g, "").trim(),
          faab: f.bbidAvailableBalance != null ? +f.bbidAvailableBalance : null,
          icon: (f.icon || f.logo || "").replace(/^http:\/\//, "https://") || null,
          waiver: +f.waiverSortOrder || null,
        })),
        faabLimit: +lg.bbidSeasonLimit || null,
        rosterSize: +lg.rosterSize || null,
        playoffTeams: +lg.playoffTeams || null,
        waiverType: lg.currentWaiverType || "",
        roster,
        proj,
        live,
      };
    })
  );
  // A league that failed to load is reported on its own instead of failing the whole page.
  const leagues = [], failed = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") leagues.push(r.value);
    else failed.push({ id: mine[i].id, name: mine[i].name, error: r.reason?.message || "Couldn't load this league from MFL." });
  });
  if (!leagues.length) throw settled[0].reason;

  // Your own MFL starters are included too: in a past week some of them may have left your roster since.
  const ids = [...new Set(leagues.flatMap((l) => [...l.roster, ...(l.live?.me ? Object.keys(l.live.me.players) : []), ...(l.live?.opp ? Object.keys(l.live.opp.players) : [])]))];
  // v36: from the shared player list (ages included, for the player card) instead of batches of MFL lookups.
  const players = {}, info = await playersFor(ids);
  for (const id of Object.keys(info)) { const x = info[id]; players[id] = { name: x.name, pos: x.pos, team: x.team, rookie: x.rookie, ...(x.age ? { age: x.age } : {}) }; }

  const photos = await photosP;
  if (photos) for (const id of Object.keys(players)) { const x = photos.get(id); if (x) { if (x.s) players[id].sl = x.s; if (x.e) players[id].es = x.e; } }

  const injuries = (await injP) || {};

  return { year: YEAR, week: +wk, current, generated: Date.now(), games, byes, players, injuries, leagues, failed };
}

// Injury designations for the week (Out, Doubtful, Questionable, IR...). Optional: null if MFL doesn't answer.
async function injuryMap(week) {
  try {
    const inj = await mfl(exportUrl(API_HOST, "injuries", { W: week }), { auth: false });
    const out = {};
    arr(inj.injuries?.injury).forEach((i) => { out[i.id] = { status: i.status, details: i.details || "" }; });
    return out;
  } catch { return null; }
}

// Points per catch ("CC") a position gets from the league's rules. Only per-catch rules count
// (points written "*n", starting from the first catch); flat bonuses such as "+3 for 8+ catches" don't.
function perCatch(groups, pos) {
  let pts = 0;
  for (const g of arr(groups)) {
    if (!String(g.positions || "").split("|").includes(pos)) continue;
    for (const r of arr(g.rule)) {
      if ((r.event?.$t ?? r.event) !== "CC") continue;
      const raw = String(r.points?.$t ?? r.points ?? "").trim();
      if (!raw.startsWith("*")) continue;
      const lo = parseFloat(String(r.range?.$t ?? r.range ?? "0").split("-")[0]);
      if (isFinite(lo) && lo > 1) continue; // a per-catch rate that only kicks in later is a bonus tier
      const n = parseFloat(raw.slice(1));
      if (isFinite(n)) pts += n;
    }
  }
  return pts;
}
// This league's PPR for a WR, snapped to what the values source supports: 0, 0.5 or 1.
function pprOf(groups) {
  const p = perCatch(groups, "WR");
  return p < 0.25 ? 0 : p < 0.75 ? 0.5 : 1;
}
// TE premium: tight ends get more per catch than wide receivers.
function tePremium(groups) {
  return perCatch(groups, "TE") > perCatch(groups, "WR") + 1e-9;
}

// Dynasty values from FantasyCalc, keyed by MFL player id: { id: [value, 30-day trend] }.
// One upstream call per (QBs, PPR) per day: kept in memory and in Netlify Blobs for 24 hours,
// with concurrent requests sharing one fetch. If FantasyCalc fails, an older saved copy is used.
const VALUES_TTL = 24 * 3600e3;
const valuesInFlight = new Map();
async function dynastyValues(qbs, ppr) {
  const key = `fc-values3-${qbs}-${ppr}`;
  const mem = CACHE.get(key);
  if (mem && Date.now() - mem.t < VALUES_TTL) return mem.v;
  const saved = await blobGet(key);
  if (saved && Date.now() - saved.t < VALUES_TTL) { CACHE.set(key, saved); return saved.v; }
  if (valuesInFlight.has(key)) return valuesInFlight.get(key);
  const job = (async () => {
    try {
      const res = await fetch(`https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=${qbs}&ppr=${ppr}`,
        { headers: { "user-agent": UA }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw httpError(502, `FantasyCalc answered ${res.status}.`);
      const list = await res.json();
      const v = {}, pk = {};
      for (const x of Array.isArray(list) ? list : []) {
        const id = String(x?.player?.mflId ?? "");
        // v37: [value, 30-day trend, position rank] (the rank is for the player card's "Dynasty WR3")
        if (/^\d+$/.test(id) && isFinite(+x.value)) v[id] = [Math.round(+x.value), Math.round(+x.trend30Day || 0), +x.positionRank || 0];
        // Draft picks come in the same list (position "PICK"), named like "2027 1st", "2027 Round 2" or "2027 Pick 1.05".
        if (String(x?.player?.position || "").toUpperCase() === "PICK" && isFinite(+x.value)) {
          const n = String(x.player.name || ""), y = n.match(/20\d\d/)?.[0];
          const r = n.match(/(\d)(?:st|nd|rd|th)\b/i)?.[1] || n.match(/round\s*(\d)/i)?.[1] || n.match(/pick\s*(\d)\.\d+/i)?.[1];
          if (y && r) (pk[`${y}-${r}`] ||= []).push(+x.value);
        }
      }
      const picks = Object.fromEntries(Object.entries(pk).map(([k, a]) => [k, Math.round(a.reduce((s, n) => s + n, 0) / a.length)]));
      if (!Object.keys(v).length) throw httpError(502, "FantasyCalc sent no values.");
      const e = { t: Date.now(), v: { qbs, ppr, at: Date.now(), values: v, picks } };
      CACHE.set(key, e);
      await blobSet(key, e);
      return e.v;
    } catch (err) {
      const old = mem || saved;
      if (old) return old.v;
      throw err.status ? err : httpError(502, "Couldn't reach FantasyCalc.");
    } finally { valuesInFlight.delete(key); }
  })();
  valuesInFlight.set(key, job);
  return job;
}

async function submitLineup({ league, host, week, starters }) {
  if (!league || !week || !Array.isArray(starters) || !starters.length) throw httpError(400, "Missing league, week or starters.");
  if (!okHost(host)) throw httpError(400, "Unknown league server.");
  if (!validWeek(String(week))) throw httpError(400, "Lineups can only be set for weeks 1 to 18.");
  // v34: the app can show past weeks, which are read-only. Refuse a lineup for a week that's already over
  // (if the schedule can't be read, MFL makes the call).
  const now = await mfl(exportUrl(API_HOST, "nflSchedule", {}), { auth: false }).then((s) => +s.nflSchedule?.week || 0, () => 0);
  if (now && +week < now) throw httpError(400, `Week ${+week} is over, so its lineup can't be changed.`);
  await session();
  const send = () =>
    mflFetch(`${host}/${YEAR}/import`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, cookie: `MFL_USER_ID=${cookie}` },
      body: new URLSearchParams({ TYPE: "lineup", L: league, W: String(week), STARTERS: starters.join(",") }),
    }).then((r) => r.text());
  let reply = await send();
  if (!/<status>\s*OK/i.test(reply) && (cookieSaved || AUTH_RE.test(reply))) { await login(); reply = await send(); }
  if (/<status>\s*OK/i.test(reply)) { bustLeague(league); return { ok: true }; }
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
  // v36: your pending claims (never cached, so the slowest part), the photo table and the shared player list
  // are all requested right away, alongside the free agent list, instead of one after another.
  const pendingP = pending(host, league), photosP = photoIds();
  allPlayers().catch(() => null);
  const fa = await mfl(exportUrl(host, "freeAgents", { L: league }));
  const ids = [];
  const walk = (x) => {
    if (Array.isArray(x)) return x.forEach(walk);
    if (x && typeof x === "object") { if (typeof x.id === "string" && /^\d+$/.test(x.id)) ids.push(x.id); Object.values(x).forEach((v) => typeof v === "object" && walk(v)); }
  };
  walk(fa.freeAgents);
  const players = {}, info = await playersFor([...new Set(ids)], { fill: false });
  for (const [id, p] of Object.entries(info)) {
    if (!["QB", "RB", "WR", "TE"].includes(p.pos)) continue;
    players[id] = { name: p.name, pos: p.pos, team: p.team, rookie: p.rookie, ...(p.age ? { age: p.age } : {}) };
  }
  const photos = await photosP;
  if (photos) for (const id of Object.keys(players)) { const x = photos.get(id); if (x) { if (x.s) players[id].sl = x.s; if (x.e) players[id].es = x.e; } }
  const keep = Object.keys(players);
  const proj = {};
  await Promise.all(chunks(keep, 250).map(async (c) => {
    const ps = await mfl(exportUrl(host, "projectedScores", { L: league, W: week, PLAYERS: c.join(",") }));
    arr(ps.projectedScores?.playerScore).forEach((p) => { if (p.score !== "") proj[p.id] = +p.score; });
  }));
  return { league, week: +week, players, proj, pending: await pendingP };
}

async function submitBid({ league, host, add, bid, drop }) {
  if (!okHost(host)) throw httpError(400, "Unknown league server.");
  const amt = String(bid ?? "").trim();
  if (!/^\d+$/.test(String(add)) || !BID_RE.test(amt)) throw httpError(400, "Pick a player and a bid like 12 (or 12.50 if your league allows cents).");
  if (drop && !/^\d+$/.test(String(drop))) throw httpError(400, "Unknown drop player.");
  await session();
  const send = () =>
    mflFetch(`${host}/${YEAR}/import`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, cookie: `MFL_USER_ID=${cookie}` },
      body: new URLSearchParams({ TYPE: "blindBidWaiverRequest", L: league, PICKS: `${add}_${amt}_${drop || "0000"}` }),
    }).then((r) => r.text());
  let reply = await send();
  if (!/<status>\s*OK/i.test(reply) && (cookieSaved || AUTH_RE.test(reply))) { await login(); reply = await send(); }
  if (!/<status>\s*OK/i.test(reply)) {
    const msg = reply.match(/<error>([\s\S]*?)<\/error>/i)?.[1] || reply.replace(/<[^>]+>/g, " ").trim().slice(0, 200);
    throw httpError(502, `MFL didn't accept the bid: ${msg}`);
  }
  bustLeague(league);
  return { ok: true, pending: await pending(host, league) };
}

// One blind-bid import call. With REPLACE=1 the PICKS list (comma-separated, in priority order)
// replaces every pending claim; an empty list clears them.
async function bbidImport(host, league, pick, replace) {
  await session();
  const params = { TYPE: "blindBidWaiverRequest", L: league, PICKS: pick };
  if (replace) params.REPLACE = "1";
  const send = () =>
    mflFetch(`${host}/${YEAR}/import`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, cookie: `MFL_USER_ID=${cookie}` },
      body: new URLSearchParams(params),
    }).then((r) => r.text());
  let reply = await send();
  if (!/<status>\s*OK/i.test(reply) && (cookieSaved || AUTH_RE.test(reply))) { await login(); reply = await send(); }
  if (/<status>\s*OK/i.test(reply)) return null;
  return reply.match(/<error>([\s\S]*?)<\/error>/i)?.[1] || reply.replace(/<[^>]+>/g, " ").trim().slice(0, 200) || "no reply";
}

// Bids are whole dollars, or dollars and cents (up to 2 places) for leagues that allow decimals.
const BID_RE = /^\d+(\.\d{1,2})?$/;
const PICK_RE = /^\d+_\d+(\.\d{1,2})?_\d+$/;
// Make your pending claims exactly `picks` (each "addId_bid_dropId", in priority order) with one REPLACE call.
const normPick = (s) => { const m = String(s).match(/(\d+)_([\d.]+)_(\d+)/); return m ? `${+m[1]}_${+m[2]}_${+m[3]}` : String(s); };
async function setClaims({ league, host, picks }) {
  if (!okHost(host)) throw httpError(400, "Unknown league server.");
  if (!Array.isArray(picks) || picks.some((p) => typeof p !== "string" || !PICK_RE.test(p))) throw httpError(400, "Claims must look like player_bid_drop.");
  const error = await bbidImport(host, league, picks.join(","), true);
  bustLeague(league);
  const now = await pending(host, league);
  const want = picks.map(normPick).sort().join("|");
  const matched = now != null && now.map(normPick).sort().join("|") === want;
  return { ok: !error && matched, matched, error, pending: now, wanted: picks };
}

// Winning blind bids in this league (most recent first), to help size your own bids.
// MFL lists each as "addedId,|amount|droppedIds," under TRANS_TYPE=BBID_WAIVER.
async function bidHistory({ league, host }) {
  if (!okHost(host)) throw httpError(400, "Unknown league server.");
  allPlayers().catch(() => null); // v36: loads alongside the transactions
  const t = await mfl(exportUrl(host, "transactions", { L: league, TRANS_TYPE: "BBID_WAIVER" }));
  const bids = [];
  for (const x of arr(t.transactions?.transaction)) {
    if (!/BBID/i.test(x.type || "")) continue;
    const m = String(x.transaction || "").match(/^(\d+),?\|([\d.]+)\|/);
    if (m) bids.push({ id: m[1], amt: +m[2], fid: x.franchise, t: +x.timestamp || 0 });
  }
  bids.sort((a, b) => b.t - a.t);
  const info = await playersFor([...new Set(bids.map((b) => b.id))]), players = {};
  for (const [id, p] of Object.entries(info)) players[id] = { name: p.name, pos: p.pos, team: p.team };
  return { league, bids: bids.filter((b) => players[b.id]).map((b) => ({ ...b, ...players[b.id] })) };
}

// Everything Rankings needs from MFL for one league: every roster, each team's future picks, and player info with ages.
async function rankingsData({ league, host }) {
  if (!okHost(host)) throw httpError(400, "Unknown league server.");
  allPlayers().catch(() => null); // v36: loads alongside the rosters and picks
  const [ro, fp] = await Promise.all([
    mfl(exportUrl(host, "rosters", { L: league })),
    mfl(exportUrl(host, "futureDraftPicks", { L: league })).catch(() => null),
  ]);
  const picksBy = {};
  for (const f of arr(fp?.futureDraftPicks?.franchise))
    picksBy[f.id] = arr(f.futureDraftPick).map((p) => ({ year: +p.year, round: +p.round, from: p.originalPickFor || f.id })).filter((p) => p.year && p.round);
  const teams = arr(ro.rosters?.franchise).map((f) => ({ id: f.id, players: arr(f.player).map((p) => p.id), picks: picksBy[f.id] || [] }));
  const info = await playersFor([...new Set(teams.flatMap((t) => t.players))], { details: true }), players = {};
  for (const [id, p] of Object.entries(info)) players[id] = { name: p.name, pos: p.pos, team: p.team, age: p.age ?? null };
  return { league, teams, players };
}

// Everything the playoff odds need: the whole season's schedule with results so far, the playoff settings MFL
// has (falling back to 6 teams / 2 byes and a points-for tiebreak), and each team's projected points this week.
async function playoffData({ league, host, week }) {
  if (!okHost(host)) throw httpError(400, "Unknown league server.");
  const [lgr, sc, ro, pj] = await Promise.all([
    mfl(exportUrl(host, "league", { L: league })),
    mfl(exportUrl(host, "schedule", { L: league })),
    mfl(exportUrl(host, "rosters", { L: league })),
    week ? mfl(exportUrl(host, "projectedScores", { L: league, W: week })).catch(() => null) : null,
  ]);
  const lg = lgr.league || {};
  const games = [];
  for (const ws of arr(sc.schedule?.weeklySchedule)) {
    for (const m of arr(ws.matchup)) {
      const [a, b] = arr(m.franchise);
      if (!a || !b) continue;
      const done = !!(a.result || b.result);
      games.push({ week: +ws.week, a: a.id, b: b.id, done, sa: done ? +a.score || 0 : null, sb: done ? +b.score || 0 : null });
    }
  }
  const proj = {};
  arr(pj?.projectedScores?.playerScore).forEach((p) => { if (p.score !== "") proj[p.id] = +p.score; });
  const n = +lg.starters?.count || 10;
  const projected = {};
  for (const f of arr(ro.rosters?.franchise)) {
    const top = arr(f.player).map((p) => proj[p.id] || 0).sort((x, y) => y - x).slice(0, n);
    projected[f.id] = top.length && top.some(Boolean) ? Math.round(top.reduce((s, x) => s + x, 0) * 10) / 10 : null;
  }
  const num = (...k) => { for (const x of k) if (+lg[x] > 0) return +lg[x]; return null; };
  const sort = String(lg.standingsSort || "");
  return {
    league,
    lastRegWeek: num("lastRegularSeasonWeek") || 14,
    playoffTeams: num("playoffTeams", "numPlayoffTeams"),
    byes: num("playoffByes", "numPlayoffByes", "byes"),
    tiebreak: /PCT,\s*(PTS|PF)/i.test(sort) || !sort ? "PF" : sort,
    games,
    projected,
  };
}

async function standings({ league, host }) {
  if (!okHost(host)) throw httpError(400, "Unknown league server.");
  const st = await mfl(exportUrl(host, "leagueStandings", { L: league }));
  // Pass each franchise's fields through as-is; MFL's columns differ by league setup.
  const rows = arr(st.leagueStandings?.franchise).map((f) => {
    const o = {};
    for (const [k, v] of Object.entries(f)) if (typeof v === "string" || typeof v === "number") o[k] = v;
    return o;
  });
  return { league, rows };
}

// ---- v37: game logs ----
// Every rostered player's points in each finished week (MFL weeklyResults, one call for the season when MFL
// allows it), each team's starters and bench that week, plus last-weeks projections for the players asked for.
// Players who were never on a roster get their weekly points straight from MFL (playerScores).
async function gameLog({ league, host, week, ids }) {
  if (!okHost(host)) throw httpError(400, "Unknown league server.");
  const past = []; for (let k = 1; k < week && k <= 18; k++) past.push(k);
  if (!past.length) return { league, week, scores: {}, proj: {}, teams: {} };
  let list = [];
  try {
    const r = await mfl(exportUrl(host, "weeklyResults", { L: league, W: "YTD" }));
    list = arr(r.allWeeklyResults?.weeklyResults ?? r.weeklyResults);
  } catch { /* week by week below */ }
  if (!list.some((x) => +x?.week)) {
    list = (await Promise.all(past.map((k) => mfl(exportUrl(host, "weeklyResults", { L: league, W: String(k) })).then((r) => ({ week: k, ...(r.weeklyResults || {}) }), () => null)))).filter(Boolean);
  }
  const scores = {}, teams = {};
  for (const wr of list) {
    const k = +wr?.week;
    if (!k || k >= week) continue;
    const fr = [...arr(wr.matchup).flatMap((m) => arr(m.franchise)), ...arr(wr.franchise)];
    for (const f of fr) {
      if (!f?.id) continue;
      const st = [], bn = [];
      for (const p of arr(f.player ?? f.players?.player)) {
        if (!p?.id) continue;
        const s = numOrNull(p.score);
        if (s != null) (scores[p.id] ||= {})[k] = s;
        (p.status === "starter" ? st : bn).push(p.id);
      }
      (teams[k] ||= {})[f.id] = { s: numOrNull(f.score) ?? 0, st, bn, r: String(f.result || "") };
    }
  }
  const proj = {}, want = ids.filter((id) => /^\d+$/.test(id));
  if (want.length) {
    await Promise.all(past.slice(-6).map((k) => mfl(exportUrl(host, "projectedScores", { L: league, W: String(k), PLAYERS: want.join(",") }))
      .then((ps) => arr(ps.projectedScores?.playerScore).forEach((p) => { const v = numOrNull(p.score); if (p.id && v != null) (proj[p.id] ||= {})[k] = v; }), () => null)));
    const missing = want.filter((id) => !scores[id]);
    if (missing.length) {
      await Promise.all(past.slice(-8).map((k) => mfl(exportUrl(host, "playerScores", { L: league, W: String(k), PLAYERS: missing.join(",") }))
        .then((ps) => arr(ps.playerScores?.playerScore).forEach((p) => { const v = numOrNull(p.score); if (p.id && v != null) (scores[p.id] ||= {})[k] = v; }), () => null)));
    }
  }
  return { league, week, scores, proj, teams };
}

// ---- v37: trade offers ----
// Sends a trade offer to another team on MFL. Players are MFL ids; future picks are FP_<original team>_<year>_<round>.
const TRADE_ITEM = /^(\d{3,6}|FP_\d{4}_\d{4}_\d{1,2})$/;
async function proposeTrade({ league, host, to, give, get, note }) {
  if (!okHost(host)) throw httpError(400, "Unknown league server.");
  if (!/^\d+$/.test(String(league)) || !/^\d{4}$/.test(String(to))) throw httpError(400, "Pick a team to trade with.");
  if (!Array.isArray(give) || !Array.isArray(get) || !give.length || !get.length) throw httpError(400, "A trade needs something on each side.");
  if ([...give, ...get].some((x) => !TRADE_ITEM.test(String(x)))) throw httpError(400, "Unknown player or pick in the trade.");
  await session();
  const params = { TYPE: "tradeProposal", L: league, OFFEREDTO: to, WILL_GIVE_UP: give.join(","), WILL_RECEIVE: get.join(","),
    COMMENTS: String(note || "").replace(/[\r\n]+/g, " ").slice(0, 240), EXPIRES: String(Math.floor(Date.now() / 1000) + 3 * 86400) };
  const send = () =>
    mflFetch(`${host}/${YEAR}/import`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, cookie: `MFL_USER_ID=${cookie}` },
      body: new URLSearchParams(params),
    }).then((r) => r.text());
  let reply = await send();
  if (!/<status>\s*OK/i.test(reply) && (cookieSaved || AUTH_RE.test(reply))) { await login(); reply = await send(); }
  if (/<status>\s*OK/i.test(reply)) return { ok: true };
  const msg = reply.match(/<error>([\s\S]*?)<\/error>/i)?.[1] || reply.replace(/<[^>]+>/g, " ").trim().slice(0, 200);
  throw httpError(502, `MFL didn't accept the offer: ${msg}`);
}

async function handle(req, context) {
  const pin = process.env.APP_PIN;
  if (!pin) return json(500, { error: "APP_PIN is not set in Netlify." });
  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  const until = lockedUntil(ip);
  if (until) return json(429, { error: `Too many wrong PINs. Try again in ${Math.ceil((until - Date.now()) / 60e3)} minutes.` });
  if (!samePin(req.headers.get("x-app-pin") || "", pin)) {
    missed(ip);
    await sleep(1200);
    return json(401, { error: "Wrong PIN." });
  }
  misses.delete(ip);
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body.action === "lineup") return json(200, await submitLineup(body));
      if (body.action === "bid") return json(200, await submitBid(body));
      if (body.action === "claims") return json(200, await setClaims(body));
      if (body.action === "trade") return json(200, await proposeTrade(body));
      return json(400, { error: "Unknown action." });
    }
    const q = new URL(req.url).searchParams;
    const w = q.get("w");
    if (q.get("action") === "live") {
      if (!/^\d{1,2}$/.test(w || "")) return json(400, { error: "Missing week." });
      const list = (q.get("leagues") || "").split(",").map((s) => { const [id, host, fid] = s.split("~"); return { id, host, fid }; })
        .filter((x) => /^\d+$/.test(x.id) && okHost(x.host) && /^\d{4}$/.test(x.fid));
      if (!list.length) return json(400, { error: "No leagues given." });
      const [leagues, injuries, sched] = await Promise.all([liveAll(w, list, q.get("fresh") === "1"), injuryMap(w),
        mfl(exportUrl(API_HOST, "nflSchedule", { W: w }), { auth: false }).catch(() => null)]);
      return json(200, { week: +w, at: Date.now(), leagues, injuries, games: sched ? gamesOf(sched) : null });
    }
    if (q.get("type") === "values") {
      const qbs = q.get("qbs"), ppr = q.get("ppr");
      if (!["1", "2"].includes(qbs) || !/^\d(\.\d{1,2})?$/.test(ppr || "") || +ppr > 3) return json(400, { error: "qbs must be 1 or 2 and ppr a number like 0.5 or 1." });
      return json(200, await dynastyValues(+qbs, +ppr));
    }
    if (q.get("action") === "playoff") {
      if (!/^\d+$/.test(q.get("L") || "")) return json(400, { error: "Missing league." });
      return json(200, await playoffData({ league: q.get("L"), host: q.get("host"), week: /^\d{1,2}$/.test(q.get("w") || "") ? q.get("w") : null }));
    }
    if (q.get("action") === "rankings") {
      if (!/^\d+$/.test(q.get("L") || "")) return json(400, { error: "Missing league." });
      return json(200, await rankingsData({ league: q.get("L"), host: q.get("host") }));
    }
    if (q.get("action") === "bids") {
      if (!/^\d+$/.test(q.get("L") || "")) return json(400, { error: "Missing league." });
      return json(200, await bidHistory({ league: q.get("L"), host: q.get("host") }));
    }
    if (q.get("action") === "standings") {
      if (!/^\d+$/.test(q.get("L") || "")) return json(400, { error: "Missing league." });
      return json(200, await standings({ league: q.get("L"), host: q.get("host") }));
    }
    if (q.get("action") === "log") {
      if (!/^\d+$/.test(q.get("L") || "") || !/^\d{1,2}$/.test(w || "")) return json(400, { error: "Missing league or week." });
      const ids = (q.get("P") || "").split(",").filter((x) => /^\d{3,6}$/.test(x)).slice(0, 80);
      return json(200, await gameLog({ league: q.get("L"), host: q.get("host"), week: +w, ids }));
    }
    if (q.get("action") === "fa") {
      if (!/^\d+$/.test(q.get("L") || "") || !/^\d{1,2}$/.test(w || "")) return json(400, { error: "Missing league or week." });
      return json(200, await freeAgents({ league: q.get("L"), host: q.get("host"), week: w }));
    }
    // Weeks 1-18 only (the NFL regular season); anything else loads the current week.
    return json(200, await loadWeek(validWeek(w) ? String(+w) : null, q.get("fresh") === "1"));
  } catch (e) {
    return json(e.status || 500, { error: e.message || "Something went wrong talking to MFL." });
  }
}

// ---- Marquee ----
// Marquee is a separate site that reads your leagues through this relay. A browser only lets
// another site read the answer when the relay says so, so read-only requests from your Netlify
// sites get that permission. Your PIN is still required for every request, and lineup changes,
// bids and claims (POST) stay limited to Dynasty Desk itself.
// To allow a site that isn't on netlify.app, list it in ALLOWED_ORIGINS (comma-separated).
function corsFor(req) {
  const origin = req.headers.get("origin") || "";
  if (!origin) return null;
  const extra = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  let ok = false;
  try {
    const u = new URL(origin);
    ok = u.protocol === "https:" && (u.hostname.endsWith(".netlify.app") || extra.includes(origin));
  } catch { /* not a URL */ }
  if (!ok) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "x-app-pin",
    "access-control-expose-headers": "x-dd-version",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export default async (req, context) => {
  const cors = corsFor(req);
  if (req.method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
  const res = await handle(req, context);
  if (cors && req.method === "GET") for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
  return res;
};
