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

    // Server.js - மல்டிபிளேயர் கேம் லாஜிக்

    function handleMove(roomId, playerId, card) {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;

        const player = room.players.find(p => p.id === playerId);
        if (!player) return;

        // 1. பிளேயர் கையில் இருந்து கார்டை நீக்குதல்
        player.hand = player.hand.filter(c => c.id !== card.id);
        player.handCount = player.hand.length;

        const playedCard = { ...card, playedBy: playerId };
        room.table.push(playedCard);

        // AI Memory: யார் எந்த சூட்டை வெட்டினார்கள் என்று குறித்துக்கொள்ளும்
        if (room.table.length > 1) {
            const leadS = room.table[0].symbol;
            if (playedCard.symbol !== leadS) {
                if (!room.missingCards[playerId]) room.missingCards[playerId] = [];
                if (!room.missingCards[playerId].includes(leadS)) {
                    room.missingCards[playerId].push(leadS);
                }
            }
        }

        // கார்டு விளையாடியதை உடனே அப்டேட் செய்தல்
        io.to(roomId).emit("gameUpdated", {
            table: room.table,
            currentTurn: null, // அடுத்த லாஜிக் முடியும் வரை காத்திருக்கவும்
            players: room.players.map(({ hand, ...rest }) => rest)
        });

        setTimeout(() => {
            if (room.table.length === 0) return; // ரூம் ரீசெட் ஆகியிருந்தால் தடுக்க
            const leadSuit = room.table[0].symbol;

            // --- 🚨 STRIKE LOGIC (வெட்டுதல்) ---
            if (playedCard.symbol !== leadSuit) {
                // லீட் சூட்டில் அதிக மதிப்புள்ள கார்டு போட்டவரை கண்டுபிடித்தல்
                const highestInLead = room.table
                    .filter(c => c.symbol === leadSuit)
                    .sort((a, b) => b.val - a.val)[0];

                const loserId = highestInLead.playedBy;
                const loserPlayer = room.players.find(p => p.id === loserId);

                // 🚨 முக்கிய திருத்தம்: டேபிள் கார்டுகளை பிளேயரின் உண்மையான 'hand' அரே-ல் சேர்த்தல்
                const tableCards = [...room.table];
                loserPlayer.hand = [...loserPlayer.hand, ...tableCards];
                loserPlayer.hand.sort((a, b) => b.val - a.val); // பெரிய கார்டு முதலில்
                loserPlayer.handCount = loserPlayer.hand.length;

                // அனிமேஷனுக்காக ஸ்ட்ரைக் ஈவென்ட் அனுப்புதல்
                io.to(roomId).emit("strikeOccurred", {
                    loser: loserId,
                    table: room.table,
                    nextTurn: loserId, // வெட்டு வாங்கியவரே மீண்டும் தொடங்க வேண்டும்
                    players: room.players.map(({ hand, ...rest }) => rest)
                });

                // 🚨 மிக முக்கியம்: வெட்டு வாங்கிய பிளேயருக்கு அவரது புதிய கையை (Hand) உடனடியாக அனுப்புதல்
                if (!loserPlayer.isBot) {
                    io.to(loserId).emit("yourCards", loserPlayer.hand);
                }

                room.table = []; // டேபிளைக் காலி செய்தல்
                updateWinners(roomId);

                // வெட்டு வாங்கியவர் பாட் (Bot) என்றால் விளையாடச் சொல்லவும்
                if (loserId.startsWith('bot-')) checkBotTurn(roomId, loserId);
                return;
            }

            // --- 🚨 FIX: ROUND COMPLETE (சுற்று முடிதல் கணக்கீடு) ---
            // 'activeCount' என்பது கார்டுகள் முடித்து வெளியேறியவர்களைத் தவிா்த்து கணக்கிட வேண்டும்
            const activePlayersNow = room.players.filter(p => p.handCount > 0 || !room.winners.some(w => w.id === p.id)).length;

            if (room.table.length === activePlayersNow) {
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

                if (roundWinnerId.startsWith('bot-')) checkBotTurn(roomId, roundWinnerId);
            } else {
                // அடுத்த பிளேயர் டர்ன்
                let nextTurnId = getNextPlayer(roomId, playerId);
                io.to(roomId).emit("gameUpdated", {
                    table: room.table,
                    currentTurn: nextTurnId,
                    players: room.players.map(({ hand, ...rest }) => rest)
                });

                if (nextTurnId.startsWith('bot-')) checkBotTurn(roomId, nextTurnId);
            }
        }, 1200);
    }

    // 1. அடுத்த பிளேயரை முடிவு செய்யும் பங்க்ஷன் (கார்டு முடித்தவர்களைத் தவிர்க்கும்)
    function getNextPlayer(roomId, currentPlayerId) {
        const room = rooms[roomId];
        const playerIndex = room.players.findIndex(p => p.id === currentPlayerId);

        for (let i = 1; i <= 4; i++) {
            const nextIdx = (playerIndex + i) % 4;
            const nextP = room.players[nextIdx];

            // 🚨 கார்டு இன்னும் கையில் வைத்திருப்பவரை (handCount > 0) 
            // மற்றும் இன்னும் வெற்றி பெறாதவரை மட்டுமே அடுத்த பிளேயராகத் தேர்ந்தெடுக்க வேண்டும்
            if (nextP.handCount > 0 && !room.winners.some(w => w.id === nextP.id)) {
                return nextP.id;
            }
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

    // 2. AI BOT TACTICAL LOGIC (பாதுகாப்பு விதிகள்)
    function checkBotTurn(roomId, botId) {
        const room = rooms[roomId];
        if (!room || !room.gameStarted) return;
        const bot = room.players.find(p => p.id === botId);
        if (!bot || !bot.isBot || room.winners.some(w => w.id === botId)) return;

        setTimeout(() => {
            let cardToPlay;
            const turnOrder = room.players.map(p => p.id);
            const nextPlayerId = turnOrder[(turnOrder.indexOf(botId) + 1) % 4];

            if (room.table.length === 0) {
                // HIGH-VALUE PROTECTION:
                // அடுத்த பிளேயரிடம் எந்த சூட் இல்லை (Missing) என்பதைப் பார்த்து, 
                // அந்த சூட்டில் உள்ள பெரிய கார்டுகளை (A, K) தற்காத்துக் கொள்ளும்.
                const nextMissing = room.missingCards[nextPlayerId] || [];

                // அடுத்த பிளேயரிடம் இருக்கும் என நம்பப்படும் "Safe" சூட்டைத் தேடுதல்
                let safeCards = bot.hand.filter(c => !nextMissing.includes(c.symbol));

                if (safeCards.length > 0) {
                    // பாதுகாப்பான சூட்டில் சிறிய கார்டைப் போட்டு ஆட்டத்தைத் தொடங்கும்
                    cardToPlay = safeCards.sort((a, b) => a.val - b.val)[0];
                } else {
                    // வேறு வழியில்லை என்றால் மிகச்சிறிய கார்டைப் போடும்
                    cardToPlay = bot.hand.sort((a, b) => a.val - b.val)[0];
                }

                // ஆட்டத்தின் ஆரம்பம் எனில் Ace of Spades கட்டாயம்
                const aceSpade = bot.hand.find(c => c.symbol === '♠' && c.label === 'A' && room.discardedPile.length === 0);
                if (aceSpade) cardToPlay = aceSpade;

            } else {
                const leadSuit = room.table[0].symbol;
                const sameSuit = bot.hand.filter(c => c.symbol === leadSuit).sort((a, b) => a.val - b.val);

                if (sameSuit.length > 0) {
                    const currentHigh = [...room.table].filter(c => c.symbol === leadSuit).sort((a, b) => b.val - a.val)[0];
                    // தன்னிடம் வெல்லும் கார்டு (A/K) இருந்தால் அதைப் போட்டு தப்பிக்கும்
                    cardToPlay = sameSuit.find(c => c.val > currentHigh.val) || sameSuit[0];
                } else {
                    // வெட்டுவதற்கு தன்னிடம் உள்ள மிகப்பெரிய கார்டைப் பயன்படுத்தும்
                    cardToPlay = bot.hand.sort((a, b) => b.val - a.val)[bot.hand.length - 1];
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