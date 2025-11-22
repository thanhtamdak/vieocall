/**
 * app.js
 * Client-side WebRTC group-call + screen-sharing logic (mesh topology).
 *
 * Signaling: WebSocket to ws://localhost:3000 by default. You can adapt to your signaling server.
 *
 * Major functions:
 *  - joinRoom(): connect to signaling, announce presence, create offers to existing peers.
 *  - handleOffer/Answer/ICE: basic signaling handlers.
 *  - handleNewPeer(peerId, stream): add remote video element.
 *  - shareScreen()/stopSharing(): replace outgoing video track on all RTCPeerConnections.
 *
 * NOTE: This is meant as a full-featured client skeleton. In production use TURN server and secure signaling (wss).
 */

const SIGNALING_URL = 'ws://192.168.1.14:3000';
 // adjust to your signaling server
const localIdLabel = document.getElementById('localId');
const connStatus = document.getElementById('connStatus');

const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const leaveBtn2 = document.getElementById('leaveBtn2');
const roomInput = document.getElementById('roomId');

const videosContainer = document.getElementById('videos');

const toggleAudioBtn = document.getElementById('toggleAudio');
const toggleVideoBtn = document.getElementById('toggleVideo');
const shareScreenBtn = document.getElementById('shareScreen');
const stopShareBtn = document.getElementById('stopShare');

let localStream = null;
let currentVideoTrack = null;
let screenStream = null;

let ws = null;
let localId = null;
let roomId = null;

/**
 * peers: map of peerId => {
 *   pc: RTCPeerConnection,
 *   remoteEl: HTMLDivElement (tile),
 *   audioEl: <audio> or <video>,
 * }
 */
const peers = {};

const ICE_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

/* -------------------- UI helpers -------------------- */
function setStatus(s){ connStatus.textContent = s; }
function setLocalId(id){ localId = id; localIdLabel.textContent = id; }
function createVideoTile(id, label, muted = false){
  const wrapper = document.createElement('div');
  wrapper.className = 'video-tile';
  wrapper.id = `tile-${id}`;
  const v = document.createElement('video');
  v.autoplay = true;
  v.playsInline = true;
  v.muted = muted;
  v.id = `video-${id}`;
  wrapper.appendChild(v);
  const lbl = document.createElement('div');
  lbl.className = 'tile-label';
  lbl.textContent = label || id;
  wrapper.appendChild(lbl);

  // click to spotlight (fullscreen)
  wrapper.addEventListener('click', ()=> {
    if (v.requestFullscreen) v.requestFullscreen();
  });

  videosContainer.appendChild(wrapper);
  return { wrapper, videoEl: v, labelEl: lbl };
}
function removeVideoTile(id){
  const el = document.getElementById(`tile-${id}`);
  if(el) el.remove();
}

/* -------------------- Signaling helpers -------------------- */

/**
 * Simple WebSocket signaling protocol (JSON messages):
 * { type: 'join', room, id }
 * { type: 'peers', peers: [id1,id2,...] }      // server -> new client: existing peers
 * { type: 'new-peer', id }                    // server -> others: someone joined
 * { type: 'offer', from, to, sdp }
 * { type: 'answer', from, to, sdp }
 * { type: 'ice', from, to, candidate }
 * { type: 'leave', id }
 *
 * Your server should implement these minimal messages.
 */

function connectSignaling(){
  ws = new WebSocket(SIGNALING_URL);
  ws.onopen = () => {
    setStatus('Signaling connected');
    // generate simple random id if server doesn't provide you one
    setLocalId(makeId(6));
  };
  ws.onmessage = async (msgEv) => {
    try{
      const msg = JSON.parse(msgEv.data);
      if(msg.type === 'peers'){
        // list of existing peers in room
        for(const peerId of msg.peers){
          if(peerId === localId) continue;
          await createPeerAndOffer(peerId);
        }
      } else if(msg.type === 'new-peer'){
        const peerId = msg.id;
        if(peerId === localId) return;
        // Wait for them to appear in peers list; here we will create an offer to them:
        await createPeerAndOffer(peerId);
      } else if(msg.type === 'offer'){
        await handleOffer(msg);
      } else if(msg.type === 'answer'){
        await handleAnswer(msg);
      } else if(msg.type === 'ice'){
        await handleRemoteIce(msg);
      } else if(msg.type === 'leave'){
        handlePeerLeave(msg.id);
      }
    }catch(e){
      console.warn('Invalid signal', e);
    }
  };
  ws.onclose = ()=> setStatus('Signaling disconnected');
  ws.onerror = (e)=> console.error('WS error', e);
}

