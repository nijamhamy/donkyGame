import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors({ origin: "*" }));
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    transports: ['polling', 'websocket']
});

// ─────────────────────────────────────────────
// DECK
// ─────────────────────────────────────────────
const createShuffledDeck = () => {
    const suits = ["Spades", "Hearts", "Clubs", "Diamonds"];
    const symbols = { "Spades": "♠", "Hearts": "♥", "Clubs": "♣", "Diamonds": "♦" };
    const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
    let deck = [];
    suits.forEach(suit => {
        const cardColor = (suit === "Spades" || suit === "Clubs") ? "black" : "#e0115f";
        ranks.forEach((rank, index) => {
            deck.push({
                id: `${rank}-${suit}-${Math.random().toString(36).substr(2, 5)}`,
                name: suit,
                symbol: symbols[suit],
                label: rank,
                val: index + 2,
                color: cardColor
            });
        });
    });
    return deck.sort(() => Math.random() - 0.5);
};

const sortHandBySuitAndValue = (hand) => {
    const suitOrder = { 'Spades': 0, 'Hearts': 1, 'Diamonds': 2, 'Clubs': 3 };
    return [...hand].sort((a, b) => {
        if (suitOrder[a.name] !== suitOrder[b.name]) return suitOrder[a.name] - suitOrder[b.name];
        return a.val - b.val;
    });
};

let rooms = {};

// ─────────────────────────────────────────────
// HELPERS (module-level, not inside socket handler)
// ─────────────────────────────────────────────
function getNextPlayer(room, currentPlayerId) {
    if (!room || !room.players.length) return null;
    const playerIndex = room.players.findIndex(p => p.id === currentPlayerId);
    if (playerIndex === -1) return null;
    for (let i = 1; i <= room.players.length; i++) {
        const next = room.players[(playerIndex + i) % room.players.length];
        const isWinner = room.winners.some(w => w.id === next.id);
        const hasCards = (next.hand?.length ?? 0) > 0;
        if (next && hasCards && !isWinner) return next.id;
    }
    return null;
}

function rememberMissingSuit(room, playerId, suitSymbol) {
    if (!room.missingCards[playerId]) room.missingCards[playerId] = [];
    if (!room.missingCards[playerId].includes(suitSymbol)) {
        room.missingCards[playerId].push(suitSymbol);
    }
}

function pushRecentLeadSuit(room, suitSymbol) {
    room.recentLeadSuits.push(suitSymbol);
    if (room.recentLeadSuits.length > 8) room.recentLeadSuits.shift();
}

function getHighestLeadCard(cards, leadSuit) {
    return [...cards]
        .filter(c => c.symbol === leadSuit)
        .sort((a, b) => b.val - a.val)[0];
}

function getNextStarterFromTable(room, tableCards, leadSuit) {
    const rankedLeadCards = [...tableCards]
        .filter(c => c.symbol === leadSuit)
        .sort((a, b) => b.val - a.val);
    for (const trickCard of rankedLeadCards) {
        const player = room.players.find(p => p.id === trickCard.playedBy);
        const isWinner = room.winners.some(w => w.id === trickCard.playedBy);
        const hasCards = (player?.hand?.length ?? 0) > 0;
        if (player && hasCards && !isWinner) return trickCard.playedBy;
    }
    return null;
}

function getAlivePlayers(room) {
    return room.players.filter(
        p => !room.winners.some(w => w.id === p.id) && p.hand && p.hand.length > 0
    );
}

// ✅ FIX: module-level, order-preserving "who should act next" resolver.
// Mirrors Game.jsx's getNextActivePlayer guarantee: given ANY candidate
// (which might be null, ranked, or out of cards), always fall back to
// scanning the alive-players list in turn order so we never get stuck.
function resolveValidTurn(room, preferredId, fallbackAnchorId) {
    const alive = getAlivePlayers(room);
    if (alive.length === 0) return null;

    const isValid = (id) => {
        if (!id) return false;
        if (room.winners.some(w => w.id === id)) return false;
        const p = room.players.find(pl => pl.id === id);
        return !!(p && p.hand && p.hand.length > 0);
    };

    if (isValid(preferredId)) return preferredId;

    // Try to walk forward from the anchor (last actor) in table order
    if (fallbackAnchorId) {
        const next = getNextPlayer(room, fallbackAnchorId);
        if (isValid(next)) return next;
    }

    // Last resort: first alive player in seating order
    return alive[0].id;
}

