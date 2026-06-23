const Game = require('../models/game');
const Team = require('../models/team');
const Group = require('../models/group');
const Stadium = require('../models/stadium');

const PROVIDER = 'varzesh3';
const EVENT_TYPES = {
    1: 'goal',
    2: 'yellow_card',
    3: 'penalty',
    4: 'substitution',
    6: 'var',
    7: 'own_goal',
    8: 'second_yellow_card',
    9: 'missed_penalty',
    10: 'injury',
    11: 'half_time',
    12: 'full_time'
};

function publicId(id) {
    const n = Number(id);
    return Number.isNaN(n) ? id : n;
}

function numberOrZero(value) {
    const n = Number(value);
    return Number.isNaN(n) ? 0 : n;
}

function buildMap(items) {
    return items.reduce((acc, item) => {
        acc[item.id] = item;
        return acc;
    }, {});
}

function splitIranDate(value) {
    const [dateIran = null, timeIran = null] = String(value || '').split(' ');
    return {
        date_iran: dateIran,
        time_iran: timeIran,
        datetime_iran: value || null
    };
}

function formatStageLabel(game) {
    if (game.type === 'group' && game.group) return `Group ${game.group}`;
    if (!game.type) return game.group || null;

    return String(game.type)
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function getExternalMatchId(game) {
    return game.external_match_id || game.raw_provider_match_id || null;
}

function normalizeStatus(game) {
    const raw = game.raw_provider_status || {};
    const rawMinute = raw.liveTime || game.time_elapsed || null;
    const elapsed = String(game.time_elapsed || '').toLowerCase();
    const finished = game.finished === 'TRUE' || elapsed === 'finished' || raw.status === 7;
    const scheduled = !finished && (!elapsed || elapsed === 'notstarted');
    const isLive = Boolean(raw.isLive) || (!finished && !scheduled);

    let status = 'scheduled';
    if (finished) status = 'finished';
    else if (isLive) status = 'live';

    const minuteMatch = String(rawMinute || '').match(/\d+/);
    const minute = status === 'live' && minuteMatch ? Number(minuteMatch[0]) : null;
    const statusTitle = raw.statusTitle || (finished ? 'Finished' : isLive ? 'Live' : 'Scheduled');
    const liveBadge = finished ? 'FT' : isLive ? (rawMinute || 'LIVE') : '';

    return {
        status,
        status_title: statusTitle,
        live_badge: liveBadge,
        is_live: isLive,
        minute,
        raw_minute: rawMinute
    };
}

function buildScore(game) {
    const home = numberOrZero(game.home_score);
    const away = numberOrZero(game.away_score);
    return {
        home_score: home,
        away_score: away,
        score: { home, away }
    };
}

function buildResult(game, status, score) {
    if (status !== 'finished') return null;
    if (score.home > score.away) return 'home';
    if (score.away > score.home) return 'away';
    return 'draw';
}

function teamName(team, fallback) {
    return team ? team.name_en : fallback || null;
}

function normalizeMatch(game, maps) {
    const home = maps.teams[game.home_team_id];
    const away = maps.teams[game.away_team_id];
    const stadium = maps.stadiums[game.stadium_id];
    const kickoff = game.date instanceof Date ? game.date.toISOString() : null;
    const iranDate = splitIranDate(game.persian_date);
    const status = normalizeStatus(game);
    const score = buildScore(game);

    return {
        id: publicId(game.id),
        internal_match_id: publicId(game.id),
        external_match_id: getExternalMatchId(game),
        provider: game.provider || (getExternalMatchId(game) ? PROVIDER : null),
        home_en: teamName(home, game.home_team_label),
        home_fa: home ? home.name_fa : null,
        away_en: teamName(away, game.away_team_label),
        away_fa: away ? away.name_fa : null,
        home_flag: home ? home.flag : null,
        away_flag: away ? away.flag : null,
        home_logo: null,
        away_logo: null,
        kickoff,
        kickoff_utc: kickoff,
        date: game.local_date || null,
        date_iran: iranDate.date_iran,
        time_iran: iranDate.time_iran,
        datetime_iran: iranDate.datetime_iran,
        group: game.group || null,
        stage: game.type || null,
        stage_label: formatStageLabel(game),
        stadium: stadium ? stadium.name_en : null,
        city: stadium ? stadium.city_en : null,
        status: status.status,
        status_title: status.status_title,
        live_badge: status.live_badge,
        is_live: status.is_live,
        minute: status.minute,
        home_score: score.home_score,
        away_score: score.away_score,
        score: score.score,
        result: buildResult(game, status.status, score.score),
        last_updated: game.provider_payload_updated_at ? game.provider_payload_updated_at.toISOString() : null
    };
}

function normalizeLiveMatch(game) {
    const status = normalizeStatus(game);
    const score = buildScore(game);

    return {
        id: publicId(game.id),
        internal_match_id: publicId(game.id),
        external_match_id: getExternalMatchId(game),
        provider: game.provider || (getExternalMatchId(game) ? PROVIDER : null),
        status: status.status,
        status_title: status.status_title,
        is_live: status.is_live,
        live_badge: status.live_badge,
        minute: status.minute,
        raw_minute: status.raw_minute,
        home_score: score.home_score,
        away_score: score.away_score,
        score: score.score,
        video_url: null,
        summary_url: null,
        last_updated: game.provider_payload_updated_at ? game.provider_payload_updated_at.toISOString() : null
    };
}

function detectEventType(event) {
    const text = [
        event.title,
        event.description,
        event.eventTitle,
        event.typeTitle,
        event.name
    ].filter(Boolean).join(' ').toLowerCase();

    if (text.includes('\u062a\u0639\u0648\u06cc\u0636')) return 'substitution';
    if (text.includes('\u06a9\u0627\u0631\u062a \u0632\u0631\u062f')) return 'yellow_card';
    if (text.includes('\u06a9\u0627\u0631\u062a \u0642\u0631\u0645\u0632')) return 'red_card';
    if (text.includes('\u067e\u0646\u0627\u0644\u062a\u06cc')) return 'penalty';
    if (text.includes('\u06af\u0644')) return 'goal';

    const explicit = EVENT_TYPES[event.eventType] || EVENT_TYPES[event.type];
    if (explicit) return explicit;

    if (text.includes('own')) return 'own_goal';
    if (text.includes('penalty') && text.includes('miss')) return 'missed_penalty';
    if (text.includes('penalty')) return 'penalty';
    if (text.includes('goal')) return 'goal';
    if (text.includes('yellow')) return 'yellow_card';
    if (text.includes('red')) return 'red_card';
    if (text.includes('sub')) return 'substitution';
    if (text.includes('var')) return 'var';
    if (text.includes('injury')) return 'injury';
    if (text.includes('half')) return 'half_time';
    if (text.includes('full')) return 'full_time';

    return 'unknown';
}

function playerName(event) {
    return event.playerName ||
        event.strickerName ||
        event.strikerName ||
        event.kickerName ||
        event.player?.name ||
        null;
}

function assistName(event) {
    return event.assistName ||
        event.assistantName ||
        event.assistPlayerName ||
        event.assist?.name ||
        null;
}

function eventDescription(event, normalizedType) {
    return event.description ||
        event.title ||
        event.eventTitle ||
        event.typeTitle ||
        normalizedType;
}

function normalizeEvent(event, index, game, maps) {
    const normalizedType = detectEventType(event);
    const side = event.side === 0 ? 'home' : event.side === 1 ? 'away' : null;
    const teamId = side === 'home' ? game.home_team_id : side === 'away' ? game.away_team_id : null;
    const team = teamId ? maps.teams[teamId] : null;
    const rawMinute = event.time || event.minute || event.eventTime || null;
    const minuteMatch = String(rawMinute || '').match(/\d+/);

    return {
        id: event.id || event.eventId || `${getExternalMatchId(game) || game.id}-${index}`,
        minute: minuteMatch ? Number(minuteMatch[0]) : null,
        raw_minute: rawMinute,
        type: event.eventType || event.type || null,
        normalized_type: normalizedType,
        team: teamId,
        team_side: side,
        team_name: team ? team.name_en : null,
        player: playerName(event),
        assist: assistName(event),
        description: eventDescription(event, normalizedType),
        video_url: event.videoUrl || event.video_url || null,
        created_at: event.createdAt || event.created_at || null
    };
}

async function getMaps() {
    const [teams, stadiums] = await Promise.all([
        Team.find({}).lean(),
        Stadium.find({}).lean()
    ]);

    return {
        teams: buildMap(teams),
        stadiums: buildMap(stadiums)
    };
}

module.exports = (app) => {
    app.get('/matches', async (req, res) => {
        try {
            const [games, maps] = await Promise.all([
                Game.find({}).sort({ id: 1 }).lean(),
                getMaps()
            ]);

            const matches = games
                .sort((a, b) => numberOrZero(a.id) - numberOrZero(b.id))
                .map((game) => normalizeMatch(game, maps));

            return res.json({
                ok: true,
                count: matches.length,
                matches
            });
        } catch (err) {
            return res.status(500).json({
                ok: false,
                error: 'Failed to get matches',
                details: err.message
            });
        }
    });

    app.get('/match/:id/live', async (req, res) => {
        try {
            const game = await Game.findOne({ id: String(req.params.id) }).lean();
            if (!game) {
                return res.status(404).json({
                    ok: false,
                    error: `Match not found: ${req.params.id}`
                });
            }

            return res.json({
                ok: true,
                match: normalizeLiveMatch(game)
            });
        } catch (err) {
            return res.status(500).json({
                ok: false,
                error: 'Failed to get live match',
                details: err.message
            });
        }
    });

    app.get('/match/:id/events', async (req, res) => {
        try {
            const game = await Game.findOne({ id: String(req.params.id) }).lean();
            if (!game) {
                return res.status(404).json({
                    ok: false,
                    error: `Match not found: ${req.params.id}`
                });
            }

            const externalMatchId = getExternalMatchId(game);
            if (!externalMatchId) {
                return res.json({
                    ok: true,
                    match_id: publicId(game.id),
                    external_match_id: null,
                    provider: game.provider || null,
                    events: [],
                    warning: 'Match has no external provider id yet'
                });
            }

            try {
                const url = `https://web-api.varzesh3.com/v2.0/livescore/football/matches/${encodeURIComponent(externalMatchId)}/events`;
                const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
                if (!response.ok) throw new Error(`Provider returned ${response.status}`);

                const rawEvents = await response.json();
                const maps = await getMaps();
                const events = (Array.isArray(rawEvents) ? rawEvents : [])
                    .map((event, index) => normalizeEvent(event, index, game, maps));

                return res.json({
                    ok: true,
                    match_id: publicId(game.id),
                    external_match_id: externalMatchId,
                    provider: game.provider || PROVIDER,
                    events
                });
            } catch (err) {
                return res.json({
                    ok: true,
                    match_id: publicId(game.id),
                    external_match_id: externalMatchId,
                    provider: game.provider || PROVIDER,
                    events: [],
                    warning: 'Could not fetch provider events',
                    error: err.message
                });
            }
        } catch (err) {
            return res.status(500).json({
                ok: false,
                error: 'Failed to get match events',
                details: err.message
            });
        }
    });

    app.get('/standings', async (req, res) => {
        try {
            const [groups, teams] = await Promise.all([
                Group.find({}).sort({ name: 1 }).lean(),
                Team.find({}).lean()
            ]);
            const teamMap = buildMap(teams);
            const standings = [];

            for (const group of groups) {
                (group.teams || []).forEach((row, index) => {
                    const team = teamMap[row.team_id];
                    standings.push({
                        group: group.name,
                        team_id: row.team_id,
                        team: team ? team.name_en : null,
                        team_en: team ? team.name_en : null,
                        team_fa: team ? team.name_fa : null,
                        flag: team ? team.flag : null,
                        logo: null,
                        played: numberOrZero(row.mp),
                        wins: numberOrZero(row.w),
                        draws: numberOrZero(row.d),
                        losses: numberOrZero(row.l),
                        goals_for: numberOrZero(row.gf),
                        goals_against: numberOrZero(row.ga),
                        goal_difference: numberOrZero(row.gd),
                        points: numberOrZero(row.pts),
                        rank: index + 1
                    });
                });
            }

            return res.json({
                ok: true,
                standings
            });
        } catch (err) {
            return res.status(500).json({
                ok: false,
                error: 'Failed to get standings',
                details: err.message
            });
        }
    });

    app.get('/teams', async (req, res) => {
        try {
            const teams = await Team.find({}).sort({ id: 1 }).lean();

            return res.json({
                ok: true,
                teams: teams
                    .sort((a, b) => numberOrZero(a.id) - numberOrZero(b.id))
                    .map((team) => ({
                        id: publicId(team.id),
                        external_team_id: null,
                        provider: null,
                        name_en: team.name_en,
                        name_fa: team.name_fa,
                        short_name: team.fifa_code || team.iso2 || team.name_en,
                        flag: team.flag || null,
                        logo: null,
                        group: team.groups
                    }))
            });
        } catch (err) {
            return res.status(500).json({
                ok: false,
                error: 'Failed to get teams',
                details: err.message
            });
        }
    });
};
