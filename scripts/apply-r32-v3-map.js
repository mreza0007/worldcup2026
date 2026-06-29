/**
 * One-time Varzesh3 Round-of-32 backfill.
 *
 * Dry run (default):
 *   node scripts/apply-r32-v3-map.js
 *
 * Apply only after a perfect dry run:
 *   node scripts/apply-r32-v3-map.js --apply
 */

const mongoose = require("mongoose");
const { loadEnvConfig, config } = require("../config/env");

loadEnvConfig();
mongoose.set("strictQuery", false);

const APPLY = process.argv.includes("--apply");
const unknownFlags = process.argv.slice(2).filter((arg) => arg !== "--apply");
const mongoUri =
  process.env.MONGODB_URL ||
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.DATABASE_URL ||
  config.MONGODB_URL;

const r32 = [
  { id: 73, external_match_id: "464755", home_en: "South Africa", away_en: "Canada" },
  { id: 74, external_match_id: "464770", home_en: "Germany", away_en: "Paraguay" },
  { id: 75, external_match_id: "464756", home_en: "Netherlands", away_en: "Morocco" },
  { id: 76, external_match_id: "464740", home_en: "Brazil", away_en: "Japan" },
  { id: 77, external_match_id: "464771", home_en: "France", away_en: "Sweden" },
  { id: 78, external_match_id: "464757", home_en: "Ivory Coast", away_en: "Norway" },
  { id: 79, external_match_id: "464772", home_en: "Mexico", away_en: "Ecuador" },
  { id: 80, external_match_id: "464773", home_en: "England", away_en: "Democratic Republic of the Congo" },
  { id: 81, external_match_id: "464775", home_en: "United States", away_en: "Bosnia and Herzegovina" },
  { id: 82, external_match_id: "464774", home_en: "Belgium", away_en: "Senegal" },
  { id: 83, external_match_id: "464759", home_en: "Portugal", away_en: "Croatia" },
  { id: 84, external_match_id: "464758", home_en: "Spain", away_en: "Austria" },
  { id: 85, external_match_id: "464776", home_en: "Switzerland", away_en: "Algeria" },
  { id: 86, external_match_id: "464761", home_en: "Argentina", away_en: "Cape Verde" },
  { id: 87, external_match_id: "464777", home_en: "Colombia", away_en: "Ghana" },
  { id: 88, external_match_id: "464760", home_en: "Australia", away_en: "Egypt" },
];

const ENGLISH_TEAM_FIELDS = [
  "name_en",
  "english_name",
  "nameEnglish",
  "short_name_en",
];

function normalizeEnglishName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function findTeamByEnglishName(teams, englishName) {
  const expected = normalizeEnglishName(englishName);

  for (const field of ENGLISH_TEAM_FIELDS) {
    const team = teams.find(
      (candidate) => normalizeEnglishName(candidate[field]) === expected
    );
    if (team) return team;
  }

  return null;
}

function gameQuery(id) {
  return {
    $or: [
      { id: Number(id) },
      { id: String(id) },
      { internal_match_id: Number(id) },
      { internal_match_id: String(id) },
    ],
  };
}

function teamPersianName(team) {
  return typeof team?.name_fa === "string" ? team.name_fa.trim() : "";
}

function buildUpdate(match, homeTeam, awayTeam) {
  return {
    provider: "varzesh3",
    external_match_id: match.external_match_id,
    raw_provider_match_id: match.external_match_id,
    homeTeam: homeTeam._id,
    visitingTeam: awayTeam._id,
    home_team_id: String(homeTeam.id),
    away_team_id: String(awayTeam.id),
    home_team_label: match.home_en,
    away_team_label: match.away_en,
    r32_home_en: match.home_en,
    r32_home_fa: teamPersianName(homeTeam),
    r32_away_en: match.away_en,
    r32_away_fa: teamPersianName(awayTeam),
    provider_payload_updated_at: new Date(),
  };
}