function sendSignal(obj){
  if(!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(obj));
}

/* -------------------- Room lifecycle -------------------- */

joinBtn.addEventListener('click', async ()=>{
  if(!roomInput.value.trim()) return alert('Nhập Room ID');
  roomId = roomInput.value.trim();
  // get local stream
  try{
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  }catch(e){
    alert('Không thể truy cập camera/micro: ' + e.message);
    return;
  }
  // show local video tile
  const tile = createVideoTile('local', 'Bạn (local)', true);
  tile.videoEl.srcObject = localStream;
  currentVideoTrack = localStream.getVideoTracks()[0];

  // connect signaling and join
  connectSignaling();

  ws.addEventListener('open', ()=>{
    // inform server we join
    sendSignal({ type:'join', room: roomId, id: localId });
    setStatus('Trong phòng: ' + roomId);
    // enable leave buttons
    leaveBtn.disabled = false;
    leaveBtn2.disabled = false;
    toggleAudioBtn.disabled = false;
    toggleVideoBtn.disabled = false;
    shareScreenBtn.disabled = false;
  });
});

leaveBtn.addEventListener('click', leaveRoom);
leaveBtn2.addEventListener('click', leaveRoom);

function leaveRoom(){
  // close peer connections
  Object.keys(peers).forEach(pid => {
    try{ peers[pid].pc.close(); }catch(e){}
    removeVideoTile(pid);
    delete peers[pid];
  });
  // stop local tracks
  if(localStream){
    localStream.getTracks().forEach(t=>t.stop());
    localStream = null;
  }
  // stop screen
  if(screenStream){
    screenStream.getTracks().forEach(t=>t.stop());
    screenStream = null;
  }
  // notify server
  if(ws && ws.readyState === WebSocket.OPEN){
    sendSignal({ type:'leave', id: localId, room: roomId });
    ws.close();
  }
  setStatus('Offline');
  localIdLabel.textContent = '—';
  // remove local tile
  removeVideoTile('local');
  leaveBtn.disabled = true;
  leaveBtn2.disabled = true;
  toggleAudioBtn.disabled = true;
  toggleVideoBtn.disabled = true;
  shareScreenBtn.disabled = true;
  stopShareBtn.disabled = true;
}

/* -------------------- Peer connection management -------------------- */

