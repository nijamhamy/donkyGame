import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors({ origin: "*" }));
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    transports: ['polling', 'websocket'],
    pingTimeout: 20000,
    pingInterval: 10000,
});

// ─────────────────────────────────────────────
// DECK
// ─────────────────────────────────────────────
const createShuffledDeck = () => {
    const suits = ["Spades", "Hearts", "Clubs", "Diamonds"];
    const symbols = { Spades: "♠", Hearts: "♥", Clubs: "♣", Diamonds: "♦" };
    const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
    let deck = [];
    suits.forEach(suit => {
        const color = suit === "Spades" || suit === "Clubs" ? "black" : "#e0115f";
        ranks.forEach((rank, index) => {
            deck.push({
                id: `${rank}-${suit}-${Math.random().toString(36).substr(2, 5)}`,
                name: suit, symbol: symbols[suit], label: rank,
                val: index + 2, color
            });
        });
    });
    return deck.sort(() => Math.random() - 0.5);
};

const sortHand = (hand) => {
    const suitOrder = { Spades: 0, Hearts: 1, Clubs: 2, Diamonds: 3 };
    return [...hand].sort((a, b) => {
        if (suitOrder[a.name] !== suitOrder[b.name]) return suitOrder[a.name] - suitOrder[b.name];
        return a.val - b.val;
    });
};

let rooms = {};

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function getAlivePlayers(room) {
    return room.players.filter(
        p => !room.winners.some(w => w.id === p.id) && p.hand && p.hand.length > 0
    );
}

function getHighestLeadPlayer(tableCards, leadSuit) {
    const highest = [...tableCards]
        .filter(c => c.symbol === leadSuit)
        .sort((a, b) => b.val - a.val)[0];
    return highest ? highest.playedBy : null;
}

function getNextStarterFromTrick(room, tableCards, leadSuit) {
    const ranked = [...tableCards]
        .filter(c => c.symbol === leadSuit)
        .sort((a, b) => b.val - a.val);
    for (const trickCard of ranked) {
        const player = room.players.find(p => p.id === trickCard.playedBy);
        const isWinner = room.winners.some(w => w.id === trickCard.playedBy);
        const hasCards = (player?.hand?.length ?? 0) > 0;
        if (player && hasCards && !isWinner) return trickCard.playedBy;
    }
    return null;
}

function getNextActivePlayer(room, currentPlayerId) {
    const alive = getAlivePlayers(room);
    if (alive.length === 0) return null;
    const currentIdx = room.players.findIndex(p => p.id === currentPlayerId);
    for (let i = 1; i <= room.players.length; i++) {
        const candidate = room.players[(currentIdx + i) % room.players.length];
        if (alive.some(p => p.id === candidate.id)) return candidate.id;
    }
    return alive[0].id;
}

function rememberMissingSuit(room, playerId, suitSymbol) {
    if (!room.missingCards[playerId]) room.missingCards[playerId] = new Set();
    room.missingCards[playerId].add(suitSymbol);
}

function pushRecentLeadSuit(room, suitSymbol) {
    room.recentLeadSuits.push(suitSymbol);
    if (room.recentLeadSuits.length > 6) room.recentLeadSuits.shift();
}

function updateWinners(roomId) {
    const room = rooms[roomId];
    if (!room) return false;
    let changed = false;
    room.players.forEach(player => {
        const alreadyWinner = room.winners.some(w => w.id === player.id);
        if (!alreadyWinner && player.hand.length === 0) {
            const rank = room.winners.length + 1;
            const labels = { 1: '1st Winner', 2: '2nd Winner', 3: '3rd Winner', 4: 'Oops! Donkey' };
            room.winners.push({ id: player.id, name: player.name, rank, label: labels[rank] || '' });
            changed = true;
        }
    });
    // Auto-assign 4th (donkey) when 3 are done
    if (room.winners.length === 3) {
        const remaining = room.players.find(p => !room.winners.some(w => w.id === p.id));
        if (remaining) {
            room.winners.push({ id: remaining.id, name: remaining.name, rank: 4, label: 'Oops! Donkey' });
            changed = true;
        }
    }
    if (changed) io.to(roomId).emit('winnersUpdated', room.winners);
    io.to(roomId).emit('playersUpdated', room.players.map(({ hand, ...r }) => r));
    return changed;
}

