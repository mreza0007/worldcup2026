const Game = require('../models/game');
const Team = require('../models/team');
const Group = require('../models/group');
const Stadium = require('../models/stadium');

const PROVIDER = 'varzesh3';
const EVENT_TYPES = {
    1: 'goal',
    2: 'yellow_card',
    3: 'penalty_event',
    4: 'substitution',
    5: 'var_disallowed_goal',
    6: 'var',
    7: 'own_goal',
    8: 'red_card',
    9: 'penalty_missed',
    10: 'injury',
    11: 'half_time',
    12: 'full_time'
};

const SCORING_EVENT_TYPES = new Set(['goal', 'own_goal', 'penalty_goal']);

function hasExplicitScoredPenalty(event) {
    const booleanSignals = [event.isGoal, event.isScored, event.scored, event.goal, event.isSuccessful];
    if (booleanSignals.some((value) => value === true || value === 1 || value === '1')) return true;

    const result = String(event.result || event.outcome || event.decision || event.penaltyResult || '').trim().toLowerCase();
    return ['goal', 'scored', 'score', 'successful', 'converted'].includes(result);
}

function isScoringEvent(eventOrType) {
    const normalizedType = typeof eventOrType === 'string' ? eventOrType : detectEventType(eventOrType);
    return SCORING_EVENT_TYPES.has(normalizedType);
}

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
        homeTeam: game.homeTeam || (home ? home._id : null),
        visitingTeam: game.visitingTeam || (away ? away._id : null),
        awayTeam: game.awayTeam || game.visitingTeam || (away ? away._id : null),
        home_team_id: game.home_team_id || null,
        away_team_id: game.away_team_id || null,
        home_team_label: game.home_team_label || null,
        away_team_label: game.away_team_label || null,
        r32_home_en: game.r32_home_en || null,
        r32_home_fa: game.r32_home_fa || null,
        r32_away_en: game.r32_away_en || null,
        r32_away_fa: game.r32_away_fa || null,
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
        last_updated: game.provider_payload_updated_at ? game.provider_payload_updated_at.toISOString() : null,
        __source: game
    };
}

function repairMojibake(value) {
    const text = String(value || '');
    if (!/[ØÙÛ]/.test(text)) return text;

    try {
        const windows1252 = new Map([
            ['€', 0x80], ['‚', 0x82], ['ƒ', 0x83], ['„', 0x84], ['…', 0x85],
            ['†', 0x86], ['‡', 0x87], ['ˆ', 0x88], ['‰', 0x89], ['Š', 0x8A],
            ['‹', 0x8B], ['Œ', 0x8C], ['Ž', 0x8E], ['‘', 0x91], ['’', 0x92],
            ['“', 0x93], ['”', 0x94], ['•', 0x95], ['–', 0x96], ['—', 0x97],
            ['˜', 0x98], ['™', 0x99], ['š', 0x9A], ['›', 0x9B], ['œ', 0x9C],
            ['ž', 0x9E], ['Ÿ', 0x9F],
        ]);
        const bytes = [];
        for (const character of text) {
            const code = character.charCodeAt(0);
            if (code <= 0xFF) bytes.push(code);
            else if (windows1252.has(character)) bytes.push(windows1252.get(character));
            else return text;
        }
        const repaired = Buffer.from(bytes).toString('utf8');
        return repaired.includes('\uFFFD') ? text : repaired;
    } catch {
        return text;
    }
}

function normalizeDigits(value) {
    return repairMojibake(value)
        .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06F0))
        .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

function extractPlaceholderRef(value) {
    const text = normalizeDigits(value).trim();
    if (!text) return null;

    const english = text.match(/\b(winner|loser)\s+match\s+(\d+)\b/i);
    if (english) {
        return { kind: english[1].toLowerCase(), matchId: Number(english[2]) };
    }

    const persianWinner = text.match(/برنده\s*بازی\s*(\d+)/);
    if (persianWinner) return { kind: 'winner', matchId: Number(persianWinner[1]) };

    const persianLoser = text.match(/بازنده\s*بازی\s*(\d+)/);
    if (persianLoser) return { kind: 'loser', matchId: Number(persianLoser[1]) };

    return null;
}

function isFinished(match) {
    const source = match?.__source || {};
    return match?.status === 'finished' ||
        source.finished === true ||
        String(source.finished || '').toUpperCase() === 'TRUE' ||
        String(source.time_elapsed || '').toLowerCase() === 'finished';
}

function optionalNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function firstNumber(...values) {
    for (const value of values) {
        const number = optionalNumber(value);
        if (number !== null) return number;
    }
    return null;
}

