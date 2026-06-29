/**
 * World Cup 2026 Auto Live Updater
 *
 * Fetches live match data from Varzesh3 and updates the existing Game records.
 * This script intentionally uses the same app database configuration and the
 * same games collection that import-matches.js and /get/games use.
 */

const fs = require("fs");
const path = require("path");

const { loadEnvConfig, config } = require("../config/env");
loadEnvConfig();

const mongoose = require("../database");
const Game = require("../models/game");
const Team = require("../models/team");
const Group = require("../models/group");

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "3000", 10);
const PROVIDER = "varzesh3";
const WORLD_CUP_LEAGUE_ID = 28;
const KICKOFF_WINDOW_MS = parseInt(
  process.env.MATCH_KICKOFF_WINDOW_MS || String(18 * 60 * 60 * 1000),
  10
);

const TEAM_MAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../data/team-name-map.json"), "utf8")
);

let playerDb = {};
try {
  playerDb = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../data/player-names.json"), "utf8")
  );
} catch {}

function getPlayerName(id, faName) {
  const sid = String(id || "");
  if (playerDb[sid]) return playerDb[sid];

  if (sid && faName && !playerDb[sid]) {
    playerDb[sid] = faName;
    try {
      fs.writeFileSync(
        path.join(__dirname, "../data/player-names.json"),
        JSON.stringify(playerDb, null, 2)
      );
    } catch {}
  }

  return faName;
}

function normalizeName(value) {
  return String(value || "").trim();
}

function mapStatus(status, liveTime, isLive) {
  if (isLive) return liveTime || "Live";
  if (status === 7) return "finished";
  return "notstarted";
}

function getScore(m, side, fallback) {
  const fromGoals = side === "home" ? m.goals?.host : m.goals?.guest;
  const fromTeam = side === "home" ? m.host?.goals : m.guest?.goals;
  const fromLegacy = side === "home" ? m.hostGoalCount : m.guestGoalCount;
  return String(fromGoals ?? fromTeam ?? fromLegacy ?? fallback);
}

function parseProviderKickoff(m) {
  const candidates = [
    m.startOnUtc,
    m.startDateUtc,
    m.startTimeUtc,
    m.startOn,
    m.startDate,
    m.dateTime,
  ];

  for (const value of candidates) {
    if (!value) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  if (m.date && m.time) {
    const parsed = new Date(`${m.date} ${m.time}`);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }

  return null;
}

function buildRawStatus(m) {
  return {
    status: m.status ?? null,
    statusTitle: m.statusTitle ?? null,
    liveTime: m.liveTime ?? null,
    isLive: Boolean(m.isLive),
    startOnUtc: m.startOnUtc ?? null,
    date: m.date ?? null,
    time: m.time ?? null,
  };
}

function eventText(event) {
  return [
    event.title,
    event.description,
    event.eventTitle,
    event.typeTitle,
    event.name,
  ].filter(Boolean).join(" ").toLowerCase();
}

function isDisallowedGoalEvent(event) {
  const text = eventText(event);
  return event.eventType === 5 ||
    (text.includes("گل") && (text.includes("رد شده") || text.includes("مردود") || text.includes("کمک داور ویدیویی"))) ||
    (text.includes("goal") && (text.includes("disallow") || text.includes("var")));
}

function hasExplicitScoredPenalty(event) {
  const booleanSignals = [event.isGoal, event.isScored, event.scored, event.goal, event.isSuccessful];
  if (booleanSignals.some((value) => value === true || value === 1 || value === "1")) return true;

  const result = String(event.result || event.outcome || event.decision || event.penaltyResult || "").trim().toLowerCase();
  return ["goal", "scored", "score", "successful", "converted"].includes(result);
}

function isScoredGoalEvent(event) {
  if (isDisallowedGoalEvent(event)) return false;
  if (Number(event.eventType) === 3) return hasExplicitScoredPenalty(event);
  return Number(event.eventType) === 1 || Number(event.eventType) === 7;
}

function hasChanged(match, newData) {
  return Object.entries(newData).some(([key, value]) => {
    const current = match[key];

    if (value instanceof Date) {
      return !(current instanceof Date) || current.getTime() !== value.getTime();
    }

    if (typeof value === "object" && value !== null) {
      return JSON.stringify(current || null) !== JSON.stringify(value);
    }

    return String(current ?? "") !== String(value ?? "");
  });
}

async function fetchVarzesh3(dayOffset) {
  const url =
    dayOffset === 0
      ? "https://web-api.varzesh3.com/v2.0/livescore/today"
      : `https://web-api.varzesh3.com/v2.0/livescore/${dayOffset}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const data = await res.json();
  const matches = [];

  for (const league of data || []) {
    if (league.id !== WORLD_CUP_LEAGUE_ID) continue;

    if (Array.isArray(league.matches)) {
      matches.push(...league.matches);
    }

    for (const dg of league.dates || []) {
      for (const m of dg.matches || []) matches.push(m);
    }
  }

  console.log(
    `[auto-updater] Varzesh3 offset ${dayOffset}: fetched ${matches.length} World Cup matches`
  );

  return matches;
}

async function fetchEvents(matchId) {
  try {
    const res = await fetch(
      `https://web-api.varzesh3.com/v2.0/livescore/football/matches/${matchId}/events`,
      { signal: AbortSignal.timeout(5000) }
    );
    const events = await res.json();
    const homeGoals = [];
    const awayGoals = [];

    for (const e of events || []) {
      if (isScoredGoalEvent(e)) {
        const id = e.strikerId || e.kickerId || "";
        const name = getPlayerName(
          id,
          e.strickerName || e.strikerName || e.kickerName || "Goal"
        );
        const time = e.time || "";
        const pen = e.eventType === 3 ? "(p)" : "";
        const scorer = `"${name} ${time}'${pen}"`;

        if (e.side === 0) homeGoals.push(scorer);
        if (e.side === 1) awayGoals.push(scorer);
      }
    }

    return {
      home_scorers: homeGoals.length ? `{${homeGoals.join(",")}}` : "null",
      away_scorers: awayGoals.length ? `{${awayGoals.join(",")}}` : "null",
    };
  } catch (err) {
    console.warn(
      `[auto-updater] Could not fetch events for Varzesh3 match ${matchId}: ${err.message}`
    );
    return null;
  }
}

