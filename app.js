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
  let athletes = []; // {id,name,color,count,laps:[{t,split,wallTime,photo,dbId}],faceDescriptors,lastAutoCountAt}
  let logEntries = []; // {time, athleteName, lapNo, split, wallTime, photo, source, dbId, confirmedFace}
  let sessionRunning = false, sessionStart = 0, sessionElapsed = 0, timerRAF = null;
  let autoMode = true;

  // AI face-recognition state
  let faceApiReady = false, faceApiLoading = false, faceApiFailed = false;
  let isScanningFaces = false;
  let enrollmentInProgress = false;
  let lastFaceBoxes = []; // [{box, label, color}] from the continuous scan — for the overlay only
  const modelStatusEl = document.getElementById('modelStatus');
  function setModelStatus(msg){
    if(!msg){ modelStatusEl.style.display = 'none'; return; }
    modelStatusEl.textContent = msg;
    modelStatusEl.style.display = 'block';
  }

  const COLORS = ["#ff4438","#3ddc84","#ffb020","#4ea1ff","#c78bff","#ff7ab8","#7fffd4","#ffd166"];

  // ---------- elements ----------
  const video = document.getElementById('video');
  const overlay = document.getElementById('overlay');
  const placeholder = document.getElementById('placeholder');
  const camBtn = document.getElementById('camBtn');
  const switchBtn = document.getElementById('switchBtn');
  const autoBtn = document.getElementById('autoBtn');
  const cdRow = document.getElementById('cdRow'), cdSlider = document.getElementById('cdSlider'), cdVal = document.getElementById('cdVal');
  const faceRow = document.getElementById('faceRow'), faceSlider = document.getElementById('faceSlider'), faceVal = document.getElementById('faceVal');
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

  const FACE_MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js/weights/";
  async function loadFaceModel(){
    faceApiLoading = true;
    setModelStatus("กำลังโหลดโมเดล AI จดจำใบหน้า (ครั้งแรกอาจใช้เวลาสักครู่)...");
    try{
      await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL);
      await faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODEL_URL);
      await faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URL);
      faceApiReady = true;
      faceApiLoading = false;
      setModelStatus("");
      showToast("โหลด AI จดจำใบหน้าสำเร็จ — ลงทะเบียนหน้านักกีฬาได้แล้ว");
    }catch(e){
      console.error('โหลดโมเดล AI จดจำใบหน้าไม่สำเร็จ:', e);
      faceApiFailed = true;
      faceApiLoading = false;
      setModelStatus("โหลด AI จดจำใบหน้าไม่สำเร็จ — เชื่อมต่ออินเทอร์เน็ตแล้วลองเปิดกล้องใหม่");
    }
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
      const { error } = await sb.from('athletes').insert({ id:a.id, session_id: sessionId, name:a.name, color:a.color, face_descriptors: a.faceDescriptors || [] });
      if(error) throw error;
    }catch(e){
      console.error('บันทึกนักกีฬาไป Supabase ไม่สำเร็จ:', e);
      showToast('บันทึกนักกีฬาไป Supabase ไม่สำเร็จ');
    }
  }
  async function persistUpdateAthleteFace(a){
    if(!supabaseReady) return;
    try{
      const { error } = await sb.from('athletes').update({ face_descriptors: a.faceDescriptors || [] }).eq('id', a.id);
      if(error) throw error;
    }catch(e){
      console.error('บันทึกใบหน้าไป Supabase ไม่สำเร็จ:', e);
      showToast('บันทึกใบหน้าไป Supabase ไม่สำเร็จ (เก็บไว้ในเครื่องนี้ชั่วคราว)');
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

      athletes = athRows.map(r => ({ id:r.id, name:r.name, color:r.color, count:0, laps:[], faceDescriptors: r.face_descriptors || [], lastAutoCountAt:0 }));
      logEntries = lapRows.map(r => ({
        time: r.elapsed_ms, athleteName: r.athlete_name, lapNo: (r.lap_no==null ? '-' : r.lap_no),
        split: r.split_ms, source: r.source, wallTime: new Date(r.wall_time), photo: r.photo, dbId: r.id,
        confirmedFace: !!(r.source && r.source.includes('face'))
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
      cdRow.style.display = 'block';
      faceRow.style.display = 'block';
      resizeOverlay();
      requestAnimationFrame(processLoop);
      if(!faceApiReady && !faceApiLoading && !faceApiFailed) loadFaceModel();
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
    cdRow.style.display = 'none';
    faceRow.style.display = 'none';
    lastFaceBoxes = [];
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
    autoBtn.textContent = "นับอัตโนมัติ: " + (autoMode ? "เปิด" : "ปิด");
    autoBtn.classList.toggle('active', autoMode);
  });
  autoBtn.classList.add('active');

  function resizeOverlay(){
    const rect = video.getBoundingClientRect();
    overlay.width = rect.width; overlay.height = rect.height;
  }
  window.addEventListener('resize', resizeOverlay);

  cdSlider.addEventListener('input', ()=> cdVal.textContent = cdSlider.value + "s");
  faceSlider.addEventListener('input', ()=> faceVal.textContent = faceSlider.value);

  let lastFaceScanTime = 0;
  function processLoop(ts){
    if(stream){
      // การนับรอบทั้งหมดทำงานเฉพาะตอนกด "เริ่มจับเวลา" แล้วเท่านั้น
      // ระหว่างตั้งกล้อง/ลงทะเบียนใบหน้าก่อนเริ่ม จะไม่มีอะไรมาแย่งประมวลผลกับ AI จดจำใบหน้า
      if(sessionRunning && faceApiReady && !isScanningFaces && !enrollmentInProgress &&
         (!lastFaceScanTime || ts - lastFaceScanTime > 350)){
        lastFaceScanTime = ts;
        scanFacesContinuous();
      }
      drawOverlay();
    }
    requestAnimationFrame(processLoop);
  }

  function getCoverTransform(){
    const vw = video.videoWidth, vh = video.videoHeight;
    const dw = overlay.width, dh = overlay.height;
    if(!vw || !vh || !dw || !dh) return null;
    const scale = Math.max(dw/vw, dh/vh);
    return { scale, offsetX: (dw - vw*scale)/2, offsetY: (dh - vh*scale)/2, vw, vh };
  }

  function euclideanDistance(a, b){
    let sum = 0;
    for(let i=0;i<a.length;i++){ const d = a[i]-b[i]; sum += d*d; }
    return Math.sqrt(sum);
  }
  function matchFace(descriptor){
    let best = null, bestDist = Infinity;
    athletes.forEach(a=>{
      (a.faceDescriptors||[]).forEach(raw=>{
        const fd = normalizeFaceSample(raw);
        const dist = euclideanDistance(descriptor, fd.descriptor);
        if(dist < bestDist){ bestDist = dist; best = a; }
      });
    });
    return { athlete: best, distance: bestDist };
  }

  // สแกนหน้าทั้งเฟรมต่อเนื่อง — นี่คือกลไกหลักในการนับรอบ (ไม่มีเส้นชัยแล้ว)
  // พบหน้าที่จำได้ + พ้นระยะเว้นของคนนั้นแล้ว = นับรอบให้ทันที
  async function scanFacesContinuous(){
    if(isScanningFaces || !faceApiReady || video.readyState < 2) return;
    isScanningFaces = true;
    try{
      const detections = await faceapi
        .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize:224, scoreThreshold:0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptors();

      const threshold = Number(faceSlider.value)/100;
      const cooldownMs = Number(cdSlider.value) * 1000;
      const now = performance.now();
      const boxes = [];

      detections.forEach(d=>{
        const { athlete, distance } = matchFace(d.descriptor);
        const matched = athlete && distance < threshold;
        boxes.push({ box: d.detection.box, label: matched ? athlete.name : '?', color: matched ? athlete.color : '#ff4438' });
        if(matched && autoMode){
          const lastAt = athlete.lastAutoCountAt || 0;
          if(now - lastAt > cooldownMs){
            athlete.lastAutoCountAt = now;
            const photo = capturePhoto();
            lapForAthlete(athlete, 'face-auto', { photo, wallTime: new Date(), confirmedFace:true, faceDistance: distance });
          }
        }
      });
      lastFaceBoxes = boxes;
    }catch(e){ /* ignore — this is a background aid, never blocks the app */ }
    isScanningFaces = false;
  }

  // แปลงตัวอย่างใบหน้าให้เป็นรูปแบบเดียวกันเสมอ {descriptor, photo}
  // (รองรับข้อมูลเก่าที่เคยเก็บเป็น array ดิบๆ ก่อนมีฟีเจอร์เก็บรูปตัวอย่าง)
  function normalizeFaceSample(s){
    if(Array.isArray(s)) return { descriptor: s, photo: null };
    return s;
  }

  // ลงทะเบียนใบหน้าให้นักกีฬาคนหนึ่ง จากเฟรมกล้องปัจจุบัน (ต้องเห็นหน้าชัดๆ ใกล้ๆ)
  async function tryEnrollFace(a, opts){
    const silent = opts && opts.silent;
    if(!faceApiReady){ if(!silent) showToast("AI จดจำใบหน้ายังโหลดไม่เสร็จ ลองอีกครั้งสักครู่"); return; }
    if(!stream || video.readyState < 2){ if(!silent) showToast("เปิดกล้องก่อนถึงจะลงทะเบียนใบหน้าได้"); return; }
    if(enrollmentInProgress){ if(!silent) showToast("กำลังลงทะเบียนอยู่ รอสักครู่"); return; }
    enrollmentInProgress = true;
    try{
      const result = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize:320, scoreThreshold:0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
      if(!result){
        if(!silent) showToast("ไม่เจอใบหน้าชัดเจน — ให้ " + a.name + " หันหน้าเข้ากล้องใกล้ๆ แล้วลองใหม่");
        return;
      }
      const photo = capturePhoto();
      a.faceDescriptors = a.faceDescriptors || [];
      a.faceDescriptors.push({ descriptor: Array.from(result.descriptor), photo });
      if(a.faceDescriptors.length > 5) a.faceDescriptors = a.faceDescriptors.slice(-5); // กันสะสมมากเกินไป (ลบเองได้ในหน้าจัดการใบหน้า)
      renderAthletes();
      persistUpdateAthleteFace(a);
      showToast("ลงทะเบียนใบหน้า " + a.name + " สำเร็จ (" + a.faceDescriptors.length + " ตัวอย่าง)");
    }catch(e){
      console.error('ลงทะเบียนใบหน้าไม่สำเร็จ:', e);
      if(!silent) showToast("ลงทะเบียนใบหน้าไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      enrollmentInProgress = false;
    }
  }

  // ---------- หน้าจัดการใบหน้า (ดู/ลบ/ถ่ายเพิ่ม) ----------
  let faceModalAthleteId = null;
  const faceModalEl = document.getElementById('faceModal');
  const faceModalTitleEl = document.getElementById('faceModalTitle');
  const faceModalGridEl = document.getElementById('faceModalGrid');

  function openFaceModal(a){
    faceModalAthleteId = a.id;
    faceModalTitleEl.textContent = "จัดการใบหน้า — " + a.name;
    renderFaceModalGrid();
    faceModalEl.classList.add('show');
  }
  function closeFaceModal(){
    faceModalEl.classList.remove('show');
    faceModalAthleteId = null;
  }
  function renderFaceModalGrid(){
    const a = athletes.find(x=>x.id===faceModalAthleteId);
    if(!a){ faceModalGridEl.innerHTML=''; return; }
    const samples = a.faceDescriptors || [];
    if(!samples.length){
      faceModalGridEl.innerHTML = '<div class="empty-hint" style="grid-column:1/-1;">ยังไม่มีตัวอย่างใบหน้า — กด "ถ่ายเพิ่ม" ด้านล่าง</div>';
      return;
    }
    faceModalGridEl.innerHTML = samples.map((raw, idx)=>{
      const s = normalizeFaceSample(raw);
      const inner = s.photo ? `<img src="${s.photo}">` : `<div class="thumb-empty">👤</div>`;
      return `<div class="face-thumb">${inner}<button class="del" data-idx="${idx}">✕</button></div>`;
    }).join('');
    faceModalGridEl.querySelectorAll('.del').forEach(btn=>{
      btn.addEventListener('click', ()=>{
        const a2 = athletes.find(x=>x.id===faceModalAthleteId);
        if(!a2) return;
        const idx = Number(btn.dataset.idx);
        a2.faceDescriptors.splice(idx, 1);
        renderFaceModalGrid();
        renderAthletes();
        persistUpdateAthleteFace(a2);
      });
    });
  }
  document.getElementById('faceCaptureBtn').addEventListener('click', async ()=>{
    const a = athletes.find(x=>x.id===faceModalAthleteId);
    if(!a) return;
    await tryEnrollFace(a);
    renderFaceModalGrid();
  });
  document.getElementById('faceModalCloseBtn').addEventListener('click', closeFaceModal);
  faceModalEl.addEventListener('click', (e)=>{ if(e.target===faceModalEl) closeFaceModal(); });

  function drawOverlay(){
    const ctx = overlay.getContext('2d');
    const w = overlay.width, h = overlay.height;
    if(!w||!h) return;
    ctx.clearRect(0,0,w,h);

    if(!sessionRunning){
      // ยังไม่กด "เริ่มจับเวลา" — ไม่วาดกรอบใดๆ เพื่อไม่ให้ตีกับตอนลงทะเบียนใบหน้า
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(0, h/2-18, w, 36);
      ctx.fillStyle = 'rgba(242,241,234,0.95)';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('กด "เริ่มจับเวลา" เพื่อเริ่มให้ AI จำหน้าและนับรอบ', w/2, h/2+5);
      ctx.textAlign = 'left';
      return;
    }

    if(faceApiReady && lastFaceBoxes.length){
      const t = getCoverTransform();
      if(t){
        lastFaceBoxes.forEach(item=>{
          const box = item.box;
          const dx = box.x*t.scale + t.offsetX, dy = box.y*t.scale + t.offsetY;
          const dw2 = box.width*t.scale, dh2 = box.height*t.scale;
          ctx.strokeStyle = item.color || 'rgba(255,68,56,0.85)';
          ctx.lineWidth = 2;
          ctx.strokeRect(dx, dy, dw2, dh2);
          ctx.font = '11px sans-serif';
          ctx.fillStyle = item.color || 'rgba(255,68,56,0.85)';
          ctx.fillText(item.label || '?', dx+3, Math.max(11, dy-4));
        });
      }
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
      // เริ่มตรวจจับใหม่แบบสะอาด กันของเก่าตอนตั้งกล้อง/ลงทะเบียนใบหน้าทำให้นับพลาดจังหวะแรก
      lastFaceScanTime = 0;
      lastFaceBoxes = [];
      athletes.forEach(a=>{ a.lastAutoCountAt = 0; });
      tickTimer();
    } else {
      sessionRunning = false;
      sessionElapsed += performance.now()-sessionStart;
      startBtn.textContent = "เริ่มต่อ";
      cancelAnimationFrame(timerRAF);
      lastFaceBoxes = [];
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
    const a = { id, name, color, count:0, laps:[], faceDescriptors:[], lastAutoCountAt:0 };
    athletes.push(a);
    renderAthletes();
    persistAddAthlete(a);
    // ลองลงทะเบียนใบหน้าอัตโนมัติถ้ากล้องเปิดอยู่และเห็นหน้าคนนั้นชัดเจน (ให้หันหน้าเข้ากล้องก่อนกด "+ เพิ่ม")
    tryEnrollFace(a, { silent:true });
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
    const logObj = { time:t, athleteName:a.name, lapNo:a.count, split, source:sourceLabel, wallTime, photo, confirmedFace: !!(capture && capture.confirmedFace), dbId:null };
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
      const hasFace = a.faceDescriptors && a.faceDescriptors.length;
      const faceBadge = hasFace
        ? `<span class="face-badge on">●จำหน้าแล้ว (${a.faceDescriptors.length})</span>`
        : `<span class="face-badge off">●ยังไม่จำหน้า</span>`;
      el.innerHTML = `
        <div class="swatch" style="background:${a.color}"></div>
        <div class="info">
          <div class="name">${escapeHtml(a.name)}</div>
          <div class="split tabular">รอบล่าสุด ${lastSplit} · ${faceBadge}</div>
        </div>
        <div>
          <div class="count tabular" style="color:${a.color}">${a.count}</div>
          <div class="count-label">รอบ</div>
        </div>
        <div class="actions">
          <button class="btn-ghost btn-face" data-id="${a.id}" title="จัดการใบหน้า">📷</button>
          <button class="btn-ghost btn-plus" data-id="${a.id}">+1</button>
          <button class="btn-ghost btn-minus" data-id="${a.id}">−1</button>
          <button class="btn-ghost btn-del" data-id="${a.id}">✕</button>
        </div>`;
      athleteListEl.appendChild(el);
    });
    athleteListEl.querySelectorAll('.btn-face').forEach(b=>{
      b.addEventListener('click', ()=>{
        const a = athletes.find(x=>x.id==b.dataset.id);
        if(a) openFaceModal(a);
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
          <div class="top">${escapeHtml(entry.athleteName)} ${entry.lapNo!=='-'?'· รอบ '+entry.lapNo:''} ${entry.confirmedFace?'<span style="color:var(--lane-green)">✓จำหน้า</span>':''}</div>
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
    await loadState();
    renderAthletes();
    renderLog();
    sessionTimerEl.textContent = fmtTime(sessionElapsed);
  })();
})();
