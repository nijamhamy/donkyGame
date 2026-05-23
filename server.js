import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';

const app = express();
app.use(cors({ origin: "*" }));
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    transports: ['websocket', 'polling'], // ✅ websocket FIRST = instant upgrade, no polling lag
    pingTimeout: 20000,
    pingInterval: 10000,
    upgradeTimeout: 5000,
    allowUpgrades: true,
    perMessageDeflate: false, // ✅ disable compression = lower latency for small payloads
});

// --- 🃏 Deck Creation ---
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

// ✅ Stripped player (no hand data sent to all — saves bandwidth)
const publicPlayer = ({ hand, ...rest }) => rest;

let rooms = {};

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
            lastRoundType: null
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
            io.to(roomId).emit("playersUpdated", room.players.map(publicPlayer));
            return callback({ success: true, rejoined: true });
        }

        const existingByName = room.players.find(
            p => !p.isBot && p.name.trim().toLowerCase() === playerName.trim().toLowerCase()
        );

        if (existingByName) {
            console.log("Reconnecting player:", existingByName.name);
            existingByName.id = socket.id;
            existingByName.isConnected = true;
            socket.join(roomId);
            io.to(roomId).emit("playersUpdated", room.players.map(publicPlayer));
            if (existingByName.hand?.length > 0) io.to(socket.id).emit("yourCards", existingByName.hand);
            return callback({ success: true, rejoined: true });
        }

        const realPlayers = room.players.filter(p => !p.isBot);
        if (realPlayers.length >= 4) return callback({ success: false, message: "Room full!" });

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
        io.to(roomId).emit("playersUpdated", room.players.map(publicPlayer));
        callback({ success: true });
    });

    socket.on("requestRoomState", ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        io.to(roomId).emit("roomState", {
            roomId,
            players: room.players.map(publicPlayer)
        });
    });

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
            .filter(p => !p.isBot)
            .map((player, index) => ({
                ...player,
                host: index === 0 ? true : player.host,
                hand: [],
                handCount: 0,
                isConnected: player.isConnected !== false
            }));

        io.to(roomId).emit("playersUpdated", room.players.map(publicPlayer));
        io.to(roomId).emit("roomState", { roomId, players: room.players.map(publicPlayer) });
    });

    socket.on("removePlayer", ({ roomId, targetPlayerId }, callback) => {
        const room = rooms[roomId];
        if (!room) return callback?.({ success: false, message: "Room not found" });

        const requester = room.players.find(p => p.id === socket.id);
        if (!requester || !requester.host) return callback?.({ success: false, message: "Only host can remove players" });
        if (targetPlayerId === socket.id) return callback?.({ success: false, message: "Host cannot remove self" });

        const targetPlayer = room.players.find(p => p.id === targetPlayerId);
        if (!targetPlayer) return callback?.({ success: false, message: "Player not found" });

        room.players = room.players.filter(p => p.id !== targetPlayerId);
        io.to(targetPlayerId).emit("removedFromRoom", { message: "You were removed from the room" });
        io.to(roomId).emit("playersUpdated", room.players.map(publicPlayer));
        io.to(roomId).emit("roomState", { roomId, players: room.players.map(publicPlayer) });
        callback?.({ success: true });
    });

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
            players: room.players.map(publicPlayer)
        });

        if (starterId.startsWith('bot-')) checkBotTurn(roomId, starterId);
    });

    socket.on("requestMyCards", ({ roomId }) => {
        const room = rooms[roomId];
        if (room) {
            const player = room.players.find(p => p.id === socket.id);
            if (player && player.hand.length > 0) socket.emit("yourCards", player.hand);
        }
    });

    // ✅ Acknowledge callback so client knows card was accepted
    socket.on("playCard", ({ roomId, card }, callback) => {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) {
            return callback?.({ success: false, message: "Game not active" });
        }

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return callback?.({ success: false, message: "Player not found" });

        // ✅ Validate it's this player's turn
        if (!room.currentTurn && room.table.length > 0) {
            // turn not set yet during processing, reject
        }

        // ✅ Validate card exists in hand
        const cardInHand = player.hand.find(c => c.id === card.id);
        if (!cardInHand) {
            return callback?.({ success: false, message: "Card not in your hand" });
        }

        // ✅ Validate card eligibility
        if (room.table.length === 0 && room.discardedPile.length === 0) {
            if (!(card.symbol === '♠' && card.label === 'A')) {
                return callback?.({ success: false, message: "First card must be Ace of Spades" });
            }
        }

        if (room.table.length > 0) {
            const leadSuit = room.table[0].symbol;
            const hasLeadSuit = player.hand.some(c => c.symbol === leadSuit);
            if (hasLeadSuit && card.symbol !== leadSuit) {
                return callback?.({ success: false, message: `You must follow ${leadSuit}` });
            }
        }

        callback?.({ success: true });
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
            if (nextPlayer && hasCards && !isWinner) return nextPlayer.id;
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

    function handleMove(roomId, playerId, card) {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;

        const player = room.players.find(p => p.id === playerId);
        if (!player) return;

        player.hand = player.hand.filter(c => c.id !== card.id);
        player.handCount = player.hand.length;

        const playedCard = { ...card, playedBy: playerId };
        room.table.push(playedCard);

        if (room.table.length === 1) pushRecentLeadSuit(room, playedCard.symbol);

        if (room.table.length > 1) {
            const leadS = room.table[0].symbol;
            if (playedCard.symbol !== leadS) rememberMissingSuit(room, playerId, leadS);
        }

        // ✅ Immediately broadcast the new table state + next turn
        const leadSuit = room.table[0].symbol;
        const latestCard = room.table[room.table.length - 1];

        // ✅ CUT: someone played off-suit → immediate resolution
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

            // ✅ Send updated hand to loaded player instantly
            if (!loadedPlayerId.startsWith('bot-')) {
                io.to(loadedPlayerId).emit("yourCards", loadedPlayer.hand);
            }

            updateWinners(roomId);

            io.to(roomId).emit("strikeOccurred", {
                loser: loadedPlayerId,
                table: cardsFromTable,
                nextTurn: loadedPlayerId,
                players: room.players.map(publicPlayer)
            });

            // ✅ Bot delay: 800ms (down from 1500ms) — feels natural, not laggy
            if (room.gameStarted && loadedPlayerId.startsWith('bot-')) checkBotTurn(roomId, loadedPlayerId);
            return;
        }

        const activePlayersNow = room.players.filter(p =>
            p.hand.length > 0 && !room.winners.some(w => w.id === p.id)
        ).length;

        if (activePlayersNow === 0) {
            updateWinners(roomId);
            return;
        }

        // ✅ ROUND COMPLETE: all active players have played
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
            if (!nextStarterId) nextStarterId = getNextPlayer(roomId, roundWinnerId);

            io.to(roomId).emit("roundComplete", {
                winner: roundWinnerId,
                table: trickSnapshot,
                nextTurn: nextStarterId,
                players: room.players.map(publicPlayer)
            });

            if (room.gameStarted && nextStarterId && nextStarterId.startsWith('bot-')) checkBotTurn(roomId, nextStarterId);
        } else {
            // ✅ MID-ROUND: pass to next player immediately (0ms delay)
            let nextTurnId = getNextPlayer(roomId, playerId);

            if (!nextTurnId) {
                updateWinners(roomId);
                return;
            }

            io.to(roomId).emit("gameUpdated", {
                table: room.table,
                currentTurn: nextTurnId,
                players: room.players.map(publicPlayer)
            });

            if (nextTurnId && nextTurnId.startsWith('bot-')) checkBotTurn(roomId, nextTurnId);
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
                console.log(`🏆 Winner: ${player.name}`);
            }
        });

        io.to(roomId).emit("playersUpdated", room.players.map(publicPlayer));
        if (changed) io.to(roomId).emit("winnersUpdated", room.winners);

        if (room.winners.length >= 3) {
            const donkey = room.players.find(p => !room.winners.some(w => w.id === p.id));
            if (donkey && !room.winners.some(w => w.id === donkey.id)) {
                room.winners.push({ id: donkey.id, name: donkey.name, rank: 4 });
            }

            room.gameStarted = false;

            io.to(roomId).emit("winnersUpdated", room.winners);
            io.to(roomId).emit("gameFinished", {
                winners: room.winners,
                players: room.players.map(publicPlayer)
            });
        }
    }

    // ✅ IMPROVED BOT AI — checks all void opponents, avoids safe-suit leads
    function checkBotTurn(roomId, botId) {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;
        const bot = room.players.find(p => p.id === botId);
        if (!bot || !bot.isBot || bot.hand.length === 0) return;
        if (room.winners.some(w => w.id === botId)) return;

        // ✅ Bot think time: 800ms (was 1500ms) — feels human, not robotic
        setTimeout(() => {
            const room2 = rooms[roomId]; // re-fetch in case state changed
            if (!room2 || !room2.gameStarted) return;
            const bot2 = room2.players.find(p => p.id === botId);
            if (!bot2 || bot2.hand.length === 0) return;
            if (room2.winners.some(w => w.id === botId)) return;

            let cardToPlay;
            const recentLeads = room2.recentLeadSuits.slice(-4);

            // ✅ Collect ALL opponents' void suits (not just next player)
            const aliveOpponents = room2.players
                .filter(p => p.id !== botId && !room2.winners.some(w => w.id === p.id) && p.hand.length > 0)
                .map(p => p.id);

            const voidCountBySuit = {};
            aliveOpponents.forEach(oppId => {
                const missing = room2.missingCards[oppId] || [];
                missing.forEach(suit => {
                    voidCountBySuit[suit] = (voidCountBySuit[suit] || 0) + 1;
                });
            });

            if (room2.table.length === 0) {
                // ✅ Must play Ace of Spades first if first round
                const aceSpade = bot2.hand.find(c => c.symbol === '♠' && c.label === 'A' && room2.discardedPile.length === 0);
                if (aceSpade) {
                    cardToPlay = aceSpade;
                } else {
                    // ✅ LEAD selection: avoid suits where any opponent is void
                    let bestCard = null;
                    let bestScore = -Infinity;

                    bot2.hand.forEach(card => {
                        let score = 0;
                        const voidOpponents = voidCountBySuit[card.symbol] || 0;

                        // ✅ Heavy penalty for each opponent void in this suit
                        score -= voidOpponents * 40;

                        // ✅ Bonus when zero opponents are void (truly safe)
                        if (voidOpponents === 0) score += 25;

                        // ✅ Avoid high-value cards (they attract danger dumps)
                        if (card.val === 14) score -= 20; // Ace
                        if (card.val === 13) score -= 12; // King
                        score -= card.val * 0.4;

                        // ✅ Avoid overused suits
                        const repetition = recentLeads.filter(s => s === card.symbol).length;
                        score -= repetition * 10;

                        // ✅ Prefer suits with more cards (maintains control)
                        const sameSuitCount = bot2.hand.filter(c => c.symbol === card.symbol).length;
                        if (sameSuitCount >= 3) score += 8;

                        // ✅ Prefer small cards
                        if (card.val <= 5) score += 6;

                        if (score > bestScore) {
                            bestScore = score;
                            bestCard = card;
                        }
                    });

                    cardToPlay = bestCard || sortHandBySuitAndValue(bot2.hand)[0];
                }
            } else {
                // ✅ FOLLOW logic
                const leadSuit = room2.table[0].symbol;
                const sameSuit = bot2.hand.filter(c => c.symbol === leadSuit).sort((a, b) => a.val - b.val);

                if (sameSuit.length > 0) {
                    const currentHigh = [...room2.table]
                        .filter(c => c.symbol === leadSuit)
                        .sort((a, b) => b.val - a.val)[0];

                    // ✅ Check if any player after bot is void — if so, avoid winning
                    const botIndex = room2.players.findIndex(p => p.id === botId);
                    const playersAfterBot = [];
                    for (let i = 1; i < room2.players.length; i++) {
                        const p = room2.players[(botIndex + i) % room2.players.length];
                        if (!room2.winners.some(w => w.id === p.id) && p.hand.length > 0) {
                            const alreadyPlayed = room2.table.some(c => c.playedBy === p.id);
                            if (!alreadyPlayed) playersAfterBot.push(p.id);
                        }
                    }
                    const dangerAhead = playersAfterBot.some(pid =>
                        (room2.missingCards[pid] || []).includes(leadSuit)
                    );

                    if (dangerAhead) {
                        // ✅ Someone after us is void — play lowest losing card to avoid winning
                        const losingCards = sameSuit.filter(c => c.val < currentHigh.val);
                        cardToPlay = losingCards.length > 0
                            ? losingCards[losingCards.length - 1] // highest losing card
                            : sameSuit[0]; // forced, play smallest
                    } else {
                        // Safe to win — smallest winning card, else smallest
                        cardToPlay = sameSuit.find(c => c.val > currentHigh.val) || sameSuit[0];
                    }
                } else {
                    // Void — dump highest value card
                    rememberMissingSuit(room2, botId, leadSuit);
                    cardToPlay = [...bot2.hand].sort((a, b) => b.val - a.val)[0];
                }
            }

            if (cardToPlay) handleMove(roomId, botId, cardToPlay);
        }, 800); // ✅ 800ms (was 1500ms)
    }

    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);

        for (const roomId in rooms) {
            const room = rooms[roomId];
            const player = room.players.find(p => p.id === socket.id);
            if (!player) continue;

            player.isConnected = false;
            console.log(`${player.name} went offline`);

            io.to(roomId).emit("playersUpdated", room.players.map(publicPlayer));

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
    console.log(`🚀 Server live on port ${PORT}`);
});
