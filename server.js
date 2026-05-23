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

    // NEW: room state request
    socket.on("requestRoomState", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        io.to(roomId).emit("roomState", {
            roomId,
            players: room.players.map(({ hand, ...rest }) => rest)
        });
    });

    // NEW: return all players to lobby
    socket.on("returnToLobby", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        room.gameStarted = false;
        room.table = [];
        room.winners = [];
        room.discardedPile = [];
        room.missingCards = {};
        room.recentLeadSuits = [];
        room.loadedPlayerId = null;
        room.lastRoundType = null;

        room.players = room.players
            .filter(player => !player.isBot)
            .map((player, index) => ({
                ...player,
                host: index === 0 ? true : player.host,
                hand: [],
                handCount: 0,
                isConnected: player.isConnected !== false
            }));

        io.to(roomId).emit(
            "playersUpdated",
            room.players.map(({ hand, ...rest }) => rest)
        );

        io.to(roomId).emit("roomState", {
            roomId,
            players: room.players.map(({ hand, ...rest }) => rest)
        });
    });

    // NEW: host remove player
    socket.on("removePlayer", ({ roomId, targetPlayerId }, callback) => {
        const room = rooms[roomId];

        if (!room) {
            return callback?.({
                success: false,
                message: "Room not found"
            });
        }

        const requester = room.players.find(p => p.id === socket.id);

        if (!requester || !requester.host) {
            return callback?.({
                success: false,
                message: "Only host can remove players"
            });
        }

        if (targetPlayerId === socket.id) {
            return callback?.({
                success: false,
                message: "Host cannot remove self"
            });
        }

        const targetPlayer = room.players.find(p => p.id === targetPlayerId);

        if (!targetPlayer) {
            return callback?.({
                success: false,
                message: "Player not found"
            });
        }

        room.players = room.players.filter(p => p.id !== targetPlayerId);

        io.to(targetPlayerId).emit("removedFromRoom", {
            message: "You were removed from the room"
        });

        io.to(roomId).emit(
            "playersUpdated",
            room.players.map(({ hand, ...rest }) => rest)
        );

        io.to(roomId).emit("roomState", {
            roomId,
            players: room.players.map(({ hand, ...rest }) => rest)
        });

        callback?.({
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

    function getNextStarterFromTable(room, tableCards, leadSuit) {
        const rankedLeadCards = [...tableCards]
            .filter(c => c.symbol === leadSuit)
            .sort((a, b) => b.val - a.val);

        for (const trickCard of rankedLeadCards) {
            const player = room.players.find(p => p.id === trickCard.playedBy);
            const isWinner = room.winners.some(w => w.id === trickCard.playedBy);
            const hasCards = (player?.hand?.length ?? 0) > 0;

            if (player && hasCards && !isWinner) {
                return trickCard.playedBy;
            }
        }

        return null;
    }

    function handleMove(roomId, playerId, card) {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;

        const player = room.players.find(p => p.id === playerId);
        if (!player) return;

        player.hand = player.hand.filter(c => c.id !== card.id);
        player.handCount = player.hand.length;

        const playedCard = { ...card, playedBy: playerId };
        room.table.push(playedCard);

        if (room.table.length === 1) {
            pushRecentLeadSuit(room, playedCard.symbol);
        }

        if (room.table.length > 1) {
            const leadS = room.table[0].symbol;
            if (playedCard.symbol !== leadS) {
                rememberMissingSuit(room, playerId, leadS);
            }
        }

        io.to(roomId).emit("gameUpdated", {
            table: room.table,
            currentTurn: null,
            players: room.players.map(({ hand, ...rest }) => rest)
        });

        setTimeout(() => {
            if (!room.table || room.table.length === 0) return;

            const leadSuit = room.table[0].symbol;
            const latestCard = room.table[room.table.length - 1];

            if (room.table.length > 1 && latestCard.symbol !== leadSuit) {
                const highestInLead = getHighestLeadCard(room.table, leadSuit);
                const loadedPlayerId = highestInLead.playedBy;
                const loadedPlayer = room.players.find(p => p.id === loadedPlayerId);

                const cardsFromTable = [...room.table];
                loadedPlayer.hand = sortHandBySuitAndValue([...loadedPlayer.hand, ...cardsFromTable]);
                loadedPlayer.handCount = loadedPlayer.hand.length;

                room.loadedPlayerId = loadedPlayerId;
                room.lastRoundType = 'cut';

                room.table = [];

                updateWinners(roomId);

                io.to(roomId).emit("strikeOccurred", {
                    loser: loadedPlayerId,
                    table: cardsFromTable,
                    nextTurn: loadedPlayerId,
                    updatedHand: loadedPlayer.hand,
                    players: room.players.map(({ hand, ...rest }) => rest)
                });

                if (room.gameStarted && loadedPlayerId.startsWith('bot-')) checkBotTurn(roomId, loadedPlayerId);
                return;
            }

            const activePlayersNow = room.players.filter(p =>
                p.hand.length > 0 &&
                !room.winners.some(w => w.id === p.id)
            ).length;

            if (activePlayersNow === 0) {
                updateWinners(roomId);
                return;
            }

            if (room.table.length === activePlayersNow) {
                const highestLead = getHighestLeadCard(room.table, leadSuit);
                const roundWinnerId = highestLead.playedBy;
                const trickSnapshot = [...room.table];

                room.discardedPile.push(...room.table);
                room.table = [];
                room.loadedPlayerId = null;
                room.lastRoundType = 'normal';

                updateWinners(roomId);

                let nextStarterId = getNextStarterFromTable(room, trickSnapshot, leadSuit);

                if (!nextStarterId) {
                    nextStarterId = getNextPlayer(roomId, roundWinnerId);
                }

                io.to(roomId).emit("roundComplete", {
                    winner: roundWinnerId,
                    table: trickSnapshot,
                    nextTurn: nextStarterId,
                    players: room.players.map(({ hand, ...rest }) => rest)
                });

                if (room.gameStarted && nextStarterId && nextStarterId.startsWith('bot-')) checkBotTurn(roomId, nextStarterId);
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
                winners: room.winners,
                players: room.players.map(({ hand, ...rest }) => rest)
            });
        }
    }

    // ── AI BOT TACTICAL LOGIC (same mastermind as offline Game_fixed3.jsx) ──
    function checkBotTurn(roomId, botId) {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;
        const bot = room.players.find(p => p.id === botId);
        if (!bot || !bot.isBot || room.winners.some(w => w.id === botId)) return;
        if (bot.hand.length <= 0) return;

        setTimeout(() => {
            // Re-validate after delay (game state may have changed)
            if (!room.gameStarted) return;
            if (room.winners.some(w => w.id === botId)) return;
            if (bot.hand.length <= 0) return;

            let cardToPlay;

            if (room.table.length === 0) {
                // ── LEAD LOGIC ──────────────────────────────────────────────

                // First card of entire game: must play Ace of Spades
                const aceSpade = bot.hand.find(
                    c => c.symbol === '♠' && c.label === 'A' && room.discardedPile.length === 0
                );
                if (aceSpade) {
                    cardToPlay = aceSpade;
                } else {
                    // ── Master-mind lead: check ALL alive opponents for voids ──
                    const alivePlayers = room.players.filter(p =>
                        p.id !== botId &&
                        (p.hand?.length ?? 0) > 0 &&
                        !room.winners.some(w => w.id === p.id)
                    );

                    // Build void count per suit across all alive opponents
                    const voidCountBySuit = {};
                    alivePlayers.forEach(opponent => {
                        const opponentMissing = room.missingCards[opponent.id] || [];
                        opponentMissing.forEach(suit => {
                            voidCountBySuit[suit] = (voidCountBySuit[suit] || 0) + 1;
                        });
                    });

                    // Find the next player in turn order to weigh heavily
                    const turnOrder = room.players.map(p => p.id);
                    const nextPlayerId = turnOrder[(turnOrder.indexOf(botId) + 1) % turnOrder.length];
                    const nextMissing = room.missingCards[nextPlayerId] || [];

                    const recentLeads = room.recentLeadSuits.slice(-6);

                    let bestCard = null;
                    let bestScore = -Infinity;

                    bot.hand.forEach(card => {
                        let score = 0;

                        // Count how many alive opponents are void in this suit
                        const voidOpponents = voidCountBySuit[card.symbol] || 0;

                        // Heavy penalty per void opponent (they will cut/dump)
                        score -= voidOpponents * 40;

                        // Extra penalty if next player specifically is void
                        if (nextMissing.includes(card.symbol)) score -= 25;

                        // Bonus for suits where zero opponents are void (safe lead)
                        if (voidOpponents === 0) score += 25;

                        // Penalty for high-value cards (likely to win = collect danger dumps)
                        if (card.val >= 14) score -= 20; // Ace
                        if (card.val >= 13) score -= 12; // King
                        if (card.val >= 12) score -= 6;  // Queen

                        // Slight prefer low cards (less exposure)
                        score += (15 - card.val) * 0.5;

                        // Anti-spam: penalise suits repeated recently as lead
                        const recentSpam = recentLeads.filter(s => s === card.symbol).length;
                        score -= recentSpam * 10;

                        // Prefer suits bot holds many of (control / reduce hand)
                        const sameSuitCount = bot.hand.filter(c => c.symbol === card.symbol).length;
                        score += sameSuitCount * 2;

                        if (score > bestScore) {
                            bestScore = score;
                            bestCard = card;
                        }
                    });

                    cardToPlay = bestCard || sortHandBySuitAndValue(bot.hand)[0];
                }

            } else {
                // ── FOLLOW LOGIC ─────────────────────────────────────────────
                const leadSuit = room.table[0].symbol;
                const sameSuit = bot.hand
                    .filter(c => c.symbol === leadSuit)
                    .sort((a, b) => a.val - b.val);

                if (sameSuit.length > 0) {
                    // Bot has the lead suit — decide whether to win or lose
                    const currentHigh = [...room.table]
                        .filter(c => c.symbol === leadSuit)
                        .sort((a, b) => b.val - a.val)[0];

                    // Check if any player AFTER bot in this trick is void in lead suit
                    // (they will cut/dump danger cards onto the trick winner)
                    const playersYetToPlay = getPlayersYetToAct(room, botId, leadSuit);
                    const anyVoidAhead = playersYetToPlay.some(pid => {
                        const missing = room.missingCards[pid] || [];
                        return missing.includes(leadSuit);
                    });

                    // Check if there are already danger cards (high value) on the table
                    const maxTableVal = Math.max(...room.table.map(c => c.val));
                    const trickIsDangerous = maxTableVal >= 13;

                    if (anyVoidAhead || trickIsDangerous) {
                        // Unsafe to win: play lowest card (intentionally lose or minimise)
                        cardToPlay = sameSuit[0];
                    } else {
                        // Safe to win: play smallest winning card, else smallest losing card
                        const smallestWin = sameSuit.find(c => c.val > currentHigh.val);
                        cardToPlay = smallestWin || sameSuit[0];
                    }
                } else {
                    // Bot is void in lead suit — must cut/dump
                    rememberMissingSuit(room, botId, leadSuit);

                    // Dump highest value card to clear danger from own hand
                    cardToPlay = [...bot.hand].sort((a, b) => b.val - a.val)[0];
                }
            }

            if (cardToPlay) handleMove(roomId, botId, cardToPlay);
        }, 1500);
    }

    // ── Helper: get player IDs that haven't played yet in current trick ──
    function getPlayersYetToAct(room, botId, leadSuit) {
        const playedIds = new Set(room.table.map(c => c.playedBy));
        const turnOrder = room.players.map(p => p.id);
        const botIdx = turnOrder.indexOf(botId);
        const result = [];

        for (let i = 1; i < turnOrder.length; i++) {
            const pid = turnOrder[(botIdx + i) % turnOrder.length];
            const p = room.players.find(pl => pl.id === pid);
            const isWinner = room.winners.some(w => w.id === pid);
            const hasCards = (p?.hand?.length ?? 0) > 0;
            if (!playedIds.has(pid) && !isWinner && hasCards) {
                result.push(pid);
            }
        }

        return result;
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
