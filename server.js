// server.js
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 3000 });
console.log('Signaling server running on ws://localhost:3000');

const rooms = {}; // roomId => Set of sockets

wss.on('connection', ws => {
  ws.id = Math.random().toString(36).substr(2,6);
  ws.roomId = null;

  ws.on('message', msg => {
    let data;
    try { data = JSON.parse(msg); } catch(e){ return; }

    if(data.type === 'join'){
      ws.roomId = data.room;
      if(!rooms[ws.roomId]) rooms[ws.roomId] = new Set();
      // send existing peers to this client
      const peers = Array.from(rooms[ws.roomId]).map(s => s.id);
      ws.send(JSON.stringify({ type:'peers', peers }));
      // notify others
      rooms[ws.roomId].forEach(s => {
        s.send(JSON.stringify({ type:'new-peer', id: ws.id }));
      });
      rooms[ws.roomId].add(ws);
    }

    if(['offer','answer','ice'].includes(data.type)){
      const target = Array.from(rooms[ws.roomId]||[]).find(s => s.id===data.to);
      if(target) target.send(JSON.stringify(data));
    }

    if(data.type==='leave'){
      handleLeave(ws);
    }
  });

  ws.on('close', ()=> handleLeave(ws));
  function handleLeave(ws){
    if(!ws.roomId || !rooms[ws.roomId]) return;
    rooms[ws.roomId].delete(ws);
    rooms[ws.roomId].forEach(s=>{
      s.send(JSON.stringify({ type:'leave', id: ws.id }));
    });
  }
});
