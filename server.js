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

// --- 🃏 கார்டு கட்டு உருவாக்கம் (A to 2 Order) ---
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
    const suitOrder = {
        'Spades': 0,
        'Hearts': 1,
        'Diamonds': 2,
        'Clubs': 3
    };

    return [...hand].sort((a, b) => {
        if (suitOrder[a.name] !== suitOrder[b.name]) {
            return suitOrder[a.name] - suitOrder[b.name];
        }
        return a.val - b.val;
    });
};

let rooms = {};

io.on("connection", (socket) => {
    console.log("Player Connected:", socket.id);

    // 1. ரூம் உருவாக்குதல்
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
            lastRoundType: null
        };
        socket.join(roomId);
        callback(roomId);
    });

    // 2. ரூமில் இணைதல்
    socket.on("joinRoom", ({ roomId, playerName }, callback) => {
        const room = rooms[roomId];

        if (!room) {
            return callback({
                success: false,
                message: "Room not found!"
            });
        }

        if (room.gameStarted) {
            return callback({
                success: false,
                message: "Game already started!"
            });
        }

        const existingBySocket = room.players.find(p => p.id === socket.id);

        if (existingBySocket) {
            existingBySocket.isConnected = true;
            socket.join(roomId);

            io.to(roomId).emit(
                "playersUpdated",
                room.players.map(({ hand, ...rest }) => rest)
            );

            return callback({
                success: true,
                rejoined: true
            });
        }

        const existingByName = room.players.find(
            p =>
                !p.isBot &&
                p.name.trim().toLowerCase() === playerName.trim().toLowerCase()
        );

        if (existingByName) {
            console.log("Reconnecting player:", existingByName.name);

            existingByName.id = socket.id;
            existingByName.isConnected = true;

            socket.join(roomId);

            io.to(roomId).emit(
                "playersUpdated",
                room.players.map(({ hand, ...rest }) => rest)
            );

            if (existingByName.hand?.length > 0) {
                io.to(socket.id).emit("yourCards", existingByName.hand);
            }

            return callback({
                success: true,
                rejoined: true
            });
        }

        const realPlayers = room.players.filter(p => !p.isBot);

        if (realPlayers.length >= 4) {
            return callback({
                success: false,
                message: "Room full!"
            });
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

        io.to(roomId).emit(
            "playersUpdated",
            room.players.map(({ hand, ...rest }) => rest)
        );

        callback({
            success: true
        });
    });

    // 3. ஆட்டத்தைத் தொடங்குதல்
    socket.on("startGame", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        room.gameStarted = true;
        room.table = [];
        room.winners = [];
        room.discardedPile = [];
        room.missingCards = {};
        room.recentLeadSuits = [];
        room.loadedPlayerId = null;
        room.lastRoundType = null;

        while (room.players.length < 4) {
            const botId = `bot-${Math.random().toString(36).substr(2, 5)}`;
            room.players.push({
                id: botId,
                name: `Bot ${room.players.length}`,
                isBot: true,
                hand: [],
                handCount: 13,
                isConnected: true
            });
        }

        const deck = createShuffledDeck();
        let starterId = '';

        room.players.forEach((player, i) => {
            player.hand = sortHandBySuitAndValue(deck.slice(i * 13, (i + 1) * 13));
            player.handCount = 13;
            if (player.hand.some(c => c.symbol === '♠' && c.label === 'A')) starterId = player.id;
            if (!player.isBot) io.to(player.id).emit("yourCards", player.hand);
        });

        io.to(roomId).emit("gameStarted", {
            currentTurn: starterId,
            players: room.players.map(({ hand, ...rest }) => rest)
        });

        if (starterId.startsWith('bot-')) checkBotTurn(roomId, starterId);
    });

    // கார்டுகளை மீண்டும் கேட்கும் வசதி
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

    function getNextPlayer(roomId, currentPlayerId) {
        const room = rooms[roomId];
        if (!room || !room.players.length) return null;

        const playerIndex = room.players.findIndex(p => p.id === currentPlayerId);
        if (playerIndex === -1) return null;

        for (let i = 1; i <= room.players.length; i++) {
            const nextIdx = (playerIndex + i) % room.players.length;
            const nextPlayer = room.players[nextIdx];
            const isWinner = room.winners.some(w => w.id === nextPlayer.id);
            const hasCards = (nextPlayer.hand?.length ?? 0) > 0;

            if (nextPlayer && hasCards && !isWinner) {
                return nextPlayer.id;
            }
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
        if (room.recentLeadSuits.length > 8) {
            room.recentLeadSuits.shift();
        }
    }

    function getHighestLeadCard(cards, leadSuit) {
        return [...cards]
            .filter(c => c.symbol === leadSuit)
            .sort((a, b) => b.val - a.val)[0];
    }

    function handleMove(roomId, playerId, card) {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;

        const player = room.players.find(p => p.id === playerId);
        if (!player) return;

        // 1. பிளேயர் கையில் இருந்து கார்டை நீக்குதல்
        player.hand = player.hand.filter(c => c.id !== card.id);
        player.handCount = player.hand.length;

        updateWinners(roomId);

        // stop game instantly if finished
        if (!rooms[roomId]?.gameStarted) {
            room.table = [];
            io.to(roomId).emit("gameUpdated", {
                table: [],
                currentTurn: null,
                players: room.players.map(({ hand, ...rest }) => rest)
            });
            return;
        }

        const playedCard = { ...card, playedBy: playerId };
        room.table.push(playedCard);

        if (room.table.length === 1) {
            pushRecentLeadSuit(room, playedCard.symbol);
        }

        // AI Memory: மிஸ்ஸிங் சூட் குறித்துக்கொள்ளுதல்
        if (room.table.length > 1) {
            const leadS = room.table[0].symbol;
            if (playedCard.symbol !== leadS) {
                rememberMissingSuit(room, playerId, leadS);
            }
        }

        // போர்டை அப்டேட் செய்தல்
        io.to(roomId).emit("gameUpdated", {
            table: room.table,
            currentTurn: null,
            players: room.players.map(({ hand, ...rest }) => rest)
        });

        setTimeout(() => {
            if (!room.table || room.table.length === 0) return;

            const leadSuit = room.table[0].symbol;
            const latestCard = room.table[room.table.length - 1];

            // --- 🚨 STRIKE LOGIC (வெட்டுதல்) ---
            if (room.table.length > 1 && latestCard.symbol !== leadSuit) {
                const highestInLead = getHighestLeadCard(room.table, leadSuit);
                const loadedPlayerId = highestInLead.playedBy;
                const loadedPlayer = room.players.find(p => p.id === loadedPlayerId);

                const cardsFromTable = [...room.table];
                loadedPlayer.hand = sortHandBySuitAndValue([...loadedPlayer.hand, ...cardsFromTable]);
                loadedPlayer.handCount = loadedPlayer.hand.length;

                room.loadedPlayerId = loadedPlayerId;
                room.lastRoundType = 'cut';

                io.to(roomId).emit("strikeOccurred", {
                    loser: loadedPlayerId,
                    table: room.table,
                    nextTurn: loadedPlayerId,
                    updatedHand: loadedPlayer.hand,
                    players: room.players.map(({ hand, ...rest }) => rest)
                });

                room.table = [];
                updateWinners(roomId);

                if (loadedPlayerId.startsWith('bot-')) checkBotTurn(roomId, loadedPlayerId);
                return;
            }

            // --- ROUND COMPLETE (சுற்று முடிதல்) ---
            const activePlayersNow = room.players.filter(p =>
                p.hand.length > 0 &&
                !room.winners.some(w => w.id === p.id)
            ).length;

            if (activePlayersNow === 0) return;

            if (room.table.length === activePlayersNow) {
                const highestLead = getHighestLeadCard(room.table, leadSuit);
                const roundWinnerId = highestLead.playedBy;

                io.to(roomId).emit("roundComplete", {
                    winner: roundWinnerId,
                    table: room.table,
                    nextTurn: roundWinnerId,
                    players: room.players.map(({ hand, ...rest }) => rest)
                });

                room.discardedPile.push(...room.table);
                room.table = [];
                room.loadedPlayerId = null;
                room.lastRoundType = 'normal';
                updateWinners(roomId);

                if (roundWinnerId.startsWith('bot-')) checkBotTurn(roomId, roundWinnerId);
            } else {
                let nextTurnId = getNextPlayer(roomId, playerId);

                if (!nextTurnId) {
                    updateWinners(roomId);
                    return;
                }

                io.to(roomId).emit("gameUpdated", {
                    table: room.table,
                    currentTurn: nextTurnId,
                    players: room.players.map(({ hand, ...rest }) => rest)
                });

                if (nextTurnId && nextTurnId.startsWith('bot-')) checkBotTurn(roomId, nextTurnId);
            }
        }, 1200);
    }

    function updateWinners(roomId) {
        const room = rooms[roomId];
        if (!room) return;

        let changed = false;

        room.players.forEach(player => {
            const alreadyWinner = room.winners.some(w => w.id === player.id);

            if (player.hand.length === 0 && !alreadyWinner) {
                room.winners.push({
                    id: player.id,
                    name: player.name,
                    rank: room.winners.length + 1
                });
                changed = true;
                console.log(`🏆 Winner added: ${player.name}`);
            }
        });

        io.to(roomId).emit(
            "playersUpdated",
            room.players.map(({ hand, ...rest }) => rest)
        );

        if (changed) {
            io.to(roomId).emit("winnersUpdated", room.winners);
        }

        const totalFinished = room.winners.length;

        if (totalFinished >= 3) {
            const donkey = room.players.find(
                p => !room.winners.some(w => w.id === p.id)
            );

            if (donkey && !room.winners.some(w => w.id === donkey.id)) {
                room.winners.push({
                    id: donkey.id,
                    name: donkey.name,
                    rank: 4
                });
            }

            room.gameStarted = false;

            io.to(roomId).emit("winnersUpdated", room.winners);
            io.to(roomId).emit("gameFinished", {
                winners: room.winners
            });
        }
    }

    // 2. AI BOT TACTICAL LOGIC (பாதுகாப்பு விதிகள்)
    function checkBotTurn(roomId, botId) {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;
        const bot = room.players.find(p => p.id === botId);
        if (!bot || !bot.isBot || room.winners.some(w => w.id === botId)) return;
        if (bot.hand.length <= 0 || room.winners.some(w => w.id === botId)) return;

        setTimeout(() => {
            let cardToPlay;
            const turnOrder = room.players.map(p => p.id);
            const nextPlayerId = turnOrder[(turnOrder.indexOf(botId) + 1) % 4];
            const nextMissing = room.missingCards[nextPlayerId] || [];
            const recentLeads = room.recentLeadSuits.slice(-4);

            if (room.table.length === 0) {
                const aceSpade = bot.hand.find(c => c.symbol === '♠' && c.label === 'A' && room.discardedPile.length === 0);

                if (aceSpade) {
                    cardToPlay = aceSpade;
                } else if (room.loadedPlayerId === botId && room.lastRoundType === 'cut') {
                    let bestCard = null;
                    let bestScore = -Infinity;

                    bot.hand.forEach(card => {
                        let score = 0;

                        if (!nextMissing.includes(card.symbol)) score += 30;
                        else score -= 25;

                        score -= card.val * 2;

                        const repetition = recentLeads.filter(s => s === card.symbol).length;
                        score -= repetition * 5;

                        const sameSuitCount = bot.hand.filter(c => c.symbol === card.symbol).length;
                        if (sameSuitCount >= 2) score += 4;

                        if (score > bestScore) {
                            bestScore = score;
                            bestCard = card;
                        }
                    });

                    cardToPlay = bestCard || sortHandBySuitAndValue(bot.hand)[0];
                } else {
                    let bestCard = null;
                    let bestScore = -Infinity;

                    bot.hand.forEach(card => {
                        let score = 0;

                        if (!nextMissing.includes(card.symbol)) score += 18;
                        else score -= 18;

                        score -= card.val * 0.35;

                        const repetition = recentLeads.filter(s => s === card.symbol).length;
                        score -= repetition * 6;

                        const sameSuitCount = bot.hand.filter(c => c.symbol === card.symbol).length;
                        if (sameSuitCount >= 3) score += 5;

                        if (card.val >= 13 && nextMissing.includes(card.symbol)) score -= 10;
                        if (card.val <= 5) score += 8;

                        if (score > bestScore) {
                            bestScore = score;
                            bestCard = card;
                        }
                    });

                    cardToPlay = bestCard || sortHandBySuitAndValue(bot.hand)[0];
                }
            } else {
                const leadSuit = room.table[0].symbol;
                const sameSuit = bot.hand.filter(c => c.symbol === leadSuit).sort((a, b) => a.val - b.val);

                if (sameSuit.length > 0) {
                    const currentHigh = [...room.table]
                        .filter(c => c.symbol === leadSuit)
                        .sort((a, b) => b.val - a.val)[0];

                    if (room.loadedPlayerId === botId && room.lastRoundType === 'cut') {
                        cardToPlay = sameSuit[0];
                    } else {
                        cardToPlay = sameSuit.find(c => c.val > currentHigh.val) || sameSuit[0];
                    }
                } else {
                    rememberMissingSuit(room, botId, leadSuit);

                    // When cutting, use a high-value card to put danger on lead player
                    cardToPlay = [...bot.hand].sort((a, b) => b.val - a.val)[0];
                }
            }

            if (cardToPlay) handleMove(roomId, botId, cardToPlay);
        }, 1500);
    }

    // --- 🚨 NEW: CONNECTION TRACKING LOGIC ---
    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);

        for (const roomId in rooms) {
            const room = rooms[roomId];
            const player = room.players.find(
                p => p.id === socket.id
            );

            if (!player) continue;

            player.isConnected = false;

            console.log(`${player.name} went offline`);

            io.to(roomId).emit(
                "playersUpdated",
                room.players.map(({ hand, ...rest }) => rest)
            );

            const humansOnline = room.players.some(
                p => !p.isBot && p.isConnected
            );

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
    console.log(`🚀 Server is live and running on port ${PORT}`);
});