// ✅ FIX: watchdog — after every resolution, verify currentTurn is a real,
// alive, non-ranked player. If not, recompute it and, if it's a bot,
// re-arm the bot scheduler. This is the safety net Game.jsx effectively
// gets for free client-side via getAlivePlayers/getNextActivePlayer chains;
// the server previously had no equivalent guarantee.
function ensureTurnProgress(roomId, anchorId) {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;

    const alive = getAlivePlayers(room);
    if (alive.length === 0) return; // nothing to do, game should be finishing via updateWinners

    const currentIsValid =
        room.currentTurn &&
        !room.winners.some(w => w.id === room.currentTurn) &&
        room.players.find(p => p.id === room.currentTurn && p.hand && p.hand.length > 0);

    // ✅ FIX: even when currentTurn *looks* valid (real bot, has cards, not
    // ranked out), verify a timer is actually armed and not yet overdue.
    // A race between overlapping scheduleBotTurn/ensureTurnProgress calls
    // can invalidate a token before its timer ever fires, leaving a
    // "correct" currentTurn with nothing behind it — the exact bug where a
    // bot's turn just sits forever with an empty table. Anything overdue
    // by more than a small grace window is treated as dead and re-armed.
    if (currentIsValid && room.currentTurn.startsWith('bot-')) {
        const armed = room._armedBotTimer?.[room.currentTurn];
        const tokenMatches = armed && room._botToken?.[room.currentTurn] === armed.token;
        const overdue = !armed || armed.fired || (armed.dueAt + 1000 < Date.now());
        if (!tokenMatches || overdue) {
            scheduleBotTurn(roomId, room.currentTurn, 300);
            return;
        }
    }

    if (currentIsValid) return;

    const fixedTurn = resolveValidTurn(room, room.currentTurn, anchorId);
    if (!fixedTurn) return;

    room.currentTurn = fixedTurn;
    io.to(roomId).emit('gameUpdated', {
        table: room.table,
        currentTurn: fixedTurn,
        players: room.players.map(({ hand, ...rest }) => rest)
    });

    if (fixedTurn.startsWith('bot-')) {
        scheduleBotTurn(roomId, fixedTurn, 800);
    } else {
        // ✅ FIX: also re-arm the human watchdog for the newly assigned turn,
        // and proactively resend their hand in case the client's copy is
        // out of sync (see onYourCards race in the client for context).
        armHumanTurnWatchdog(roomId, fixedTurn);
        resendHandToPlayer(roomId, fixedTurn);
    }
}

// ✅ FIX: periodic liveness sweep, one per room, running for the lifetime
// of an active game. This is what actually guarantees "never stuck
// forever" for the bot-timer-race case above — ensureTurnProgress is only
// ever called reactively from specific code paths, so if some future edge
// case invalidates a bot timer from a path that doesn't call it, the room
// would still hang. This sweep calls the same check unconditionally every
// 2 seconds, so any dead timer gets caught within ~2s no matter how it
// happened. It does not touch cards, scores, or turn order — it only
// re-arms execution when it detects nothing is actually scheduled.
function startRoomWatchdogSweep(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (room._sweepInterval) clearInterval(room._sweepInterval);
    room._sweepInterval = setInterval(() => {
        const r = rooms[roomId];
        if (!r || !r.gameStarted) {
            clearInterval(room._sweepInterval);
            return;
        }
        ensureTurnProgress(roomId, r.currentTurn);
    }, 2000);
}

