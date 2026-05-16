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

const sortHand = (hand) => {
    const suitOrder = { 'Spades': 0, 'Hearts': 1, 'Clubs': 2, 'Diamonds': 3 };
    return [...hand].sort((a, b) => {
        if (suitOrder[a.name] !== suitOrder[b.name]) return suitOrder[a.name] - suitOrder[b.name];
        return a.val - b.val;
    });
};

let rooms = {};

const getPublicPlayers = (room) => room.players.map(({ hand, ...rest }) => rest);

const ensureMemoryPlayer = (room, playerId) => {
    if (!room.missingCards[playerId]) room.missingCards[playerId] = [];
};

const rememberMissingSuit = (room, playerId, suitSymbol) => {
    ensureMemoryPlayer(room, playerId);
    if (!room.missingCards[playerId].includes(suitSymbol)) {
        room.missingCards[playerId].push(suitSymbol);
    }
};

const pushRecentLeadSuit = (room, suitSymbol) => {
    room.recentLeadSuits.push(suitSymbol);
    if (room.recentLeadSuits.length > 8) {
        room.recentLeadSuits.shift();
    }
};

const getHighestCardOfSuit = (cards, suit) => {
    return cards
        .filter(c => c.symbol === suit)
        .sort((a, b) => b.val - a.val)[0] || null;
};

const getActivePlayers = (room) => {
    return room.players.filter(
        p => p.hand.length > 0 && !room.winners.some(w => w.id === p.id)
    );
};

const getNextPlayer = (roomId, currentPlayerId) => {
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
};

const emitPlayersUpdated = (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    io.to(roomId).emit("playersUpdated", getPublicPlayers(room));
};

const emitWinnersUpdated = (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    io.to(roomId).emit("winnersUpdated", room.winners);
};

const emitGameUpdated = (roomId, currentTurn = null) => {
    const room = rooms[roomId];
    if (!room) return;

    io.to(roomId).emit("gameUpdated", {
        table: room.table,
        currentTurn,
        players: getPublicPlayers(room),
        discardedCount: room.discardedPile.length,
        winners: room.winners
    });
};

const maybeFinishGame = (roomId) => {
    const room = rooms[roomId];
    if (!room) return true;

    if (room.winners.length >= 3) {
        const donkey = room.players.find(p => !room.winners.some(w => w.id === p.id));
        if (donkey) {
            room.winners.push({
                id: donkey.id,
                name: donkey.name,
                rank: 4
            });
        }

        room.gameStarted = false;
        room.currentTurn = null;

        emitWinnersUpdated(roomId);

        io.to(roomId).emit("gameFinished", {
            winners: room.winners
        });

        return true;
    }

    return false;
};

const updateWinners = (roomId) => {
    const room = rooms[roomId];
    if (!room) return { finished: true, addedWinners: [] };

    const addedWinners = [];

    room.players.forEach(player => {
        const alreadyWinner = room.winners.some(w => w.id === player.id);

        if (player.hand.length === 0 && !alreadyWinner) {
            const winnerObj = {
                id: player.id,
                name: player.name,
                rank: room.winners.length + 1
            };

            room.winners.push(winnerObj);
            addedWinners.push(winnerObj);
            console.log(`🏆 Winner added: ${player.name}`);
        }
    });

    emitPlayersUpdated(roomId);

    if (addedWinners.length > 0) {
        emitWinnersUpdated(roomId);
    }

    const finished = maybeFinishGame(roomId);
    return { finished, addedWinners };
};

const validateCardPlay = (room, player, card) => {
    if (!room || !room.gameStarted) return false;
    if (!player) return false;
    if (room.currentTurn !== player.id) return false;

    const existingCard = player.hand.find(c => c.id === card.id);
    if (!existingCard) return false;

    if (room.table.length === 0 && room.discardedPile.length === 0) {
        return existingCard.symbol === '♠' && existingCard.label === 'A';
    }

    if (room.table.length === 0) return true;

    const leadSuit = room.table[0].symbol;
    const hasLeadSuit = player.hand.some(c => c.symbol === leadSuit);

    if (hasLeadSuit && existingCard.symbol !== leadSuit) {
        return false;
    }

    return true;
};

const groupBySuit = (hand) => {
    return hand.reduce((acc, card) => {
        if (!acc[card.symbol]) acc[card.symbol] = [];
        acc[card.symbol].push(card);
        return acc;
    }, {});
};

