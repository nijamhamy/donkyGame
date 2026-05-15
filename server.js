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

let rooms = {};

const sortHand = (hand) => {
    const suitOrder = { 'Spades': 0, 'Hearts': 1, 'Clubs': 2, 'Diamonds': 3 };
    return [...hand].sort((a, b) => {
        if (suitOrder[a.name] !== suitOrder[b.name]) return suitOrder[a.name] - suitOrder[b.name];
        return a.val - b.val;
    });
};

const getRankLabel = (rank) => {
    if (rank === 1) return '1st Winner';
    if (rank === 2) return '2nd Winner';
    if (rank === 3) return '3rd Winner';
    if (rank === 4) return 'Donkey';
    return 'Finished';
};

const publicPlayers = (room) => room.players.map(({ hand, ...rest }) => rest);

const getAlivePlayers = (room) => {
    return room.players.filter(p =>
        p.hand.length > 0 &&
        !room.winners.some(w => w.id === p.id)
    );
};

const getHighestLeadPlayer = (table) => {
    if (!table.length) return null;
    const leadSuit = table[0].symbol;
    const highest = table
        .filter(c => c.symbol === leadSuit)
        .sort((a, b) => b.val - a.val)[0];
    return highest?.playedBy || null;
};

const getNextPlayer = (roomId, currentPlayerId) => {
    const room = rooms[roomId];
    if (!room || !room.players.length) return null;

    const alivePlayers = getAlivePlayers(room);
    if (alivePlayers.length === 0) return null;
    if (alivePlayers.length === 1) return alivePlayers[0].id;

    const playerIndex = room.players.findIndex(p => p.id === currentPlayerId);
    if (playerIndex === -1) return alivePlayers[0].id;

    for (let i = 1; i <= room.players.length; i++) {
        const nextIdx = (playerIndex + i) % room.players.length;
        const nextPlayer = room.players[nextIdx];
        const isWinner = room.winners.some(w => w.id === nextPlayer.id);
        const hasCards = (nextPlayer.hand?.length ?? 0) > 0;

        if (nextPlayer && hasCards && !isWinner) return nextPlayer.id;
    }

    return alivePlayers[0]?.id || null;
};

const finalizeDonkeyIfNeeded = (room) => {
    if (room.winners.length === 3) {
        const donkey = room.players.find(p => !room.winners.some(w => w.id === p.id));
        if (donkey) {
            room.winners.push({
                id: donkey.id,
                name: donkey.name,
                rank: 4,
                label: getRankLabel(4)
            });
        }
    }
};

const emitPlayersUpdated = (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    io.to(roomId).emit("playersUpdated", publicPlayers(room));
};

const updateWinners = (roomId) => {
    const room = rooms[roomId];
    if (!room) return false;

    room.players.forEach(player => {
        const alreadyWinner = room.winners.some(w => w.id === player.id);
        if (player.hand.length === 0 && !alreadyWinner) {
            const rank = room.winners.length + 1;
            room.winners.push({
                id: player.id,
                name: player.name,
                rank,
                label: getRankLabel(rank)
            });
        }
    });

    finalizeDonkeyIfNeeded(room);
    emitPlayersUpdated(roomId);

    if (room.winners.length >= 4 || room.winners.length >= 3) {
        room.gameStarted = false;
        io.to(roomId).emit("gameFinished", { winners: room.winners });
        return true;
    }

    return false;
};

const emitGameState = (roomId, extra = {}) => {
    const room = rooms[roomId];
    if (!room) return;

    io.to(roomId).emit("gameUpdated", {
        table: room.table,
        currentTurn: room.currentTurn ?? null,
        discardedCount: room.discardedPile.length,
        winners: room.winners,
        players: publicPlayers(room),
        ...extra
    });
};

