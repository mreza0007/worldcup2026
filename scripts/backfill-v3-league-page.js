const fs = require("fs");
const path = require("path");

const { loadEnvConfig } = require("../config/env");
loadEnvConfig();

const mongoose = require("../database");
const Game = require("../models/game");
const Team = require("../models/team");
const Group = require("../models/group");

const PROVIDER = "varzesh3";
const WORLD_CUP_LEAGUE_URL = "https://www.varzesh3.com/football/league/28/%D8%AC%D8%A7%D9%85-%D8%AC%D9%87%D8%A7%D9%86%DB%8C";
const EVENT_URL_BASE = "https://web-api.varzesh3.com/v2.0/livescore/football/matches";
const KICKOFF_WINDOW_MS = 18 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

const TEAM_MAP = JSON.parse(
  fs.readFileSync(path.join(__dirname, "../data/team-name-map.json"), "utf8")
);

let playerDb = {};
try {
  playerDb = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../data/player-names.json"), "utf8")
  );
} catch {}

function savePlayerDb() {
  try {
    fs.writeFileSync(
      path.join(__dirname, "../data/player-names.json"),
      JSON.stringify(playerDb, null, 2),
      "utf8"
    );
  } catch {}
}

function getPlayerName(id, faName) {
  const sid = String(id || "");
  if (sid && playerDb[sid]) return playerDb[sid];

  if (sid && faName) {
    playerDb[sid] = faName;
    savePlayerDb();
  }

  return faName || "Goal";
}

function normalizeName(value) {
  return String(value || "").trim();
}

