import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors({ origin: "*" }));
app.get('/', (req, res) => res.send('Donkey server OK'));
app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ['polling', 'websocket'],
    pingInterval: 10000,
    pingTimeout: 25000,
    connectTimeout: 45000,
    perMessageDeflate: false
});

const EMPTY_ROOM_GRACE_MS = 90000;
const AUTOPLAY_AFTER_MS = 6000;
const BOT_DELAY = 1500;
const RESOLVE_DELAY = 1200;

// ───────────── DECK ─────────────
const createShuffledDeck = () => {
    const suits = ["Spades", "Hearts", "Clubs", "Diamonds"];
    const symbols = { Spades: "♠", Hearts: "♥", Clubs: "♣", Diamonds: "♦" };
    const ranks = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
    const deck = [];
    suits.forEach(suit => {
        const color = (suit === "Spades" || suit === "Clubs") ? "black" : "#e0115f";
        ranks.forEach((rank, index) => {
            deck.push({
                id: `${rank}-${suit}-${Math.random().toString(36).substr(2, 5)}`,
                name: suit, symbol: symbols[suit], label: rank, val: index + 2, color
            });
        });
    });
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
};

const sortHandBySuitAndValue = (hand) => {
    const order = { Spades: 0, Hearts: 1, Diamonds: 2, Clubs: 3 };
    return [...hand].sort((a, b) =>
        order[a.name] !== order[b.name] ? order[a.name] - order[b.name] : a.val - b.val);
};

const rooms = {};
const _humanWatchdogTokens = {};

const publicPlayers = (room) => room.players.map(({ hand, clientId, ...rest }) => rest);

// ───────────── HELPERS ─────────────
const isWinnerId = (room, id) => room.winners.some(w => w.id === id);
const hasCards = (p) => !!(p && p.hand && p.hand.length > 0);

function getAlivePlayers(room) {
    return room.players.filter(p => !isWinnerId(room, p.id) && hasCards(p));
}

function getNextPlayer(room, currentPlayerId) {
    if (!room || !room.players.length) return null;
    const idx = room.players.findIndex(p => p.id === currentPlayerId);
    if (idx === -1) return null;
    for (let i = 1; i <= room.players.length; i++) {
        const next = room.players[(idx + i) % room.players.length];
        if (next && hasCards(next) && !isWinnerId(room, next.id)) return next.id;
    }
    return null;
}

function rememberMissingSuit(room, playerId, suit) {
    if (!room.missingCards[playerId]) room.missingCards[playerId] = [];
    if (!room.missingCards[playerId].includes(suit)) room.missingCards[playerId].push(suit);
}

function pushRecentLeadSuit(room, suit) {
    room.recentLeadSuits.push(suit);
    if (room.recentLeadSuits.length > 8) room.recentLeadSuits.shift();
}

function getHighestLeadCard(cards, leadSuit) {
    return [...cards].filter(c => c.symbol === leadSuit).sort((a, b) => b.val - a.val)[0];
}

function getNextStarterFromTable(room, tableCards, leadSuit) {
    const ranked = [...tableCards].filter(c => c.symbol === leadSuit).sort((a, b) => b.val - a.val);
    for (const c of ranked) {
        const p = room.players.find(x => x.id === c.playedBy);
        if (p && hasCards(p) && !isWinnerId(room, p.id)) return c.playedBy;
    }
    return null;
}

function isValidTurnId(room, id) {
    if (!id || isWinnerId(room, id)) return false;
    return hasCards(room.players.find(p => p.id === id));
}

function resolveValidTurn(room, preferredId, anchorId) {
    const alive = getAlivePlayers(room);
    if (alive.length === 0) return null;
    if (isValidTurnId(room, preferredId)) return preferredId;
    if (anchorId) {
        const next = getNextPlayer(room, anchorId);
        if (isValidTurnId(room, next)) return next;
    }
    return alive[0].id;
}

function emitGameUpdate(roomId, room) {
    io.to(roomId).emit('gameUpdated', {
        table: room.table,
        currentTurn: room.currentTurn,
        players: publicPlayers(room),
        discardedCount: room.discardedPile.length
    });
}

function clearRoomTimers(room) {
    if (!room) return;
    if (room._sweepInterval) { clearInterval(room._sweepInterval); room._sweepInterval = null; }
    if (room._botTimer) { clearTimeout(room._botTimer); room._botTimer = null; }
    if (room._resolveTimer) { clearTimeout(room._resolveTimer); room._resolveTimer = null; }
    room.resolving = false;
}