// ✅ FIX (root cause mitigation, server side): Previously, only bots had any
// mechanism to recover from a stuck turn (scheduleBotTurn + ensureTurnProgress).
// A human whose client never rendered their dealt hand (due to the client-side
// race described in MultiplayerGame.jsx) had NO way to ever act, and the server
// had no timeout — so the entire table would hang forever waiting for a
// playCard event that could never arrive. This resends the current turn
// player's authoritative hand a couple of times as a passive nudge; it does
// NOT change whose turn it is, does NOT change any cards, and does NOT
// auto-play on behalf of a human — it only guarantees the client has every
// opportunity to resync its rendered hand with what the server already holds.
const _humanWatchdogTokens = {};
function armHumanTurnWatchdog(roomId, playerId) {
    if (!playerId || playerId.startsWith('bot-')) return;
    if (!_humanWatchdogTokens[roomId]) _humanWatchdogTokens[roomId] = {};
    const token = Date.now() + Math.random();
    _humanWatchdogTokens[roomId][playerId] = token;

    const nudge = (delay) => {
        setTimeout(() => {
            const room = rooms[roomId];
            if (!room || !room.gameStarted) return;
            if (_humanWatchdogTokens[roomId]?.[playerId] !== token) return; // superseded
            if (room.currentTurn !== playerId) return; // turn already moved on, nothing to do
            resendHandToPlayer(roomId, playerId);
        }, delay);
    };

    // Two gentle nudges. If the player's client was simply mid-race, the
    // first requestMyCards/yourCards round trip (client-side fix) resolves
    // it well before this ever fires. This is a pure safety net.
    nudge(4000);
    nudge(9000);
}

function resendHandToPlayer(roomId, playerId) {
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (player && !player.isBot && player.hand && player.hand.length > 0) {
        io.to(playerId).emit('yourCards', player.hand);
    }
}

function updateWinners(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    let changed = false;
    room.players.forEach(player => {
        const alreadyWinner = room.winners.some(w => w.id === player.id);
        if (player.hand.length === 0 && !alreadyWinner) {
            room.winners.push({ id: player.id, name: player.name, rank: room.winners.length + 1 });
            changed = true;
            console.log(`Winner: ${player.name} rank ${room.winners.length}`);
        }
    });

    io.to(roomId).emit('playersUpdated', room.players.map(({ hand, ...rest }) => rest));
    if (changed) io.to(roomId).emit('winnersUpdated', room.winners);

    if (room.winners.length >= 3) {
        const donkey = room.players.find(p => !room.winners.some(w => w.id === p.id));
        if (donkey) {
            room.winners.push({ id: donkey.id, name: donkey.name, rank: 4 });
        }
        room.gameStarted = false;
        room.currentTurn = null;
        // ✅ FIX: stop the periodic sweep once the game has actually ended —
        // it would otherwise keep polling a finished room every 2s forever.
        if (room._sweepInterval) { clearInterval(room._sweepInterval); room._sweepInterval = null; }
        io.to(roomId).emit('winnersUpdated', room.winners);
        io.to(roomId).emit('gameFinished', {
            winners: room.winners,
            players: room.players.map(({ hand, ...rest }) => rest)
        });
    }
}

// ─────────────────────────────────────────────
// MASTERMIND AI LEAD LOGIC
// Checks ALL alive opponents for void suits — not just next player.
// ─────────────────────────────────────────────
function chooseLeadCard(room, botId) {
    const bot = room.players.find(p => p.id === botId);
    if (!bot || !bot.hand || bot.hand.length === 0) return null;
    const aiHand = bot.hand;

    // Must lead Ace of Spades on very first move
    if (room.discardedPile.length === 0 && room.table.length === 0) {
        const aceSpade = aiHand.find(c => c.symbol === '♠' && c.label === 'A');
        if (aceSpade) return aceSpade;
    }

    const aliveOpponents = room.players.filter(p =>
        p.id !== botId &&
        !room.winners.some(w => w.id === p.id) &&
        p.hand && p.hand.length > 0
    );

    // Count how many alive opponents are void in each suit
    const voidCountBySuit = {};
    aliveOpponents.forEach(opp => {
        const missing = room.missingCards[opp.id] || [];
        missing.forEach(suit => {
            voidCountBySuit[suit] = (voidCountBySuit[suit] || 0) + 1;
        });
    });

    const recentLeads = room.recentLeadSuits.slice(-4);
    let bestCard = null;
    let bestScore = -Infinity;

    aiHand.forEach(card => {
        let score = 0;
        const voidOpponents = voidCountBySuit[card.symbol] || 0;

        // Heavy penalty per void opponent — core safety rule
        score -= voidOpponents * 40;

        // Bonus for suits where NO opponent is void
        if (voidOpponents === 0) score += 25;

        // Prefer lower value cards as lead
        score += (15 - card.val) * 1.5;

        // Penalty for high-value cards (Ace, King) as lead
        if (card.val >= 14) score -= 20;
        if (card.val === 13) score -= 12;

        // Penalty for repeating recently led suits
        const repetition = recentLeads.filter(s => s === card.symbol).length;
        score -= repetition * 10;

        // Bonus for suit density (maintain control)
        const sameSuitCount = aiHand.filter(c => c.symbol === card.symbol).length;
        score += sameSuitCount * 3;

        if (voidOpponents === 0 && sameSuitCount >= 3) score += 12;

        if (score > bestScore) { bestScore = score; bestCard = card; }
    });

    return bestCard || aiHand[0];
}