function printMatchResult(details) {
  console.log(
    [
      `[r32] local=${details.localId}`,
      `external_match_id=${details.externalMatchId}`,
      `home="${details.homeName}"`,
      `away="${details.awayName}"`,
      `homeTeam=${details.homeFound ? "found" : "MISSING"}`,
      `awayTeam=${details.awayFound ? "found" : "MISSING"}`,
      `game=${details.gameFound ? "found" : "MISSING"}`,
      `action=${details.action}`,
    ].join(" | ")
  );
}

async function main() {
  if (unknownFlags.length) {
    throw new Error(`Unknown argument(s): ${unknownFlags.join(", ")}`);
  }

  console.log(`[r32] mode=${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(
    APPLY
      ? "[r32] MongoDB updates are enabled."
      : "[r32] MongoDB is read-only in this run; no updates will be written."
  );

  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10000 });

  const db = mongoose.connection.db;
  const games = db.collection("games");
  const teams = await db.collection("teams").find({}).toArray();
  const totals = {
    gamesFound: 0,
    teamsFound: 0,
    wouldUpdate: 0,
    updated: 0,
    skipped: 0,
  };
  const plans = [];

  console.log(
    `[r32] database=${mongoose.connection.name} collection=games teamsLoaded=${teams.length}`
  );

  for (const match of r32) {
    const homeTeam = findTeamByEnglishName(teams, match.home_en);
    const awayTeam = findTeamByEnglishName(teams, match.away_en);
    const game = await games.findOne(gameQuery(match.id));

    if (homeTeam) totals.teamsFound++;
    else console.warn(`[r32] TEAM NOT FOUND: home "${match.home_en}"`);

    if (awayTeam) totals.teamsFound++;
    else console.warn(`[r32] TEAM NOT FOUND: away "${match.away_en}"`);

    if (game) totals.gamesFound++;
    else console.warn(`[r32] GAME NOT FOUND: local id ${match.id}`);

    const ready = Boolean(game && homeTeam && awayTeam);
    const details = {
        localId: match.id,
        externalMatchId: match.external_match_id,
        homeName: match.home_en,
        awayName: match.away_en,
        homeFound: Boolean(homeTeam),
        awayFound: Boolean(awayTeam),
        gameFound: Boolean(game),
      };

    if (!ready) {
      totals.skipped++;
      plans.push({ ready, details });
      continue;
    }

    totals.wouldUpdate++;
    plans.push({ ready, details, match, game, homeTeam, awayTeam });
  }

  const perfect =
    totals.gamesFound === r32.length &&
    totals.teamsFound === r32.length * 2 &&
    totals.wouldUpdate === r32.length;

  if (APPLY && !perfect) {
    console.error(
      "[r32] APPLY BLOCKED: preflight is incomplete; no MongoDB updates were written."
    );
    totals.skipped = r32.length;
    for (const plan of plans) {
      printMatchResult({
        ...plan.details,
        action: plan.ready ? "apply-blocked" : "skipped",
      });
    }
  } else if (APPLY) {
    for (const plan of plans) {
      const result = await games.updateOne(
        { _id: plan.game._id },
        { $set: buildUpdate(plan.match, plan.homeTeam, plan.awayTeam) }
      );
      totals.updated += result.modifiedCount;
      printMatchResult({
        ...plan.details,
        action: result.modifiedCount ? "updated" : "matched-no-change",
      });
    }
  } else {
    for (const plan of plans) {
      printMatchResult({
        ...plan.details,
        action: plan.ready ? "would-update" : "skipped",
      });
    }
  }

  console.log(
    `[r32] totals gamesFound=${totals.gamesFound} teamsFound=${totals.teamsFound} wouldUpdate=${totals.wouldUpdate} updated=${totals.updated} skipped=${totals.skipped}`
  );

  if (!APPLY && !perfect) {
    console.warn(
      "[r32] DRY-RUN NOT PERFECT: do not use --apply until gamesFound=16 and teamsFound=32."
    );
  }
}

main()
  .catch((error) => {
    console.error("[r32] failed", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await mongoose.disconnect();
    } catch (error) {
      console.error("[r32] disconnect failed", error);
      process.exitCode = 1;
    }
  });