function resendHandToPlayer(roomId, playerId) {
    const room = rooms[roomId];
    if (!room) return;
    const p = room.players.find(x => x.id === playerId);
    if (p && !p.isBot && hasCards(p)) io.to(playerId).emit('yourCards', p.hand);
}

function armHumanTurnWatchdog(roomId, playerId) {
    if (!playerId || playerId.startsWith('bot-')) return;
    if (!_humanWatchdogTokens[roomId]) _humanWatchdogTokens[roomId] = {};
    const token = Date.now() + Math.random();
    _humanWatchdogTokens[roomId][playerId] = token;
    [4000, 9000].forEach(delay => setTimeout(() => {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;
        if (_humanWatchdogTokens[roomId]?.[playerId] !== token) return;
        if (room.currentTurn !== playerId) return;
        resendHandToPlayer(roomId, playerId);
    }, delay));
}

function giveTurnTo(roomId, turnId) {
    const room = rooms[roomId];
    if (!room) return;
    room.currentTurn = turnId;
    if (!turnId) return;
    if (turnId.startsWith('bot-')) scheduleBotTurn(roomId, turnId, BOT_DELAY);
    else armHumanTurnWatchdog(roomId, turnId);
}

// Runs a delayed trick resolution while locking the watchdog out.
function resolveLater(roomId, fn) {
    const room = rooms[roomId];
    if (!room) return;
    room.resolving = true;
    if (room._resolveTimer) clearTimeout(room._resolveTimer);
    room._resolveTimer = setTimeout(() => {
        const r = rooms[roomId];
        if (!r) return;
        r._resolveTimer = null;
        try {
            if (r.gameStarted) fn(r);
        } catch (e) {
            console.error('resolve error:', e);
        } finally {
            r.resolving = false;
        }
        if (r.gameStarted) ensureTurnProgress(roomId, r.currentTurn);
    }, RESOLVE_DELAY);
}

// ───────────── WATCHDOG ─────────────
function ensureTurnProgress(roomId, anchorId) {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;
    if (room.resolving) return;
    if (getAlivePlayers(room).length === 0) return;

    if (isValidTurnId(room, room.currentTurn)) {
        if (room.currentTurn.startsWith('bot-') && !room._botTimer) {
            scheduleBotTurn(roomId, room.currentTurn, 300);
        }
        return;
    }

    const fixed = resolveValidTurn(room, room.currentTurn, anchorId);
    if (!fixed) return;
    giveTurnTo(roomId, fixed);
    emitGameUpdate(roomId, room);
    if (!fixed.startsWith('bot-')) resendHandToPlayer(roomId, fixed);
}

function autoPlayIfDisconnected(roomId) {
    const room = rooms[roomId];
    if (!room || !room.gameStarted || room.resolving || !room.currentTurn) return;
    const p = room.players.find(x => x.id === room.currentTurn);
    if (!p || p.isBot || p.isConnected !== false) return;
    if (Date.now() - (p.disconnectedAt || 0) < AUTOPLAY_AFTER_MS) return;
    if (!hasCards(p)) return;

    let card = null;
    try {
        card = room.table.length === 0 ? chooseLeadCard(room, p.id) : chooseFollowCard(room, p.id);
    } catch (e) { console.error('Auto-play choose error:', e); }
    if (!card) card = p.hand[0];
    if (card) handleMove(roomId, p.id, card);
}

function startRoomWatchdogSweep(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    if (room._sweepInterval) clearInterval(room._sweepInterval);
    room._sweepInterval = setInterval(() => {
        const r = rooms[roomId];
        if (!r || !r.gameStarted) { clearInterval(room._sweepInterval); return; }
        autoPlayIfDisconnected(roomId);
        ensureTurnProgress(roomId, r.currentTurn);
    }, 2000);
}