// ─────────────────────────────────────────────
// MASTERMIND AI FOLLOW LOGIC
// Avoids winning risky tricks; dumps danger cards when void.
// ─────────────────────────────────────────────
function chooseFollowCard(room, botId) {
    const bot = room.players.find(p => p.id === botId);
    if (!bot || !bot.hand || bot.hand.length === 0) return null;
    const aiHand = bot.hand;

    // ✅ FIX: guard against a transiently empty/stale table (race between
    // trick resolution clearing room.table and a queued bot timer firing).
    if (!room.table || room.table.length === 0) {
        return chooseLeadCard(room, botId);
    }

    const leadSuit = room.table[0].symbol;

    const sameSuit = aiHand.filter(c => c.symbol === leadSuit).sort((a, b) => a.val - b.val);

    if (sameSuit.length > 0) {
        const currentHigh = [...room.table]
            .filter(c => c.symbol === leadSuit)
            .sort((a, b) => b.val - a.val)[0];
        const currentHighVal = currentHigh ? currentHigh.val : 0;

        const winningCards = sameSuit.filter(c => c.val > currentHighVal);
        const losingCards = sameSuit.filter(c => c.val <= currentHighVal);

        // Detect future void players who haven't played yet this trick
        const roundPlayedBy = new Set(room.table.map(c => c.playedBy));
        const remainingAlive = room.players.filter(p =>
            !roundPlayedBy.has(p.id) &&
            !room.winners.some(w => w.id === p.id) &&
            p.hand && p.hand.length > 0 &&
            p.id !== botId
        );
        const futureVoidCount = remainingAlive.filter(p => {
            const missing = room.missingCards[p.id] || [];
            return missing.includes(leadSuit);
        }).length;
        const dangerAlreadyOnTable = room.table.filter(c => c.symbol !== leadSuit).length;
        const trickIsRisky = futureVoidCount > 0 || dangerAlreadyOnTable > 0;

        if (trickIsRisky) {
            // Try to lose intentionally — play highest card that still loses
            if (losingCards.length > 0) return losingCards[losingCards.length - 1];
            // Forced to win — play smallest winner to minimize future risk
            if (winningCards.length > 0) return winningCards[0];
            return sameSuit[0];
        }

        // Safe trick — win cheaply
        if (winningCards.length > 0) return winningCards[0];
        return sameSuit[0];
    }

    // Void in lead suit — dump highest value card (discard danger)
    rememberMissingSuit(room, botId, leadSuit);
    return [...aiHand].sort((a, b) => b.val - a.val)[0];
}