function compactName(value) {
  return normalizeName(value)
    .replace(/[\u064a]/g, "ی")
    .replace(/[\u0643]/g, "ک")
    .replace(/[\u0623\u0625\u0622]/g, "ا")
    .replace(/[\u200c\u200e\u200f\s\-_().,'\"/]+/g, "")
    .toLowerCase();
}

function unescapeHtmlJson(value) {
  return String(value || "")
    .replace(/\\"/g, '"')
    .replace(/\\u0026/g, "&")
    .replace(/\\\\/g, "\\");
}

function eventText(event) {
  return [
    event.title,
    event.description,
    event.eventTitle,
    event.typeTitle,
    event.decisionTitle,
    event.name,
  ].filter(Boolean).join(" ").toLowerCase();
}

function isDisallowedGoalEvent(event) {
  const text = eventText(event);
  return event.eventType === 5 ||
    event.decisionTitle === "گل رد شده" ||
    (text.includes("گل") && (text.includes("رد شده") || text.includes("مردود") || text.includes("کمک داور ویدیویی"))) ||
    (text.includes("goal") && (text.includes("disallow") || text.includes("var")));
}

function isRedCardEvent(event) {
  const text = eventText(event);
  return event.cardType === 3 || event.cardType === 2 || text.includes("کارت قرمز") || text.includes("red card");
}

function hasExplicitScoredPenalty(event) {
  const booleanSignals = [event.isGoal, event.isScored, event.scored, event.goal, event.isSuccessful];
  if (booleanSignals.some((value) => value === true || value === 1 || value === "1")) return true;

  const result = String(event.result || event.outcome || event.decision || event.penaltyResult || "").trim().toLowerCase();
  return ["goal", "scored", "score", "successful", "converted"].includes(result);
}

function normalizeEventType(event) {
  if (isDisallowedGoalEvent(event)) return "var_disallowed_goal";
  if (isRedCardEvent(event)) return "red_card";

  const text = eventText(event);
  const type = Number(event.eventType ?? event.type);

  if (type === 1) return "goal";
  if (type === 2) return "yellow_card";
  if (type === 3) return hasExplicitScoredPenalty(event) ? "penalty_goal" : "penalty_event";
  if (type === 4) return "substitution";
  if (type === 6) return "var";
  if (type === 7) return "own_goal";
  if (type === 8) return "red_card";
  if (type === 9) return "penalty_missed";

  if (text.includes("تعویض")) return "substitution";
  if (text.includes("کارت زرد")) return "yellow_card";
  if (text.includes("کارت قرمز")) return "red_card";
  if (text.includes("گل به خودی")) return "own_goal";
  if (text.includes("پنالتی") && (text.includes("از دست") || text.includes("مهار") || text.includes("خراب"))) return "penalty_missed";
  if (text.includes("پنالتی")) return "penalty_event";
  if (text.includes("گل")) return "goal";
  if (text.includes("var")) return "var";

  return "unknown";
}

function isScoredGoalEvent(event) {
  const normalizedType = normalizeEventType(event);
  return ["goal", "own_goal", "penalty_goal"].includes(normalizedType);
}

function eventMinute(event) {
  return event.time || event.minute || event.eventTime || "";
}

function eventPlayerName(event) {
  const playerObject = event.player && typeof event.player === "object" ? event.player : {};
  return event.playerName ||
    event.strickerName ||
    event.strikerName ||
    event.kickerName ||
    event.cardPlayerName ||
    playerObject.name ||
    "";
}

function normalizeEvent(event, index) {
  const normalizedType = normalizeEventType(event);
  return {
    id: event.id || event.eventId || index,
    minute: eventMinute(event),
    raw_minute: eventMinute(event),
    type: event.eventType ?? event.type ?? null,
    raw_type: event.eventType ?? event.type ?? null,
    normalized_type: normalizedType,
    is_scoring_event: isScoredGoalEvent(event),
    side: event.side === 0 ? "home" : event.side === 1 ? "away" : "",
    team_side: event.side === 0 ? "home" : event.side === 1 ? "away" : "",
    player: eventPlayerName(event),
    assist: event.assistName || event.assistantName || event.assistPlayerName || event.assist?.name || null,
    description: event.description || event.title || event.eventTitle || event.typeTitle || normalizedType,
    video_url: event.videoUrl || event.video_url || null,
    created_at: event.createdAt || event.created_at || null,
    raw_event: event,
  };
}

async function fetchLeagueHtml() {
  console.log("[backfill] Fetching league page...");
  const response = await fetch(WORLD_CUP_LEAGUE_URL, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      "User-Agent": "Mozilla/5.0",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!response.ok) throw new Error(`League page returned ${response.status}`);

  const html = await response.text();
  console.log(`[backfill] League page length=${html.length}`);
  return html;
}

function extractLeagueMatches(html) {
  const text = unescapeHtmlJson(html);
  const positions = [];
  const idRegex = /"id"\s*:\s*(44\d{4,}|46\d{4,})/g;
  let match;

  while ((match = idRegex.exec(text)) !== null) {
    positions.push({ id: String(match[1]), index: match.index });
  }

  const seen = new Set();
  const matches = [];

  for (let i = 0; i < positions.length; i++) {
    const id = positions[i].id;
    if (seen.has(id)) continue;

    const start = positions[i].index;
    const end = positions[i + 1] ? positions[i + 1].index : Math.min(start + 8000, text.length);
    const chunk = text.slice(start, end);

    if (!chunk.includes("/football/match/")) continue;
    if (!chunk.includes("scheduledStartOn")) continue;

    const hostBlock = (chunk.match(/"host"\s*:\s*\{([\s\S]*?)\}\s*,\s*"guest"/) || [])[1] || "";
    const guestBlock = (chunk.match(/"guest"\s*:\s*\{([\s\S]*?)\}\s*,/) || [])[1] || "";
    const host = (hostBlock.match(/"name"\s*:\s*"([^"]+)"/) || [])[1] || "";
    const guest = (guestBlock.match(/"name"\s*:\s*"([^"]+)"/) || [])[1] || "";
    const goalsMatch = chunk.match(/"goals"\s*:\s*\{\s*"host"\s*:\s*(\d+)\s*,\s*"guest"\s*:\s*(\d+)/);
    const date = (chunk.match(/"date"\s*:\s*"([^"]+)"/) || [])[1] || "";
    const link = (chunk.match(/"link"\s*:\s*"([^"]*\/football\/match\/[^"]+)"/) || [])[1] || "";
    const status = (chunk.match(/"status"\s*:\s*(\d+)/) || [])[1] || "";
    const statusTitle = (chunk.match(/"statusTitle"\s*:\s*"([^"]+)"/) || [])[1] || "";
    const scheduledStartOn = (chunk.match(/"scheduledStartOn"\s*:\s*"([^"]+)"/) || [])[1] || "";

    seen.add(id);
    matches.push({
      id,
      host: normalizeName(host),
      guest: normalizeName(guest),
      hostGoals: goalsMatch ? String(goalsMatch[1]) : "",
      guestGoals: goalsMatch ? String(goalsMatch[2]) : "",
      date,
      scheduledStartOn,
      status,
      statusTitle,
      link,
    });
  }

  matches.sort((a, b) => {
    const ta = new Date(a.scheduledStartOn || 0).getTime();
    const tb = new Date(b.scheduledStartOn || 0).getTime();
    return ta - tb || Number(a.id) - Number(b.id);
  });

  console.log(`[backfill] Extracted ${matches.length} league matches from ${positions.length} id positions`);
  return matches;
}

async function buildTeamMap() {
  const teams = await Team.find({}).lean();
  const teamByFa = {};

  for (const team of teams) {
    teamByFa[compactName(team.name_fa)] = team.id;
  }

  for (const [fa, en] of Object.entries(TEAM_MAP)) {
    const team = teams.find((candidate) => candidate.name_en === en);
    if (team) teamByFa[compactName(fa)] = team.id;
  }

  return teamByFa;
}

async function fetchEvents(matchId) {
  try {
    const response = await fetch(`${EVENT_URL_BASE}/${matchId}/events`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { "User-Agent": "MatchPulse/1.0" },
    });

    if (!response.ok) throw new Error(`events returned ${response.status}`);

    const events = await response.json();
    const normalizedEvents = (Array.isArray(events) ? events : []).map(normalizeEvent);
    const homeGoals = [];
    const awayGoals = [];

    for (const event of Array.isArray(events) ? events : []) {
      if (!isScoredGoalEvent(event)) continue;

      const id = event.strikerId || event.kickerId || event.playerId || "";
      const name = getPlayerName(
        id,
        event.strickerName || event.strikerName || event.kickerName || eventPlayerName(event) || "Goal"
      );
      const time = eventMinute(event);
      const penalty = normalizeEventType(event) === "penalty_goal" ? "(p)" : "";
      const scorer = `"${name} ${time}'${penalty}"`;

      if (event.side === 0) homeGoals.push(scorer);
      if (event.side === 1) awayGoals.push(scorer);
    }

    return {
      count: Array.isArray(events) ? events.length : 0,
      normalized_count: normalizedEvents.length,
      normalized_events: normalizedEvents,
      home_scorers: homeGoals.length ? `{${homeGoals.join(",")}}` : "null",
      away_scorers: awayGoals.length ? `{${awayGoals.join(",")}}` : "null",
    };
  } catch (error) {
    console.warn(`[backfill] Could not fetch events for ${matchId}: ${error.message}`);
    return null;
  }
}

async function findLocalGame(teamByFa, v3) {
  const homeTeamId = teamByFa[compactName(v3.host)];
  const awayTeamId = teamByFa[compactName(v3.guest)];

  if (!homeTeamId || !awayTeamId) {
    return {
      game: null,
      reason: `team mapping failed: ${v3.host}->${homeTeamId || "missing"}, ${v3.guest}->${awayTeamId || "missing"}`,
    };
  }

  const providerId = String(v3.id || "");
  const alreadyLinked = await Game.findOne({
    $or: [
      { external_match_id: providerId },
      { raw_provider_match_id: providerId },
    ],
  });
  if (alreadyLinked) return { game: alreadyLinked, reason: "already linked by provider id" };

  const candidates = await Game.find({ home_team_id: homeTeamId, away_team_id: awayTeamId }).sort({ date: 1 });
  if (!candidates.length) return { game: null, reason: "no local candidate by teams" };

  const providerKickoff = new Date(v3.scheduledStartOn);
  if (Number.isNaN(providerKickoff.getTime())) {
    return { game: candidates[0], reason: "matched by teams only" };
  }

  const ranked = candidates
    .map((game) => ({
      game,
      distance: Math.abs(new Date(game.date).getTime() - providerKickoff.getTime()),
    }))
    .sort((a, b) => a.distance - b.distance);

  if (ranked[0] && ranked[0].distance <= KICKOFF_WINDOW_MS) {
    return { game: ranked[0].game, reason: `matched by teams/date ${ranked[0].distance}ms` };
  }

  return { game: null, reason: `no local candidate within kickoff window; best=${ranked[0]?.distance}` };
}

function isFinished(v3) {
  return String(v3.status) === "7" || /finished|final|نتیجه نهایی|پایان/.test(String(v3.statusTitle || "").toLowerCase());
}

function isLive(v3) {
  return ["2", "3", "4", "5", "6"].includes(String(v3.status)) || /live|زنده/.test(String(v3.statusTitle || "").toLowerCase());
}

async function updateStandings() {
  const matches = await Game.find({ finished: "TRUE", type: "group" }).lean();
  const teams = await Team.find({}).lean();
  const stats = {};

  for (const team of teams) {
    stats[team.id] = { team_id: team.id, mp: 0, w: 0, d: 0, l: 0, pts: 0, gf: 0, ga: 0, gd: 0 };
  }

  for (const match of matches) {
    const homeGoals = parseInt(match.home_score, 10) || 0;
    const awayGoals = parseInt(match.away_score, 10) || 0;
    const home = stats[match.home_team_id];
    const away = stats[match.away_team_id];
    if (!home || !away) continue;

    home.mp++;
    away.mp++;
    home.gf += homeGoals;
    home.ga += awayGoals;
    away.gf += awayGoals;
    away.ga += homeGoals;

    if (homeGoals > awayGoals) {
      home.w++;
      home.pts += 3;
      away.l++;
    } else if (homeGoals < awayGoals) {
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
  for (const group of groups) {
    const updatedTeams = group.teams.map((row) => {
      const stat = stats[row.team_id];
      if (!stat) return row;
      return {
        team_id: row.team_id,
        mp: String(stat.mp),
        w: String(stat.w),
        d: String(stat.d),
        l: String(stat.l),
        pts: String(stat.pts),
        gf: String(stat.gf),
        ga: String(stat.ga),
        gd: String(stat.gd),
      };
    });

    updatedTeams.sort(
      (a, b) =>
        parseInt(b.pts, 10) - parseInt(a.pts, 10) ||
        parseInt(b.gd, 10) - parseInt(a.gd, 10) ||
        parseInt(b.gf, 10) - parseInt(a.gf, 10)
    );

    await Group.updateOne({ _id: group._id }, { $set: { teams: updatedTeams } });
  }
}

async function main() {
  await mongoose.connection.asPromise();

  const html = await fetchLeagueHtml();
  const v3Matches = extractLeagueMatches(html);
  fs.writeFileSync(path.join(process.cwd(), "v3-league-matches.json"), JSON.stringify(v3Matches, null, 2), "utf8");

  const teamByFa = await buildTeamMap();
  const stats = {
    extracted: v3Matches.length,
    mapped: 0,
    updated: 0,
    skippedFuture: 0,
    finished: 0,
    live: 0,
    failed: 0,
    eventsFetched: 0,
  };
  const failures = [];

  for (const v3 of v3Matches) {
    const { game, reason } = await findLocalGame(teamByFa, v3);

    if (!game) {
      stats.failed++;
      failures.push({ provider_id: v3.id, match: `${v3.host} vs ${v3.guest}`, date: v3.scheduledStartOn, reason });
      continue;
    }

    stats.mapped++;
    const finished = isFinished(v3);
    const live = isLive(v3);
    if (finished) stats.finished++;
    if (live) stats.live++;
    if (!finished && !live) stats.skippedFuture++;

    const update = {
      external_match_id: String(v3.id),
      raw_provider_match_id: String(v3.id),
      provider: PROVIDER,
      raw_provider_status: {
        status: Number(v3.status),
        statusTitle: v3.statusTitle || null,
        source: "league-page",
        date: v3.date,
        scheduledStartOn: v3.scheduledStartOn,
        link: v3.link,
      },
      provider_payload_updated_at: new Date(),
    };

    if (v3.hostGoals !== "" && v3.guestGoals !== "") {
      update.home_score = String(v3.hostGoals);
      update.away_score = String(v3.guestGoals);
    }

    if (finished) {
      update.finished = "TRUE";
      update.time_elapsed = "finished";
    } else if (live) {
      update.finished = "FALSE";
      update.time_elapsed = "live";
    }

    if (finished || live) {
      const events = await fetchEvents(v3.id);
      if (events) {
        stats.eventsFetched++;
        update.home_scorers = events.home_scorers;
        update.away_scorers = events.away_scorers;
        update.raw_provider_events = events.normalized_events;
      }
    }

    await Game.updateOne({ _id: game._id }, { $set: update });
    stats.updated++;
    console.log(`[backfill] updated local=${game.id} provider=${v3.id} ${v3.host} ${v3.hostGoals || "?"}-${v3.guestGoals || "?"} ${v3.guest}`);
  }

  await updateStandings();
  fs.writeFileSync(path.join(process.cwd(), "v3-backfill-failures.json"), JSON.stringify(failures, null, 2), "utf8");

  console.log("[backfill] done");
  console.log(stats);
  console.log(`[backfill] failures=${failures.length}`);
  console.log("[backfill] wrote v3-league-matches.json and v3-backfill-failures.json");

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("[backfill] fatal:", error);
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