// ───────────── WINNERS ─────────────
function updateWinners(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    let changed = false;
    room.players.forEach(player => {
        if (player.hand.length === 0 && !isWinnerId(room, player.id)) {
            room.winners.push({ id: player.id, name: player.name, rank: room.winners.length + 1 });
            changed = true;
        }
    });

    io.to(roomId).emit('playersUpdated', publicPlayers(room));
    if (changed) io.to(roomId).emit('winnersUpdated', room.winners);

    if (room.winners.length >= 3) {
        const donkey = room.players.find(p => !isWinnerId(room, p.id));
        if (donkey) room.winners.push({ id: donkey.id, name: donkey.name, rank: 4 });
        room.gameStarted = false;
        room.currentTurn = null;
        clearRoomTimers(room);
        io.to(roomId).emit('winnersUpdated', room.winners);
        io.to(roomId).emit('gameFinished', { winners: room.winners, players: publicPlayers(room) });
    }
}

// ───────────── AI ─────────────
function chooseLeadCard(room, botId) {
    const bot = room.players.find(p => p.id === botId);
    if (!hasCards(bot)) return null;
    const aiHand = bot.hand;

    if (room.discardedPile.length === 0 && room.table.length === 0) {
        const aceSpade = aiHand.find(c => c.symbol === '♠' && c.label === 'A');
        if (aceSpade) return aceSpade;
    }

    const aliveOpponents = room.players.filter(p =>
        p.id !== botId && !isWinnerId(room, p.id) && hasCards(p));

    const voidCountBySuit = {};
    aliveOpponents.forEach(opp => {
        (room.missingCards[opp.id] || []).forEach(suit => {
            voidCountBySuit[suit] = (voidCountBySuit[suit] || 0) + 1;
        });
    });

    const recentLeads = room.recentLeadSuits.slice(-4);
    let bestCard = null, bestScore = -Infinity;

    aiHand.forEach(card => {
        let score = 0;
        const voidOpponents = voidCountBySuit[card.symbol] || 0;
        score -= voidOpponents * 40;
        if (voidOpponents === 0) score += 25;
        score += (15 - card.val) * 1.5;
        if (card.val >= 14) score -= 20;
        if (card.val === 13) score -= 12;
        score -= recentLeads.filter(s => s === card.symbol).length * 10;
        const sameSuitCount = aiHand.filter(c => c.symbol === card.symbol).length;
        score += sameSuitCount * 3;
        if (voidOpponents === 0 && sameSuitCount >= 3) score += 12;
        if (score > bestScore) { bestScore = score; bestCard = card; }
    });
    return bestCard || aiHand[0];
}

function chooseFollowCard(room, botId) {
    const bot = room.players.find(p => p.id === botId);
    if (!hasCards(bot)) return null;
    const aiHand = bot.hand;

    if (!room.table || room.table.length === 0) return chooseLeadCard(room, botId);

    const leadSuit = room.table[0].symbol;
    const sameSuit = aiHand.filter(c => c.symbol === leadSuit).sort((a, b) => a.val - b.val);

    if (sameSuit.length > 0) {
        const currentHigh = getHighestLeadCard(room.table, leadSuit);
        const currentHighVal = currentHigh ? currentHigh.val : 0;
        const winningCards = sameSuit.filter(c => c.val > currentHighVal);
        const losingCards = sameSuit.filter(c => c.val <= currentHighVal);

        const playedBy = new Set(room.table.map(c => c.playedBy));
        const remainingAlive = room.players.filter(p =>
            !playedBy.has(p.id) && !isWinnerId(room, p.id) && hasCards(p) && p.id !== botId);
        const futureVoidCount = remainingAlive.filter(p =>
            (room.missingCards[p.id] || []).includes(leadSuit)).length;
        const dangerOnTable = room.table.filter(c => c.symbol !== leadSuit).length;
        const risky = futureVoidCount > 0 || dangerOnTable > 0;

        if (risky) {
            if (losingCards.length > 0) return losingCards[losingCards.length - 1];
            if (winningCards.length > 0) return winningCards[0];
            return sameSuit[0];
        }
        if (winningCards.length > 0) return winningCards[0];
        return sameSuit[0];
    }

    rememberMissingSuit(room, botId, leadSuit);
    return [...aiHand].sort((a, b) => b.val - a.val)[0];
}