// ─────────────────────────────────────────────
// BOT SCHEDULER — token lock prevents stale/duplicate fires
// Token is the ONLY guard. currentTurn is re-validated inside
// handleMove, which is the authoritative gate.
// ✅ FIX: guaranteed fallback so a bot NEVER silently fails to act —
// if hand is transiently empty (race with updateWinners) we do one
// cheap re-check shortly after instead of dying silently; if a card
// still can't be resolved we hand off via ensureTurnProgress instead
// of leaving the room frozen.
// ─────────────────────────────────────────────
function scheduleBotTurn(roomId, botId, delay = 1500) {
    if (!rooms[roomId]) return;
    if (!rooms[roomId]._botToken) rooms[roomId]._botToken = {};
    const token = Date.now() + Math.random();
    rooms[roomId]._botToken[botId] = token;

    // ✅ FIX: record that a timer is now "armed" for this specific
    // (roomId, botId, token) so ensureTurnProgress and a periodic
    // liveness sweep can tell the difference between "currentTurn is a
    // valid bot" and "currentTurn is a valid bot AND a timer is actually
    // going to fire for it". Previously multiple call sites could each
    // invalidate each other's token in a race (ensureTurnProgress after a
    // strike/round resolution overlapping with an earlier re-arm), leaving
    // currentTurn correct but zero live timers behind it — the bot would
    // then never act and the whole table would hang, exactly matching the
    // "Bot 3 not playing while a human waits" symptom.
    if (!rooms[roomId]._armedBotTimer) rooms[roomId]._armedBotTimer = {};
    rooms[roomId]._armedBotTimer[botId] = { token, dueAt: Date.now() + delay, fired: false };

    setTimeout(() => {
        const r = rooms[roomId];
        if (!r || !r.gameStarted) return;
        // Discard if a newer schedule replaced this one
        if (r._botToken[botId] !== token) return;
        if (r._armedBotTimer?.[botId]?.token === token) {
            r._armedBotTimer[botId].fired = true;
        }
        // Re-validate: bot must still be the current turn
        if (r.currentTurn !== botId) return;

        const b = r.players.find(p => p.id === botId);
        if (!b || !b.isBot) return;

        if (!b.hand || b.hand.length === 0) {
            // ✅ FIX: transient race (e.g., winners just updated) — retry once
            // shortly instead of abandoning the bot's turn forever. If the
            // bot is genuinely out of cards, updateWinners/ensureTurnProgress
            // will move the turn on when this fires again and finds nothing.
            if (r.winners.some(w => w.id === botId)) {
                ensureTurnProgress(roomId, botId);
                return;
            }
            setTimeout(() => {
                const r2 = rooms[roomId];
                if (!r2 || !r2.gameStarted) return;
                if (r2._botToken[botId] !== token) return;
                if (r2.currentTurn !== botId) return;
                ensureTurnProgress(roomId, botId);
            }, 400);
            return;
        }
        if (r.winners.some(w => w.id === botId)) {
            ensureTurnProgress(roomId, botId);
            return;
        }

        let cardToPlay;
        try {
            if (r.table.length === 0) {
                cardToPlay = chooseLeadCard(r, botId);
            } else {
                cardToPlay = chooseFollowCard(r, botId);
            }
        } catch (e) {
            console.error('AI choose error:', e);
            cardToPlay = null;
        }

        // ✅ FIX: guaranteed non-empty fallback — always play SOMETHING
        // rather than doing nothing and stalling the whole table.
        if (!cardToPlay && b.hand.length > 0) {
            cardToPlay = b.hand[0];
        }

        if (cardToPlay) {
            handleMove(roomId, botId, cardToPlay);
        } else {
            // Truly nothing to play (empty hand) — let the watchdog resolve turn.
            ensureTurnProgress(roomId, botId);
        }
    }, delay);
}