const chooseBotCard = (room, botId) => {
    const bot = room.players.find(p => p.id === botId);
    if (!bot || !bot.hand.length) return null;

    const recentLeadSuits = room.recentLeadSuits || [];
    const playerIndex = room.players.findIndex(p => p.id === botId);
    const nextPlayer = room.players[(playerIndex + 1) % room.players.length];
    const nextMissing = room.missingCards[nextPlayer?.id] || [];

    if (room.table.length === 0) {
        const aceSpade = bot.hand.find(c => c.symbol === '♠' && c.label === 'A' && room.discardedPile.length === 0);
        if (aceSpade) return aceSpade;

        let bestCard = bot.hand[0];
        let bestScore = -Infinity;

        bot.hand.forEach(card => {
            let score = 0;
            score += (15 - card.val);

            if (!nextMissing.includes(card.symbol)) score += 15;
            else score -= 20;

            const recentSpam = recentLeadSuits.filter(s => s === card.symbol).length;
            score -= recentSpam * 8;

            const sameSuitCount = bot.hand.filter(c => c.symbol === card.symbol).length;
            score += sameSuitCount * 2;

            if (card.val >= 13) score -= 10;

            if (score > bestScore) {
                bestScore = score;
                bestCard = card;
            }
        });

        return bestCard;
    }

    const leadSuit = room.table[0].symbol;
    const sameSuit = bot.hand.filter(c => c.symbol === leadSuit).sort((a, b) => a.val - b.val);

    if (sameSuit.length > 0) {
        const currentHigh = [...room.table]
            .filter(c => c.symbol === leadSuit)
            .sort((a, b) => b.val - a.val)[0];

        return sameSuit.find(c => c.val > currentHigh.val) || sameSuit[0];
    }

    return [...bot.hand].sort((a, b) => b.val - a.val)[0];
};

const checkBotTurn = (roomId, botId) => {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;

    const bot = room.players.find(p => p.id === botId);
    if (!bot || !bot.isBot) return;
    if (room.winners.some(w => w.id === botId)) return;
    if (room.currentTurn !== botId) return;
    if (bot.hand.length <= 0) return;

    setTimeout(() => {
        const freshRoom = rooms[roomId];
        if (!freshRoom || !freshRoom.gameStarted || freshRoom.currentTurn !== botId) return;

        const cardToPlay = chooseBotCard(freshRoom, botId);
        if (cardToPlay) handleMove(roomId, botId, cardToPlay);
    }, 1200);
};