async function buildTeamMap() {
  const teams = await Team.find({}).lean();
  const teamByFa = {};

  for (const team of teams) {
    teamByFa[normalizeName(team.name_fa)] = team.id;
  }

  for (const [fa, en] of Object.entries(TEAM_MAP)) {
    const team = teams.find((t) => t.name_en === en);
    if (team) teamByFa[normalizeName(fa)] = team.id;
  }

  return teamByFa;
}

async function findLocalGame(homeTeamId, awayTeamId, providerMatchId, providerKickoff) {
  const providerId = String(providerMatchId || "");

  if (providerId) {
    const linked = await Game.findOne({
      $or: [
        { external_match_id: providerId },
        { raw_provider_match_id: providerId },
      ],
    });
    if (linked) return linked;
  }

  const candidates = await Game.find({
    home_team_id: homeTeamId,
    away_team_id: awayTeamId,
  }).sort({ date: 1 });

  if (!candidates.length) return null;
  if (!providerKickoff) return candidates[0];

  const withDistance = candidates
    .map((game) => ({
      game,
      distance: Math.abs(new Date(game.date).getTime() - providerKickoff.getTime()),
    }))
    .sort((a, b) => a.distance - b.distance);

  if (withDistance[0].distance <= KICKOFF_WINDOW_MS) {
    return withDistance[0].game;
  }

  return null;
}

async function syncMatches(v3Matches, options = {}) {
  const teamByFa = await buildTeamMap();
  const stats = {
    fetched: v3Matches.length,
    mappedToLocalTeams: 0,
    localGamesFound: 0,
    updated: 0,
    failedMapping: 0,
    failedLocalGame: 0,
  };

  for (const m of v3Matches) {
    const hostName = normalizeName(m.host?.name || m.hostName);
    const guestName = normalizeName(m.guest?.name || m.guestName);
    const homeTeamId = teamByFa[hostName];
    const awayTeamId = teamByFa[guestName];

    if (!homeTeamId || !awayTeamId) {
      stats.failedMapping++;
      if (options.verbose) {
        console.warn(
          `[auto-updater] Team mapping failed: "${hostName}" -> ${homeTeamId || "missing"}, "${guestName}" -> ${awayTeamId || "missing"}`
        );
      }
      continue;
    }

    stats.mappedToLocalTeams++;

    const providerMatchId = String(m.id || "");
    const providerKickoff = parseProviderKickoff(m);
    const match = await findLocalGame(
      homeTeamId,
      awayTeamId,
      providerMatchId,
      providerKickoff
    );

    if (!match) {
      stats.failedLocalGame++;
      if (options.verbose) {
        const kickoffText = providerKickoff ? providerKickoff.toISOString() : "unknown kickoff";
        console.warn(
          `[auto-updater] Local game not found: ${hostName} vs ${guestName} (${homeTeamId}-${awayTeamId}, ${kickoffText})`
        );
      }
      continue;
    }

    stats.localGamesFound++;

    const newData = {
      home_score: getScore(m, "home", match.home_score),
      away_score: getScore(m, "away", match.away_score),
      time_elapsed: mapStatus(m.status, m.liveTime, m.isLive),
      finished: m.status === 7 ? "TRUE" : match.finished,
      external_match_id: providerMatchId,
      raw_provider_match_id: providerMatchId,
      provider: PROVIDER,
      raw_provider_status: buildRawStatus(m),
    };

    if (m.isLive || m.status === 7) {
      const scorers = await fetchEvents(providerMatchId);
      if (scorers) {
        newData.home_scorers = scorers.home_scorers;
        newData.away_scorers = scorers.away_scorers;
      }
    }

    if (hasChanged(match, newData)) {
      await Game.updateOne(
        { _id: match._id },
        { $set: { ...newData, provider_payload_updated_at: new Date() } }
      );
      stats.updated++;
    }
  }

  console.log(
    `[auto-updater] Sync stats: fetched=${stats.fetched}, mapped=${stats.mappedToLocalTeams}, local_games_found=${stats.localGamesFound}, updated=${stats.updated}, failed_mapping=${stats.failedMapping}, failed_local_game=${stats.failedLocalGame}`
  );

  return stats;
}