// ─────────────────────────────────────────────
// CORE MOVE HANDLER
// ─────────────────────────────────────────────
function handleMove(roomId, playerId, card) {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;

    // Authoritative turn gate
    if (room.currentTurn !== playerId) return;

    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    if (room.winners.some(w => w.id === playerId)) return;

    const cardInHand = player.hand.find(c => c.id === card.id);
    if (!cardInHand) {
        // Stale card reference (bot) — play any card
        if (player.isBot && player.hand.length > 0) {
            return handleMove(roomId, playerId, player.hand[0]);
        }
        // ✅ FIX: no valid card to play at all — don't leave turn dangling.
        if (player.isBot) {
            ensureTurnProgress(roomId, playerId);
        }
        return;
    }

    // Remove card from hand
    player.hand = player.hand.filter(c => c.id !== card.id);
    player.handCount = player.hand.length;

    const playedCard = { ...cardInHand, playedBy: playerId };
    const isLeadMove = room.table.length === 0;
    room.table.push(playedCard);

    // Track suits
    if (isLeadMove) {
        pushRecentLeadSuit(room, playedCard.symbol);
    } else {
        const leadSuit = room.table[0].symbol;
        if (playedCard.symbol !== leadSuit) {
            rememberMissingSuit(room, playerId, leadSuit);
        }
    }

    // Send updated hand to human immediately
    if (!player.isBot) {
        io.to(playerId).emit('yourCards', player.hand);
    }

    // ── CUT: off-suit play ends trick immediately ─────────────────
    if (!isLeadMove) {
        const leadSuit = room.table[0].symbol;
        if (playedCard.symbol !== leadSuit) {
            room.currentTurn = null;
            io.to(roomId).emit('gameUpdated', {
                table: room.table,
                currentTurn: null,
                players: room.players.map(({ hand, ...rest }) => rest)
            });

            setTimeout(() => {
                const r = rooms[roomId];
                if (!r || !r.gameStarted) return;

                const trickCards = [...r.table];
                const highestLead = getHighestLeadCard(trickCards, leadSuit);
                const loadedPlayerId = highestLead?.playedBy;
                const loadedPlayer = r.players.find(p => p.id === loadedPlayerId);

                if (loadedPlayer) {
                    loadedPlayer.hand = sortHandBySuitAndValue([...loadedPlayer.hand, ...trickCards]);
                    loadedPlayer.handCount = loadedPlayer.hand.length;
                }

                r.table = [];
                r.loadedPlayerId = loadedPlayerId;
                r.lastRoundType = 'cut';

                updateWinners(roomId);
                if (!r.gameStarted) return; // game ended

                // Winner who collected must lead next
                // ✅ FIX: use resolveValidTurn so a null/ranked candidate
                // always falls back to a real alive player instead of
                // leaving currentTurn stuck.
                let nextTurn = resolveValidTurn(r, loadedPlayerId, playerId);
                r.currentTurn = nextTurn;

                io.to(roomId).emit('strikeOccurred', {
                    loser: loadedPlayerId,
                    table: trickCards,
                    nextTurn,
                    updatedHand: loadedPlayer?.hand || [],
                    players: r.players.map(({ hand, ...rest }) => rest)
                });

                if (loadedPlayer && !loadedPlayer.isBot) {
                    io.to(loadedPlayerId).emit('yourCards', loadedPlayer.hand);
                }

                if (nextTurn && nextTurn.startsWith('bot-')) {
                    scheduleBotTurn(roomId, nextTurn, 1500);
                } else if (nextTurn) {
                    // ✅ FIX: arm the same stuck-human safety net used elsewhere
                    // whenever a human is handed the next turn after a cut.
                    armHumanTurnWatchdog(roomId, nextTurn);
                }

                // ✅ FIX: watchdog pass in case nextTurn still somehow invalid
                ensureTurnProgress(roomId, loadedPlayerId || playerId);
            }, 1200);
            return;
        }
    }

    // ── Check if trick is complete (all alive players have played) ─
    const alivePlayers = getAlivePlayers(room);
    const roundPlayers = new Set(room.table.map(c => c.playedBy));
    const aliveNotPlayed = alivePlayers.filter(p => !roundPlayers.has(p.id));

    if (aliveNotPlayed.length === 0) {
        // All alive have played — resolve trick
        room.currentTurn = null;
        io.to(roomId).emit('gameUpdated', {
            table: room.table,
            currentTurn: null,
            players: room.players.map(({ hand, ...rest }) => rest)
        });

        setTimeout(() => {
            const r = rooms[roomId];
            if (!r || !r.gameStarted) return;

            const leadSuit = r.table[0]?.symbol;
            if (!leadSuit) {
                // ✅ FIX: nothing to resolve (table already cleared by a
                // concurrent path) — don't just return and leave turn null.
                ensureTurnProgress(roomId, playerId);
                return;
            }

            const trickSnapshot = [...r.table];
            const highestLead = getHighestLeadCard(trickSnapshot, leadSuit);
            const roundWinnerId = highestLead?.playedBy;

            r.discardedPile.push(...r.table);
            r.table = [];
            r.loadedPlayerId = null;
            r.lastRoundType = 'normal';

            updateWinners(roomId);
            if (!r.gameStarted) return; // game ended

            // ✅ FIX: use resolveValidTurn for guaranteed fallback instead of
            // relying solely on getNextStarterFromTable / getNextPlayer,
            // either of which can return null and stall the room.
            let nextStarter = getNextStarterFromTable(r, trickSnapshot, leadSuit);
            nextStarter = resolveValidTurn(r, nextStarter, roundWinnerId || playerId);

            r.currentTurn = nextStarter;

            io.to(roomId).emit('roundComplete', {
                winner: roundWinnerId,
                table: trickSnapshot,
                nextTurn: nextStarter,
                players: r.players.map(({ hand, ...rest }) => rest),
                discardedCount: r.discardedPile.length
            });

            if (nextStarter && nextStarter.startsWith('bot-')) {
                scheduleBotTurn(roomId, nextStarter, 1500);
            } else if (nextStarter) {
                // ✅ FIX: arm the same stuck-human safety net used elsewhere
                // whenever a human is handed the next lead after a normal trick.
                armHumanTurnWatchdog(roomId, nextStarter);
            }

            // ✅ FIX: watchdog pass in case nextStarter still somehow invalid
            ensureTurnProgress(roomId, roundWinnerId || playerId);
        }, 1200);
        return;
    }

    // ── Pass turn to next player in ongoing trick ─────────────────
    let nextTurnId = getNextPlayer(room, playerId);
    // ✅ FIX: guaranteed fallback instead of just calling updateWinners and
    // leaving currentTurn stale/null when getNextPlayer can't find anyone
    // (can happen transiently if ranks changed mid-trick).
    nextTurnId = resolveValidTurn(room, nextTurnId, playerId);

    if (!nextTurnId) {
        updateWinners(roomId);
        return;
    }
    room.currentTurn = nextTurnId;

    io.to(roomId).emit('gameUpdated', {
        table: room.table,
        currentTurn: nextTurnId,
        players: room.players.map(({ hand, ...rest }) => rest)
    });

    if (nextTurnId.startsWith('bot-')) {
        scheduleBotTurn(roomId, nextTurnId, 1500);
    } else {
        // ✅ FIX: arm the same stuck-human safety net used elsewhere whenever
        // a human is handed the next turn mid-trick.
        armHumanTurnWatchdog(roomId, nextTurnId);
    }
}