// ───────────── BOT SCHEDULER (one timer per room) ─────────────
function scheduleBotTurn(roomId, botId, delay = BOT_DELAY) {
    const room = rooms[roomId];
    if (!room) return;
    if (room._botTimer) clearTimeout(room._botTimer);

    room._botTimer = setTimeout(() => {
        const r = rooms[roomId];
        if (!r) return;
        r._botTimer = null;
        if (!r.gameStarted || r.resolving) return;
        if (r.currentTurn !== botId) return;

        const b = r.players.find(p => p.id === botId);
        if (!b || !b.isBot) return;
        if (!hasCards(b) || isWinnerId(r, botId)) { ensureTurnProgress(roomId, botId); return; }

        let card = null;
        try {
            card = r.table.length === 0 ? chooseLeadCard(r, botId) : chooseFollowCard(r, botId);
        } catch (e) { console.error('AI choose error:', e); }
        if (!card) card = b.hand[0];
        if (card) handleMove(roomId, botId, card);
        else ensureTurnProgress(roomId, botId);
    }, delay);
}

// ───────────── CORE MOVE ─────────────
function handleMove(roomId, playerId, card) {
    const room = rooms[roomId];
    if (!room || !room.gameStarted || room.resolving) return;
    if (room.currentTurn !== playerId) return;

    const player = room.players.find(p => p.id === playerId);
    if (!player || isWinnerId(room, playerId)) return;

    const cardInHand = player.hand.find(c => c.id === card.id);
    if (!cardInHand) {
        if (player.isBot && player.hand.length > 0) return handleMove(roomId, playerId, player.hand[0]);
        if (player.isBot) ensureTurnProgress(roomId, playerId);
        return;
    }

    player.hand = player.hand.filter(c => c.id !== card.id);
    player.handCount = player.hand.length;

    const playedCard = { ...cardInHand, playedBy: playerId };
    const isLeadMove = room.table.length === 0;
    room.table.push(playedCard);

    if (isLeadMove) {
        pushRecentLeadSuit(room, playedCard.symbol);
    } else {
        const leadSuit = room.table[0].symbol;
        if (playedCard.symbol !== leadSuit) rememberMissingSuit(room, playerId, leadSuit);
    }

    if (!player.isBot) io.to(playerId).emit('yourCards', player.hand);

    // CUT: off-suit play ends the trick
    if (!isLeadMove) {
        const leadSuit = room.table[0].symbol;
        if (playedCard.symbol !== leadSuit) {
            room.currentTurn = null;
            emitGameUpdate(roomId, room);

            resolveLater(roomId, (r) => {
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
                if (!r.gameStarted) return;

                const nextTurn = resolveValidTurn(r, loadedPlayerId, playerId);
                r.currentTurn = nextTurn;

                io.to(roomId).emit('strikeOccurred', {
                    winner: loadedPlayerId,
                    loser: playerId,
                    table: trickCards,
                    nextTurn,
                    updatedHand: loadedPlayer?.hand || [],
                    players: publicPlayers(r)
                });

                if (loadedPlayer && !loadedPlayer.isBot) io.to(loadedPlayerId).emit('yourCards', loadedPlayer.hand);
                giveTurnTo(roomId, nextTurn);
            });
            return;
        }
    }

    // Trick complete?
    const roundPlayers = new Set(room.table.map(c => c.playedBy));
    const aliveNotPlayed = getAlivePlayers(room).filter(p => !roundPlayers.has(p.id));

    if (aliveNotPlayed.length === 0) {
        room.currentTurn = null;
        emitGameUpdate(roomId, room);

        resolveLater(roomId, (r) => {
            const leadSuit = r.table[0]?.symbol;
            if (!leadSuit) return;

            const trickSnapshot = [...r.table];
            const highestLead = getHighestLeadCard(trickSnapshot, leadSuit);
            const roundWinnerId = highestLead?.playedBy;

            r.discardedPile.push(...r.table);
            r.table = [];
            r.loadedPlayerId = null;
            r.lastRoundType = 'normal';

            updateWinners(roomId);
            if (!r.gameStarted) return;

            let nextStarter = getNextStarterFromTable(r, trickSnapshot, leadSuit);
            nextStarter = resolveValidTurn(r, nextStarter, roundWinnerId || playerId);
            r.currentTurn = nextStarter;

            io.to(roomId).emit('roundComplete', {
                winner: roundWinnerId,
                table: trickSnapshot,
                nextTurn: nextStarter,
                players: publicPlayers(r),
                discardedCount: r.discardedPile.length
            });

            giveTurnTo(roomId, nextStarter);
        });
        return;
    }

    // Pass turn within trick
    const nextTurnId = resolveValidTurn(room, getNextPlayer(room, playerId), playerId);
    if (!nextTurnId) { updateWinners(roomId); return; }

    giveTurnTo(roomId, nextTurnId);
    emitGameUpdate(roomId, room);
}