const chooseLeadCardAI = (room, bot) => {
    const nextPlayerId = getNextPlayer(room.id, bot.id);
    const nextMissing = nextPlayerId ? (room.missingCards[nextPlayerId] || []) : [];
    const recentLeads = room.recentLeadSuits.slice(-4);

    const aceSpade = bot.hand.find(
        c => c.symbol === '♠' && c.label === 'A' && room.discardedPile.length === 0
    );
    if (aceSpade) return aceSpade;

    const suitGroups = groupBySuit(bot.hand);
    Object.values(suitGroups).forEach(cards => cards.sort((a, b) => a.val - b.val));

    // 🔥 Danger protection:
    // If this bot just won by cut and took many cards, protect by leading a small card
    // in a suit the next player is likely to still have.
    if (room.dangerPlayerId === bot.id && room.lastRoundType === 'cut') {
        let safestCandidate = null;
        let safestScore = -Infinity;

        Object.entries(suitGroups).forEach(([suit, cards]) => {
            const smallest = cards[0];
            let score = 0;

            const nextPlayerLikelyHasSuit = !nextMissing.includes(suit);
            if (nextPlayerLikelyHasSuit) score += 30;
            else score -= 25;

            const suitSpamPenalty = recentLeads.filter(s => s === suit).length * 5;
            score -= suitSpamPenalty;

            score -= smallest.val * 2;

            if (cards.length >= 2) score += 4;

            if (score > safestScore) {
                safestScore = score;
                safestCandidate = smallest;
            }
        });

        if (safestCandidate) return safestCandidate;
    }

    let bestCard = bot.hand[0];
    let bestScore = -Infinity;

    bot.hand.forEach(card => {
        let score = 0;

        score -= card.val * 0.35;

        const isSafeSuit = !nextMissing.includes(card.symbol);
        if (isSafeSuit) score += 20;
        else score -= 18;

        const suitSpamPenalty = recentLeads.filter(s => s === card.symbol).length * 6;
        score -= suitSpamPenalty;

        const ownSuitCards = bot.hand.filter(c => c.symbol === card.symbol).length;
        if (ownSuitCards >= 3) score += 5;

        if (card.val >= 13 && !isSafeSuit) score -= 12;
        if (card.val <= 5) score += 8;

        if (score > bestScore) {
            bestScore = score;
            bestCard = card;
        }
    });

    return bestCard;
};

const chooseFollowCardAI = (room, bot) => {
    const leadSuit = room.table[0].symbol;
    const sameSuitCards = bot.hand
        .filter(c => c.symbol === leadSuit)
        .sort((a, b) => a.val - b.val);

    if (sameSuitCards.length > 0) {
        const currentHigh = room.table
            .filter(c => c.symbol === leadSuit)
            .sort((a, b) => b.val - a.val)[0];

        const winningCard = sameSuitCards.find(c => c.val > currentHigh.val);

        // If bot is in danger mode, protect by using smallest valid same-suit card when possible
        if (room.dangerPlayerId === bot.id && room.lastRoundType === 'cut') {
            return sameSuitCards[0];
        }

        return winningCard || sameSuitCards[0];
    }

    rememberMissingSuit(room, bot.id, leadSuit);

    const offSuitCards = [...bot.hand].sort((a, b) => b.val - a.val);
    return offSuitCards[0];
};

