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
// HELPERS
// ─────────────────────────────────────────────
function getPublicPlayers(room) {
    return room.players.map(({ hand, ...rest }) => rest);
}

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

function clearRoomForLobby(room) {
    room.gameStarted = false;
    room.table = [];
    room.winners = [];
    room.discardedPile = [];
    room.missingCards = {};
    room.recentLeadSuits = [];
    room.loadedPlayerId = null;
    room.lastRoundType = null;
    room.currentTurn = null;
    room._botToken = {};

    room.players = room.players
        .filter(p => !p.isBot)
        .map((p) => ({
            ...p,
            hand: [],
            handCount: 0,
            host: false
        }));

    const firstHuman = room.players[0];
    if (firstHuman) firstHuman.host = true;
}

function updateWinners(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    let changed = false;

    room.players.forEach(player => {
        const alreadyWinner = room.winners.some(w => w.id === player.id);
        if ((player.hand?.length ?? 0) === 0 && !alreadyWinner) {
            room.winners.push({
                id: player.id,
                name: player.name,
                rank: room.winners.length + 1
            });
            changed = true;
            console.log(`Winner: ${player.name} rank ${room.winners.length}`);
        }
    });

    io.to(roomId).emit('playersUpdated', getPublicPlayers(room));
    if (changed) io.to(roomId).emit('winnersUpdated', room.winners);

    if (room.winners.length >= 3) {
        const donkey = room.players.find(p => !room.winners.some(w => w.id === p.id));
        if (donkey && !room.winners.some(w => w.id === donkey.id)) {
            room.winners.push({ id: donkey.id, name: donkey.name, rank: 4 });
        }

        room.gameStarted = false;
        room.currentTurn = null;

        io.to(roomId).emit('winnersUpdated', room.winners);
        io.to(roomId).emit('gameFinished', {
            winners: room.winners,
            players: getPublicPlayers(room)
        });
    }
}

// ─────────────────────────────────────────────
// MASTERMIND AI LEAD LOGIC
// ─────────────────────────────────────────────
function chooseLeadCard(room, botId) {
    const bot = room.players.find(p => p.id === botId);
    const aiHand = bot.hand;

    if (room.discardedPile.length === 0 && room.table.length === 0) {
        const aceSpade = aiHand.find(c => c.symbol === '♠' && c.label === 'A');
        if (aceSpade) return aceSpade;
    }

    const aliveOpponents = room.players.filter(p =>
        p.id !== botId &&
        !room.winners.some(w => w.id === p.id) &&
        p.hand && p.hand.length > 0
    );

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

        score -= voidOpponents * 40;
        if (voidOpponents === 0) score += 25;
        score += (15 - card.val) * 1.5;

        if (card.val >= 14) score -= 20;
        if (card.val === 13) score -= 12;

        const repetition = recentLeads.filter(s => s === card.symbol).length;
        score -= repetition * 10;

        const sameSuitCount = aiHand.filter(c => c.symbol === card.symbol).length;
        score += sameSuitCount * 3;

        if (voidOpponents === 0 && sameSuitCount >= 3) score += 12;

        if (score > bestScore) {
            bestScore = score;
            bestCard = card;
        }
    });

    return bestCard || aiHand[0];
}

