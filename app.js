(function(){
  "use strict";

  // ---------- session / supabase ----------
  function generateShortCode(){
    // สั้น จำง่าย พิมพ์ข้ามเครื่องได้สะดวก (ตัดตัวที่สับสนออก: 0/O, 1/I)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for(let i=0;i<6;i++) s += chars[Math.floor(Math.random()*chars.length)];
    return s;
  }
  function getOrCreateSessionId(){
    let id = localStorage.getItem('lc_session_id');
    if(!id){
      id = generateShortCode();
      localStorage.setItem('lc_session_id', id);
    }
    return id;
  }
  const sessionId = getOrCreateSessionId();
  let sb = null;
  let supabaseReady = false;

  // แสดง/เปลี่ยน/แชร์ "รหัสทีม" — พิมพ์รหัสเดียวกันในอุปกรณ์อื่นเพื่อดูข้อมูลชุดเดียวกัน
  const teamCodeValEl = document.getElementById('teamCodeVal');
  const teamCodeChangeBtn = document.getElementById('teamCodeChangeBtn');
  if(teamCodeValEl){
    teamCodeValEl.textContent = sessionId;
    teamCodeValEl.addEventListener('click', ()=>{
      if(navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(sessionId)
          .then(()=> showToast('คัดลอกรหัสทีมแล้ว: ' + sessionId))
          .catch(()=> showToast('รหัสทีม: ' + sessionId));
      } else {
        showToast('รหัสทีม: ' + sessionId);
      }
    });
  }
  if(teamCodeChangeBtn){
    teamCodeChangeBtn.addEventListener('click', ()=>{
      const input = prompt('พิมพ์รหัสทีมที่ต้องการใช้ (ให้ตรงกับอุปกรณ์อื่นที่จะดูข้อมูลชุดเดียวกัน):', sessionId);
      if(input === null) return;
      const trimmed = input.trim().toUpperCase().replace(/\s+/g, '');
      if(!trimmed){ showToast('รหัสว่างเปล่า ไม่เปลี่ยน'); return; }
      if(trimmed === sessionId){ showToast('รหัสเดิมอยู่แล้ว'); return; }
      if(!confirm('เปลี่ยนเป็นรหัส "' + trimmed + '" และโหลดข้อมูลของรหัสนี้แทน?\n(หน้าเว็บจะรีโหลดใหม่)')) return;
      localStorage.setItem('lc_session_id', trimmed);
      location.reload();
    });
  }

  function initSupabase(){
    try{
      const url = window.SUPABASE_URL, key = window.SUPABASE_ANON_KEY;
      if(url && key && !url.includes('YOUR-PROJECT') && !key.includes('YOUR-ANON')){
        sb = window.supabase.createClient(url, key);
        supabaseReady = true;
      } else {
        setSyncStatus("ยังไม่ได้ตั้งค่า Supabase — ข้อมูลจะไม่ถูกบันทึกข้ามการรีเฟรช");
      }
    }catch(e){
      console.error('Supabase init failed:', e);
      setSyncStatus("เชื่อมต่อ Supabase ไม่สำเร็จ — ใช้งานแบบไม่บันทึกข้อมูล");
    }
  }
  const syncStatusEl = document.getElementById('syncStatus');
  function setSyncStatus(msg){
    if(!msg){ syncStatusEl.style.display = 'none'; return; }
    syncStatusEl.textContent = msg;
    syncStatusEl.style.display = 'block';
  }

  // ---------- state ----------
  let stream = null, facing = "environment";
  let athletes = []; // {id,name,color,count,laps:[{t,split,wallTime,photo,dbId}],nfcSerial,lastAutoCountAt}
  let logEntries = []; // {time, athleteName, lapNo, split, wallTime, photo, source, dbId}
  let sessionRunning = false, sessionStart = 0, sessionElapsed = 0, timerRAF = null;

  const COLORS = ["#ff4438","#3ddc84","#ffb020","#4ea1ff","#c78bff","#ff7ab8","#7fffd4","#ffd166"];

  // ---------- elements ----------
  const video = document.getElementById('video');
  const placeholder = document.getElementById('placeholder');
  const camBtn = document.getElementById('camBtn');
  const switchBtn = document.getElementById('switchBtn');
  const cdSlider = document.getElementById('cdSlider'), cdVal = document.getElementById('cdVal');
  const sessionTimerEl = document.getElementById('sessionTimer');
  const startBtn = document.getElementById('startBtn');
  const resetBtn = document.getElementById('resetBtn');
  const athleteListEl = document.getElementById('athleteList');
  const emptyHint = document.getElementById('emptyHint');
  const nameInput = document.getElementById('nameInput');
  const addBtn = document.getElementById('addBtn');
  const logListEl = document.getElementById('logList');
  const exportBtn = document.getElementById('exportBtn');
  const toast = document.getElementById('toast');

  const shotCanvas = document.createElement('canvas');
  const shotCtx = shotCanvas.getContext('2d');
  function capturePhoto(){
    if(!stream || video.readyState < 2) return null;
    const vw = video.videoWidth || 640, vh = video.videoHeight || 480;
    const targetW = 480;
    const targetH = Math.round(targetW * (vh/vw));
    shotCanvas.width = targetW; shotCanvas.height = targetH;
    shotCtx.drawImage(video, 0, 0, targetW, targetH);
    try{ return shotCanvas.toDataURL('image/jpeg', 0.6); }catch(e){ return null; }
  }
  function fmtWallTime(date){
    return date.toTimeString().slice(0,8);
  }

  // ---------- helpers ----------
  function showToast(msg){
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=>toast.classList.remove('show'), 1800);
  }
  function fmtTime(ms){
    const total = ms/1000;
    const m = Math.floor(total/60);
    const s = total%60;
    return String(m).padStart(2,'0')+":"+s.toFixed(1).padStart(4,'0');
  }
  function beep(){
    try{
      const ctx = beep._ctx || (beep._ctx = new (window.AudioContext||window.webkitAudioContext)());
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.type = 'square'; osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+0.18);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(); osc.stop(ctx.currentTime+0.18);
    }catch(e){}
    if(navigator.vibrate) navigator.vibrate(60);
  }

  // ---------- supabase persistence ----------
  async function persistAddAthlete(a){
    if(!supabaseReady) return;
    try{
      const { error } = await sb.from('athletes').insert({ id:a.id, session_id: sessionId, name:a.name, color:a.color, nfc_serial: a.nfcSerial || null });
      if(error) throw error;
    }catch(e){
      console.error('บันทึกนักกีฬาไป Supabase ไม่สำเร็จ:', e);
      showToast('บันทึกนักกีฬาไป Supabase ไม่สำเร็จ');
    }
  }
  async function persistUpdateAthleteTag(a){
    if(!supabaseReady) return;
    try{
      const { error } = await sb.from('athletes').update({ nfc_serial: a.nfcSerial || null }).eq('id', a.id);
      if(error) throw error;
    }catch(e){
      console.error('บันทึกแท็กไป Supabase ไม่สำเร็จ:', e);
      showToast('บันทึกแท็กไป Supabase ไม่สำเร็จ (เก็บไว้ในเครื่องนี้ชั่วคราว)');
    }
  }
  async function persistRemoveAthlete(id){
    if(!supabaseReady) return;
    try{
      const { error } = await sb.from('athletes').delete().eq('id', id);
      if(error) throw error;
    }catch(e){ console.error('ลบนักกีฬาบน Supabase ไม่สำเร็จ:', e); }
  }
  async function persistLapEntry({ athleteId, athleteName, lapNo, elapsedMs, splitMs, wallTime, source, photo }){
    if(!supabaseReady) return null;
    try{
      const { data, error } = await sb.from('laps').insert({
        session_id: sessionId,
        athlete_id: athleteId || null,
        athlete_name: athleteName,
        lap_no: (lapNo === '-' ? null : lapNo),
        elapsed_ms: Math.round(elapsedMs) || 0,
        split_ms: Math.round(splitMs) || 0,
        wall_time: wallTime.toISOString(),
        source: source || null,
        photo: photo || null
      }).select('id').single();
      if(error) throw error;
      return data ? data.id : null;
    }catch(e){
      console.error('บันทึกรอบไป Supabase ไม่สำเร็จ:', e);
      showToast('บันทึกรอบไป Supabase ไม่สำเร็จ');
      return null;
    }
  }
  async function persistDeleteLap(id){
    if(!supabaseReady || !id) return;
    try{
      const { error } = await sb.from('laps').delete().eq('id', id);
      if(error) throw error;
    }catch(e){
      console.error('ลบรอบบน Supabase ไม่สำเร็จ:', e);
    }
  }
  async function persistClearLaps(){
    if(!supabaseReady) return;
    try{
      const { error } = await sb.from('laps').delete().eq('session_id', sessionId);
      if(error) throw error;
    }catch(e){ console.error('ลบรอบบน Supabase ไม่สำเร็จ:', e); }
  }

  async function loadState(){
    if(!supabaseReady) return;
    try{
      const [athRes, lapRes] = await Promise.all([
        sb.from('athletes').select('*').eq('session_id', sessionId).order('created_at', { ascending:true }),
        sb.from('laps').select('*').eq('session_id', sessionId).order('created_at', { ascending:true })
      ]);
      if(athRes.error) throw athRes.error;
      if(lapRes.error) throw lapRes.error;
      const athRows = athRes.data || [];
      const lapRows = lapRes.data || [];

      athletes = athRows.map(r => ({ id:r.id, name:r.name, color:r.color, count:0, laps:[], nfcSerial: r.nfc_serial || null, lastAutoCountAt:0 }));
      logEntries = lapRows.map(r => ({
        time: r.elapsed_ms, athleteName: r.athlete_name, lapNo: (r.lap_no==null ? '-' : r.lap_no),
        split: r.split_ms, source: r.source, wallTime: new Date(r.wall_time), photo: r.photo, dbId: r.id
      }));
      lapRows.forEach(r=>{
        if(!r.athlete_id) return;
        const a = athletes.find(x=>x.id===r.athlete_id);
        if(a){ a.count++; a.laps.push({ t:r.elapsed_ms, split:r.split_ms, wallTime:new Date(r.wall_time), photo:r.photo, dbId:r.id }); }
      });
      if(logEntries.length){
        sessionElapsed = Math.max.apply(null, logEntries.map(e=>e.time));
      }
    }catch(e){
      console.error('โหลดข้อมูลจาก Supabase ไม่สำเร็จ:', e);
      setSyncStatus('โหลดข้อมูลจาก Supabase ไม่สำเร็จ — เริ่มเซสชันใหม่');
    }
  }

  // ---------- NFC (NDEFReader) — ตัวนับหลัก ----------
  const nfcSupportWarningEl = document.getElementById('nfcSupportWarning');
  const nfcStatusBox = document.getElementById('nfcStatusBox');
  const nfcDotEl = document.getElementById('nfcDot');
  const nfcStatusTextEl = document.getElementById('nfcStatusText');
  const nfcToggleBtn = document.getElementById('nfcToggleBtn');

  const nfcSupported = ('NDEFReader' in window);
  let ndefReader = null;
  let nfcAbortController = null;
  let nfcScanning = false;
  let enrollTargetAthleteId = null; // ถ้าตั้งไว้ การอ่านแท็กครั้งถัดไปจะไปลงทะเบียนแทนที่จะนับรอบ

  if(!nfcSupported){
    nfcSupportWarningEl.style.display = 'block';
    nfcSupportWarningEl.textContent = '⚠️ อุปกรณ์/เบราว์เซอร์นี้ไม่รองรับ NFC ผ่านเว็บ (Web NFC รองรับเฉพาะ Chrome/Samsung Internet บน Android เท่านั้น ไม่รองรับ iPhone หรือคอมพิวเตอร์) — ใช้ปุ่ม +1 กดเองแทนได้';
    nfcToggleBtn.disabled = true;
    nfcToggleBtn.textContent = '📡 ไม่รองรับ NFC บนอุปกรณ์นี้';
  }

  function setNfcStatus(scanning, textOverride){
    nfcDotEl.classList.toggle('scanning', !!scanning);
    if(textOverride){ nfcStatusTextEl.textContent = textOverride; return; }
    nfcStatusTextEl.textContent = scanning ? 'กำลังรอแตะแท็ก...' : 'ยังไม่ได้เริ่มสแกน';
  }

  async function startNfcScan(){
    if(!nfcSupported) return;
    try{
      nfcAbortController = new AbortController();
      ndefReader = new NDEFReader();
      await ndefReader.scan({ signal: nfcAbortController.signal });
      nfcScanning = true;
      nfcToggleBtn.textContent = '⏹️ หยุดสแกน NFC';
      setNfcStatus(true);
      ndefReader.onreading = handleNfcReading;
      ndefReader.onreadingerror = () => showToast('อ่านแท็กไม่สำเร็จ ลองแตะใหม่อีกครั้ง');
      showToast('เริ่มสแกน NFC แล้ว — แตะแท็กได้เลย');
    }catch(e){
      console.error('เปิดสแกน NFC ไม่สำเร็จ:', e);
      const msg = (e && e.name === 'NotAllowedError')
        ? 'ไม่ได้รับสิทธิ์ใช้ NFC — ถ้าเคยกดปฏิเสธไว้ ต้องไปเปิดสิทธิ์ใหม่ในตั้งค่าเว็บไซต์ของเบราว์เซอร์'
        : 'เปิดสแกน NFC ไม่สำเร็จ: ' + (e && e.message ? e.message : e);
      showToast(msg);
    }
  }
  function stopNfcScan(){
    if(nfcAbortController) nfcAbortController.abort();
    nfcAbortController = null;
    ndefReader = null;
    nfcScanning = false;
    nfcToggleBtn.textContent = '📡 เริ่มสแกน NFC';
    setNfcStatus(false);
  }
  nfcToggleBtn.addEventListener('click', ()=>{
    if(nfcScanning) stopNfcScan(); else startNfcScan();
  });

  function handleNfcReading(event){
    const serial = event.serialNumber;
    if(!serial){ showToast('อ่านแท็กได้แต่ไม่มีหมายเลขซีเรียล (แท็กนี้อาจไม่รองรับ)'); return; }

    // โหมดลงทะเบียน: กำลังรอผูกแท็กนี้กับนักกีฬาที่เลือกไว้
    if(enrollTargetAthleteId){
      const a = athletes.find(x=>x.id===enrollTargetAthleteId);
      enrollTargetAthleteId = null;
      if(a){
        a.nfcSerial = serial;
        renderAthletes();
        persistUpdateAthleteTag(a);
        showToast('ผูกแท็กกับ ' + a.name + ' สำเร็จ');
        beep();
      }
      return;
    }

    // โหมดนับรอบปกติ
    if(!sessionRunning){ showToast('กด "เริ่มจับเวลา" ก่อนถึงจะเริ่มนับรอบได้'); return; }
    const athlete = athletes.find(a => a.nfcSerial === serial);
    if(!athlete){ showToast('แท็กนี้ยังไม่ได้ลงทะเบียนกับนักกีฬาคนไหน'); return; }

    const cooldownMs = Number(cdSlider.value) * 1000;
    const now = performance.now();
    if(now - (athlete.lastAutoCountAt || 0) < cooldownMs) return; // กันนับซ้ำตอนแตะค้าง/แตะรัว
    athlete.lastAutoCountAt = now;
    const photo = capturePhoto(); // null ถ้าไม่ได้เปิดกล้อง — ไม่บังคับ
    lapForAthlete(athlete, 'nfc-auto', { photo, wallTime: new Date() });
  }

  // เริ่มลงทะเบียนแท็กให้นักกีฬาคนหนึ่ง — เปิดสแกนให้อัตโนมัติถ้ายังไม่ได้เปิด แล้วรอแตะแท็กครั้งถัดไป
  async function beginEnrollTag(a){
    if(!nfcSupported){ showToast('อุปกรณ์นี้ไม่รองรับ NFC'); return; }
    if(!nfcScanning) await startNfcScan();
    enrollTargetAthleteId = a.id;
    setNfcStatus(true, 'แตะแท็กของ "' + a.name + '" ตอนนี้...');
    showToast('แตะแท็ก NFC ของ ' + a.name + ' ที่หลังโทรศัพท์ได้เลย');
  }
  function clearTag(a){
    a.nfcSerial = null;
    renderAthletes();
    persistUpdateAthleteTag(a);
    showToast('ล้างแท็กของ ' + a.name + ' แล้ว');
  }

  // ---------- กล้อง (ไม่บังคับ — ถ่ายภาพประกอบทุกรอบเท่านั้น ไม่เกี่ยวกับการนับ) ----------
  async function startCamera(){
    if(stream){ stopCamera(); return; }
    try{
      stream = await navigator.mediaDevices.getUserMedia({
        video:{ facingMode:{ideal:facing}, width:{ideal:1280}, height:{ideal:720} },
        audio:false
      });
      video.srcObject = stream;
      await video.play();
      placeholder.style.display = 'none';
      camBtn.textContent = "ปิดกล้อง";
      switchBtn.style.display = 'inline-flex';
    }catch(err){
      showToast("เปิดกล้องไม่ได้: อนุญาตสิทธิ์กล้องในเบราว์เซอร์ก่อน");
    }
  }
  function stopCamera(){
    if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    video.srcObject = null;
    placeholder.style.display = 'flex';
    camBtn.textContent = "เปิดกล้อง";
    switchBtn.style.display = 'none';
  }
  camBtn.addEventListener('click', startCamera);
  switchBtn.addEventListener('click', async ()=>{
    facing = facing === 'environment' ? 'user' : 'environment';
    if(stream){ stream.getTracks().forEach(t=>t.stop()); }
    stream = null;
    await startCamera();
  });

  cdSlider.addEventListener('input', ()=> cdVal.textContent = cdSlider.value + "s");

  // ---------- session timer ----------
  function tickTimer(){
    if(!sessionRunning) return;
    const now = performance.now();
    const elapsed = sessionElapsed + (now - sessionStart);
    sessionTimerEl.textContent = fmtTime(elapsed);
    timerRAF = requestAnimationFrame(tickTimer);
  }
  startBtn.addEventListener('click', ()=>{
    if(!sessionRunning){
      sessionRunning = true;
      sessionStart = performance.now();
      startBtn.textContent = "หยุดชั่วคราว";
      startBtn.classList.remove('btn-primary'); startBtn.classList.add('btn-ghost','active');
      athletes.forEach(a=>{ a.lastAutoCountAt = 0; });
      tickTimer();
    } else {
      sessionRunning = false;
      sessionElapsed += performance.now()-sessionStart;
      startBtn.textContent = "เริ่มต่อ";
      cancelAnimationFrame(timerRAF);
    }
  });
  resetBtn.addEventListener('click', async ()=>{
    if(!confirm("รีเซ็ตเวลาและรอบทั้งหมด?")) return;
    sessionRunning = false; sessionElapsed = 0; sessionStart = 0;
    cancelAnimationFrame(timerRAF);
    sessionTimerEl.textContent = "00:00.0";
    startBtn.textContent = "เริ่มจับเวลา";
    startBtn.classList.add('btn-primary'); startBtn.classList.remove('btn-ghost','active');
    athletes.forEach(a=>{ a.count=0; a.laps=[]; a.lastAutoCountAt=0; });
    logEntries = [];
    renderAthletes(); renderLog();
    await persistClearLaps();
  });
  function currentElapsed(){
    return sessionElapsed + (sessionRunning ? performance.now()-sessionStart : 0);
  }

  // ---------- athletes ----------
  function addAthlete(name){
    name = name.trim();
    if(!name) return;
    const id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'a-'+Date.now()+'-'+Math.random().toString(16).slice(2);
    const color = COLORS[athletes.length % COLORS.length];
    const a = { id, name, color, count:0, laps:[], nfcSerial:null, lastAutoCountAt:0 };
    athletes.push(a);
    renderAthletes();
    persistAddAthlete(a);
  }
  addBtn.addEventListener('click', ()=>{ addAthlete(nameInput.value); nameInput.value=''; nameInput.focus(); });
  nameInput.addEventListener('keydown', e=>{ if(e.key==='Enter'){ addAthlete(nameInput.value); nameInput.value=''; } });

  function removeAthlete(id){
    athletes = athletes.filter(a=>a.id!==id);
    renderAthletes();
    persistRemoveAthlete(id);
  }

  function lapForAthlete(a, sourceLabel, capture){
    const t = currentElapsed();
    const prevT = a.laps.length ? a.laps[a.laps.length-1].t : 0;
    const split = t - prevT;
    const wallTime = (capture && capture.wallTime) ? capture.wallTime : new Date();
    const photo = capture ? capture.photo : null;
    a.count++;
    const lapObj = {t, split, wallTime, photo, dbId:null};
    a.laps.push(lapObj);
    const logObj = { time:t, athleteName:a.name, lapNo:a.count, split, source:sourceLabel, wallTime, photo, dbId:null };
    logEntries.push(logObj);
    renderAthletes(a.id);
    renderLog();
    beep();
    showToast((a.name)+" — รอบที่ "+a.count);
    persistLapEntry({ athleteId:a.id, athleteName:a.name, lapNo:a.count, elapsedMs:t, splitMs:split, wallTime, source:sourceLabel, photo })
      .then(id => { lapObj.dbId = id; logObj.dbId = id; });
  }

  // ลบรอบล่าสุดของนักกีฬาคนหนึ่ง (แก้รอบที่กดพลาด/นับซ้ำ)
  function removeLastLapForAthlete(a){
    if(!a.laps.length){ showToast(a.name + " ยังไม่มีรอบให้ลบ"); return; }
    const removed = a.laps.pop();
    a.count = Math.max(0, a.count - 1);
    let idx = -1;
    for(let i=logEntries.length-1; i>=0; i--){
      if(logEntries[i].athleteName === a.name && logEntries[i].time === removed.t){ idx = i; break; }
    }
    let removedEntry = null;
    if(idx >= 0) removedEntry = logEntries.splice(idx, 1)[0];
    renderAthletes();
    renderLog();
    showToast("ลบรอบล่าสุดของ " + a.name + " แล้ว");
    const dbId = removed.dbId || (removedEntry && removedEntry.dbId);
    if(dbId) persistDeleteLap(dbId);
  }

  function renderAthletes(flashId){
    athleteListEl.innerHTML = '';
    emptyHint.style.display = athletes.length ? 'none' : 'block';
    athletes.forEach(a=>{
      const el = document.createElement('div');
      el.className = 'athlete' + (flashId===a.id ? ' flash' : '');
      const lastSplit = a.laps.length ? fmtTime(a.laps[a.laps.length-1].split) : '—';
      const nfcBadge = a.nfcSerial
        ? `<span class="nfc-badge on">●มีแท็กแล้ว<span class="clear-tag" data-clear="${a.id}">(ล้าง)</span></span>`
        : `<span class="nfc-badge off">●ยังไม่มีแท็ก</span>`;
      el.innerHTML = `
        <div class="swatch" style="background:${a.color}"></div>
        <div class="info">
          <div class="name">${escapeHtml(a.name)}</div>
          <div class="split tabular">รอบล่าสุด ${lastSplit} · ${nfcBadge}</div>
        </div>
        <div>
          <div class="count tabular" style="color:${a.color}">${a.count}</div>
          <div class="count-label">รอบ</div>
        </div>
        <div class="actions">
          <button class="btn-ghost btn-nfc" data-id="${a.id}" title="ลงทะเบียนแท็ก NFC">🏷️</button>
          <button class="btn-ghost btn-plus" data-id="${a.id}">+1</button>
          <button class="btn-ghost btn-minus" data-id="${a.id}">−1</button>
          <button class="btn-ghost btn-del" data-id="${a.id}">✕</button>
        </div>`;
      athleteListEl.appendChild(el);
    });
    athleteListEl.querySelectorAll('.btn-nfc').forEach(b=>{
      b.addEventListener('click', ()=>{
        const a = athletes.find(x=>x.id==b.dataset.id);
        if(a) beginEnrollTag(a);
      });
    });
    athleteListEl.querySelectorAll('.clear-tag').forEach(el=>{
      el.addEventListener('click', (e)=>{
        e.stopPropagation();
        const a = athletes.find(x=>x.id===el.dataset.clear);
        if(a) clearTag(a);
      });
    });
    athleteListEl.querySelectorAll('.btn-plus').forEach(b=>{
      b.addEventListener('click', ()=>{
        const a = athletes.find(x=>x.id==b.dataset.id);
        if(a) lapForAthlete(a, 'manual', { photo: capturePhoto(), wallTime: new Date() });
      });
    });
    athleteListEl.querySelectorAll('.btn-minus').forEach(b=>{
      b.addEventListener('click', ()=>{
        const a = athletes.find(x=>x.id==b.dataset.id);
        if(a) removeLastLapForAthlete(a);
      });
    });
    athleteListEl.querySelectorAll('.btn-del').forEach(b=>{
      b.addEventListener('click', ()=> removeAthlete(b.dataset.id));
    });
    renderStats();
  }
  function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

  function renderStats(){
    const statsTable = document.getElementById('statsTable');
    const statsBody = document.getElementById('statsBody');
    const statsEmptyHint = document.getElementById('statsEmptyHint');
    if(!athletes.length){
      statsTable.style.display = 'none';
      statsEmptyHint.style.display = 'block';
      return;
    }
    statsTable.style.display = '';
    statsEmptyHint.style.display = 'none';
    statsBody.innerHTML = athletes.map(a=>{
      if(!a.laps.length){
        return `<tr>
          <td>${escapeHtml(a.name)}</td>
          <td class="num">0</td>
          <td class="num">—</td>
          <td class="num">—</td>
        </tr>`;
      }
      const splits = a.laps.map(l=>l.split);
      const fastest = Math.min.apply(null, splits);
      const avg = splits.reduce((s,x)=>s+x,0) / splits.length;
      return `<tr>
        <td>${escapeHtml(a.name)}</td>
        <td class="num">${a.laps.length}</td>
        <td class="num" style="color:var(--lane-green)">${fmtTime(fastest)}</td>
        <td class="num">${fmtTime(avg)}</td>
      </tr>`;
    }).join('');
  }

  // ---------- log ----------
  function renderLog(){
    if(!logEntries.length){ logListEl.innerHTML = '<div class="log-empty">ยังไม่มีการนับรอบ</div>'; return; }
    logListEl.innerHTML = '';
    logEntries.forEach((entry, idx)=>{
      const div = document.createElement('div');
      div.className = 'log-item';
      const wt = entry.wallTime ? fmtWallTime(entry.wallTime) : '';
      const thumbHtml = entry.photo
        ? `<img class="thumb" data-idx="${idx}" src="${entry.photo}">`
        : `<div class="thumb empty" data-idx="${idx}">🏃</div>`;
      div.innerHTML = `
        ${thumbHtml}
        <div class="meta">
          <div class="top">${escapeHtml(entry.athleteName)} ${entry.lapNo!=='-'?'· รอบ '+entry.lapNo:''}</div>
          <div class="bottom">${wt} · เวลาแข่ง ${fmtTime(entry.time)}</div>
        </div>
        <div class="split-badge tabular">${entry.split? fmtTime(entry.split):''}</div>`;
      logListEl.appendChild(div);
    });
    logListEl.querySelectorAll('.thumb[data-idx]').forEach(el=>{
      el.addEventListener('click', ()=>{
        const entry = logEntries[Number(el.dataset.idx)];
        if(entry && entry.photo) openLightbox(entry);
      });
    });
    renderHistoryByDate();
  }

  function renderHistoryByDate(){
    const wrap = document.getElementById('historyByDate');
    const emptyHint = document.getElementById('historyEmptyHint');
    if(!logEntries.length){
      wrap.innerHTML = '';
      emptyHint.style.display = 'block';
      return;
    }
    emptyHint.style.display = 'none';

    const groups = {}; // sortKey (yyyy-mm-dd) -> { label, items:[] }
    logEntries.forEach(e=>{
      const d = (e.wallTime instanceof Date) ? e.wallTime : new Date(e.wallTime);
      const sortKey = d.toISOString().slice(0,10);
      if(!groups[sortKey]){
        groups[sortKey] = {
          label: d.toLocaleDateString('th-TH', { year:'numeric', month:'long', day:'numeric' }),
          items: []
        };
      }
      groups[sortKey].items.push(e);
    });
    const sortedKeys = Object.keys(groups).sort().reverse();

    wrap.innerHTML = sortedKeys.map((k, idx)=>{
      const g = groups[k];
      const rows = g.items.map(e=>{
        const d = (e.wallTime instanceof Date) ? e.wallTime : new Date(e.wallTime);
        const wt = fmtWallTime(d);
        return `<tr>
          <td>${wt}</td>
          <td>${escapeHtml(e.athleteName)}</td>
          <td class="num">${e.lapNo!=='-' ? e.lapNo : '-'}</td>
          <td class="num">${e.split ? fmtTime(e.split) : '-'}</td>
        </tr>`;
      }).join('');
      return `<details class="history-date-group" ${idx===0 ? 'open' : ''}>
        <summary><span>${g.label}</span><span class="count-badge">${g.items.length} รอบ</span></summary>
        <table class="history-table">
          <thead><tr><th>เวลา</th><th>นักกีฬา</th><th class="num">รอบที่</th><th class="num">เวลาต่อรอบ</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>`;
    }).join('');
  }

  const lightbox = document.getElementById('lightbox');
  const lbImg = document.getElementById('lbImg');
  const lbCaption = document.getElementById('lbCaption');
  document.getElementById('lbClose').addEventListener('click', ()=> lightbox.classList.remove('show'));
  lightbox.addEventListener('click', (e)=>{ if(e.target===lightbox) lightbox.classList.remove('show'); });
  function openLightbox(entry){
    lbImg.src = entry.photo;
    const wt = entry.wallTime ? fmtWallTime(entry.wallTime) : '';
    lbCaption.innerHTML = `${escapeHtml(entry.athleteName)} ${entry.lapNo!=='-'?'· รอบ '+entry.lapNo:''}<span>${wt} · เวลาแข่ง ${fmtTime(entry.time)}</span>`;
    lightbox.classList.add('show');
  }

  exportBtn.addEventListener('click', ()=>{
    if(!logEntries.length){ showToast("ไม่มีข้อมูลให้ส่งออก"); return; }
    let csv = "เวลาแข่ง,เวลานาฬิกา,นักกีฬา,รอบที่,เวลาต่อรอบ,ที่มา\n";
    logEntries.forEach(e=>{
      const wt = e.wallTime ? fmtWallTime(e.wallTime) : '';
      csv += `${fmtTime(e.time)},${wt},${e.athleteName},${e.lapNo},${e.split?fmtTime(e.split):''},${e.source}\n`;
    });
    const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'lap-log.csv';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("ส่งออก CSV แล้ว (ไม่รวมรูปถ่าย)");
  });

  // ---------- PWA: ติดตั้งลงเครื่อง + service worker ----------
  if('serviceWorker' in navigator){
    window.addEventListener('load', ()=>{
      navigator.serviceWorker.register('sw.js').catch(e=>console.error('SW register failed:', e));
    });
  }
  let deferredInstallPrompt = null;
  const installBtn = document.getElementById('installBtn');
  window.addEventListener('beforeinstallprompt', (e)=>{
    e.preventDefault();
    deferredInstallPrompt = e;
    installBtn.style.display = 'inline-flex';
  });
  installBtn.addEventListener('click', async ()=>{
    if(!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    installBtn.style.display = 'none';
  });
  window.addEventListener('appinstalled', ()=>{
    installBtn.style.display = 'none';
    showToast('ติดตั้งแอปสำเร็จ — เปิดจากหน้าจอโฮมได้เลย');
  });

  // ---------- init ----------
  (async function init(){
    initSupabase();
    setNfcStatus(false);
    await loadState();
    renderAthletes();
    renderLog();
    sessionTimerEl.textContent = fmtTime(sessionElapsed);
  })();
})();