io.on("connection", (socket) => {
    console.log("Player Connected:", socket.id);

    socket.on("createRoom", ({ playerName }, callback) => {
        const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();

        rooms[roomId] = {
            id: roomId,
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
            recentLeadSuits: [],
            dangerPlayerId: null,
            lastRoundType: null
        };

        socket.join(roomId);
        callback(roomId);
    });

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
            emitPlayersUpdated(roomId);

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
            emitPlayersUpdated(roomId);

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
        emitPlayersUpdated(roomId);

        callback({
            success: true
        });
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
        room.dangerPlayerId = null;
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
            player.hand = sortHand(deck.slice(i * 13, (i + 1) * 13));
            player.handCount = 13;
            ensureMemoryPlayer(room, player.id);

            if (player.hand.some(c => c.symbol === '♠' && c.label === 'A')) {
                starterId = player.id;
            }

            if (!player.isBot) io.to(player.id).emit("yourCards", player.hand);
        });

        room.currentTurn = starterId;

        io.to(roomId).emit("gameStarted", {
            currentTurn: starterId,
            players: getPublicPlayers(room),
            winners: room.winners
        });

        emitWinnersUpdated(roomId);

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

    function handleMove(roomId, playerId, card) {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;

        const player = room.players.find(p => p.id === playerId);
        if (!player) return;
        if (room.winners.some(w => w.id === playerId)) return;

        const valid = validateCardPlay(room, player, card);
        if (!valid) return;

        const actualCard = player.hand.find(c => c.id === card.id);
        if (!actualCard) return;

        player.hand = player.hand.filter(c => c.id !== card.id);
        player.handCount = player.hand.length;

        const playedCard = { ...actualCard, playedBy: playerId };
        room.table.push(playedCard);

        if (room.table.length === 1) {
            pushRecentLeadSuit(room, playedCard.symbol);
        }

        const { finished } = updateWinners(roomId);

        if (finished || !rooms[roomId]?.gameStarted) {
            room.table = [];
            room.currentTurn = null;
            emitGameUpdated(roomId, null);
            return;
        }

        room.currentTurn = null;
        emitGameUpdated(roomId, null);

        setTimeout(() => {
            const liveRoom = rooms[roomId];
            if (!liveRoom || !liveRoom.gameStarted) return;
            if (!liveRoom.table || liveRoom.table.length === 0) return;

            const leadSuit = liveRoom.table[0].symbol;
            const latestCard = liveRoom.table[liveRoom.table.length - 1];
            const isCut = liveRoom.table.length > 1 && latestCard.symbol !== leadSuit;

            if (isCut) {
                rememberMissingSuit(liveRoom, latestCard.playedBy, leadSuit);

                const cutSuit = latestCard.symbol;
                const highestCut = getHighestCardOfSuit(liveRoom.table, cutSuit);
                const cutWinnerId = highestCut.playedBy;
                const cutWinner = liveRoom.players.find(p => p.id === cutWinnerId);

                if (!cutWinner) return;

                const tableCards = [...liveRoom.table];
                cutWinner.hand = sortHand([...cutWinner.hand, ...tableCards]);
                cutWinner.handCount = cutWinner.hand.length;

                liveRoom.dangerPlayerId = cutWinnerId;
                liveRoom.lastRoundType = 'cut';

                io.to(roomId).emit("strikeOccurred", {
                    loser: cutWinnerId,
                    table: liveRoom.table,
                    nextTurn: cutWinnerId,
                    updatedHand: cutWinner.hand,
                    players: getPublicPlayers(liveRoom),
                    winners: liveRoom.winners
                });

                liveRoom.table = [];

                const result = updateWinners(roomId);
                if (result.finished) return;

                liveRoom.currentTurn = cutWinnerId;
                emitWinnersUpdated(roomId);

                if (cutWinnerId.startsWith('bot-')) {
                    checkBotTurn(roomId, cutWinnerId);
                } else {
                    emitGameUpdated(roomId, cutWinnerId);
                }

                return;
            }

            const activePlayersNow = getActivePlayers(liveRoom).length;
            if (activePlayersNow === 0) return;

            if (liveRoom.table.length === activePlayersNow) {
                const highestLead = getHighestCardOfSuit(liveRoom.table, leadSuit);
                const roundWinnerId = highestLead.playedBy;

                io.to(roomId).emit("roundComplete", {
                    winner: roundWinnerId,
                    table: liveRoom.table,
                    nextTurn: roundWinnerId,
                    players: getPublicPlayers(liveRoom),
                    discardedCount: liveRoom.discardedPile.length + liveRoom.table.length,
                    winners: liveRoom.winners
                });

                liveRoom.discardedPile.push(...liveRoom.table);
                liveRoom.table = [];
                liveRoom.dangerPlayerId = null;
                liveRoom.lastRoundType = 'normal';

                const result = updateWinners(roomId);
                if (result.finished) return;

                liveRoom.currentTurn = roundWinnerId;
                emitWinnersUpdated(roomId);

                if (roundWinnerId.startsWith('bot-')) {
                    checkBotTurn(roomId, roundWinnerId);
                } else {
                    emitGameUpdated(roomId, roundWinnerId);
                }
            } else {
                let nextTurnId = getNextPlayer(roomId, playerId);

                if (!nextTurnId) {
                    const result = updateWinners(roomId);
                    if (!result.finished) emitWinnersUpdated(roomId);
                    return;
                }

                liveRoom.currentTurn = nextTurnId;
                emitWinnersUpdated(roomId);
                emitGameUpdated(roomId, nextTurnId);

                if (nextTurnId.startsWith('bot-')) {
                    checkBotTurn(roomId, nextTurnId);
                }
            }
        }, 1200);
    }

    function checkBotTurn(roomId, botId) {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;
        if (room.currentTurn !== botId) return;

        const bot = room.players.find(p => p.id === botId);
        if (!bot || !bot.isBot || room.winners.some(w => w.id === botId)) return;
        if (bot.hand.length <= 0) return;

        setTimeout(() => {
            const liveRoom = rooms[roomId];
            if (!liveRoom || !liveRoom.gameStarted) return;
            if (liveRoom.currentTurn !== botId) return;

            const liveBot = liveRoom.players.find(p => p.id === botId);
            if (!liveBot || !liveBot.hand.length) return;

            let cardToPlay = null;

            if (liveRoom.table.length === 0) {
                cardToPlay = chooseLeadCardAI(liveRoom, liveBot);
            } else {
                cardToPlay = chooseFollowCardAI(liveRoom, liveBot);
            }

            if (cardToPlay) {
                handleMove(roomId, botId, cardToPlay);
            }
        }, 1200);
    }

    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);

        for (const roomId in rooms) {
            const room = rooms[roomId];
            const player = room.players.find(p => p.id === socket.id);

            if (!player) continue;

            player.isConnected = false;
            console.log(`${player.name} went offline`);

            emitPlayersUpdated(roomId);

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
    console.log(`🚀 Server is live and running on port ${PORT}`);
});