function getPenaltyScores(match) {
    const source = match?.__source || {};
    const home = firstNumber(
        source.home_penalty_score,
        source.home_penalties,
        source.penalties?.home,
        source.penalty_score?.home,
        source.score?.penalties?.home,
        match?.home_penalty_score,
        match?.home_penalties,
        match?.penalties?.home,
        match?.penalty_score?.home,
        match?.score?.penalties?.home
    );
    const away = firstNumber(
        source.away_penalty_score,
        source.away_penalties,
        source.penalties?.away,
        source.penalty_score?.away,
        source.score?.penalties?.away,
        match?.away_penalty_score,
        match?.away_penalties,
        match?.penalties?.away,
        match?.penalty_score?.away,
        match?.score?.penalties?.away
    );

    return { home, away };
}

function participantFromMatch(match, side) {
    if (!match) return null;

    if (side === 'home') {
        return {
            name_en: match.home_en,
            name_fa: match.home_fa,
            flag: match.home_flag,
            logo: match.home_logo,
            teamRef: match.homeTeam,
            teamId: match.home_team_id,
        };
    }

    return {
        name_en: match.away_en,
        name_fa: match.away_fa,
        flag: match.away_flag,
        logo: match.away_logo,
        teamRef: match.visitingTeam || match.awayTeam,
        teamId: match.away_team_id,
    };
}

function placeholderForSide(match, side) {
    const source = match?.__source || {};
    const values = side === 'home'
        ? [
            match.home_en,
            match.home_fa,
            match.home_team_label,
            match.r32_home_en,
            match.r32_home_fa,
            source.home_team_label,
            source.r32_home_en,
            source.r32_home_fa,
        ]
        : [
            match.away_en,
            match.away_fa,
            match.away_team_label,
            match.r32_away_en,
            match.r32_away_fa,
            source.away_team_label,
            source.r32_away_en,
            source.r32_away_fa,
        ];

    for (const value of values) {
        const reference = extractPlaceholderRef(value);
        if (reference) return reference;
    }

    return null;
}

function resolveMatchSide(match, side, matchById, visited) {
    const reference = placeholderForSide(match, side);
    if (!reference) return participantFromMatch(match, side);
    return resolveParticipant(reference, matchById, visited);
}

function getDecidingSide(match) {
    if (!isFinished(match)) return null;

    const homeScore = optionalNumber(match.home_score);
    const awayScore = optionalNumber(match.away_score);
    if (homeScore === null || awayScore === null) return null;
    if (homeScore > awayScore) return 'home';
    if (awayScore > homeScore) return 'away';

    const penalties = getPenaltyScores(match);
    if (penalties.home === null || penalties.away === null) return null;
    if (penalties.home > penalties.away) return 'home';
    if (penalties.away > penalties.home) return 'away';
    return null;
}

function getWinnerParticipant(match, matchById, visited) {
    const side = getDecidingSide(match);
    return side ? resolveMatchSide(match, side, matchById, visited) : null;
}

function getLoserParticipant(match, matchById, visited) {
    const side = getDecidingSide(match);
    if (!side) return null;
    return resolveMatchSide(match, side === 'home' ? 'away' : 'home', matchById, visited);
}

function resolveParticipant(reference, matchById, visited = new Set()) {
    const referenceKey = String(reference?.matchId ?? '');
    if (!reference || visited.has(referenceKey)) return null;

    const sourceMatch = matchById.get(referenceKey);
    if (!sourceMatch || !isFinished(sourceMatch)) return null;

    const nextVisited = new Set(visited);
    nextVisited.add(referenceKey);
    return reference.kind === 'loser'
        ? getLoserParticipant(sourceMatch, matchById, nextVisited)
        : getWinnerParticipant(sourceMatch, matchById, nextVisited);
}

function applyResolvedParticipant(destinationMatch, side, participant) {
    if (!participant?.name_en) return;

    if (side === 'home') {
        destinationMatch.home_en = participant.name_en;
        destinationMatch.home_fa = participant.name_fa || null;
        destinationMatch.home_flag = participant.flag || null;
        destinationMatch.home_logo = participant.logo || null;
        destinationMatch.homeTeam = participant.teamRef || null;
        destinationMatch.home_team_id = participant.teamId || null;
        destinationMatch.home_team_label = participant.name_en;
        if (destinationMatch.r32_home_en) destinationMatch.r32_home_en = participant.name_en;
        if (destinationMatch.r32_home_fa) destinationMatch.r32_home_fa = participant.name_fa || null;
        return;
    }

    destinationMatch.away_en = participant.name_en;
    destinationMatch.away_fa = participant.name_fa || null;
    destinationMatch.away_flag = participant.flag || null;
    destinationMatch.away_logo = participant.logo || null;
    destinationMatch.visitingTeam = participant.teamRef || null;
    destinationMatch.awayTeam = participant.teamRef || null;
    destinationMatch.away_team_id = participant.teamId || null;
    destinationMatch.away_team_label = participant.name_en;
    if (destinationMatch.r32_away_en) destinationMatch.r32_away_en = participant.name_en;
    if (destinationMatch.r32_away_fa) destinationMatch.r32_away_fa = participant.name_fa || null;
}