function endGame(roomId) {
    const room = rooms[roomId];
    if (!room || room.gameEnded) return;
    room.gameEnded = true;
    room.gameStarted = false;
    room.currentTurn = null;
    if (room.winners.length < 4) {
        const remaining = room.players.find(p => !room.winners.some(w => w.id === p.id));
        if (remaining) room.winners.push({ id: remaining.id, name: remaining.name, rank: 4, label: 'Oops! Donkey' });
    }
    io.to(roomId).emit('winnersUpdated', room.winners);
    io.to(roomId).emit('gameFinished', {
        winners: room.winners,
        players: room.players.map(({ hand, ...r }) => r)
    });
}

// ─────────────────────────────────────────────
// MASTERMIND AI
// ─────────────────────────────────────────────
function chooseLeadCardAI(room, botId) {
    const bot = room.players.find(p => p.id === botId);
    const aiHand = bot.hand;

    // Very first move of the entire game — must play Ace of Spades
    if (!room.firstRoundPlayed) {
        const ace = aiHand.find(c => c.symbol === '♠' && c.label === 'A');
        if (ace) return ace;
    }

    const aliveOpponents = room.players.filter(p =>
        p.id !== botId &&
        !room.winners.some(w => w.id === p.id) &&
        p.hand && p.hand.length > 0
    );

    const voidCountBySuit = {};
    aliveOpponents.forEach(opp => {
        const missing = room.missingCards[opp.id] || new Set();
        missing.forEach(suit => {
            voidCountBySuit[suit] = (voidCountBySuit[suit] || 0) + 1;
        });
    });

    let bestCard = null;
    let bestScore = -Infinity;
    aiHand.forEach(card => {
        let score = 0;
        const voidOpponents = voidCountBySuit[card.symbol] || 0;
        score -= voidOpponents * 40;
        if (voidOpponents === 0) score += 25;
        score += (15 - card.val) * 1.5;
        if (card.val >= 14) score -= 20;
        if (card.val === 13) score -= 12;
        const recentSpam = room.recentLeadSuits.filter(s => s === card.symbol).length;
        score -= recentSpam * 10;
        const sameSuitCount = aiHand.filter(c => c.symbol === card.symbol).length;
        score += sameSuitCount * 3;
        if (voidOpponents === 0 && sameSuitCount >= 3) score += 12;
        if (score > bestScore) { bestScore = score; bestCard = card; }
    });

    return bestCard || aiHand[0];
}

function chooseFollowCardAI(room, botId) {
    const bot = room.players.find(p => p.id === botId);
    const aiHand = bot.hand;
    const leadSuit = room.table[0].symbol;

    const sameSuitCards = aiHand.filter(c => c.symbol === leadSuit).sort((a, b) => a.val - b.val);

    if (sameSuitCards.length > 0) {
        const currentHigh = [...room.table]
            .filter(c => c.symbol === leadSuit)
            .sort((a, b) => b.val - a.val)[0];
        const currentHighVal = currentHigh ? currentHigh.val : 0;

        const winningCards = sameSuitCards.filter(c => c.val > currentHighVal);
        const losingCards = sameSuitCards.filter(c => c.val <= currentHighVal);

        const roundPlayedBy = new Set(room.table.map(c => c.playedBy));
        const remainingAlive = room.players.filter(p =>
            !roundPlayedBy.has(p.id) &&
            !room.winners.some(w => w.id === p.id) &&
            p.hand && p.hand.length > 0 &&
            p.id !== botId
        );
        const futureVoidCount = remainingAlive.filter(p => {
            const missing = room.missingCards[p.id] || new Set();
            return missing.has(leadSuit);
        }).length;
        const dangerAlreadyOnTable = room.table.filter(c => c.symbol !== leadSuit).length;
        const trickIsRisky = futureVoidCount > 0 || dangerAlreadyOnTable > 0;

        if (trickIsRisky) {
            if (losingCards.length > 0) return losingCards[losingCards.length - 1];
            if (winningCards.length > 0) return winningCards[0];
            return sameSuitCards[0];
        }

        if (winningCards.length > 0) return winningCards[0];
        return sameSuitCards[0];
    }

    rememberMissingSuit(room, botId, leadSuit);
    return [...aiHand].sort((a, b) => b.val - a.val)[0];
}

