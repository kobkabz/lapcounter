(function(){
  "use strict";

  // ---------- session / supabase ----------
  function getOrCreateSessionId(){
    let id = localStorage.getItem('lc_session_id');
    if(!id){
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'sess-'+Date.now()+'-'+Math.random().toString(16).slice(2);
      localStorage.setItem('lc_session_id', id);
    }
    return id;
  }
  const sessionId = getOrCreateSessionId();
  let sb = null;
  let supabaseReady = false;

  const syncStatusEl = document.getElementById('syncStatus');
  function setSyncStatus(msg){
    if(!msg){ syncStatusEl.style.display = 'none'; return; }
    syncStatusEl.textContent = msg;
    syncStatusEl.style.display = 'block';
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

  // ---------- state ----------
  let stream = null, facing = "environment";
  let athletes = []; // {id,name,color,count,laps:[{t,split,wallTime,photo}]}
  let logEntries = []; // {time, athleteName, lapNo, split, wallTime, photo, source}
  let sessionRunning = false, sessionStart = 0, sessionElapsed = 0, timerRAF = null;
  let autoMode = true;
  let lastTriggerTime = 0;
  let prevFrame = null;
  let wasAbove = false;
  let procW = 160, procH = 90;

  const COLORS = ["#ff4438","#3ddc84","#ffb020","#4ea1ff","#c78bff","#ff7ab8","#7fffd4","#ffd166"];

  // ---------- elements ----------
  const video = document.getElementById('video');
  const overlay = document.getElementById('overlay');
  const placeholder = document.getElementById('placeholder');
  const camBtn = document.getElementById('camBtn');
  const switchBtn = document.getElementById('switchBtn');
  const autoBtn = document.getElementById('autoBtn');
  const posRow = document.getElementById('posRow'), posSlider = document.getElementById('posSlider'), posVal = document.getElementById('posVal');
  const sensRow = document.getElementById('sensRow'), sensSlider = document.getElementById('sensSlider'), sensVal = document.getElementById('sensVal');
  const cdRow = document.getElementById('cdRow'), cdSlider = document.getElementById('cdSlider'), cdVal = document.getElementById('cdVal');
  const meterWrap = document.getElementById('meterWrap'), meterFill = document.getElementById('meterFill'), meterThresh = document.getElementById('meterThresh');
  const sessionTimerEl = document.getElementById('sessionTimer');
  const startBtn = document.getElementById('startBtn');
  const resetBtn = document.getElementById('resetBtn');
  const athleteListEl = document.getElementById('athleteList');
  const emptyHint = document.getElementById('emptyHint');
  const nameInput = document.getElementById('nameInput');
  const addBtn = document.getElementById('addBtn');
  const logListEl = document.getElementById('logList');
  const exportBtn = document.getElementById('exportBtn');
  const assignModal = document.getElementById('assignModal');
  const assignGrid = document.getElementById('assignGrid');
  const modalTimeoutFill = document.getElementById('modalTimeoutFill');
  const toast = document.getElementById('toast');

  const procCanvas = document.createElement('canvas');
  procCanvas.width = procW; procCanvas.height = procH;
  const procCtx = procCanvas.getContext('2d', {willReadFrequently:true});

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
      const { error } = await sb.from('athletes').insert({ id:a.id, session_id: sessionId, name:a.name, color:a.color });
      if(error) throw error;
    }catch(e){
      console.error('บันทึกนักกีฬาไป Supabase ไม่สำเร็จ:', e);
      showToast('บันทึกนักกีฬาไป Supabase ไม่สำเร็จ');
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
    if(!supabaseReady) return;
    try{
      const { error } = await sb.from('laps').insert({
        session_id: sessionId,
        athlete_id: athleteId || null,
        athlete_name: athleteName,
        lap_no: (lapNo === '-' ? null : lapNo),
        elapsed_ms: Math.round(elapsedMs) || 0,
        split_ms: Math.round(splitMs) || 0,
        wall_time: wallTime.toISOString(),
        source: source || null,
        photo: photo || null
      });
      if(error) throw error;
    }catch(e){
      console.error('บันทึกรอบไป Supabase ไม่สำเร็จ:', e);
      showToast('บันทึกรอบไป Supabase ไม่สำเร็จ');
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

      athletes = athRows.map(r => ({ id:r.id, name:r.name, color:r.color, count:0, laps:[] }));
      logEntries = lapRows.map(r => ({
        time: r.elapsed_ms, athleteName: r.athlete_name, lapNo: (r.lap_no==null ? '-' : r.lap_no),
        split: r.split_ms, source: r.source, wallTime: new Date(r.wall_time), photo: r.photo
      }));
      lapRows.forEach(r=>{
        if(!r.athlete_id) return;
        const a = athletes.find(x=>x.id===r.athlete_id);
        if(a){ a.count++; a.laps.push({ t:r.elapsed_ms, split:r.split_ms, wallTime:new Date(r.wall_time), photo:r.photo }); }
      });
      if(logEntries.length){
        sessionElapsed = Math.max.apply(null, logEntries.map(e=>e.time));
      }
    }catch(e){
      console.error('โหลดข้อมูลจาก Supabase ไม่สำเร็จ:', e);
      setSyncStatus('โหลดข้อมูลจาก Supabase ไม่สำเร็จ — เริ่มเซสชันใหม่');
    }
  }

  // ---------- camera ----------
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
      autoBtn.style.display = 'inline-flex';
      posRow.style.display = 'block';
      sensRow.style.display = 'block';
      cdRow.style.display = 'block';
      meterWrap.style.display = 'block';
      resizeOverlay();
      requestAnimationFrame(processLoop);
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
    autoBtn.style.display = 'none';
    posRow.style.display = 'none';
    sensRow.style.display = 'none';
    cdRow.style.display = 'none';
    meterWrap.style.display = 'none';
    prevFrame = null;
  }
  camBtn.addEventListener('click', startCamera);
  switchBtn.addEventListener('click', async ()=>{
    facing = facing === 'environment' ? 'user' : 'environment';
    if(stream){ stream.getTracks().forEach(t=>t.stop()); }
    stream = null;
    await startCamera();
  });
  autoBtn.addEventListener('click', ()=>{
    autoMode = !autoMode;
    autoBtn.textContent = "โหมดอัตโนมัติ: " + (autoMode ? "เปิด" : "ปิด");
    autoBtn.classList.toggle('active', autoMode);
  });
  autoBtn.classList.add('active');

  function resizeOverlay(){
    const rect = video.getBoundingClientRect();
    overlay.width = rect.width; overlay.height = rect.height;
  }
  window.addEventListener('resize', resizeOverlay);

  posSlider.addEventListener('input', ()=> posVal.textContent = posSlider.value + "%");
  sensSlider.addEventListener('input', ()=> sensVal.textContent = sensSlider.value);
  cdSlider.addEventListener('input', ()=> cdVal.textContent = (cdSlider.value/10).toFixed(1) + "s");

  let lastProcTime = 0;
  function processLoop(ts){
    if(stream){
      if(!lastProcTime || ts - lastProcTime > 66){ // ~15fps
        lastProcTime = ts;
        try{ analyzeFrame(); }catch(e){}
      }
      drawOverlay();
    }
    requestAnimationFrame(processLoop);
  }

  function analyzeFrame(){
    if(video.readyState < 2) return;
    procCtx.drawImage(video, 0, 0, procW, procH);
    const linePct = posSlider.value/100;
    const bandH = Math.max(4, Math.round(procH*0.08));
    const y0 = Math.max(0, Math.round(linePct*procH - bandH/2));
    const y1 = Math.min(procH, y0+bandH);
    const img = procCtx.getImageData(0, y0, procW, y1-y0);
    const data = img.data;

    let score = 0, count = 0;
    if(prevFrame && prevFrame.length === data.length){
      for(let i=0;i<data.length;i+=16){ // sample sparsely
        score += Math.abs(data[i]-prevFrame[i]);
        count++;
      }
    }
    prevFrame = data;
    const avgDiff = count ? score/count : 0;
    const threshold = Number(sensSlider.value);
    const cooldownMs = Number(cdSlider.value)*100;

    const meterPct = Math.min(100, (avgDiff/ (threshold*3)) *100);
    meterFill.style.width = meterPct + "%";
    meterThresh.style.left = Math.min(97,(threshold/(threshold*3))*100) + "%";

    const now = performance.now();
    const above = avgDiff > threshold;
    if(above && !wasAbove && (now-lastTriggerTime) > cooldownMs){
      lastTriggerTime = now;
      if(autoMode){
        const capture = { photo: capturePhoto(), wallTime: new Date() };
        triggerLap('auto', capture);
      }
      flashLine = true; flashLineTime = now;
    }
    wasAbove = above;
  }

  let flashLine = false, flashLineTime = 0;
  function drawOverlay(){
    const ctx = overlay.getContext('2d');
    const w = overlay.width, h = overlay.height;
    if(!w||!h) return;
    ctx.clearRect(0,0,w,h);
    const linePct = posSlider.value/100;
    const y = linePct*h;
    const flashActive = flashLine && (performance.now()-flashLineTime < 350);
    ctx.strokeStyle = flashActive ? '#3ddc84' : 'rgba(255,68,56,0.9)';
    ctx.lineWidth = flashActive ? 5 : 2.5;
    ctx.setLineDash([10,8]);
    ctx.beginPath();
    ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
    ctx.setLineDash([]);
    if(flashActive){
      ctx.fillStyle = 'rgba(61,220,132,0.12)';
      ctx.fillRect(0, y-24, w, 48);
    } else {
      flashLine = false;
    }
  }

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
    athletes.forEach(a=>{ a.count=0; a.laps=[]; });
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
    const a = { id, name, color, count:0, laps:[] };
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
    a.laps.push({t, split, wallTime, photo});
    logEntries.push({ time:t, athleteName:a.name, lapNo:a.count, split, source:sourceLabel, wallTime, photo });
    renderAthletes(a.id);
    renderLog();
    beep();
    showToast((a.name)+" — รอบที่ "+a.count);
    persistLapEntry({ athleteId:a.id, athleteName:a.name, lapNo:a.count, elapsedMs:t, splitMs:split, wallTime, source:sourceLabel, photo });
  }

  function renderAthletes(flashId){
    athleteListEl.innerHTML = '';
    emptyHint.style.display = athletes.length ? 'none' : 'block';
    athletes.forEach(a=>{
      const el = document.createElement('div');
      el.className = 'athlete' + (flashId===a.id ? ' flash' : '');
      const lastSplit = a.laps.length ? fmtTime(a.laps[a.laps.length-1].split) : '—';
      el.innerHTML = `
        <div class="swatch" style="background:${a.color}"></div>
        <div class="info">
          <div class="name">${escapeHtml(a.name)}</div>
          <div class="split tabular">รอบล่าสุด ${lastSplit}</div>
        </div>
        <div>
          <div class="count tabular" style="color:${a.color}">${a.count}</div>
          <div class="count-label">รอบ</div>
        </div>
        <div class="actions">
          <button class="btn-ghost btn-plus" data-id="${a.id}">+1</button>
          <button class="btn-ghost btn-del" data-id="${a.id}">✕</button>
        </div>`;
      athleteListEl.appendChild(el);
    });
    athleteListEl.querySelectorAll('.btn-plus').forEach(b=>{
      b.addEventListener('click', ()=>{
        const a = athletes.find(x=>x.id==b.dataset.id);
        if(a) lapForAthlete(a, 'manual', { photo: capturePhoto(), wallTime: new Date() });
      });
    });
    athleteListEl.querySelectorAll('.btn-del').forEach(b=>{
      b.addEventListener('click', ()=> removeAthlete(b.dataset.id));
    });
  }
  function escapeHtml(s){ const d=document.createElement('div'); d.textContent=s; return d.innerHTML; }

  // ---------- auto trigger -> assign ----------
  function triggerLap(source, capture){
    capture = capture || { photo: capturePhoto(), wallTime: new Date() };
    if(athletes.length === 0){
      const entry = { time: currentElapsed(), athleteName:'(ไม่ระบุ)', lapNo:'-', split:0, source, wallTime: capture.wallTime, photo: capture.photo };
      logEntries.push(entry);
      renderLog();
      beep();
      showToast("ตรวจพบการวิ่งผ่าน — ยังไม่มีนักกีฬาในระบบ");
      persistLapEntry({ athleteId:null, athleteName:entry.athleteName, lapNo:'-', elapsedMs:entry.time, splitMs:0, wallTime:entry.wallTime, source, photo:entry.photo });
      return;
    }
    if(athletes.length === 1){
      lapForAthlete(athletes[0], source, capture);
      return;
    }
    openAssignModal(capture);
  }

  let modalStart = 0, modalRAF = null;
  function openAssignModal(capture){
    assignGrid.innerHTML = '';
    const modalPhoto = document.getElementById('modalPhoto');
    if(capture && capture.photo){
      modalPhoto.src = capture.photo;
      modalPhoto.style.display = 'block';
    } else {
      modalPhoto.style.display = 'none';
    }
    athletes.forEach(a=>{
      const btn = document.createElement('button');
      btn.textContent = a.name + " (" + a.count + ")";
      btn.style.borderLeft = "4px solid " + a.color;
      btn.addEventListener('click', ()=>{ closeAssignModal(); lapForAthlete(a, 'auto-confirmed', capture); });
      assignGrid.appendChild(btn);
    });
    const unkBtn = document.createElement('button');
    unkBtn.textContent = "ไม่ระบุ / ข้าม";
    unkBtn.style.gridColumn = '1 / -1';
    unkBtn.addEventListener('click', ()=>{
      closeAssignModal();
      const entry = { time: currentElapsed(), athleteName:'(ไม่ระบุ)', lapNo:'-', split:0, source:'auto-skipped', wallTime: capture.wallTime, photo: capture.photo };
      logEntries.push(entry);
      renderLog();
      persistLapEntry({ athleteId:null, athleteName:entry.athleteName, lapNo:'-', elapsedMs:entry.time, splitMs:0, wallTime:entry.wallTime, source:entry.source, photo:entry.photo });
    });
    assignGrid.appendChild(unkBtn);

    assignModal.classList.add('show');
    modalStart = performance.now();
    const DURATION = 5000;
    function tick(){
      const pct = Math.max(0, 1-(performance.now()-modalStart)/DURATION);
      modalTimeoutFill.style.width = (pct*100)+"%";
      if(pct<=0){
        closeAssignModal();
        const entry = { time: currentElapsed(), athleteName:'(ไม่ระบุ)', lapNo:'-', split:0, source:'auto-timeout', wallTime: capture.wallTime, photo: capture.photo };
        logEntries.push(entry);
        renderLog();
        persistLapEntry({ athleteId:null, athleteName:entry.athleteName, lapNo:'-', elapsedMs:entry.time, splitMs:0, wallTime:entry.wallTime, source:entry.source, photo:entry.photo });
        return;
      }
      modalRAF = requestAnimationFrame(tick);
    }
    tick();
  }
  function closeAssignModal(){
    assignModal.classList.remove('show');
    cancelAnimationFrame(modalRAF);
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

  // ---------- init ----------
  (async function init(){
    initSupabase();
    await loadState();
    renderAthletes();
    renderLog();
    sessionTimerEl.textContent = fmtTime(sessionElapsed);
  })();
})();