// ─────────────────────────────────────────────
// MASTERMIND AI FOLLOW LOGIC
// ─────────────────────────────────────────────
function chooseFollowCard(room, botId) {
    const bot = room.players.find(p => p.id === botId);
    const aiHand = bot.hand;
    const leadSuit = room.table[0].symbol;

    const sameSuit = aiHand.filter(c => c.symbol === leadSuit).sort((a, b) => a.val - b.val);

    if (sameSuit.length > 0) {
        const currentHigh = [...room.table]
            .filter(c => c.symbol === leadSuit)
            .sort((a, b) => b.val - a.val)[0];
        const currentHighVal = currentHigh ? currentHigh.val : 0;

        const winningCards = sameSuit.filter(c => c.val > currentHighVal);
        const losingCards = sameSuit.filter(c => c.val <= currentHighVal);

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

// ─────────────────────────────────────────────
// BOT SCHEDULER
// ─────────────────────────────────────────────
function scheduleBotTurn(roomId, botId, delay = 1500) {
    if (!rooms[roomId]) return;
    if (!rooms[roomId]._botToken) rooms[roomId]._botToken = {};

    const token = Date.now() + Math.random();
    rooms[roomId]._botToken[botId] = token;

    setTimeout(() => {
        const r = rooms[roomId];
        if (!r || !r.gameStarted) return;
        if (r._botToken[botId] !== token) return;
        if (r.currentTurn !== botId) return;

        const b = r.players.find(p => p.id === botId);
        if (!b || !b.isBot || !b.hand || b.hand.length === 0) return;
        if (r.winners.some(w => w.id === botId)) return;

        let cardToPlay;
        try {
            if (r.table.length === 0) cardToPlay = chooseLeadCard(r, botId);
            else cardToPlay = chooseFollowCard(r, botId);
        } catch (e) {
            console.error('AI choose error:', e);
            cardToPlay = b.hand[0];
        }

        if (cardToPlay) {
            handleMove(roomId, botId, cardToPlay);
        } else if (b.hand.length > 0) {
            handleMove(roomId, botId, b.hand[0]);
        }
    }, delay);
}

// ─────────────────────────────────────────────
// CORE MOVE HANDLER
// ─────────────────────────────────────────────
function handleMove(roomId, playerId, card) {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return false;

    if (room.currentTurn !== playerId) return false;

    const player = room.players.find(p => p.id === playerId);
    if (!player) return false;
    if (room.winners.some(w => w.id === playerId)) return false;

    const cardInHand = player.hand.find(c => c.id === card.id);
    if (!cardInHand) {
        if (player.isBot && player.hand.length > 0) {
            return handleMove(roomId, playerId, player.hand[0]);
        }
        return false;
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
        if (playedCard.symbol !== leadSuit) {
            rememberMissingSuit(room, playerId, leadSuit);
        }
    }

    if (!player.isBot) {
        io.to(playerId).emit('yourCards', player.hand);
    }

    // ── CUT
    if (!isLeadMove) {
        const leadSuit = room.table[0].symbol;
        if (playedCard.symbol !== leadSuit) {
            room.currentTurn = null;

            io.to(roomId).emit('gameUpdated', {
                table: room.table,
                currentTurn: null,
                players: getPublicPlayers(room)
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
                if (!r.gameStarted) return;

                let nextTurn = loadedPlayerId;
                if (!nextTurn || r.winners.some(w => w.id === nextTurn)) {
                    nextTurn = getNextPlayer(r, loadedPlayerId || playerId);
                }

                r.currentTurn = nextTurn;

                io.to(roomId).emit('strikeOccurred', {
                    winner: loadedPlayerId,
                    loser: loadedPlayerId,
                    table: trickCards,
                    nextTurn,
                    updatedHand: loadedPlayer?.hand || [],
                    players: getPublicPlayers(r)
                });

                if (loadedPlayer && !loadedPlayer.isBot) {
                    io.to(loadedPlayerId).emit('yourCards', loadedPlayer.hand);
                }

                if (nextTurn && nextTurn.startsWith('bot-')) {
                    scheduleBotTurn(roomId, nextTurn, 1500);
                }
            }, 1200);

            return true;
        }
    }

    // ── ROUND COMPLETE
    const alivePlayers = getAlivePlayers(room);
    const roundPlayers = new Set(room.table.map(c => c.playedBy));
    const aliveNotPlayed = alivePlayers.filter(p => !roundPlayers.has(p.id));

    if (aliveNotPlayed.length === 0) {
        room.currentTurn = null;

        io.to(roomId).emit('gameUpdated', {
            table: room.table,
            currentTurn: null,
            players: getPublicPlayers(room)
        });

        setTimeout(() => {
            const r = rooms[roomId];
            if (!r || !r.gameStarted) return;

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

            let nextStarter = roundWinnerId;
            if (!nextStarter || r.winners.some(w => w.id === nextStarter)) {
                nextStarter = getNextStarterFromTable(r, trickSnapshot, leadSuit);
            }
            if (!nextStarter || r.winners.some(w => w.id === nextStarter)) {
                nextStarter = getNextPlayer(r, roundWinnerId || r.players[0]?.id);
            }

            r.currentTurn = nextStarter;

            io.to(roomId).emit('roundComplete', {
                winner: roundWinnerId,
                table: trickSnapshot,
                nextTurn: nextStarter,
                players: getPublicPlayers(r),
                discardedCount: r.discardedPile.length
            });

            if (nextStarter && nextStarter.startsWith('bot-')) {
                scheduleBotTurn(roomId, nextStarter, 1500);
            }
        }, 1200);

        return true;
    }

    // ── PASS TURN
    const nextTurnId = getNextPlayer(room, playerId);
    if (!nextTurnId) {
        updateWinners(roomId);
        return true;
    }

    room.currentTurn = nextTurnId;

    io.to(roomId).emit('gameUpdated', {
        table: room.table,
        currentTurn: nextTurnId,
        players: getPublicPlayers(room)
    });

    if (nextTurnId.startsWith('bot-')) {
        scheduleBotTurn(roomId, nextTurnId, 1500);
    }

    return true;
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
                id: socket.id,
                name: playerName,
                host: true,
                isBot: false,
                hand: [],
                handCount: 0,
                isConnected: true
            }],
            gameStarted: false,
            table: [],
            winners: [],
            discardedPile: [],
            missingCards: {},
            recentLeadSuits: [],
            loadedPlayerId: null,
            lastRoundType: null,
            currentTurn: null,
            _botToken: {}
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
            io.to(roomId).emit("playersUpdated", getPublicPlayers(room));
            return callback({ success: true, rejoined: true });
        }

        const existingByName = room.players.find(
            p => !p.isBot && p.name.trim().toLowerCase() === playerName.trim().toLowerCase()
        );

        if (existingByName) {
            existingByName.id = socket.id;
            existingByName.isConnected = true;
            socket.join(roomId);
            io.to(roomId).emit("playersUpdated", getPublicPlayers(room));
            if (existingByName.hand?.length > 0) {
                io.to(socket.id).emit("yourCards", existingByName.hand);
            }
            return callback({ success: true, rejoined: true });
        }

        const realPlayers = room.players.filter(p => !p.isBot);
        if (realPlayers.length >= 4) {
            return callback({ success: false, message: "Room full!" });
        }

        room.players.push({
            id: socket.id,
            name: playerName.trim(),
            host: false,
            isBot: false,
            hand: [],
            handCount: 0,
            isConnected: true
        });

        socket.join(roomId);
        io.to(roomId).emit("playersUpdated", getPublicPlayers(room));
        callback({ success: true });
    });

    socket.on("requestRoomState", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        io.to(roomId).emit("roomState", {
            roomId,
            players: getPublicPlayers(room)
        });
    });

    socket.on("returnToLobby", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        clearRoomForLobby(room);

        io.to(roomId).emit("playersUpdated", getPublicPlayers(room));
        io.to(roomId).emit("roomState", {
            roomId,
            players: getPublicPlayers(room)
        });
    });

    socket.on("removePlayer", ({ roomId, targetPlayerId }, callback) => {
        const room = rooms[roomId];
        if (!room) return callback?.({ success: false, message: "Room not found" });

        const requester = room.players.find(p => p.id === socket.id);
        if (!requester?.host) {
            return callback?.({ success: false, message: "Only host can remove players" });
        }

        if (targetPlayerId === socket.id) {
            return callback?.({ success: false, message: "Host cannot remove self" });
        }

        room.players = room.players.filter(p => p.id !== targetPlayerId);

        const firstHuman = room.players.find(p => !p.isBot);
        room.players.forEach(p => { p.host = false; });
        if (firstHuman) firstHuman.host = true;

        io.to(targetPlayerId).emit("removedFromRoom", {
            message: "You were removed from the room"
        });

        io.to(roomId).emit("playersUpdated", getPublicPlayers(room));
        io.to(roomId).emit("roomState", {
            roomId,
            players: getPublicPlayers(room)
        });

        callback?.({ success: true });
    });

    socket.on("startGame", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        const requester = room.players.find(p => p.id === socket.id);
        if (!requester?.host) return;

        room.gameStarted = true;
        room.table = [];
        room.winners = [];
        room.discardedPile = [];
        room.missingCards = {};
        room.recentLeadSuits = [];
        room.loadedPlayerId = null;
        room.lastRoundType = null;
        room.currentTurn = null;
        room._botToken = {};

        while (room.players.length < 4) {
            const botId = `bot-${Math.random().toString(36).substr(2, 5)}`;
            room.players.push({
                id: botId,
                name: `Bot ${room.players.length}`,
                host: false,
                isBot: true,
                hand: [],
                handCount: 13,
                isConnected: true
            });
        }

        const deck = createShuffledDeck();
        let starterId = null;

        room.players.forEach((player, i) => {
            player.hand = sortHandBySuitAndValue(deck.slice(i * 13, (i + 1) * 13));
            player.handCount = 13;
            if (player.hand.some(c => c.symbol === '♠' && c.label === 'A')) {
                starterId = player.id;
            }
            if (!player.isBot) {
                io.to(player.id).emit("yourCards", player.hand);
            }
        });

        room.currentTurn = starterId || room.players[0].id;

        io.to(roomId).emit("gameStarted", {
            currentTurn: room.currentTurn,
            players: getPublicPlayers(room)
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

    socket.on("playCard", ({ roomId, card }, callback) => {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) {
            return callback?.({ success: false, message: "Game not active" });
        }

        if (room.currentTurn !== socket.id) {
            return callback?.({ success: false, message: "Not your turn" });
        }

        if (room.discardedPile.length === 0 && room.table.length === 0) {
            if (!(card.symbol === '♠' && card.label === 'A')) {
                return callback?.({ success: false, message: "First move must be Ace of Spades" });
            }
        }

        if (room.table.length > 0) {
            const player = room.players.find(p => p.id === socket.id);
            if (player) {
                const leadSuit = room.table[0].symbol;
                const hasLeadSuit = player.hand.some(c => c.symbol === leadSuit);
                if (hasLeadSuit && card.symbol !== leadSuit) {
                    return callback?.({ success: false, message: "You must follow suit" });
                }
            }
        }

        const ok = handleMove(roomId, socket.id, card);
        if (!ok) return callback?.({ success: false, message: "Invalid move" });

        callback?.({ success: true });
    });

    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);

        for (const roomId in rooms) {
            const room = rooms[roomId];
            const player = room.players.find(p => p.id === socket.id);
            if (!player) continue;

            player.isConnected = false;
            io.to(roomId).emit("playersUpdated", getPublicPlayers(room));

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