// ─────────────────────────────────────────────
// BOT SCHEDULER — token lock prevents duplicate/stale fires
// ─────────────────────────────────────────────
function scheduleBotTurn(roomId, botId, delay = 1000) {
    if (!rooms[roomId]) return;

    // Each new schedule stamps a unique token — only the latest fires
    if (!rooms[roomId]._botToken) rooms[roomId]._botToken = {};
    const token = Date.now() + Math.random();
    rooms[roomId]._botToken[botId] = token;

    setTimeout(() => {
        const r = rooms[roomId];
        if (!r || !r.gameStarted || r.gameEnded) return;
        if (r.currentTurn !== botId) return;
        // Stale call guard — discard if a newer schedule replaced this one
        if (r._botToken[botId] !== token) return;

        const b = r.players.find(p => p.id === botId);
        if (!b || !b.isBot || !b.hand || b.hand.length === 0) return;
        if (r.winners.some(w => w.id === botId)) return;

        let cardToPlay;
        try {
            if (r.table.length === 0) {
                cardToPlay = chooseLeadCardAI(r, botId);
            } else {
                cardToPlay = chooseFollowCardAI(r, botId);
            }
        } catch (e) {
            console.error('AI choose error:', e);
            cardToPlay = b.hand[0];
        }

        if (cardToPlay) {
            handleMove(roomId, botId, cardToPlay);
        } else {
            if (b.hand.length > 0) handleMove(roomId, botId, b.hand[0]);
        }
    }, delay);
}

