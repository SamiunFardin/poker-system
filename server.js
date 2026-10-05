const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Hand } = require('pokersolver');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static('public'));

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

const LOCAL_IP = getLocalIpAddress();
const PORT = 3000;

let gameState = {
  status: 'IDLE',
  smallBlind: 5,
  bigBlind: 10,
  actionTimerSec: 120, // 2 Minutes timer per action
  currentTurnIndex: -1,
  dealerIndex: 0,
  communityCards: [],
  pot: 0,
  deck: [],
  activeHand: false,
  highestBet: 0,
  serverIp: LOCAL_IP,
  serverPort: PORT
};

let players = [];       
let pendingJoins = [];  
let pendingCash = [];   
let historyLeft = [];   
let turnTimer = null;
let lastHandData = null;

function createDeck() {
  const suits = ['c', 'd', 'h', 's'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  let deck = [];
  for (let s of suits) {
    for (let r of ranks) {
      deck.push({ rank: r === 'T' ? '10' : r, suit: s, raw: r + s });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function broadcastState() {
  io.emit('state_update', {
    gameState,
    players: players.map(p => ({
      playerId: p.playerId,
      name: p.name,
      chips: p.chips,
      currentBet: p.currentBet,
      folded: p.folded,
      isAllIn: p.isAllIn,
      initialBuyIn: p.initialBuyIn,
      totalRebuys: p.totalRebuys,
      cards: gameState.status === 'SHOWDOWN' ? p.cards : [] 
    })),
    pendingJoins,
    pendingCash,
    historyLeft,
    hasLastHand: !!lastHandData
  });

  players.forEach(p => {
    if (p.socketId) {
      io.to(p.socketId).emit('private_state', {
        playerId: p.playerId,
        cards: gameState.activeHand ? p.cards : [],
        isMyTurn: gameState.activeHand && players[gameState.currentTurnIndex]?.playerId === p.playerId,
        chips: p.chips,
        currentBet: p.currentBet,
        folded: p.folded,
        highestBet: gameState.highestBet
      });
    }
  });
}

function startTimer() {
  if (turnTimer) clearInterval(turnTimer);
  let timeLeft = gameState.actionTimerSec;
  
  turnTimer = setInterval(() => {
    io.emit('timer_tick', timeLeft);
    if (timeLeft <= 0) {
      clearInterval(turnTimer);
      handleTimeout();
    }
    timeLeft--;
  }, 1000);
}

function handleTimeout() {
  const currentPlayer = players[gameState.currentTurnIndex];
  if (currentPlayer && !currentPlayer.folded) {
    currentPlayer.folded = true;
    currentPlayer.hasActed = true;
    advanceTurn();
  }
}

function advanceTurn() {
  if (turnTimer) clearInterval(turnTimer);

  const activePlayers = players.filter(p => !p.folded);
  
  if (activePlayers.length === 1) {
    endHandWithWinner(activePlayers[0], 'Everyone else folded.');
    return;
  }

  const playersToAct = players.filter(p => !p.folded && !p.isAllIn);
  const isRoundComplete = playersToAct.every(p => p.hasActed && p.currentBet === gameState.highestBet);

  if (isRoundComplete || playersToAct.length === 0) {
    advanceStage();
  } else {
    let next = (gameState.currentTurnIndex + 1) % players.length;
    while (players[next].folded || players[next].isAllIn) {
      next = (next + 1) % players.length;
    }
    gameState.currentTurnIndex = next;
    startTimer();
    broadcastState();
  }
}

function advanceStage() {
  players.forEach(p => {
    p.currentBet = 0;
    p.hasActed = false;
  });
  gameState.highestBet = 0;

  let stageName = '';

  if (gameState.status === 'PREFLOP') {
    gameState.status = 'FLOP';
    gameState.communityCards.push(gameState.deck.pop(), gameState.deck.pop(), gameState.deck.pop());
    stageName = 'FLOP';
  } else if (gameState.status === 'FLOP') {
    gameState.status = 'TURN';
    gameState.communityCards.push(gameState.deck.pop());
    stageName = 'TURN';
  } else if (gameState.status === 'TURN') {
    gameState.status = 'RIVER';
    gameState.communityCards.push(gameState.deck.pop());
    stageName = 'RIVER';
  } else if (gameState.status === 'RIVER') {
    evaluateShowdown();
    return;
  }

  io.emit('community_cards_popup', {
    stage: stageName,
    cards: gameState.communityCards
  });

  let next = (gameState.dealerIndex + 1) % players.length;
  while (players[next].folded || players[next].isAllIn) {
    next = (next + 1) % players.length;
  }

  gameState.currentTurnIndex = next;
  startTimer();
  broadcastState();
}

function evaluateShowdown() {
  if (turnTimer) clearInterval(turnTimer);
  gameState.status = 'SHOWDOWN';

  const active = players.filter(p => !p.folded);
  
  let solvedHands = active.map(p => {
    let fullHand = [...p.cards.map(c => c.raw), ...gameState.communityCards.map(c => c.raw)];
    return Hand.solve(fullHand);
  });

  let winners = Hand.winners(solvedHands);
  let winningPlayers = [];
  let winnerDesc = winners[0].descr;

  active.forEach((p, idx) => {
    if (winners.includes(solvedHands[idx])) {
      winningPlayers.push(p);
    }
  });

  let share = Math.floor(gameState.pot / winningPlayers.length);
  let winnerNames = winningPlayers.map(w => w.name).join(', ');

  winningPlayers.forEach(p => {
    p.chips += share;
  });

  lastHandData = {
    winners: winnerNames,
    pot: gameState.pot,
    explanation: winnerDesc,
    communityCards: [...gameState.communityCards],
    unfoldedPlayers: active.map(p => ({
      name: p.name,
      cards: [...p.cards]
    }))
  };

  io.emit('hand_settled_popup', {
    winners: winnerNames,
    pot: gameState.pot,
    explanation: winnerDesc
  });

  resetTableToDefault();
}

function endHandWithWinner(winner, explanation) {
  if (turnTimer) clearInterval(turnTimer);
  winner.chips += gameState.pot;

  lastHandData = {
    winners: winner.name,
    pot: gameState.pot,
    explanation: explanation,
    communityCards: [...gameState.communityCards],
    unfoldedPlayers: [{ name: winner.name, cards: [...winner.cards] }]
  };

  io.emit('hand_settled_popup', {
    winners: winner.name,
    pot: gameState.pot,
    explanation: explanation
  });

  resetTableToDefault();
}

function resetTableToDefault() {
  gameState.activeHand = false;
  gameState.status = 'IDLE';
  gameState.communityCards = [];
  gameState.pot = 0;
  gameState.highestBet = 0;
  gameState.currentTurnIndex = -1;

  players.forEach(p => {
    p.cards = [];
    p.currentBet = 0;
    p.folded = false;
    p.isAllIn = false;
    p.hasActed = false;
  });

  broadcastState();
}

io.on('connection', (socket) => {
  broadcastState();

  socket.on('reconnect_player', ({ playerId }) => {
    const existingPlayer = players.find(p => p.playerId === playerId);
    if (existingPlayer) {
      existingPlayer.socketId = socket.id;
      broadcastState();
    }
  });

  socket.on('get_last_hand', () => {
    if (lastHandData) {
      socket.emit('last_hand_data', lastHandData);
    }
  });

  socket.on('request_join', ({ playerId, name, amount }) => {
    if (players.some(p => p.playerId === playerId) || pendingJoins.some(p => p.playerId === playerId)) {
      return;
    }
    pendingJoins.push({ socketId: socket.id, playerId, name, amount: parseFloat(amount) });
    broadcastState();
  });

  socket.on('host_approve_join', (playerId) => {
    const idx = pendingJoins.findIndex(p => p.playerId === playerId);
    if (idx !== -1) {
      const p = pendingJoins.splice(idx, 1)[0];
      players.push({
        socketId: p.socketId,
        playerId: p.playerId,
        name: p.name,
        chips: p.amount,
        initialBuyIn: p.amount,
        totalRebuys: 0,
        currentBet: 0,
        folded: false,
        isAllIn: false,
        hasActed: false,
        cards: []
      });
      broadcastState();
    }
  });

  socket.on('host_reject_join', (playerId) => {
    pendingJoins = pendingJoins.filter(p => p.playerId !== playerId);
    broadcastState();
  });

  socket.on('host_start_hand', () => {
    if (players.length < 2 || gameState.activeHand) return;

    gameState.deck = createDeck();
    gameState.communityCards = [];
    gameState.pot = 0;
    gameState.activeHand = true;
    gameState.status = 'PREFLOP';

    players.forEach(p => {
      p.folded = false;
      p.isAllIn = false;
      p.hasActed = false;
      p.currentBet = 0;
      p.cards = [gameState.deck.pop(), gameState.deck.pop()];
    });

    gameState.dealerIndex = (gameState.dealerIndex + 1) % players.length;
    let sbIndex = (gameState.dealerIndex + 1) % players.length;
    let bbIndex = (gameState.dealerIndex + 2) % players.length;

    players[sbIndex].chips -= gameState.smallBlind;
    players[sbIndex].currentBet = gameState.smallBlind;
    
    players[bbIndex].chips -= gameState.bigBlind;
    players[bbIndex].currentBet = gameState.bigBlind;

    gameState.highestBet = gameState.bigBlind;
    gameState.pot = gameState.smallBlind + gameState.bigBlind;
    
    gameState.currentTurnIndex = (bbIndex + 1) % players.length;

    startTimer();
    broadcastState();
  });

  socket.on('host_cancel_hand', () => {
    if (!gameState.activeHand) return;
    if (turnTimer) clearInterval(turnTimer);

    players.forEach(p => {
      p.chips += p.currentBet;
    });

    resetTableToDefault();
  });

  socket.on('player_action', ({ playerId, action, amount }) => {
    const player = players[gameState.currentTurnIndex];
    if (!player || player.playerId !== playerId) return;

    player.hasActed = true;

    if (action === 'fold') {
      player.folded = true;
    } else if (action === 'call') {
      let callAmt = gameState.highestBet - player.currentBet;
      let actualBet = Math.min(callAmt, player.chips);
      player.chips -= actualBet;
      player.currentBet += actualBet;
      gameState.pot += actualBet;
      if (player.chips === 0) player.isAllIn = true;
    } else if (action === 'raise') {
      let raiseTotal = parseFloat(amount);
      if (raiseTotal > gameState.highestBet && raiseTotal <= (player.chips + player.currentBet)) {
        let additionalChipsNeeded = raiseTotal - player.currentBet;
        player.chips -= additionalChipsNeeded;
        player.currentBet = raiseTotal;
        gameState.pot += additionalChipsNeeded;
        gameState.highestBet = raiseTotal;
        
        players.forEach(p => {
          if (p.playerId !== player.playerId && !p.folded && !p.isAllIn) {
            p.hasActed = false;
          }
        });

        if (player.chips === 0) player.isAllIn = true;
      }
    }

    advanceTurn();
  });

  socket.on('request_cash', ({ playerId, amount }) => {
    pendingCash.push({ playerId, amount: parseFloat(amount) });
    broadcastState();
  });

  socket.on('host_approve_cash', (playerId) => {
    const idx = pendingCash.findIndex(c => c.playerId === playerId);
    if (idx !== -1) {
      const c = pendingCash.splice(idx, 1)[0];
      const p = players.find(pl => pl.playerId === playerId);
      if (p) {
        p.chips += c.amount;
        p.totalRebuys += c.amount;
      }
      broadcastState();
    }
  });

  socket.on('host_kick_player', (playerId) => {
    const idx = players.findIndex(p => p.playerId === playerId);
    if (idx !== -1) {
      const p = players.splice(idx, 1)[0];
      historyLeft.push({ name: p.name, finalChips: p.chips, totalBuyIn: p.initialBuyIn + p.totalRebuys });
      broadcastState();
    }
  });

  socket.on('host_end_game', () => {
    if (turnTimer) clearInterval(turnTimer);
    gameState.status = 'GAME_OVER';
    broadcastState();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://${LOCAL_IP}:${PORT}`);
});