function resolveKnockoutParticipants(matches) {
    const matchById = new Map(matches.map((match) => [String(match.id), match]));

    for (const match of matches) {
        for (const side of ['home', 'away']) {
            const reference = placeholderForSide(match, side);
            if (!reference) continue;
            const participant = resolveParticipant(reference, matchById, new Set([String(match.id)]));
            if (participant) applyResolvedParticipant(match, side, participant);
        }
    }

    for (const match of matches) delete match.__source;
    return matches;
}

function normalizeAndResolveMatches(games, maps) {
    const matches = games
        .sort((a, b) => numberOrZero(a.id) - numberOrZero(b.id))
        .map((game) => normalizeMatch(game, maps));
    return resolveKnockoutParticipants(matches);
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

    const rawType = event.eventType ?? event.type;
    const explicit = EVENT_TYPES[rawType] || EVENT_TYPES[Number(rawType)];

    if (
        (text.includes('گل') && (text.includes('رد شده') || text.includes('مردود') || text.includes('کمک داور ویدیویی'))) ||
        (text.includes('goal') && (text.includes('disallow') || text.includes('var')))
    ) {
        return 'var_disallowed_goal';
    }

    if (
        text.includes('گل به خودی') ||
        text.includes('own goal') ||
        explicit === 'own_goal'
    ) {
        return 'own_goal';
    }

    if (
        (text.includes('پنالتی') && (text.includes('از دست') || text.includes('مهار') || text.includes('خراب') || text.includes('گل نشد'))) ||
        (text.includes('penalty') && (text.includes('miss') || text.includes('saved')))
    ) {
        return 'penalty_missed';
    }

    if (Number(rawType) === 3) {
        return hasExplicitScoredPenalty(event) ? 'penalty_goal' : 'penalty_event';
    }

    if (explicit) return explicit;

    if (text.includes('\u062a\u0639\u0648\u06cc\u0636')) return 'substitution';
    if (text.includes('\u06a9\u0627\u0631\u062a \u0632\u0631\u062f')) return 'yellow_card';
    if (text.includes('\u06a9\u0627\u0631\u062a \u0642\u0631\u0645\u0632')) return 'red_card';
    if (text.includes('\u067e\u0646\u0627\u0644\u062a\u06cc')) return 'penalty_event';
    if (text.includes('\u06af\u0644')) return 'goal';

    if (text.includes('own')) return 'own_goal';
    if (text.includes('penalty') && text.includes('miss')) return 'penalty_missed';
    if (text.includes('penalty')) return 'penalty_event';
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
        event.passName ||
        event.passPlayerName ||
        event.pass_name ||
        event.assist?.name ||
        event.pass?.name ||
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
        raw_type: event.eventType ?? event.type ?? null,
        normalized_type: normalizedType,
        is_scoring_event: isScoringEvent(normalizedType),
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

            const matches = normalizeAndResolveMatches(games, maps);

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
            const [games, maps] = await Promise.all([
                Game.find({}).sort({ id: 1 }).lean(),
                getMaps()
            ]);
            const game = games.find((item) => String(item.id) === String(req.params.id));
            if (!game) {
                return res.status(404).json({
                    ok: false,
                    error: `Match not found: ${req.params.id}`
                });
            }

            const resolvedMatch = normalizeAndResolveMatches(games, maps)
                .find((item) => String(item.id) === String(req.params.id));

            return res.json({
                ok: true,
                match: {
                    ...resolvedMatch,
                    ...normalizeLiveMatch(game)
                }
            });
        } catch (err) {
            return res.status(500).json({
                ok: false,
                error: 'Failed to get live match',
                details: err.message
            });
        }
    });

    // Event smoke tests:
    // curl http://127.0.0.1:3050/match/1/events
    // curl http://127.0.0.1:3050/match/19/events
    // curl http://127.0.0.1:3050/match/37/events
    // curl http://127.0.0.1:3050/match/39/events
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
