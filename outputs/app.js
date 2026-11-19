(() => {
  const $ = (id) => document.getElementById(id);
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const state = {
    room: '', id: '', name: '', key: null, cursor: 0, timer: null,
    pc: null, stream: null, remoteStream: null, pollBusy: false,
    queuedCandidates: [], callActive: false, audio: true, video: true,
    peerId: null, peerName: null
  };
  const entry = $('entry');
  const app = $('app');
  const form = $('joinForm');
  const input = $('messageInput');
  const sendButton = $('sendButton');
  const roomInput = $('roomInput');
  const secretInput = $('secretInput');
  const nameInput = $('nameInput');
  let toastTimer;

  function getSessionId() {
    try {
      let id = sessionStorage.getItem('quietline_session');
      if (!id) { id = crypto.randomUUID(); sessionStorage.setItem('quietline_session', id); }
      return id;
    } catch (_) { return crypto.randomUUID(); }
  }

  function loadName() {
    try { return localStorage.getItem('quietline_name') || ''; }
    catch (_) { return ''; }
  }

  function saveName(name) {
    try { localStorage.setItem('quietline_name', name); } catch (_) { /* storage may be disabled */ }
  }

  function safeRoom(raw) {
    return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  }

  function initials(name) {
    return (name || 'G').trim().slice(0, 1).toUpperCase();
  }

  function timeLabel(t) {
    return new Date((t || Date.now() / 1000) * 1000).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
  }

  async function deriveKey(secret, room) {
    const material = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      {name:'PBKDF2', salt:enc.encode('quietline-v1:' + room), iterations:310000, hash:'SHA-256'},
      material, {name:'AES-GCM', length:256}, false, ['encrypt', 'decrypt']
    );
  }

  function b64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
  function unb64(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }

  async function seal(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({name:'AES-GCM', iv}, state.key, enc.encode(text));
    return {iv:b64(iv), data:b64(data), v:1};
  }

  async function open(box) {
    const clear = await crypto.subtle.decrypt({name:'AES-GCM', iv:unb64(box.iv)}, state.key, unb64(box.data));
    return dec.decode(clear);
  }

  nameInput.value = loadName();
  state.id = getSessionId();
  const linkedRoom = safeRoom(new URLSearchParams(location.search).get('room') || '');
  if (linkedRoom) roomInput.value = linkedRoom;

  $('generateRoom').addEventListener('click', () => {
    const roomBytes = crypto.getRandomValues(new Uint8Array(6));
    const phraseBytes = crypto.getRandomValues(new Uint8Array(18));
    roomInput.value = 'room-' + Array.from(roomBytes, x => x.toString(16).padStart(2, '0')).join('');
    secretInput.value = Array.from(phraseBytes, x => x.toString(16).padStart(2, '0')).join('');
    secretInput.type = 'text';
    $('toggleSecret').textContent = 'Hide';
    $('toggleSecret').setAttribute('aria-pressed', 'true');
    toast('Room details generated. Share the phrase separately from the invite link.');
  });

  $('toggleSecret').addEventListener('click', () => {
    const show = secretInput.type === 'password';
    secretInput.type = show ? 'text' : 'password';
    $('toggleSecret').textContent = show ? 'Hide' : 'Show';
    $('toggleSecret').setAttribute('aria-pressed', String(show));
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const room = safeRoom(roomInput.value);
    const secret = secretInput.value;
    const name = nameInput.value.trim().slice(0, 32);
    if (name.length < 1) { toast('Add a display name to join.'); nameInput.focus(); return; }
    if (room.length < 2 || secret.length < 10) { toast('Use a room name and a phrase of at least 10 characters.'); return; }
    if (!crypto.subtle) { toast('Secure encryption requires localhost or HTTPS.'); return; }

    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.textContent = 'Preparing your private room…';
    try {
      state.room = room;
      state.name = name;
      saveName(name);
      roomInput.value = room;
      state.key = await deriveKey(secret, room);
      secretInput.value = '';
      $('roomName').textContent = room;
      $('youName').textContent = name;
      $('youAvatar').textContent = initials(name);
      entry.classList.add('hidden');
      app.classList.remove('hidden');
      input.disabled = false;
      input.focus();
      $('connectionStatus').textContent = 'Connecting to your room…';
      const link = new URL(location.href);
      link.searchParams.set('room', room);
      history.replaceState(null, '', link);
      await announce();
      await poll();
      state.timer = setInterval(poll, 1500);
      toast('Room ready. Share the invite link and send the phrase separately.');
    } catch (err) {
      console.error(err);
      toast(relayErrorText(err));
      submit.disabled = false;
      submit.textContent = 'Open private room →';
    }
  });

  async function relay(kind, payload) {
    const res = await fetch('/api/relay', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({room:state.room, sender:state.id, kind, payload})
    });
    if (!res.ok) {
      let detail = {};
      try { detail = await res.json(); } catch (_) { /* response may not be JSON */ }
      const error = new Error(detail.error || 'Relay request failed');
      error.status = res.status;
      throw error;
    }
  }

  function relayErrorText(error) {
    if (error?.status === 429) return 'Too many requests. Wait a minute, then try again.';
    if (error?.status === 503) return error.message.includes('room capacity') ? 'The relay is at room capacity. Try again later.' : 'The relay is busy. Try again shortly.';
    if (error?.status === 413) return 'This message or call setup is too large to send.';
    return 'The relay could not be reached. Check your connection and try again.';
  }

  async function announce() { await relay('presence', {name:state.name}); }

  async function poll() {
    if (state.pollBusy || !state.room) return;
    state.pollBusy = true;
    try {
      await announce();
      const res = await fetch(`/api/poll?room=${encodeURIComponent(state.room)}&since=${state.cursor}`, {cache:'no-store'});
      if (!res.ok) {
        let detail = {};
        try { detail = await res.json(); } catch (_) { /* response may not be JSON */ }
        const error = new Error(detail.error || 'poll failed');
        error.status = res.status;
        throw error;
      }
      const data = await res.json();
      state.cursor = Math.max(state.cursor, data.cursor || 0);
      renderMembers(data.members || []);
      for (const event of data.events || []) if (event.sender !== state.id) await handleEvent(event);
    } catch (error) {
      setStatus(error?.status === 429 ? 'Rate limit reached · wait a minute and retry' : error?.status === 503 ? 'Relay is busy · retrying shortly' : 'Reconnecting to the room…', false);
    } finally { state.pollBusy = false; }
  }

  function renderMembers(members) {
    const others = members.filter(x => x.id !== state.id);
    $('memberCount').textContent = String(others.length + 1).padStart(2, '0');
    $('memberList').replaceChildren();
    $('memberList').append(row(state.name || 'You', 'Here now', initials(state.name), 'avatar-you'));
    for (const member of others) $('memberList').append(row(member.name || 'Guest', 'Online', initials(member.name), 'avatar-contact'));

    const callButton = $('callBtn');
    callButton.disabled = others.length !== 1;
    callButton.title = others.length > 1 ? 'Video calls currently support two people per room' : 'Video call';
    if (others.length === 1) {
      const peer = others[0];
      state.peerId = peer.id;
      state.peerName = peer.name || 'Guest';
      $('contactName').textContent = state.peerName;
      $('callName').textContent = state.peerName;
      $('contactAvatar').textContent = initials(state.peerName);
      $('connectionStatus').innerHTML = '<i></i> Online · room encryption active';
      $('connectionStatus').classList.add('online');
      input.placeholder = 'Write a private message…';
    } else if (others.length > 1) {
      state.peerId = null;
      state.peerName = null;
      $('contactName').textContent = `${others.length} people in this room`;
      $('callName').textContent = 'Group room';
      $('contactAvatar').textContent = String(others.length);
      setStatus('Group chat · video calls are one-to-one for now', false);
    } else {
      state.peerId = null;
      state.peerName = null;
      $('contactName').textContent = 'Waiting for someone';
      $('callName').textContent = 'Your contact';
      $('contactAvatar').textContent = '?';
      setStatus('Share the invite link and phrase', false);
    }
  }

  function row(name, status, initial, klass) {
    const r = document.createElement('div'); r.className = 'member-row';
    const a = document.createElement('div'); a.className = 'avatar ' + klass; a.textContent = initial;
    const d = document.createElement('div');
    const b = document.createElement('strong'); b.textContent = name;
    const s = document.createElement('small'); s.textContent = status;
    d.append(b, s);
    const dot = document.createElement('i'); dot.className = 'online-dot';
    r.append(a, d, dot); return r;
  }

  function setStatus(text, online) {
    $('connectionStatus').textContent = text;
    $('connectionStatus').classList.toggle('online', !!online);
  }

  async function handleEvent(event) {
    if (event.kind === 'ciphertext') {
      try {
        const message = JSON.parse(await open(event.payload));
        addMessage(message.text, false, event.time, message.name || state.peerName || 'Guest');
      } catch (_) { toast('A message could not be decrypted. Check the room phrase.'); }
    } else if (event.kind === 'offer' && Date.now() / 1000 - event.time < 120) {
      await receiveOffer(event.payload);
    } else if (event.kind === 'answer' && state.pc) {
      await state.pc.setRemoteDescription(event.payload);
      for (const candidate of state.queuedCandidates.splice(0)) await state.pc.addIceCandidate(candidate);
    } else if (event.kind === 'candidate' && state.pc) {
      if (state.pc.remoteDescription) await state.pc.addIceCandidate(event.payload);
      else state.queuedCandidates.push(event.payload);
    } else if (event.kind === 'hangup') closeCall(false);
  }

  $('messageForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || !state.key) return;
    sendButton.disabled = true;
    try {
      const box = await seal(JSON.stringify({text, name:state.name}));
      await relay('ciphertext', box);
      addMessage(text, true, Date.now() / 1000, state.name);
      input.value = '';
      input.style.height = 'auto';
    } catch (error) { toast(relayErrorText(error)); }
    finally { sendButton.disabled = !input.value.trim(); }
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 130) + 'px';
    sendButton.disabled = !input.value.trim();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('messageForm').requestSubmit(); }
  });

  function addMessage(text, mine, time, sender) {
    let list = document.querySelector('.msg-list');
    if (!list) {
      $('messages').querySelector('.welcome-message')?.remove();
      list = document.createElement('div'); list.className = 'msg-list'; $('messages').append(list);
    }
    const r = document.createElement('div'); r.className = 'msg-row ' + (mine ? 'mine' : 'theirs');
    const av = document.createElement('div'); av.className = 'msg-avatar'; av.textContent = initials(sender);
    const c = document.createElement('div'); c.className = 'msg-content';
    const meta = document.createElement('div'); meta.className = 'msg-meta'; meta.textContent = mine ? 'You' : (sender || 'Guest');
    const bubble = document.createElement('div'); bubble.className = 'bubble'; bubble.textContent = text;
    const t = document.createElement('div'); t.className = 'bubble-time'; t.textContent = timeLabel(time);
    c.append(meta, bubble, t); r.append(av, c); list.append(r); $('messages').scrollTop = $('messages').scrollHeight;
  }

  function inviteUrl() {
    const url = new URL(location.href);
    url.searchParams.set('room', state.room);
    return url.toString();
  }

  async function copyInvite() {
    const invite = inviteUrl();
    try { await navigator.clipboard.writeText(invite); toast('Invite link copied. Share the encryption phrase separately.'); }
    catch (_) { window.prompt('Copy this invite link. Share the phrase separately:', invite); }
  }

  $('callBtn').addEventListener('click', startCall);
  $('hangupBtn').addEventListener('click', () => closeCall(true));
  $('closeCall').addEventListener('click', () => closeCall(true));

  async function startCall() {
    if (!state.peerId) return;
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({audio:true, video:true});
      $('localVideo').srcObject = state.stream;
      $('callPanel').classList.remove('hidden');
      $('callState').textContent = 'Calling…';
      state.callActive = true;
      state.pc = makePeer();
      state.stream.getTracks().forEach(track => state.pc.addTrack(track, state.stream));
      const offer = await state.pc.createOffer();
      await state.pc.setLocalDescription(offer);
      await waitGather();
      await relay('offer', state.pc.localDescription);
    } catch (err) {
      console.error(err); toast('Camera or microphone access failed. Check browser permissions and try again.'); closeCall(false);
    }
  }

  async function receiveOffer(offer) {
    if (state.callActive) { toast('Another call is already active.'); return; }
    if (!window.confirm(`${state.peerName || 'Someone in this room'} is calling. Answer with video?`)) {
      relay('hangup', {}).catch(() => {}); return;
    }
    try {
      state.callActive = true;
      $('callPanel').classList.remove('hidden');
      $('callState').textContent = 'Connecting…';
      state.stream = await navigator.mediaDevices.getUserMedia({audio:true, video:true});
      $('localVideo').srcObject = state.stream;
      state.pc = makePeer();
      state.stream.getTracks().forEach(track => state.pc.addTrack(track, state.stream));
      await state.pc.setRemoteDescription(offer);
      for (const candidate of state.queuedCandidates.splice(0)) await state.pc.addIceCandidate(candidate);
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      await waitGather();
      await relay('answer', state.pc.localDescription);
      $('callState').textContent = 'Connecting securely…';
    } catch (err) { console.error(err); toast('Could not answer. Check camera and microphone permissions.'); closeCall(false); }
  }

  function makePeer() {
    const pc = new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
    state.remoteStream = new MediaStream();
    $('remoteVideo').srcObject = state.remoteStream;
    pc.ontrack = event => {
      const tracks = event.streams?.[0]?.getTracks() || [event.track];
      for (const track of tracks) if (!state.remoteStream.getTracks().some(existing => existing.id === track.id)) state.remoteStream.addTrack(track);
    };
    pc.onconnectionstatechange = () => {
      const connected = pc.connectionState === 'connected';
      document.querySelector('.call-stage').classList.toggle('connected', connected);
      $('callState').textContent = connected ? 'Encrypted call connected' : pc.connectionState === 'failed' ? 'Connection failed' : 'Connecting securely…';
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') toast('Direct call failed on this network. Try another network.');
    };
    return pc;
  }

  function waitGather() {
    return new Promise(resolve => {
      if (!state.pc || state.pc.iceGatheringState === 'complete') return resolve();
      const timeout = setTimeout(done, 4500);
      function done() { clearTimeout(timeout); if (state.pc) state.pc.removeEventListener('icegatheringstatechange', check); resolve(); }
      function check() { if (state.pc?.iceGatheringState === 'complete') done(); }
      state.pc.addEventListener('icegatheringstatechange', check);
    });
  }

  function closeCall(notify) {
    if (notify && state.callActive) relay('hangup', {}).catch(() => {});
    if (state.pc) { state.pc.close(); state.pc = null; }
    if (state.stream) { state.stream.getTracks().forEach(track => track.stop()); state.stream = null; }
    $('localVideo').srcObject = null; $('remoteVideo').srcObject = null;
    document.querySelector('.call-stage').classList.remove('connected');
    $('callPanel').classList.add('hidden');
    state.callActive = false; state.queuedCandidates = [];
    state.audio = true; state.video = true;
    $('muteBtn').classList.remove('active'); $('cameraBtn').classList.remove('active');
    $('muteBtn').querySelector('small').textContent = 'Mute';
    $('cameraBtn').querySelector('small').textContent = 'Camera';
  }

  $('muteBtn').addEventListener('click', e => {
    if (!state.stream) return;
    state.audio = !state.audio;
    state.stream.getAudioTracks().forEach(track => track.enabled = state.audio);
    e.currentTarget.classList.toggle('active', !state.audio);
    e.currentTarget.querySelector('small').textContent = state.audio ? 'Mute' : 'Unmute';
  });
  $('cameraBtn').addEventListener('click', e => {
    if (!state.stream) return;
    state.video = !state.video;
    state.stream.getVideoTracks().forEach(track => track.enabled = state.video);
    e.currentTarget.classList.toggle('active', !state.video);
    e.currentTarget.querySelector('small').textContent = state.video ? 'Camera' : 'Camera off';
  });
  $('shareBtn').addEventListener('click', copyInvite);
  $('copyRoom').addEventListener('click', copyInvite);
  $('editName').addEventListener('click', () => {
    const next = window.prompt('Choose the name people in this room will see:', state.name);
    if (!next || !next.trim()) return;
    state.name = next.trim().slice(0, 32);
    saveName(state.name);
    $('youName').textContent = state.name;
    $('youAvatar').textContent = initials(state.name);
    announce().catch(() => toast('Name changed here; the room will update when it reconnects.'));
    renderMembers([{id:state.id, name:state.name, seen:Date.now()/1000}, ...(state.peerId ? [{id:state.peerId, name:state.peerName}] : [])]);
    toast('Display name updated.');
  });
  $('leaveBtn').addEventListener('click', () => {
    clearInterval(state.timer);
    closeCall(true);
    relay('leave', {}).catch(() => {});
    location.href = location.origin;
  });
  $('learnMore').addEventListener('click', () => $('modal').classList.remove('hidden'));
  $('modalClose').addEventListener('click', () => $('modal').classList.add('hidden'));
  $('modalDone').addEventListener('click', () => $('modal').classList.add('hidden'));
  $('noticeClose').addEventListener('click', e => e.currentTarget.parentElement.remove());
  $('mobileMenu').addEventListener('click', () => document.querySelector('.sidebar').classList.toggle('open'));

  function toast(message) {
    const el = $('toast'); el.textContent = message; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  window.addEventListener('beforeunload', () => {
    clearInterval(state.timer);
    if (state.callActive) relay('hangup', {}).catch(() => {});
    if (state.room && state.id) fetch('/api/relay', {
      method:'POST', keepalive:true, headers:{'Content-Type':'application/json'},
      body:JSON.stringify({room:state.room, sender:state.id, kind:'leave', payload:{}})
    }).catch(() => {});
  });
})();