// ─────────────────────────────────────────────
// CORE MOVE HANDLER
// ─────────────────────────────────────────────
function handleMove(roomId, playerId, card) {
    const room = rooms[roomId];
    if (!room || !room.gameStarted || room.gameEnded) return;
    if (room.currentTurn !== playerId) return;

    const player = room.players.find(p => p.id === playerId);
    if (!player || !player.hand) return;
    if (room.winners.some(w => w.id === playerId)) return;

    const cardInHand = player.hand.find(c => c.id === card.id);
    if (!cardInHand) {
        if (player.isBot && player.hand.length > 0) {
            return handleMove(roomId, playerId, player.hand[0]);
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

    // Send updated hand to human player right away
    if (!player.isBot) {
        io.to(playerId).emit('yourCards', player.hand);
    }

    // ── CUT: off-suit play ends trick immediately ─────────────────
    if (!isLeadMove) {
        const leadSuit = room.table[0].symbol;
        if (playedCard.symbol !== leadSuit) {
            // Lock turn during resolution animation
            room.currentTurn = null;
            io.to(roomId).emit('gameUpdated', {
                table: room.table,
                currentTurn: null,
                players: room.players.map(({ hand, ...rest }) => rest)
            });

            setTimeout(() => {
                const r = rooms[roomId];
                if (!r || r.gameEnded) return;

                const trickCards = [...r.table];
                const winnerId = getHighestLeadPlayer(trickCards, leadSuit);
                const winnerPlayer = r.players.find(p => p.id === winnerId);

                if (winnerPlayer) {
                    winnerPlayer.hand = sortHand([...winnerPlayer.hand, ...trickCards]);
                    winnerPlayer.handCount = winnerPlayer.hand.length;
                }

                r.table = [];
                r.firstRoundPlayed = true;

                updateWinners(roomId);

                if (r.winners.length >= 4 || !r.gameStarted) { endGame(roomId); return; }
                if (r.winners.length >= 3) { endGame(roomId); return; }

                const aliveNow = getAlivePlayers(r);
                if (aliveNow.length <= 1) { updateWinners(roomId); endGame(roomId); return; }

                let nextTurn = winnerId;
                if (r.winners.some(w => w.id === winnerId)) {
                    nextTurn = getNextActivePlayer(r, winnerId);
                }

                r.currentTurn = nextTurn;

                io.to(roomId).emit('strikeOccurred', {
                    loser: playerId,
                    winner: winnerId,
                    table: trickCards,
                    nextTurn,
                    updatedHand: winnerPlayer?.hand || [],
                    players: r.players.map(({ hand, ...rest }) => rest)
                });

                if (winnerPlayer && !winnerPlayer.isBot) {
                    io.to(winnerId).emit('yourCards', winnerPlayer.hand);
                }

                if (nextTurn && nextTurn.startsWith('bot-')) {
                    scheduleBotTurn(roomId, nextTurn, 1500);
                }
            }, 800);
            return;
        }
    }

    // ── Check if trick is complete (all alive played) ─────────────
    const aliveNow = getAlivePlayers(room);
    const roundPlayers = new Set(room.table.map(c => c.playedBy));
    const aliveNotPlayed = aliveNow.filter(p => !roundPlayers.has(p.id));

    if (aliveNotPlayed.length === 0) {
        // Lock turn during resolution animation
        room.currentTurn = null;
        io.to(roomId).emit('gameUpdated', {
            table: room.table,
            currentTurn: null,
            players: room.players.map(({ hand, ...rest }) => rest)
        });

        setTimeout(() => {
            const r = rooms[roomId];
            if (!r || r.gameEnded) return;

            const leadSuit = r.table[0]?.symbol;
            if (!leadSuit) return;

            const trickSnapshot = [...r.table];
            const winnerId = getHighestLeadPlayer(trickSnapshot, leadSuit);

            r.discardedPile.push(...r.table);
            r.table = [];
            r.firstRoundPlayed = true;

            updateWinners(roomId);

            if (r.winners.length >= 3) { endGame(roomId); return; }

            const aliveAfter = getAlivePlayers(r);
            if (aliveAfter.length <= 1) { updateWinners(roomId); endGame(roomId); return; }

            let nextStarter = getNextStarterFromTrick(r, trickSnapshot, leadSuit);
            if (!nextStarter || r.winners.some(w => w.id === nextStarter)) {
                nextStarter = getNextActivePlayer(r, winnerId || r.players[0].id);
            }

            r.currentTurn = nextStarter;

            io.to(roomId).emit('roundComplete', {
                winner: winnerId,
                table: trickSnapshot,
                nextTurn: nextStarter,
                players: r.players.map(({ hand, ...rest }) => rest),
                discardedCount: r.discardedPile.length
            });

            if (nextStarter && nextStarter.startsWith('bot-')) {
                scheduleBotTurn(roomId, nextStarter, 1500);
            }
        }, 800);
        return;
    }

    // ── Pass to next player in ongoing trick ──────────────────────
    // FIX: compute nextTurn FIRST, set room.currentTurn, THEN broadcast.
    // Never broadcast currentTurn: null during an ongoing trick —
    // that was causing the bot turn to appear frozen after leading the Ace.
    const nextTurn = getNextActivePlayer(room, playerId);
    room.currentTurn = nextTurn;

    io.to(roomId).emit('gameUpdated', {
        table: room.table,
        currentTurn: nextTurn,
        players: room.players.map(({ hand, ...rest }) => rest)
    });

    if (nextTurn && nextTurn.startsWith('bot-')) {
        scheduleBotTurn(roomId, nextTurn, 1500);
    }
}

// ─────────────────────────────────────────────
// SOCKET EVENTS
// ─────────────────────────────────────────────
io.on("connection", (socket) => {
    console.log("Connected:", socket.id);

    socket.on("createRoom", ({ playerName }, callback) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
        rooms[roomId] = {
            players: [{
                id: socket.id, name: playerName.trim(),
                host: true, isBot: false, hand: [], handCount: 0, isConnected: true
            }],
            gameStarted: false, gameEnded: false,
            table: [], winners: [], discardedPile: [],
            missingCards: {}, recentLeadSuits: [],
            currentTurn: null, firstRoundPlayed: false,
            _botToken: {},
        };
        socket.join(roomId);
        callback(roomId);
    });

    socket.on("joinRoom", ({ roomId, playerName }, callback) => {
        const room = rooms[roomId];
        if (!room) return callback({ success: false, message: "Room not found!" });
        if (room.gameStarted) return callback({ success: false, message: "Game already started!" });

        const bySocket = room.players.find(p => p.id === socket.id);
        if (bySocket) {
            bySocket.isConnected = true;
            socket.join(roomId);
            io.to(roomId).emit("playersUpdated", room.players.map(({ hand, ...r }) => r));
            return callback({ success: true, rejoined: true });
        }

        const byName = room.players.find(
            p => !p.isBot && p.name.trim().toLowerCase() === playerName.trim().toLowerCase()
        );
        if (byName) {
            byName.id = socket.id;
            byName.isConnected = true;
            socket.join(roomId);
            io.to(roomId).emit("playersUpdated", room.players.map(({ hand, ...r }) => r));
            if (byName.hand?.length > 0) io.to(socket.id).emit("yourCards", byName.hand);
            return callback({ success: true, rejoined: true });
        }

        const realPlayers = room.players.filter(p => !p.isBot);
        if (realPlayers.length >= 4) return callback({ success: false, message: "Room full!" });

        room.players.push({
            id: socket.id, name: playerName.trim(),
            host: false, isBot: false, hand: [], handCount: 0, isConnected: true
        });
        socket.join(roomId);
        io.to(roomId).emit("playersUpdated", room.players.map(({ hand, ...r }) => r));
        callback({ success: true });
    });

    socket.on("requestRoomState", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        io.to(roomId).emit("roomState", {
            roomId, players: room.players.map(({ hand, ...r }) => r)
        });
    });

    socket.on("returnToLobby", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        room.gameStarted = false;
        room.gameEnded = false;
        room.table = []; room.winners = []; room.discardedPile = [];
        room.missingCards = {}; room.recentLeadSuits = [];
        room.currentTurn = null; room.firstRoundPlayed = false;
        room._botToken = {};
        room.players = room.players
            .filter(p => !p.isBot)
            .map((p, i) => ({ ...p, host: i === 0, hand: [], handCount: 0 }));
        io.to(roomId).emit("playersUpdated", room.players.map(({ hand, ...r }) => r));
        io.to(roomId).emit("roomState", { roomId, players: room.players.map(({ hand, ...r }) => r) });
    });

    socket.on("removePlayer", ({ roomId, targetPlayerId }, callback) => {
        const room = rooms[roomId];
        if (!room) return callback?.({ success: false, message: "Room not found" });
        const requester = room.players.find(p => p.id === socket.id);
        if (!requester?.host) return callback?.({ success: false, message: "Only host can remove players" });
        if (targetPlayerId === socket.id) return callback?.({ success: false, message: "Host cannot remove self" });
        room.players = room.players.filter(p => p.id !== targetPlayerId);
        io.to(targetPlayerId).emit("removedFromRoom", { message: "You were removed from the room" });
        io.to(roomId).emit("playersUpdated", room.players.map(({ hand, ...r }) => r));
        io.to(roomId).emit("roomState", { roomId, players: room.players.map(({ hand, ...r }) => r) });
        callback?.({ success: true });
    });

    socket.on("startGame", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const requester = room.players.find(p => p.id === socket.id);
        if (!requester?.host) return;

        room.gameStarted = true;
        room.gameEnded = false;
        room.table = []; room.winners = []; room.discardedPile = [];
        room.missingCards = {}; room.recentLeadSuits = [];
        room.currentTurn = null; room.firstRoundPlayed = false;
        room._botToken = {};

        const botNames = ["Mastermind", "CleverBot", "SharpAI", "TacticBot"];
        while (room.players.length < 4) {
            const botId = `bot-${Math.random().toString(36).substr(2, 5)}`;
            room.players.push({
                id: botId,
                name: botNames[room.players.length - 1] || `Bot ${room.players.length}`,
                isBot: true, hand: [], handCount: 13, isConnected: true
            });
        }

        const deck = createShuffledDeck();
        let starterId = null;
        room.players.forEach((player, i) => {
            player.hand = sortHand(deck.slice(i * 13, (i + 1) * 13));
            player.handCount = 13;
            if (player.hand.some(c => c.symbol === '♠' && c.label === 'A')) starterId = player.id;
            if (!player.isBot) io.to(player.id).emit("yourCards", player.hand);
        });

        room.currentTurn = starterId || room.players[0].id;

        io.to(roomId).emit("gameStarted", {
            currentTurn: room.currentTurn,
            players: room.players.map(({ hand, ...r }) => r)
        });

        if (room.currentTurn && room.currentTurn.startsWith('bot-')) {
            scheduleBotTurn(roomId, room.currentTurn, 1500);
        }
    });

    socket.on("requestMyCards", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player?.hand?.length > 0) socket.emit("yourCards", player.hand);
    });

    socket.on("playCard", ({ roomId, card }) => {
        const room = rooms[roomId];
        if (!room || !room.gameStarted || room.gameEnded) return;
        if (room.currentTurn !== socket.id) return;
        handleMove(roomId, socket.id, card);
    });

    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const player = room.players.find(p => p.id === socket.id);
            if (!player) continue;
            player.isConnected = false;
            io.to(roomId).emit("playersUpdated", room.players.map(({ hand, ...r }) => r));
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
