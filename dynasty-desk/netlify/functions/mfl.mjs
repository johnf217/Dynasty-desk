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
  const user = process.env.MFL_USERNAME, pass = process.env.MFL_PASSWORD;
  if (!user || !pass) throw httpError(500, "MFL_USERNAME and MFL_PASSWORD are not set in Netlify.");
  const res = await fetch(`${API}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA },
    body: new URLSearchParams({ USERNAME: user, PASSWORD: pass, XML: "1" }),
  });
  const text = await res.text();
  const m = text.match(/cookie_value="([^"]+)"/);
  if (!m) throw httpError(401, "MFL rejected the username or password. Check them in Netlify.");
  cookie = m[1];
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
      const proj = {};
      if (roster.length) {
        const ps = await mfl(exportUrl(l.host, "projectedScores", { L: l.id, W: wk, PLAYERS: roster.join(",") }));
        arr(ps.projectedScores?.playerScore).forEach((p) => { if (p.score !== "") proj[p.id] = +p.score; });
      }
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
          waiver: +f.waiverSortOrder || null,
        })),
        faabLimit: +lg.bbidSeasonLimit || null,
        roster,
        proj,
      };
    })
  );

  const ids = [...new Set(leagues.flatMap((l) => l.roster))];
  const players = {};
  if (ids.length) {
    const pl = await mfl(exportUrl(API_HOST, "players", { PLAYERS: ids.join(",") }), { auth: false });
    arr(pl.players?.player).forEach((p) => {
      const [last, first] = String(p.name).split(", ");
      players[p.id] = { name: first ? `${first} ${last}` : p.name, pos: p.position, team: p.team, rookie: p.status === "R" };
    });
  }

  const injuries = {};
  try {
    const inj = await mfl(exportUrl(API_HOST, "injuries", { W: wk }), { auth: false });
    arr(inj.injuries?.injury).forEach((i) => { injuries[i.id] = { status: i.status, details: i.details || "" }; });
  } catch { /* injuries are optional */ }

  return { year: YEAR, week: +wk, generated: Date.now(), games, byes, players, injuries, leagues };
}

async function submitLineup({ league, host, week, starters }) {
  if (!league || !week || !Array.isArray(starters) || !starters.length) throw httpError(400, "Missing league, week or starters.");
  if (!/^https:\/\/[a-z0-9]+\.myfantasyleague\.com$/.test(host)) throw httpError(400, "Unknown league server.");
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

export default async (req) => {
  const pin = process.env.APP_PIN;
  if (!pin) return json(500, { error: "APP_PIN is not set in Netlify." });
  if (req.headers.get("x-app-pin") !== pin) return json(401, { error: "Wrong PIN." });
  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      if (body.action === "lineup") return json(200, await submitLineup(body));
      return json(400, { error: "Unknown action." });
    }
    const w = new URL(req.url).searchParams.get("w");
    return json(200, await loadWeek(w && /^\d{1,2}$/.test(w) ? w : null));
  } catch (e) {
    return json(e.status || 500, { error: e.message || "Something went wrong talking to MFL." });
  }
};