// ───────────── REJOIN / SYNC ─────────────
function rebindPlayer(roomId, room, player, newId) {
    const old = player.id;
    if (old === newId) return;
    player.id = newId;
    room.table.forEach(c => { if (c.playedBy === old) c.playedBy = newId; });
    room.discardedPile.forEach(c => { if (c.playedBy === old) c.playedBy = newId; });
    room.winners.forEach(w => { if (w.id === old) w.id = newId; });
    if (room.currentTurn === old) room.currentTurn = newId;
    if (room.loadedPlayerId === old) room.loadedPlayerId = newId;
    if (room.missingCards[old]) {
        room.missingCards[newId] = room.missingCards[old];
        delete room.missingCards[old];
    }
    if (_humanWatchdogTokens[roomId]) delete _humanWatchdogTokens[roomId][old];
}

function sendFullState(socket, roomId, room) {
    const me = room.players.find(p => p.id === socket.id);
    socket.emit('syncState', {
        roomId,
        gameStarted: room.gameStarted,
        table: room.table,
        currentTurn: room.currentTurn,
        players: publicPlayers(room),
        winners: room.winners,
        discardedCount: room.discardedPile.length
    });
    if (me && hasCards(me)) socket.emit('yourCards', me.hand);
}

function tryRejoin(socket, roomId, playerName, clientId) {
    const room = rooms[roomId];
    if (!room) return null;
    let player = null;
    if (clientId) player = room.players.find(p => !p.isBot && p.clientId === clientId);
    if (!player && playerName) {
        const n = playerName.trim().toLowerCase();
        player = room.players.find(p =>
            !p.isBot && p.name.trim().toLowerCase() === n &&
            (p.isConnected === false || !room.gameStarted));
    }
    if (!player) return null;

    rebindPlayer(roomId, room, player, socket.id);
    if (clientId) player.clientId = clientId;
    player.isConnected = true;
    player.disconnectedAt = null;
    if (room._deleteTimer) { clearTimeout(room._deleteTimer); room._deleteTimer = null; }
    socket.join(roomId);
    io.to(roomId).emit('playersUpdated', publicPlayers(room));
    sendFullState(socket, roomId, room);
    if (room.gameStarted && room.currentTurn === socket.id) armHumanTurnWatchdog(roomId, socket.id);
    return room;
}

function resetRoomState(room) {
    clearRoomTimers(room);
    room.table = []; room.winners = []; room.discardedPile = [];
    room.missingCards = {}; room.recentLeadSuits = [];
    room.loadedPlayerId = null; room.lastRoundType = null;
    room.currentTurn = null;
}