const handleMove = (roomId, playerId, card) => {
    const room = rooms[roomId];
    if (!room || !room.gameStarted) return;
    if (room.currentTurn !== playerId) return;

    const player = room.players.find(p => p.id === playerId);
    if (!player) return;
    if (room.winners.some(w => w.id === playerId)) return;

    const cardExists = player.hand.find(c => c.id === card.id);
    if (!cardExists) return;

    const currentTable = [...room.table];
    const leadSuit = currentTable[0]?.symbol || null;

    if (leadSuit) {
        const hasLeadSuit = player.hand.some(c => c.symbol === leadSuit);
        if (hasLeadSuit && card.symbol !== leadSuit) return;
    } else {
        if (room.discardedPile.length === 0) {
            const isAceSpades = card.symbol === '♠' && card.label === 'A';
            if (!isAceSpades) return;
        }
        room.recentLeadSuits.push(card.symbol);
        if (room.recentLeadSuits.length > 6) room.recentLeadSuits.shift();
    }

    player.hand = sortHand(player.hand.filter(c => c.id !== card.id));
    player.handCount = player.hand.length;

    const playedCard = { ...cardExists, playedBy: playerId };
    room.table.push(playedCard);

    if (!room.missingCards[playerId]) room.missingCards[playerId] = [];
    if (leadSuit && playedCard.symbol !== leadSuit && !room.missingCards[playerId].includes(leadSuit)) {
        room.missingCards[playerId].push(leadSuit);
    }

    if (!player.isBot) {
        io.to(player.id).emit("yourCards", player.hand);
    }

    if (updateWinners(roomId)) return;

    room.currentTurn = null;
    emitGameState(roomId);

    setTimeout(() => {
        const freshRoom = rooms[roomId];
        if (!freshRoom || !freshRoom.gameStarted || freshRoom.table.length === 0) return;

        const fullTable = [...freshRoom.table];
        const leadS = fullTable[0].symbol;
        const justPlayed = fullTable[fullTable.length - 1];
        const isCut = fullTable.length > 1 && justPlayed.symbol !== leadS;

        if (isCut) {
            const winnerId = getHighestLeadPlayer(fullTable);
            const winnerPlayer = freshRoom.players.find(p => p.id === winnerId);
            if (!winnerPlayer) return;

            winnerPlayer.hand = sortHand([...winnerPlayer.hand, ...fullTable]);
            winnerPlayer.handCount = winnerPlayer.hand.length;

            const eventPayload = {
                loser: justPlayed.playedBy,
                table: fullTable,
                nextTurn: winnerId,
                updatedHand: winnerPlayer.id === playerId ? winnerPlayer.hand : winnerPlayer.hand,
                discardedCount: freshRoom.discardedPile.length,
                winners: freshRoom.winners,
                players: publicPlayers(freshRoom)
            };

            if (!winnerPlayer.isBot) {
                io.to(winnerPlayer.id).emit("yourCards", winnerPlayer.hand);
            }

            io.to(roomId).emit("strikeOccurred", eventPayload);

            freshRoom.table = [];
            freshRoom.currentTurn = winnerId;

            if (updateWinners(roomId)) return;
            if (winnerId.startsWith('bot-')) checkBotTurn(roomId, winnerId);
            return;
        }

        const aliveNow = getAlivePlayers(freshRoom);
        const roundPlayers = fullTable.map(c => c.playedBy);
        const remainingEligible = aliveNow.filter(p => !roundPlayers.includes(p.id));

        if (remainingEligible.length === 0) {
            const winnerId = getHighestLeadPlayer(fullTable);
            freshRoom.discardedPile.push(...fullTable);
            freshRoom.table = [];
            freshRoom.currentTurn = winnerId;

            io.to(roomId).emit("roundComplete", {
                winner: winnerId,
                table: fullTable,
                nextTurn: winnerId,
                discardedCount: freshRoom.discardedPile.length,
                winners: freshRoom.winners,
                players: publicPlayers(freshRoom)
            });

            if (updateWinners(roomId)) return;
            if (winnerId.startsWith('bot-')) checkBotTurn(roomId, winnerId);
            return;
        }

        const nextTurnId = getNextPlayer(roomId, playerId);
        freshRoom.currentTurn = nextTurnId;

        emitGameState(roomId);

        if (nextTurnId && nextTurnId.startsWith('bot-')) {
            checkBotTurn(roomId, nextTurnId);
        }
    }, 1200);
};

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
            currentTurn: null,
            table: [],
            winners: [],
            discardedPile: [],
            missingCards: {},
            recentLeadSuits: []
        };

        socket.join(roomId);
        callback(roomId);
        emitPlayersUpdated(roomId);
    });

    socket.on("joinRoom", ({ roomId, playerName }, callback) => {
        const room = rooms[roomId];

        if (!room) {
            return callback({ success: false, message: "Room not found!" });
        }

        if (room.gameStarted) {
            return callback({ success: false, message: "Game already started!" });
        }

        const existingBySocket = room.players.find(p => p.id === socket.id);
        if (existingBySocket) {
            existingBySocket.isConnected = true;
            socket.join(roomId);
            emitPlayersUpdated(roomId);
            return callback({ success: true, rejoined: true });
        }

        const existingByName = room.players.find(
            p => !p.isBot && p.name.trim().toLowerCase() === playerName.trim().toLowerCase()
        );

        if (existingByName) {
            existingByName.id = socket.id;
            existingByName.isConnected = true;

            socket.join(roomId);
            emitPlayersUpdated(roomId);

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
        emitPlayersUpdated(roomId);
        callback({ success: true });
    });

    socket.on("startGame", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        room.gameStarted = true;
        room.currentTurn = null;
        room.table = [];
        room.winners = [];
        room.discardedPile = [];
        room.missingCards = {};
        room.recentLeadSuits = [];

        while (room.players.length < 4) {
            const botId = `bot-${Math.random().toString(36).substr(2, 5)}`;
            room.players.push({
                id: botId,
                name: `Bot ${room.players.length}`,
                isBot: true,
                host: false,
                hand: [],
                handCount: 13,
                isConnected: true
            });
        }

        const deck = createShuffledDeck();
        let starterId = '';

        room.players.forEach((player, i) => {
            player.hand = sortHand(deck.slice(i * 13, (i + 1) * 13));
            player.handCount = player.hand.length;
            if (player.hand.some(c => c.symbol === '♠' && c.label === 'A')) starterId = player.id;
            if (!player.isBot) io.to(player.id).emit("yourCards", player.hand);
        });

        room.currentTurn = starterId;

        io.to(roomId).emit("gameStarted", {
            currentTurn: starterId,
            players: publicPlayers(room)
        });

        if (starterId.startsWith('bot-')) checkBotTurn(roomId, starterId);
    });

    socket.on("requestMyCards", ({ roomId }) => {
        const room = rooms[roomId];
        if (room) {
            const player = room.players.find(p => p.id === socket.id);
            if (player && player.hand.length > 0) {
                socket.emit("yourCards", player.hand);
            }
        }
    });

    socket.on("playCard", ({ roomId, card }) => {
        handleMove(roomId, socket.id, card);
    });

    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);

        for (const roomId in rooms) {
            const room = rooms[roomId];
            const player = room.players.find(p => p.id === socket.id);

            if (!player) continue;

            player.isConnected = false;
            emitPlayersUpdated(roomId);

            const humansOnline = room.players.some(p => !p.isBot && p.isConnected);

            if (!humansOnline) {
                delete rooms[roomId];
            }

            break;
        }
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is live and running on port ${PORT}`);
});