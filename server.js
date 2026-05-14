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
                isConnected: true // ஆன்லைன் ஸ்டேட்டஸ்
            }],
            gameStarted: false,
            table: [],
            winners: [],
            discardedPile: [],
            missingCards: {}
        };
        socket.join(roomId);
        callback(roomId);
    });

    // 2. ரூமில் இணைதல்
    socket.on("joinRoom", ({ roomId, playerName }, callback) => {
        const room = rooms[roomId];
        if (room && room.players.length < 4 && !room.gameStarted) {
            room.players.push({
                id: socket.id,
                name: playerName,
                host: false,
                isBot: false,
                hand: [],
                handCount: 0,
                isConnected: true // ஆன்லைன் ஸ்டேட்டஸ்
            });
            socket.join(roomId);
            // எல்லாருக்கும் பிளேயர் லிஸ்ட் அப்டேட்
            io.to(roomId).emit("playersUpdated", room.players.map(({ hand, ...rest }) => rest));
            callback({ success: true });
        } else {
            callback({ success: false, message: "Room error or full!" });
        }
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
            player.hand = deck.slice(i * 13, (i + 1) * 13).sort((a, b) => b.val - a.val);
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

    // Server.js - மல்டிபிளேயர் லாஜிக்
    function handleMove(roomId, playerId, card) {
        const room = rooms[roomId];
        if (!room) return;

        const player = room.players.find(p => p.id === playerId);
        if (!player) return;

        // 1. பிளேயர் கையில் இருந்து கார்டை நீக்குதல்
        player.hand = player.hand.filter(c => c.id !== card.id);
        player.handCount = player.hand.length;

        const playedCard = { ...card, playedBy: playerId };
        room.table.push(playedCard);

        // கார்டு விளையாடியதை உடனே அனைவருக்கும் தெரிவிக்கவும்
        io.to(roomId).emit("gameUpdated", {
            table: room.table,
            currentTurn: null, // அடுத்த டர்ன் கணக்கிடும் வரை காத்திருக்கவும்
            players: room.players.map(({ hand, ...rest }) => rest)
        });

        setTimeout(() => {
            const leadSuit = room.table[0].symbol;

            // 2. STRIKE LOGIC (வெட்டுதல்): கார்டு சூட் மாறினால்
            if (playedCard.symbol !== leadSuit) {
                // லீட் சூட்டில் அதிக மதிப்புள்ள கார்டு போட்ட பிளேயரை கண்டுபிடித்தல்
                const highestInLead = room.table
                    .filter(c => c.symbol === leadSuit)
                    .sort((a, b) => b.val - a.val)[0];

                const loserId = highestInLead.playedBy; // இவர்தான் தண்டனை கார்டுகளை எடுக்க வேண்டும்
                const loserPlayer = room.players.find(p => p.id === loserId);

                // டேபிளில் உள்ள அனைத்து கார்டுகளையும் அவரிடம் கொடுத்தல்
                loserPlayer.hand.push(...room.table);
                loserPlayer.hand.sort((a, b) => b.val - a.val); // கையில் உள்ள கார்டுகளை வரிசைப்படுத்துதல்
                loserPlayer.handCount = loserPlayer.hand.length;

                io.to(roomId).emit("strikeOccurred", {
                    loser: loserId,
                    table: room.table,
                    nextTurn: loserId, // வெட்டு வாங்கியவரே அடுத்த ஆட்டத்தைத் தொடங்குவார்
                    players: room.players.map(({ hand, ...rest }) => rest)
                });

                // வெட்டு வாங்கியவருக்கு மட்டும் அவரது புதிய கார்டுகளை அனுப்பவும்
                if (!loserPlayer.isBot) io.to(loserId).emit("yourCards", loserPlayer.hand);

                room.table = []; // டேபிளை காலி செய்தல்
                updateWinners(roomId);
                return;
            }

            // 3. ROUND COMPLETE (சுற்று முடிதல்): அனைவரும் கார்டு போட்டு சூட் மாறவில்லை என்றால்
            const activeCount = room.players.filter(p => p.handCount > 0 || !room.winners.some(w => w.id === p.id)).length;

            if (room.table.length === activeCount) {
                const highest = room.table.sort((a, b) => b.val - a.val)[0];
                const roundWinnerId = highest.playedBy;

                io.to(roomId).emit("roundComplete", {
                    winner: roundWinnerId,
                    table: room.table,
                    nextTurn: roundWinnerId,
                    players: room.players.map(({ hand, ...rest }) => rest)
                });

                room.discardedPile.push(...room.table);
                room.table = [];
                updateWinners(roomId);
            } else {
                // அடுத்த பிளேயர் டர்ன்
                let nextTurnId = getNextPlayer(roomId, playerId);
                io.to(roomId).emit("gameUpdated", {
                    table: room.table,
                    currentTurn: nextTurnId,
                    players: room.players.map(({ hand, ...rest }) => rest)
                });
            }
        }, 1000);
    }

    function getNextPlayer(roomId, currentPlayerId) {
        const room = rooms[roomId];
        const playerIndex = room.players.findIndex(p => p.id === currentPlayerId);
        for (let i = 1; i <= 4; i++) {
            const nextIdx = (playerIndex + i) % 4;
            const nextP = room.players[nextIdx];
            if (!room.winners.some(w => w.id === nextP.id)) return nextP.id;
        }
    }

    function updateWinners(roomId) {
        const room = rooms[roomId];
        room.players.forEach(p => {
            if (p.handCount === 0 && !room.winners.some(w => w.id === p.id)) {
                room.winners.push({ id: p.id, name: p.name, rank: room.winners.length + 1 });
                io.to(roomId).emit("playersUpdated", room.players.map(({ hand, ...rest }) => rest));
            }
        });
        if (room.winners.length === 3) {
            const donkey = room.players.find(p => !room.winners.some(w => w.id === p.id));
            if (donkey) room.winners.push({ id: donkey.id, name: donkey.name, rank: 4 });
            room.gameStarted = false;
            io.to(roomId).emit("gameFinished", { winners: room.winners });
        }
    }

    function checkBotTurn(roomId, botId) {
        const room = rooms[roomId];
        if (!room) return;
        const bot = room.players.find(p => p.id === botId);
        if (!bot || !bot.isBot || room.winners.some(w => w.id === botId)) return;

        setTimeout(() => {
            if (!room.table) return;
            let cardToPlay;
            if (room.table.length === 0) {
                const aceSpade = bot.hand.find(c => c.symbol === '♠' && c.label === 'A' && room.discardedPile.length === 0);
                cardToPlay = aceSpade || bot.hand[bot.hand.length - 1];
            } else {
                const leadSuit = room.table[0].symbol;
                const sameSuitCards = bot.hand.filter(c => c.symbol === leadSuit).sort((a, b) => b.val - a.val);
                cardToPlay = sameSuitCards.length > 0 ? sameSuitCards[0] : bot.hand[0];
            }
            if (cardToPlay) handleMove(roomId, botId, cardToPlay);
        }, 1500);
    }

    // --- 🚨 NEW: CONNECTION TRACKING LOGIC ---
    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);
        for (const roomId in rooms) {
            const room = rooms[roomId];
            const playerIndex = room.players.findIndex(p => p.id === socket.id);
            if (playerIndex !== -1) {
                // பிளேயரை ஆஃப்லைனில் மாற்றுதல்
                room.players[playerIndex].isConnected = false;

                // மற்ற பிளேயர்களுக்கு இந்த தகவலை அனுப்புதல்
                io.to(roomId).emit("playersUpdated", room.players.map(({ hand, ...rest }) => rest));

                // ஒருவேளை எல்லாரும் டிஸ்கனெக்ட் ஆனால் ரூமை நீக்கலாம் (Optional)
                const anyOnline = room.players.some(p => p.isConnected && !p.isBot);
                if (!anyOnline) {
                    console.log(`Closing empty room: ${roomId}`);
                    delete rooms[roomId];
                }
                break;
            }
        }
    });
});

// பழைய வரியை நீக்கிவிட்டு இதைச் சேர்க்கவும்
const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server is live and running on port ${PORT}`);
});