// ───────────── SOCKET EVENTS ─────────────
io.on("connection", (socket) => {
    const handshakeClientId = socket.handshake.auth?.clientId || null;

    socket.on("createRoom", ({ playerName, clientId }, callback) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        rooms[roomId] = {
            players: [{
                id: socket.id, clientId: clientId || handshakeClientId, name: playerName,
                host: true, isBot: false, hand: [], handCount: 0, isConnected: true
            }],
            gameStarted: false, resolving: false,
            table: [], winners: [], discardedPile: [],
            missingCards: {}, recentLeadSuits: [],
            loadedPlayerId: null, lastRoundType: null, currentTurn: null
        };
        socket.join(roomId);
        callback?.(roomId);
    });

    socket.on("joinRoom", ({ roomId, playerName, clientId }, callback) => {
        const cid = clientId || handshakeClientId;
        const room = rooms[roomId];
        if (!room) return callback?.({ success: false, message: "Room not found!" });

        if (room.players.some(p => p.id === socket.id)) {
            socket.join(roomId);
            io.to(roomId).emit("playersUpdated", publicPlayers(room));
            return callback?.({ success: true, rejoined: true });
        }

        if (tryRejoin(socket, roomId, playerName, cid)) {
            return callback?.({ success: true, rejoined: true });
        }

        if (room.gameStarted) return callback?.({ success: false, message: "Game already started!" });
        if (room.players.filter(p => !p.isBot).length >= 4) {
            return callback?.({ success: false, message: "Room full!" });
        }

        room.players.push({
            id: socket.id, clientId: cid, name: playerName.trim(), host: false,
            isBot: false, hand: [], handCount: 0, isConnected: true
        });
        socket.join(roomId);
        io.to(roomId).emit("playersUpdated", publicPlayers(room));
        callback?.({ success: true });
    });

    socket.on("rejoinRoom", ({ roomId, playerName, clientId }, callback) => {
        const room = tryRejoin(socket, roomId, playerName, clientId || handshakeClientId);
        if (!room) return callback?.({ success: false, message: "Room not found" });
        callback?.({ success: true, gameStarted: room.gameStarted });
    });

    socket.on("requestSync", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || !room.players.some(p => p.id === socket.id)) return;
        sendFullState(socket, roomId, room);
        if (room.gameStarted) ensureTurnProgress(roomId, room.currentTurn);
    });

    socket.on("requestRoomState", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        io.to(roomId).emit("roomState", { roomId, players: publicPlayers(room) });
    });

    socket.on("returnToLobby", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        room.gameStarted = false;
        resetRoomState(room);
        room.players = room.players
            .filter(p => !p.isBot)
            .map((p, i) => ({ ...p, host: i === 0 ? true : p.host, hand: [], handCount: 0 }));
        io.to(roomId).emit("playersUpdated", publicPlayers(room));
        io.to(roomId).emit("roomState", { roomId, players: publicPlayers(room) });
    });

    socket.on("removePlayer", ({ roomId, targetPlayerId }, callback) => {
        const room = rooms[roomId];
        if (!room) return callback?.({ success: false, message: "Room not found" });
        const requester = room.players.find(p => p.id === socket.id);
        if (!requester?.host) return callback?.({ success: false, message: "Only host can remove players" });
        if (targetPlayerId === socket.id) return callback?.({ success: false, message: "Host cannot remove self" });
        room.players = room.players.filter(p => p.id !== targetPlayerId);
        io.to(targetPlayerId).emit("removedFromRoom", { message: "You were removed from the room" });
        io.to(roomId).emit("playersUpdated", publicPlayers(room));
        io.to(roomId).emit("roomState", { roomId, players: publicPlayers(room) });
        callback?.({ success: true });
    });

    socket.on("startGame", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const requester = room.players.find(p => p.id === socket.id);
        if (!requester?.host) return;

        resetRoomState(room);
        room.gameStarted = true;
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
            players: publicPlayers(room)
        });

        giveTurnTo(roomId, room.currentTurn);
        startRoomWatchdogSweep(roomId);
    });

    socket.on("requestMyCards", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (hasCards(player)) socket.emit("yourCards", player.hand);
    });

    socket.on("playCard", ({ roomId, card }, callback) => {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return callback?.({ success: false, message: 'Game not active' });
        if (room.resolving || room.currentTurn !== socket.id) {
            return callback?.({ success: false, message: 'Not your turn' });
        }

        const player = room.players.find(p => p.id === socket.id);
        const cardInHand = player?.hand?.find(c => c.id === card?.id);
        if (!cardInHand) return callback?.({ success: false, message: 'Card not in hand' });

        if (room.table.length > 0) {
            const leadSuit = room.table[0].symbol;
            if (player.hand.some(c => c.symbol === leadSuit) && cardInHand.symbol !== leadSuit) {
                return callback?.({ success: false, message: 'You must follow suit' });
            }
        }

        handleMove(roomId, socket.id, cardInHand);
        callback?.({ success: true });
    });

    socket.on("requestTurnCheck", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;
        ensureTurnProgress(roomId, socket.id);
    });

    socket.on("disconnect", () => {
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const player = room.players.find(p => p.id === socket.id);
            if (!player) continue;
            player.isConnected = false;
            player.disconnectedAt = Date.now();
            io.to(roomId).emit("playersUpdated", publicPlayers(room));

            const humansOnline = room.players.some(p => !p.isBot && p.isConnected);
            if (!humansOnline && !room._deleteTimer) {
                room._deleteTimer = setTimeout(() => {
                    const r = rooms[roomId];
                    if (!r) return;
                    if (r.players.some(p => !p.isBot && p.isConnected)) return;
                    clearRoomTimers(r);
                    delete _humanWatchdogTokens[roomId];
                    delete rooms[roomId];
                }, EMPTY_ROOM_GRACE_MS);
            }
            break;
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));