(() => {
  const $ = (id) => document.getElementById(id);
  const state = { room: '', id: '', key: null, cursor: 0, timer: null, pc: null, stream: null, remoteStream: null, pollBusy: false, queuedCandidates: [], callActive: false, audio: true, video: true };
  const enc = new TextEncoder(), dec = new TextDecoder();
  const entry = $('entry'), app = $('app'), form = $('joinForm'), msgForm = $('messageForm'), input = $('messageInput');

  async function deriveKey(secret, room) {
    const material = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2', salt:enc.encode('quietline-v1:'+room), iterations:310000, hash:'SHA-256'}, material, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
  }
  function b64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
  function unb64(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
  async function seal(text) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt({name:'AES-GCM',iv}, state.key, enc.encode(text));
    return {iv:b64(iv), data:b64(data), v:1};
  }
  async function open(box) {
    const clear = await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(box.iv)},state.key,unb64(box.data));
    return dec.decode(clear);
  }
  const safeRoom = raw => raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-|-$/g,'');
  const shortName = () => 'Guest '+Math.floor(100+Math.random()*900);
  const timeLabel = t => new Date((t||Date.now()/1000)*1000).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const room = safeRoom($('roomInput').value), secret = $('secretInput').value;
    if (room.length < 2 || secret.length < 10) { toast('Use a room name and a phrase of at least 10 characters.'); return; }
    if (!crypto.subtle) { toast('Secure encryption requires localhost or HTTPS.'); return; }
    const submit = form.querySelector('button[type=submit]'); submit.disabled = true; submit.textContent = 'Preparing your private room…';
    try {
      state.room = room; state.id = crypto.randomUUID(); state.key = await deriveKey(secret, room); $('secretInput').value = '';
      $('roomName').textContent = room; entry.classList.add('hidden'); app.classList.remove('hidden');
      input.disabled = false; input.focus(); $('connectionStatus').textContent = 'Connecting securely…';
      await announce(); poll(); state.timer = setInterval(poll, 1000);
      toast('Your private room is ready. Share the same phrase with your contact.');
    } catch (err) { console.error(err); toast('Could not start the private room.'); submit.disabled = false; submit.textContent = 'Open private room →'; }
  });

  async function relay(kind, payload) {
    const res = await fetch('/api/relay', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({room:state.room,sender:state.id,kind,payload})});
    if (!res.ok) throw new Error('Relay request failed');
  }
  async function announce() { await relay('presence', {}); }
  async function poll() {
    if (state.pollBusy || !state.room) return; state.pollBusy=true;
    try {
      await announce();
      const res = await fetch(`/api/poll?room=${encodeURIComponent(state.room)}&since=${state.cursor}`, {cache:'no-store'});
      if (!res.ok) throw new Error('poll failed'); const data = await res.json();
      state.cursor = Math.max(state.cursor, data.cursor||0); renderMembers(data.members||[]);
      for (const event of data.events||[]) if (event.sender !== state.id) await handleEvent(event);
    } catch (_) { setStatus('Reconnecting to relay…', false); }
    finally { state.pollBusy=false; }
  }
  function renderMembers(members) {
    const others = members.filter(x=>x.id!==state.id); const count=others.length+1;
    $('memberCount').textContent=String(count).padStart(2,'0'); $('callBtn').disabled=!others.length;
    const who=others.length ? (state.peerId===others[0].id && state.peerName ? state.peerName : shortName()) : null;
    $('memberList').replaceChildren();
    const self=row('You','Here now','Y','avatar-you'); $('memberList').append(self);
    if (who) { state.peerId=others[0].id; state.peerName=who; $('contactName').textContent=who; $('callName').textContent=who; $('connectionStatus').innerHTML='<i></i> Online · room encryption active'; $('connectionStatus').classList.add('online'); $('contactName').previousElementSibling.textContent=who.slice(-1); $('contactName').previousElementSibling.className='avatar avatar-contact'; $('callBtn').disabled=false; $('messageInput').placeholder='Write a private message…'; }
    else { state.peerId=null; $('contactName').textContent='Waiting for someone'; $('connectionStatus').textContent='Share the room name and phrase'; $('connectionStatus').classList.remove('online'); $('contactName').previousElementSibling.textContent='?'; $('contactName').previousElementSibling.className='avatar avatar-contact'; }
  }
  function row(name, status, initial, klass) { const r=document.createElement('div');r.className='member-row';const a=document.createElement('div');a.className='avatar '+klass;a.textContent=initial;const d=document.createElement('div');const b=document.createElement('strong');b.textContent=name;const s=document.createElement('small');s.textContent=status;d.append(b,s);const dot=document.createElement('i');dot.className='online-dot';r.append(a,d,dot);return r; }
  function setStatus(text, online) { $('connectionStatus').textContent=text; $('connectionStatus').classList.toggle('online',!!online); }
  async function handleEvent(e) {
    if (e.kind==='ciphertext') {
      try { const m=JSON.parse(await open(e.payload)); addMessage(m.text,false,e.time); }
      catch (_) { toast('A message could not be decrypted. Check the room phrase.'); }
    } else if (e.kind==='offer' && Date.now()/1000-e.time < 120) await receiveOffer(e.payload);
    else if (e.kind==='answer' && state.pc) { await state.pc.setRemoteDescription(e.payload); for(const c of state.queuedCandidates.splice(0)) await state.pc.addIceCandidate(c); }
    else if (e.kind==='candidate' && state.pc) { if(state.pc.remoteDescription) await state.pc.addIceCandidate(e.payload); else state.queuedCandidates.push(e.payload); }
    else if (e.kind==='hangup') closeCall(false);
  }
  msgForm.addEventListener('submit', async e => {
    e.preventDefault(); const text=input.value.trim(); if(!text)return;
    try { const box=await seal(JSON.stringify({text})); await relay('ciphertext',box); addMessage(text,true,Date.now()/1000); input.value=''; input.style.height='auto'; }
    catch (_) { toast('Message could not be sent. Check your connection.'); }
  });
  input.addEventListener('input',()=>{input.style.height='auto';input.style.height=Math.min(input.scrollHeight,130)+'px';});
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();msgForm.requestSubmit();}});
  function addMessage(text,mine,time) {
    let list=document.querySelector('.msg-list'); if(!list){$('messages').querySelector('.welcome-message')?.remove();list=document.createElement('div');list.className='msg-list';$('messages').append(list);}
    const r=document.createElement('div');r.className='msg-row '+(mine?'mine':'theirs');const av=document.createElement('div');av.className='msg-avatar';av.textContent=mine?'Y':(state.peerName||'G').slice(-1);
    const c=document.createElement('div');c.className='msg-content';const meta=document.createElement('div');meta.className='msg-meta';meta.textContent=mine?'You':(state.peerName||'Guest');const b=document.createElement('div');b.className='bubble';b.textContent=text;const t=document.createElement('div');t.className='bubble-time';t.textContent=timeLabel(time);c.append(meta,b,t);r.append(av,c);list.append(r);$('messages').scrollTop=$('messages').scrollHeight;
  }
  $('callBtn').addEventListener('click',startCall); $('hangupBtn').addEventListener('click',()=>closeCall(true)); $('closeCall').addEventListener('click',()=>closeCall(true));
  async function startCall() {
    if(!state.peerId)return;
    try {
      state.stream=await navigator.mediaDevices.getUserMedia({audio:true,video:true});
      $('localVideo').srcObject=state.stream; $('callPanel').classList.remove('hidden'); $('callState').textContent='Calling…'; state.callActive=true;
      state.pc=makePeer(); state.stream.getTracks().forEach(t=>state.pc.addTrack(t,state.stream));
      const offer=await state.pc.createOffer(); await state.pc.setLocalDescription(offer); await waitGather(); await relay('offer',state.pc.localDescription);
    } catch(err) { console.error(err);toast('Camera or microphone access is unavailable.');closeCall(false); }
  }
  async function receiveOffer(offer) {
    if(state.callActive){toast('Incoming call while another call is active.');return;}
    if(!window.confirm(`${state.peerName||'Someone in this room'} is calling. Answer with video?`)){relay('hangup',{}).catch(()=>{});return;}
    try {
      state.callActive=true; $('callPanel').classList.remove('hidden'); $('callState').textContent='Connecting…';
      state.stream=await navigator.mediaDevices.getUserMedia({audio:true,video:true}); $('localVideo').srcObject=state.stream;
      state.pc=makePeer();state.stream.getTracks().forEach(t=>state.pc.addTrack(t,state.stream));
      await state.pc.setRemoteDescription(offer); for(const c of state.queuedCandidates.splice(0)) await state.pc.addIceCandidate(c);
      const answer=await state.pc.createAnswer();await state.pc.setLocalDescription(answer);await waitGather();await relay('answer',state.pc.localDescription);$('callState').textContent='Connecting securely…';
    } catch(err){console.error(err);toast('Could not answer the call.');closeCall(false);}
  }
  function makePeer() {
    const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]}); state.remoteStream=new MediaStream(); $('remoteVideo').srcObject=state.remoteStream;
    pc.ontrack=e=>{e.streams[0].getTracks().forEach(t=>state.remoteStream.addTrack(t));};
    // ICE gathering completes before SDP is relayed, so candidates are included in the offer/answer.
    pc.onconnectionstatechange=()=>{const connected=pc.connectionState==='connected';$('callStage')?.classList.toggle('connected',connected);document.querySelector('.call-stage').classList.toggle('connected',connected);$('callState').textContent=connected?'Encrypted call connected':pc.connectionState==='failed'?'Connection failed':'Connecting securely…';};
    pc.oniceconnectionstatechange=()=>{if(pc.iceConnectionState==='failed')toast('Direct call connection failed. Try a network that allows peer calls.');};
    return pc;
  }
  function waitGather(){return new Promise(resolve=>{if(!state.pc||state.pc.iceGatheringState==='complete')return resolve();const timeout=setTimeout(done,4500);function done(){clearTimeout(timeout);if(state.pc)state.pc.removeEventListener('icegatheringstatechange',check);resolve();}function check(){if(state.pc?.iceGatheringState==='complete')done();}state.pc.addEventListener('icegatheringstatechange',check);});}
  function closeCall(notify) { if(notify&&state.callActive)relay('hangup',{}).catch(()=>{});if(state.pc){state.pc.close();state.pc=null;}if(state.stream){state.stream.getTracks().forEach(t=>t.stop());state.stream=null;}$('localVideo').srcObject=null;$('remoteVideo').srcObject=null;document.querySelector('.call-stage').classList.remove('connected');$('callPanel').classList.add('hidden');state.callActive=false;state.queuedCandidates=[]; }
  $('muteBtn').addEventListener('click',e=>{if(!state.stream)return;state.audio=!state.audio;state.stream.getAudioTracks().forEach(t=>t.enabled=state.audio);e.currentTarget.classList.toggle('active',!state.audio);e.currentTarget.querySelector('small').textContent=state.audio?'Mute':'Unmute';});
  $('cameraBtn').addEventListener('click',e=>{if(!state.stream)return;state.video=!state.video;state.stream.getVideoTracks().forEach(t=>t.enabled=state.video);e.currentTarget.classList.toggle('active',!state.video);e.currentTarget.querySelector('small').textContent=state.video?'Camera':'Camera off';});
  $('shareBtn').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(`${location.origin} — room: ${state.room}`);toast('Room invite copied. Share your phrase separately.');}catch(_){toast('Room: '+state.room+' — share your phrase separately.');}});
  $('copyRoom').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(state.room);toast('Room name copied.');}catch(_){toast('Room: '+state.room);}});
  $('leaveBtn').addEventListener('click',()=>{clearInterval(state.timer);closeCall(true);location.reload();});
  $('learnMore').addEventListener('click',()=> $('modal').classList.remove('hidden')); $('modalClose').addEventListener('click',()=> $('modal').classList.add('hidden')); $('modalDone').addEventListener('click',()=> $('modal').classList.add('hidden')); $('noticeClose').addEventListener('click',e=>e.currentTarget.parentElement.remove());
  $('mobileMenu').addEventListener('click',()=>document.querySelector('.sidebar').classList.toggle('open'));
  let toastTimer;function toast(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),3000);}
  window.addEventListener('beforeunload',()=>{clearInterval(state.timer);if(state.callActive)relay('hangup',{}).catch(()=>{});});
})();