async function updateStandings() {
  const matches = await Game.find({ finished: "TRUE", type: "group" }).lean();
  const teams = await Team.find({}).lean();

  const stats = {};
  for (const t of teams) {
    stats[t.id] = {
      team_id: t.id,
      mp: 0,
      w: 0,
      d: 0,
      l: 0,
      pts: 0,
      gf: 0,
      ga: 0,
      gd: 0,
    };
  }

  for (const m of matches) {
    const h = parseInt(m.home_score, 10) || 0;
    const a = parseInt(m.away_score, 10) || 0;
    const home = stats[m.home_team_id];
    const away = stats[m.away_team_id];
    if (!home || !away) continue;

    home.mp++;
    away.mp++;
    home.gf += h;
    home.ga += a;
    away.gf += a;
    away.ga += h;

    if (h > a) {
      home.w++;
      home.pts += 3;
      away.l++;
    } else if (h < a) {
      away.w++;
      away.pts += 3;
      home.l++;
    } else {
      home.d++;
      away.d++;
      home.pts++;
      away.pts++;
    }

    home.gd = home.gf - home.ga;
    away.gd = away.gf - away.ga;
  }

  const groups = await Group.find({});
  for (const g of groups) {
    const updatedTeams = g.teams.map((t) => {
      const s = stats[t.team_id];
      if (!s) return t;

      return {
        team_id: t.team_id,
        mp: String(s.mp),
        w: String(s.w),
        d: String(s.d),
        l: String(s.l),
        pts: String(s.pts),
        gf: String(s.gf),
        ga: String(s.ga),
        gd: String(s.gd),
      };
    });

    updatedTeams.sort(
      (a, b) =>
        parseInt(b.pts, 10) - parseInt(a.pts, 10) ||
        parseInt(b.gd, 10) - parseInt(a.gd, 10) ||
        parseInt(b.gf, 10) - parseInt(a.gf, 10)
    );

    await Group.updateOne({ _id: g._id }, { $set: { teams: updatedTeams } });
  }
}

async function fetchOffsets(offsets, verbose) {
  const byProviderId = new Map();

  for (const offset of offsets) {
    try {
      const matches = await fetchVarzesh3(offset);
      for (const match of matches) {
        byProviderId.set(String(match.id || `${offset}-${byProviderId.size}`), match);
      }
    } catch (err) {
      if (verbose) {
        console.warn(
          `[auto-updater] Varzesh3 offset ${offset} failed: ${err.message}`
        );
      }
    }
  }

  return [...byProviderId.values()];
}

async function fullSync() {
  console.log("[auto-updater] Full sync starting...");
  console.log(`[auto-updater] MongoDB URL: ${config.MONGODB_URL}`);
  console.log(`[auto-updater] Mongoose database: ${mongoose.connection.name || "connecting"}`);
  console.log("[auto-updater] Target collection: games");

  const allMatches = await fetchOffsets([-2, -1, 0, 1], true);
  console.log(
    `[auto-updater] Full sync fetched ${allMatches.length} unique Varzesh3 World Cup matches`
  );

  const stats = await syncMatches(allMatches, { verbose: true });
  await updateStandings();

  console.log(
    `[auto-updater] Full sync done: ${stats.updated} matches updated, standings recalculated`
  );
}

let lastFinishedCount = 0;
async function poll() {
  try {
    const todayMatches = await fetchVarzesh3(0);
    await syncMatches(todayMatches, { verbose: false });

    const count = await Game.countDocuments({ finished: "TRUE" });
    if (count !== lastFinishedCount) {
      lastFinishedCount = count;
      await updateStandings();
      console.log(`[auto-updater] Standings updated (${count} finished games)`);
    }
  } catch (err) {
    console.warn(`[auto-updater] Poll failed: ${err.message}`);
  }
}

async function start() {
  await mongoose.connection.asPromise();
  console.log(`[auto-updater] Starting - polling every ${POLL_INTERVAL}ms`);
  await fullSync();
  setInterval(poll, POLL_INTERVAL);
}

start().catch((err) => {
  console.error("[auto-updater] Fatal error:", err);
  process.exit(1);
});