async function createPeerAndOffer(peerId){
  if(peers[peerId]) return; // already exists
  const pc = new RTCPeerConnection(ICE_CONFIG);
  setupPeerConnectionEvents(pc, peerId);

  // add local tracks
  if(localStream){
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  peers[peerId] = { pc, remoteEl: null };

  // create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal({ type:'offer', from: localId, to: peerId, sdp: pc.localDescription });
}

async function handleOffer(msg){
  const { from: peerId, sdp } = msg;
  if(peers[peerId]) {
    // if already exists, ignore or recreate
    console.warn('Offer from existing peer - ignoring', peerId);
  } else {
    const pc = new RTCPeerConnection(ICE_CONFIG);
    setupPeerConnectionEvents(pc, peerId);

    // add local tracks
    if(localStream){
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    peers[peerId] = { pc, remoteEl: null };

    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendSignal({ type:'answer', from: localId, to: peerId, sdp: pc.localDescription });
  }
}

async function handleAnswer(msg){
  const { from: peerId, sdp } = msg;
  const rec = peers[peerId];
  if(!rec) return console.warn('Answer from unknown peer', peerId);
  await rec.pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

async function handleRemoteIce(msg){
  const { from: peerId, candidate } = msg;
  const rec = peers[peerId];
  if(rec && rec.pc){
    try { await rec.pc.addIceCandidate(new RTCIceCandidate(candidate)); }
    catch(e){ console.warn('addIceCandidate failed', e); }
  }
}

function handlePeerLeave(peerId){
  if(peers[peerId]){
    try{ peers[peerId].pc.close(); }catch(e){}
    removeVideoTile(peerId);
    delete peers[peerId];
  }
}

function setupPeerConnectionEvents(pc, peerId){
  // send ICE to remote via signaling
  pc.onicecandidate = (ev) => {
    if(ev.candidate){
      sendSignal({ type:'ice', from: localId, to: peerId, candidate: ev.candidate });
    }
  };

  // when remote track arrives
  pc.ontrack = (ev) => {
    // add track stream to video tile (use first stream)
    const stream = ev.streams && ev.streams[0] ? ev.streams[0] : new MediaStream(ev.track ? [ev.track] : []);
    handleNewPeer(peerId, stream);
  };

  pc.onconnectionstatechange = () => {
    if(pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed'){
      handlePeerLeave(peerId);
    }
  };
}

/* -------------------- handleNewPeer: add remote video element -------------------- */
function handleNewPeer(peerId, stream){
  // if tile exists, reuse
  if(peers[peerId].remoteEl){
    peers[peerId].remoteEl.videoEl.srcObject = stream;
    return;
  }
  const tile = createVideoTile(peerId, 'Peer: ' + peerId, false);
  tile.videoEl.srcObject = stream;
  peers[peerId].remoteEl = tile;
}

/* -------------------- Toggle audio / video -------------------- */
toggleAudioBtn.addEventListener('click', ()=>{
  if(!localStream) return;
  const audioTracks = localStream.getAudioTracks();
  if(audioTracks.length === 0) return;
  audioTracks.forEach(t => t.enabled = !t.enabled);
  toggleAudioBtn.textContent = audioTracks[0].enabled ? '🎤 Tắt Mic' : '🎙️ Mic Tắt';
});

toggleVideoBtn.addEventListener('click', ()=>{
  if(!localStream) return;
  const videoTracks = localStream.getVideoTracks();
  if(videoTracks.length === 0) return;
  videoTracks.forEach(t => t.enabled = !t.enabled);
  toggleVideoBtn.textContent = videoTracks[0].enabled ? '📷 Tắt Camera' : '🚫 Camera Tắt';
});

/* -------------------- Screen sharing: replace outgoing video track -------------------- */
shareScreenBtn.addEventListener('click', async ()=>{
  if(!navigator.mediaDevices.getDisplayMedia) return alert('Trình duyệt không hỗ trợ getDisplayMedia');
  try{
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const screenTrack = screenStream.getVideoTracks()[0];
    // replace track on local preview if any
    replaceOutgoingVideoTrack(screenTrack);
    stopShareBtn.disabled = false;

    // when user stops screen share from browser UI
    screenTrack.onended = () => {
      stopSharing();
    };
  }catch(e){
    console.warn('screen share canceled', e);
  }
});

stopShareBtn.addEventListener('click', stopSharing);

function stopSharing(){
  if(!screenStream) return;
  // stop screen tracks
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  // replace back to camera track
  if(localStream && localStream.getVideoTracks().length > 0){
    replaceOutgoingVideoTrack(localStream.getVideoTracks()[0]);
  }
  stopShareBtn.disabled = true;
}

/**
 * Replace outgoing video track in all RTCPeerConnections
 * Uses RTCRtpSender.replaceTrack()
 */
function replaceOutgoingVideoTrack(newTrack){
  currentVideoTrack = newTrack;
  // update local tile preview if exists
  const localTileVideo = document.getElementById('video-local');
  if(localTileVideo){
    // create a temporary stream for preview
    const tmpStream = new MediaStream();
    // keep audio from localStream if exist
    if(localStream && localStream.getAudioTracks().length) tmpStream.addTrack(localStream.getAudioTracks()[0]);
    if(newTrack) tmpStream.addTrack(newTrack);
    localTileVideo.srcObject = tmpStream;
  }

  // For each peer, find sender for video and replace
  Object.keys(peers).forEach(peerId => {
    const pc = peers[peerId].pc;
    const senders = pc.getSenders ? pc.getSenders() : [];
    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
    if(videoSender){
      videoSender.replaceTrack(newTrack).catch(e => {
        console.warn('replaceTrack failed, fallback to remove/add', e);
        if(newTrack){
          pc.addTrack(newTrack);
        }
      });
    } else if(newTrack){
      // fallback: add track (may create duplicate tracks)
      try{ pc.addTrack(newTrack); }catch(e){ console.warn(e); }
    }
  });
}

/* -------------------- Utility -------------------- */
function makeId(len=6){
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s='';
  for(let i=0;i<len;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}