// ─────────────────────────────────────────────
// SOCKET EVENTS
// ─────────────────────────────────────────────
io.on("connection", (socket) => {
    console.log("Player Connected:", socket.id);

    socket.on("createRoom", ({ playerName }, callback) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        rooms[roomId] = {
            players: [{
                id: socket.id, name: playerName, host: true,
                isBot: false, hand: [], handCount: 0, isConnected: true
            }],
            gameStarted: false,
            table: [], winners: [], discardedPile: [],
            missingCards: {}, recentLeadSuits: [],
            loadedPlayerId: null, lastRoundType: null,
            currentTurn: null, _botToken: {}
        };
        socket.join(roomId);
        callback(roomId);
    });

    socket.on("joinRoom", ({ roomId, playerName }, callback) => {
        const room = rooms[roomId];
        if (!room) return callback({ success: false, message: "Room not found!" });
        if (room.gameStarted) return callback({ success: false, message: "Game already started!" });

        const existingBySocket = room.players.find(p => p.id === socket.id);
        if (existingBySocket) {
            existingBySocket.isConnected = true;
            socket.join(roomId);
            io.to(roomId).emit("playersUpdated", room.players.map(({ hand, ...rest }) => rest));
            return callback({ success: true, rejoined: true });
        }

        const existingByName = room.players.find(
            p => !p.isBot && p.name.trim().toLowerCase() === playerName.trim().toLowerCase()
        );
        if (existingByName) {
            existingByName.id = socket.id;
            existingByName.isConnected = true;
            socket.join(roomId);
            io.to(roomId).emit("playersUpdated", room.players.map(({ hand, ...rest }) => rest));
            if (existingByName.hand?.length > 0) io.to(socket.id).emit("yourCards", existingByName.hand);
            return callback({ success: true, rejoined: true });
        }

        const realPlayers = room.players.filter(p => !p.isBot);
        if (realPlayers.length >= 4) return callback({ success: false, message: "Room full!" });

        room.players.push({
            id: socket.id, name: playerName.trim(), host: false,
            isBot: false, hand: [], handCount: 0, isConnected: true
        });
        socket.join(roomId);
        io.to(roomId).emit("playersUpdated", room.players.map(({ hand, ...rest }) => rest));
        callback({ success: true });
    });

    socket.on("requestRoomState", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        io.to(roomId).emit("roomState", {
            roomId, players: room.players.map(({ hand, ...rest }) => rest)
        });
    });

    socket.on("returnToLobby", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        room.gameStarted = false;
        room.table = []; room.winners = []; room.discardedPile = [];
        room.missingCards = {}; room.recentLeadSuits = [];
        room.loadedPlayerId = null; room.lastRoundType = null;
        room.currentTurn = null; room._botToken = {};
        if (room._sweepInterval) { clearInterval(room._sweepInterval); room._sweepInterval = null; }
        room.players = room.players
            .filter(p => !p.isBot)
            .map((p, i) => ({ ...p, host: i === 0 ? true : p.host, hand: [], handCount: 0 }));
        io.to(roomId).emit("playersUpdated", room.players.map(({ hand, ...rest }) => rest));
        io.to(roomId).emit("roomState", { roomId, players: room.players.map(({ hand, ...rest }) => rest) });
    });

    socket.on("removePlayer", ({ roomId, targetPlayerId }, callback) => {
        const room = rooms[roomId];
        if (!room) return callback?.({ success: false, message: "Room not found" });
        const requester = room.players.find(p => p.id === socket.id);
        if (!requester?.host) return callback?.({ success: false, message: "Only host can remove players" });
        if (targetPlayerId === socket.id) return callback?.({ success: false, message: "Host cannot remove self" });
        room.players = room.players.filter(p => p.id !== targetPlayerId);
        io.to(targetPlayerId).emit("removedFromRoom", { message: "You were removed from the room" });
        io.to(roomId).emit("playersUpdated", room.players.map(({ hand, ...rest }) => rest));
        io.to(roomId).emit("roomState", { roomId, players: room.players.map(({ hand, ...rest }) => rest) });
        callback?.({ success: true });
    });

    socket.on("startGame", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const requester = room.players.find(p => p.id === socket.id);
        if (!requester?.host) return;

        room.gameStarted = true;
        room.table = []; room.winners = []; room.discardedPile = [];
        room.missingCards = {}; room.recentLeadSuits = [];
        room.loadedPlayerId = null; room.lastRoundType = null;
        room.currentTurn = null; room._botToken = {};
        _humanWatchdogTokens[roomId] = {};

        while (room.players.length < 4) {
            const botId = `bot-${Math.random().toString(36).substr(2, 5)}`;
            room.players.push({
                id: botId, name: `Bot ${room.players.length}`,
                isBot: true, hand: [], handCount: 13, isConnected: true
            });
        }

        const deck = createShuffledDeck();
        let starterId = null;
        room.players.forEach((player, i) => {
            player.hand = sortHandBySuitAndValue(deck.slice(i * 13, (i + 1) * 13));
            player.handCount = 13;
            if (player.hand.some(c => c.symbol === '♠' && c.label === 'A')) starterId = player.id;
            if (!player.isBot) io.to(player.id).emit("yourCards", player.hand);
        });

        room.currentTurn = starterId || room.players[0].id;

        io.to(roomId).emit("gameStarted", {
            currentTurn: room.currentTurn,
            players: room.players.map(({ hand, ...rest }) => rest)
        });

        if (room.currentTurn && room.currentTurn.startsWith('bot-')) {
            scheduleBotTurn(roomId, room.currentTurn, 1500);
        } else if (room.currentTurn) {
            // ✅ FIX: arm the stuck-human safety net for the very first turn
            // of the match too — this is exactly the scenario in the bug
            // report ("it becomes a player's turn" right after dealing).
            armHumanTurnWatchdog(roomId, room.currentTurn);
        }

        // ✅ FIX: safety net right after deal in case starter resolution
        // ever ends up pointing at an invalid player (e.g., future rule change).
        setTimeout(() => ensureTurnProgress(roomId, room.currentTurn), 2500);

        // ✅ FIX: start the periodic sweep for the whole game, so any bot
        // timer that dies from a race (see startRoomWatchdogSweep) is
        // always caught within ~2s, not just at specific reactive checkpoints.
        startRoomWatchdogSweep(roomId);
    });

    socket.on("requestMyCards", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player?.hand?.length > 0) socket.emit("yourCards", player.hand);
    });

    socket.on("playCard", ({ roomId, card }) => {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;
        if (room.currentTurn !== socket.id) return;
        handleMove(roomId, socket.id, card);
    });

    // ✅ FIX: lightweight client-triggerable nudge. If a client ever
    // observes a stalled turn (e.g. after reconnect), it can ask the
    // server to re-validate and resume without needing a restart.
    socket.on("requestTurnCheck", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;
        ensureTurnProgress(roomId, socket.id);
    });

    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const player = room.players.find(p => p.id === socket.id);
            if (!player) continue;
            player.isConnected = false;
            io.to(roomId).emit("playersUpdated", room.players.map(({ hand, ...rest }) => rest));
            const humansOnline = room.players.some(p => !p.isBot && p.isConnected);
            if (!humansOnline) {
                console.log(`Deleting empty room ${roomId}`);
                delete rooms[roomId];
            }
            break;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});