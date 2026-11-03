/* ============================================================
   CONFIG
============================================================ */
const SHEETDB_URL = "https://sheetdb.io/api/v1/s8jmt1jiwzzka";
const WEBHOOK_URL = "";

const PASSWORDS = { gad: 'oneandonly', admin: 'adminpw' };
const DEFENSE_KEY = 'safetrack_defense_v1';

const CATEGORIES = [
  'Gender Microaggression / Teasing',
  'Task Stereotyping (Lab/Projects)',
  'Verbal Harassment / Slurs',
  'Exclusion from Activities',
  'Other Equity Concern'
];
const COHORTS = ['BSIS', 'BSIT', 'BSCS', 'BSDSA', 'BLIS'];
const INTENTS = ['Unaware', 'Intentional', 'Unsure'];
const STATUSES = ['New', 'In Review', 'Resolved'];

/* ---------- STATE ---------- */
let currentRole = 'student';
let pendingRole = null;
let tickets = [];
let activeTicketId = null;
let currentView = 'wf01';
let draft = freshDraft();
let hasLoaded = false;          // true once the first fetch succeeds
let lastSig = '';               // signature of last rendered dataset (skip no-op re-renders)
let submitting = false;         // guards against double submission
let justSubmittedId = null;     // ticket whose code hasn't been saved yet
let codeSaved = false;
const busyIds = new Set();      // tickets with an in-flight status change
const triageFilter = { q:'', status:'' };

function freshDraft(){
  return { category:'', intent:'', cohort:'BSIS', location:'Room 1', desc:'', metadataStripped:false, fileName:'' };
}

/* ---------- HELPERS ---------- */
function esc(s){
  return String(s===null||s===undefined?'':s).replace(/[&<>"']/g, c => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]
  ));
}
function pad2(n){ return String(n).padStart(2,'0'); }
function nowStamp(){
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function todayStamp(){ return nowStamp().slice(0,10); }

function newTicketId(){
  let id, guard = 0;
  do {
    id = 'SAFE-' + Math.floor(1000 + Math.random()*9000);
    guard++;
  } while (tickets.some(t => t.id === id) && guard < 500);
  return id;
}

let toastTimer = null;
function toast(msg, tone){
  // One reusable live region instead of stacking overlapping toasts
  let el = document.getElementById('toast');
  if (!el){
    el = document.createElement('div');
    el.id = 'toast';
    el.className = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.dataset.tone = tone || '';
  el.classList.remove('is-out');
  el.style.animation = 'none'; void el.offsetHeight; el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>el.classList.add('is-out'), Math.max(2800, msg.length * 55));
}

function setSync(state){
  const el = document.getElementById('syncStatus');
  if (!el) return;
  el.dataset.state = state;
  const label = el.querySelector('.sync-label');
  if (state === 'syncing') label.textContent = 'Syncing…';
  else if (state === 'error') label.textContent = 'Offline';
  else {
    const d = new Date();
    label.textContent = 'Synced ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
}

function setBusy(btn, busy, busyText){
  if (!btn) return;
  if (busy){
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.disabled = true;
    btn.textContent = busyText || 'Working…';
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.textContent = btn.dataset.label;
  }
}

/* ---------- SHEETDB LAYER ---------- */
function rowToTicket(r){
  let chat = [];
  if (r.chat) {
    try {
      const parsed = JSON.parse(r.chat);
      if (Array.isArray(parsed)) chat = parsed;
    } catch (e) { /* leave chat as [] */ }
  }
  return {
    id: (r.id || '').toString().toUpperCase(),
    date: r.date || nowStamp(),
    cohort: r.cohort || 'BSIS',
    category: r.category || 'Other Equity Concern',
    intent: INTENTS.includes(r.intent) ? r.intent : 'Unsure',
    location: r.location || 'Room 1',
    desc: r.desc || '',
    status: STATUSES.includes(r.status) ? r.status : 'New',
    metadataStripped: String(r.metadataStripped).toLowerCase() === 'true',
    remarks: r.remarks || 'Report received. Awaiting GAD coordinator review.',
    chat: chat
  };
}

async function fetchTickets(){
  const res = await fetch(SHEETDB_URL, { cache: 'no-store' });
  if (!res.ok) throw new Error('SheetDB fetch failed: ' + res.status);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('Unexpected SheetDB response');
  return rows.map(rowToTicket).filter(t => t.id);
}

async function createTicket(ticket){
  const payload = {
    id: ticket.id,
    date: ticket.date,
    cohort: ticket.cohort,
    category: ticket.category,
    intent: ticket.intent,
    location: ticket.location,
    desc: ticket.desc,
    status: ticket.status,
    metadataStripped: String(ticket.metadataStripped),
    remarks: ticket.remarks,
    chat: JSON.stringify(ticket.chat || [])
  };
  const res = await fetch(SHEETDB_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: [payload] })
  });
  if (!res.ok) throw new Error('SheetDB create failed: ' + res.status);
}

async function updateTicket(id, patch){
  const body = { ...patch };
  if (Array.isArray(body.chat)) body.chat = JSON.stringify(body.chat);
  if (typeof body.metadataStripped === 'boolean') body.metadataStripped = String(body.metadataStripped);

  const res = await fetch(`${SHEETDB_URL}/id/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: body })
  });
  if (!res.ok) throw new Error('SheetDB update failed: ' + res.status);
}

async function deleteAllTickets(){
  const res = await fetch(SHEETDB_URL, { method: 'DELETE' });
  if (!res.ok) throw new Error('SheetDB delete-all failed: ' + res.status);
}

async function refreshData(showToast){
  setSync('syncing');
  try {
    const next = await fetchTickets();
    const sig = JSON.stringify(next);
    const changed = sig !== lastSig || !hasLoaded;
    tickets = next; lastSig = sig; hasLoaded = true;
    // Skip re-rendering when nothing changed, so background polling never
    // steals focus, closes open dropdowns, or resets scroll positions.
    if (changed || showToast) renderAll();
    setSync('ok');
    if (showToast) toast(changed ? 'Data refreshed.' : 'Already up to date.');
  } catch (e) {
    console.error(e);
    setSync('error');
    if (showToast) toast('Could not refresh — check your connection.', 'error');
  }
}

/* ---------- RESET ---------- */
async function resetDemoData(){
  if (!confirm('Reset ALL data? This deletes every report and chat message in the shared Google Sheet — for everyone, on every device. This cannot be undone.')) return;
  try {
    await deleteAllTickets();
    tickets = [];
    lastSig = '';
    activeTicketId = null;
    draft = freshDraft();
    goRoleHome();
    toast('All shared data cleared.');
  } catch (e) {
    console.error(e);
    toast('Could not reset data — check your connection.', 'error');
  }
}

/* ---------- ROLE GATING ---------- */
function requestRoleSwitch(role){
  if (role === currentRole) return;
  if (role === 'student'){ applyRole('student'); return; }
  if (!PASSWORDS.hasOwnProperty(role)){ document.getElementById('roleSelect').value = currentRole; return; }
  pendingRole = role;
  const subtitle = role === 'gad' ? 'Enter the GAD Coordinator password.' : 'Enter the College Admin password.';
  document.getElementById('authModalSubtitle').textContent = subtitle;
  const input = document.getElementById('authPasswordInput');
  input.value = '';
  const err = document.getElementById('authError');
  err.textContent = ''; err.classList.add('hidden');
  document.getElementById('authModal').classList.remove('hidden');
  setTimeout(()=>input.focus(), 40);
}
function submitPassword(){
  if (!pendingRole){ cancelPassword(); return; }
  const input = document.getElementById('authPasswordInput');
  const err = document.getElementById('authError');
  if (input.value === PASSWORDS[pendingRole]){
    const next = pendingRole;
    pendingRole = null;
    document.getElementById('authModal').classList.add('hidden');
    applyRole(next);
  } else {
    err.textContent = 'Incorrect password. Please try again.';
    err.classList.remove('hidden');
    input.value = ''; input.focus();
  }
}
function cancelPassword(){
  pendingRole = null;
  document.getElementById('authModal').classList.add('hidden');
  document.getElementById('roleSelect').value = currentRole;
}
function applyRole(role){
  currentRole = role;
  document.getElementById('roleSelect').value = role;
  activeTicketId = null;
  goRoleHome();
}
function goRoleHome(){
  if (currentRole === 'student') go('wf01');
  else go('wf05');
}
function updateRoleChrome(){
  const badge = document.getElementById('roleBadge');
  const tabHome = document.getElementById('tab-wf01');
  const tabReport = document.getElementById('tab-report');
  const tabMyTicket = document.getElementById('tab-wf04');
  const tabStaff = document.getElementById('tab-wf05');
  const resetBtn = document.getElementById('resetBtn');

  if (currentRole === 'student'){
    badge.textContent = 'Student (Anonymous)'; badge.className = 'pill pill-violet';
    tabHome.classList.remove('hidden'); tabReport.classList.remove('hidden');
    tabMyTicket.classList.remove('hidden'); tabStaff.classList.add('hidden');
    resetBtn.classList.add('hidden');
  } else if (currentRole === 'gad'){
    badge.textContent = 'GAD Coordinator'; badge.className = 'pill pill-cyan';
    tabHome.classList.add('hidden'); tabReport.classList.add('hidden');
    tabMyTicket.classList.add('hidden'); tabStaff.classList.remove('hidden');
    resetBtn.classList.remove('hidden');
  } else {
    badge.textContent = 'College Admin'; badge.className = 'pill pill-pink';
    tabHome.classList.add('hidden'); tabReport.classList.add('hidden');
    tabMyTicket.classList.add('hidden'); tabStaff.classList.remove('hidden');
    resetBtn.classList.add('hidden');
  }
}

const TAB_FOR_VIEW = { wf01:'wf01', wf02:'report', wf03:'report', wf04:'wf04', wf05:'wf05' };
const VIEW_HASH  = { wf01:'home', wf02:'report', wf03:'details', wf04:'ticket', wf05:'dashboard' };
const HASH_VIEW  = Object.fromEntries(Object.entries(VIEW_HASH).map(([k,v])=>[v,k]));
const VIEW_TITLE = { wf01:'Home', wf02:'Make a report (1 of 2)', wf03:'Make a report (2 of 2)', wf04:'My report', wf05:'Staff dashboard' };

function go(view, opts){
  opts = opts || {};
  const isStudent = currentRole === 'student';
  const isGad = currentRole === 'gad';
  const isAdmin = currentRole === 'admin';
  if (isStudent && view === 'wf05') view = 'wf01';
  if ((isGad || isAdmin) && (view === 'wf01' || view === 'wf02' || view === 'wf03')) view = 'wf05';
  if (isAdmin && view === 'wf04') view = 'wf05';
  if (isGad && view === 'wf04' && !activeTicketId) view = 'wf05';
  // Step 2 needs step 1 to be complete (e.g. when arriving via the back button)
  if (view === 'wf03' && (!draft.category || !draft.intent)) view = 'wf02';
  if (!VIEW_HASH[view]) view = 'wf01';

  const prevView = currentView;
  currentView = view;
  if (view !== 'wf04') justSubmittedId = null;

  document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden'));
  const target = document.getElementById('view-'+view);
  if (target) target.classList.remove('hidden');
  document.querySelectorAll('.nav-tab').forEach(b=>{ b.classList.remove('is-active'); b.removeAttribute('aria-current'); });
  const tabId = TAB_FOR_VIEW[view] || 'wf01';
  const tabBtn = document.getElementById('tab-'+tabId);
  if (tabBtn){ tabBtn.classList.add('is-active'); tabBtn.setAttribute('aria-current', 'page'); }
  document.title = VIEW_TITLE[view] + ' – SafeTrack';

  // Browser back/forward support. Only the view name goes in the URL — never a ticket code.
  const hash = '#' + VIEW_HASH[view];
  if (location.hash !== hash){
    if (opts.fromHistory || opts.replace || prevView === view) history.replaceState({ view }, '', hash);
    else history.pushState({ view }, '', hash);
  }

  if (!opts.keepScroll) window.scrollTo({ top:0, behavior:'smooth' });
  renderAll();
  // Refresh on entering views that display shared data
  if (view === 'wf04' || view === 'wf05') refreshData(false);
}
function renderAll(){
  updateRoleChrome();
  if (currentView === 'wf02') renderWF02();
  if (currentView === 'wf03') renderWF03();
  if (currentView === 'wf04') renderWF04();
  if (currentView === 'wf05') renderWF05();
}
function toggleDefenseNotes(on){
  document.body.classList.toggle('show-defense', !!on);
  try { localStorage.setItem(DEFENSE_KEY, on ? '1' : '0'); } catch(e){}
}

/* ---------- WF02 ---------- */
function renderWF02(){
  const catSel = document.getElementById('w2Category');
  const cohortSel = document.getElementById('w2Cohort');
  const locSel = document.getElementById('w2Location');
  if (catSel) catSel.value = draft.category || '';
  if (cohortSel) cohortSel.value = draft.cohort || 'BSIS';
  if (locSel) locSel.value = draft.location || 'Room 1';
  document.querySelectorAll('input[name="w2Intent"]').forEach(r => { r.checked = (r.value === draft.intent); });
}
function gotoStep2(){
  draft.category = document.getElementById('w2Category').value;
  const checked = document.querySelector('input[name="w2Intent"]:checked');
  draft.intent = checked ? checked.value : '';
  draft.cohort = document.getElementById('w2Cohort').value;
  draft.location = document.getElementById('w2Location').value;
  if (!draft.category){
    toast('Please select the type of incident.', 'error');
    flagField('w2Category');
    return;
  }
  if (!draft.intent){
    toast('Please tell us how the behavior seemed to you.', 'error');
    flagField('intentGrid');
    return;
  }
  go('wf03');
}
function flagField(id){
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('is-invalid');
  el.scrollIntoView({ behavior:'smooth', block:'center' });
  const focusable = el.matches('select,input,textarea') ? el : el.querySelector('input');
  if (focusable) focusable.focus({ preventScroll:true });
}
function clearFlag(id){
  const el = document.getElementById(id);
  if (el) el.classList.remove('is-invalid');
}

/* ---------- WF03 ---------- */
function onDescInput(el){
  draft.desc = el.value;
  clearFlag('w3Desc');
  updateDescCount();
}
function updateDescCount(){
  const el = document.getElementById('w3Count');
  if (!el) return;
  const n = (draft.desc || '').trim().length;
  el.textContent = n === 1 ? '1 character' : n + ' characters';
}
function renderWF03(){
  const ta = document.getElementById('w3Desc');
  if (ta) ta.value = draft.desc || '';
  updateDescCount();
  const btn = document.getElementById('submitBtn');
  if (btn && !submitting) setBusy(btn, false);
  const exif = document.getElementById('exifStatus');
  if (exif){
    if (draft.metadataStripped && draft.fileName){
      exif.classList.remove('hidden');
      exif.innerHTML = `<strong>Metadata stripped.</strong> GPS coordinates, device model, capture timestamp and author tags were removed from <span class="mono">${esc(draft.fileName)}</span>. Only the image content is retained.`;
    } else {
      exif.classList.add('hidden'); exif.innerHTML = '';
    }
  }
  const fileInput = document.getElementById('w3File');
  if (fileInput && !draft.fileName) fileInput.value = '';
}
function handleFileChosen(event){
  const file = event.target.files && event.target.files[0];
  const box = document.getElementById('exifStatus');
  if (!file){
    draft.metadataStripped = false; draft.fileName = '';
    if (box){ box.classList.add('hidden'); box.innerHTML = ''; }
    return;
  }
  draft.metadataStripped = true;
  draft.fileName = file.name;
  if (box){
    box.classList.remove('hidden');
    box.innerHTML = `<strong>Metadata stripped.</strong> GPS coordinates, device model, capture timestamp and author tags were removed from <span class="mono">${esc(file.name)}</span>. Only the image content is retained.`;
  }
}

/* ---------- SUBMISSION ---------- */
async function submitReport(){
  if (submitting) return;
  draft.desc = (document.getElementById('w3Desc').value || '').trim();
  if (!draft.category){ toast('Please choose a category first.', 'error'); go('wf02'); return; }
  if (!draft.desc){
    toast('Please describe what happened before submitting.', 'error');
    flagField('w3Desc');
    return;
  }

  const ticket = {
    id: newTicketId(),
    date: nowStamp(),
    cohort: draft.cohort || 'BSIS',
    category: draft.category,
    intent: draft.intent || 'Unsure',
    location: draft.location || 'Room 1',
    desc: draft.desc,
    status: 'New',
    metadataStripped: draft.metadataStripped,
    remarks: 'Report received. Awaiting GAD coordinator review.',
    chat: []
  };

  const submitBtn = document.getElementById('submitBtn');
  submitting = true;
  setBusy(submitBtn, true, 'Submitting…');

  try {
    await createTicket(ticket);
    sendToExternalFunnel(ticket);
    try { tickets = await fetchTickets(); }
    catch (e) { tickets = tickets.filter(t => t.id !== ticket.id).concat([ticket]); }
    activeTicketId = ticket.id;
    justSubmittedId = ticket.id;
    codeSaved = false;
    draft = freshDraft();
    const ta = document.getElementById('w3Desc'); if (ta) ta.value = '';
    const fi = document.getElementById('w3File'); if (fi) fi.value = '';
    const exif = document.getElementById('exifStatus'); if (exif){ exif.classList.add('hidden'); exif.innerHTML = ''; }
    submitting = false;
    setBusy(submitBtn, false);   // was left disabled after a successful submit
    go('wf04', { replace:true });
    toast('Report submitted. Your ticket code is ' + ticket.id);
  } catch (e) {
    console.error(e);
    submitting = false;
    setBusy(submitBtn, false);
    toast('Submission failed — check your connection and try again.', 'error');
  }
}

async function sendToExternalFunnel(ticket){
  if (!WEBHOOK_URL || typeof WEBHOOK_URL !== 'string' || WEBHOOK_URL.trim() === '') return;
  try {
    await fetch(WEBHOOK_URL, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        source:'CCSICT SafeTrack', event:'ticket.created',
        ticket_id: ticket.id, date: ticket.date,
        cohort: ticket.cohort, category: ticket.category,
        perceived_intent: ticket.intent, location: ticket.location,
        status: ticket.status, metadata_stripped: ticket.metadataStripped,
        description: ticket.desc
      })
    });
  } catch(err){ console.warn('SafeTrack: external funnel skipped —', err); }
}

/* ---------- WF04 ---------- */
async function lookupTicket(code){
  if (currentRole !== 'student'){ toast('Ticket lookup is a student feature.'); goRoleHome(); return; }
  let clean = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
  if (/^\d{4}$/.test(clean)) clean = 'SAFE-' + clean;          // "1234" → "SAFE-1234"
  else if (/^SAFE\d{4}$/.test(clean)) clean = 'SAFE-' + clean.slice(4);
  if (!clean){ toast('Please enter a ticket code.', 'error'); return; }
  let offline = false;
  try { tickets = await fetchTickets(); } catch(e){ offline = true; /* fall back to in-memory */ }
  const found = tickets.find(t => t.id === clean);
  if (!found){
    toast(offline
      ? 'Could not reach the database — check your connection and try again.'
      : 'Ticket not found. Please check your code.', 'error');
    return;
  }
  activeTicketId = found.id;
  go('wf04');
}
async function lookupFrom(inputId, btn){
  const input = document.getElementById(inputId);
  setBusy(btn, true, 'Opening…');
  try { await lookupTicket(input ? input.value : ''); }
  finally { setBusy(btn, false); }
}
function lookupFromWf04(){
  lookupFrom('wf04LookupInput', document.getElementById('wf04LookupBtn'));
}
function statusBadgeClass(status){
  if (status === 'Resolved') return 'badge-mint';
  if (status === 'In Review') return 'badge-amber';
  return 'badge-mute';
}
function renderWF04(){
  const body = document.getElementById('wf04Body');
  if (!body) return;

  // Preserve the in-progress message, focus, caret and scroll across re-renders
  const oldInput = document.getElementById('chatInput');
  const pendingText = oldInput ? oldInput.value : '';
  const hadFocus = !!oldInput && document.activeElement === oldInput;
  const caret = hadFocus ? oldInput.selectionStart : null;
  const oldScroll = document.querySelector('.chat-scroll');
  const wasAtBottom = !oldScroll || (oldScroll.scrollHeight - oldScroll.scrollTop - oldScroll.clientHeight < 40);
  const oldScrollTop = oldScroll ? oldScroll.scrollTop : 0;

  const t = tickets.find(x => x.id === activeTicketId);

  if (!t){
    if (currentRole !== 'student'){ body.innerHTML = ''; go('wf05'); return; }
    body.innerHTML = `
      <div class="panel state">
        <h1 class="page-title">Open your report</h1>
        <p>Enter the code you received when you submitted. You can type just the four digits.</p>
        <div class="lookup-row">
          <input id="wf04LookupInput" type="text" placeholder="SAFE-0000" aria-label="Report code"
            autocomplete="off" autocapitalize="characters" spellcheck="false"
            onkeydown="if(event.key==='Enter'){lookupFromWf04();}" class="input input-code" />
          <button id="wf04LookupBtn" onclick="lookupFromWf04()" class="btn btn-primary">Open report</button>
        </div>
        <p class="hint">Codes can't be recovered if lost. If you no longer have yours, you can always make a new report.</p>
      </div>`;
    const li = document.getElementById('wf04LookupInput');
    if (li && window.matchMedia('(hover:hover)').matches) li.focus({ preventScroll:true });
    return;
  }

  const isGadCaseView = currentRole === 'gad';
  const steps = ['New','In Review','Resolved'];
  const activeIdx = Math.max(0, steps.indexOf(t.status));

  const timeline = steps.map((s,i)=>{
    const done = i <= activeIdx;
    const current = i === activeIdx;
    const step = `<div class="tl-step ${done?'done':''} ${current?'current':''}"${current?' aria-current="step"':''}><span class="tl-dot">${done && !current ? '✓' : i+1}</span><span class="tl-label">${s}</span></div>`;
    const line = i < steps.length-1 ? `<span class="tl-line ${i < activeIdx ? 'done' : ''}"></span>` : '';
    return step + line;
  }).join('');

  const showSaveCallout = !isGadCaseView && justSubmittedId === t.id;
  const saveCallout = showSaveCallout ? `
    <div class="callout ${codeSaved ? 'is-saved' : ''}" role="alert">
      <div class="callout-icon">${codeSaved ? '✓' : '!'}</div>
      <div class="callout-body">
        <strong>${codeSaved ? 'Code saved.' : 'Save your code before you leave this page.'}</strong>
        <span>${codeSaved
          ? 'Use it under My report to check the status and read replies from the committee.'
          : 'It is the only way back into this report. There is no account, so a lost code can\'t be recovered. Copy it or download the receipt.'}</span>
      </div>
    </div>` : '';

  const chatHtml = (t.chat && t.chat.length)
    ? t.chat.map(m=>`
        <div class="msg ${m.from==='gad'?'msg-gad':'msg-me'}">
          <div class="bubble">
            <span class="msg-meta"><strong>${m.from==='gad'?'GAD Coordinator':(isGadCaseView?'Student':'You')}</strong><time>${esc(m.at)}</time></span>
            <span class="msg-text">${esc(m.text)}</span>
          </div>
        </div>`).join('')
    : `<p class="chat-empty">${isGadCaseView
        ? 'No messages yet. Anything you send appears to the student under this code.'
        : 'No messages yet. The GAD Committee will reply here — check back with your code.'}</p>`;

  const chatPlaceholder = isGadCaseView ? 'Reply as GAD Coordinator' : 'Write to the GAD Committee';

  body.innerHTML = `
    ${saveCallout}
    <div class="case-layout">
      <aside class="case-side">
        <div class="stub stub-case">
          <div class="stub-top"><span>${isGadCaseView ? 'Case code' : 'Your report code'}</span></div>
          <p class="stub-code">${esc(t.id)}</p>
          <div class="stub-perf" aria-hidden="true"></div>
          <div class="stub-foot">
            <span>Filed ${esc(t.date)}</span>
            ${isGadCaseView ? '' : `
              <div class="stub-actions">
                <button onclick="copyActiveCode()" class="btn btn-primary btn-xs">Copy code</button>
                <button onclick="downloadReceipt()" class="btn btn-secondary btn-xs">Download receipt</button>
              </div>
            `}
          </div>
        </div>
        ${isGadCaseView ? `<button onclick="go('wf05')" class="btn btn-text btn-back">Back to dashboard</button>` : ''}
      </aside>

      <div class="case-main">
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">Status</h2>
            </div>
            <div class="case-head-actions">
              <span class="badge ${statusBadgeClass(t.status)}">${esc(t.status)}</span>
              <button onclick="refreshData(true)" class="btn btn-secondary btn-xs">Refresh</button>
            </div>
          </div>
          <div class="timeline">${timeline}</div>
          <div class="remarks">
            <span class="field-label">Coordinator remarks</span>
            <p>${esc(t.remarks || 'No remarks yet.')}</p>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head"><h2 class="panel-title">Report details</h2></div>
          <dl class="detail-grid">
            <div class="detail-item"><dt>Program</dt><dd>${esc(t.cohort)}</dd></div>
            <div class="detail-item"><dt>Location</dt><dd>${esc(t.location)}</dd></div>
            <div class="detail-item"><dt>Perceived intent</dt><dd>${esc(t.intent)}</dd></div>
            <div class="detail-item detail-wide"><dt>Category</dt><dd>${esc(t.category)}</dd></div>
            <div class="detail-item"><dt>Attachment metadata removed</dt><dd>${t.metadataStripped ? 'Yes' : 'No attachment'}</dd></div>
          </dl>
          <div class="field">
            <span class="field-label">${isGadCaseView ? 'Student\'s account' : 'Your account'}</span>
            <p class="narrative">${esc(t.desc)}</p>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h2 class="panel-title">Messages</h2>
              <p class="panel-sub">${isGadCaseView
                ? 'The student sees your replies but never learns who you are, and you never learn who they are.'
                : 'The committee can reply here without knowing who you are. Only this code connects you.'}</p>
            </div>
          </div>
          <div class="chat-scroll" aria-live="polite">${chatHtml}</div>
          <div class="chat-bar">
            <input id="chatInput" type="text" placeholder="${chatPlaceholder}" aria-label="Message"
              autocomplete="off" maxlength="2000"
              onkeydown="if(event.key==='Enter' && !event.isComposing){event.preventDefault();sendChat();}" class="input" />
            <button id="chatSendBtn" onclick="sendChat()" class="btn btn-primary">Send</button>
          </div>
        </section>
      </div>
    </div>
  `;

  const newInput = document.getElementById('chatInput');
  if (newInput && pendingText) newInput.value = pendingText;
  if (newInput && hadFocus){
    newInput.focus({ preventScroll:true });
    if (caret !== null) try { newInput.setSelectionRange(caret, caret); } catch(e){}
  }
  const chatScroll = document.querySelector('.chat-scroll');
  if (chatScroll) chatScroll.scrollTop = wasAtBottom ? chatScroll.scrollHeight : oldScrollTop;
}

async function sendChat(){
  const t = tickets.find(x => x.id === activeTicketId);
  if (!t) return;
  const input = document.getElementById('chatInput');
  const text = input ? input.value.trim() : '';
  if (!text) return;

  const from = currentRole === 'gad' ? 'gad' : 'student';
  const newMsg = { from, text, at: nowStamp() };

  if (input && input.disabled) return;   // a send is already in flight
  if (input) input.disabled = true;
  setBusy(document.getElementById('chatSendBtn'), true, 'Sending…');

  try {
    const res = await fetch(`${SHEETDB_URL}/id/${encodeURIComponent(t.id)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('fetch chat failed');
    const rows = await res.json();
    const latest = rows && rows[0];
    let currentChat = [];
    if (latest && latest.chat){
      try { const p = JSON.parse(latest.chat); if (Array.isArray(p)) currentChat = p; } catch(e){}
    }
    currentChat.push(newMsg);

    await updateTicket(t.id, { chat: currentChat });
    t.chat = currentChat;
    if (input) input.value = '';
    const live = document.getElementById('chatInput');   // may differ if a poll re-rendered mid-send
    if (live) live.value = '';
    renderWF04();
    const fresh = document.getElementById('chatInput');
    if (fresh) fresh.focus({ preventScroll:true });
    toast('Message sent.');
  } catch (e) {
    console.error(e);
    toast('Could not send message — your text is still in the box. Check your connection.', 'error');
    if (input){ input.disabled = false; input.focus(); }
    setBusy(document.getElementById('chatSendBtn'), false);
  }
}

function markCodeSaved(){
  if (justSubmittedId && !codeSaved){
    codeSaved = true;
    if (currentView === 'wf04') renderWF04();
  }
}

function copyActiveCode(){
  const t = tickets.find(x => x.id === activeTicketId);
  if (!t) return;
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(t.id)
      .then(()=>{ toast('Ticket code copied: ' + t.id); markCodeSaved(); })
      .catch(()=>toast('Copy failed — write down your code: ' + t.id, 'error'));
  } else { toast('Copy unavailable — write down your code: ' + t.id); }
}

function downloadReceipt(){
  const t = tickets.find(x => x.id === activeTicketId);
  if (!t) return;
  const lines = [
    '==================================================',
    '   CCSICT SafeTrack — Anonymous Case Receipt',
    '==================================================',
    '',
    'Ticket Code       : ' + t.id,
    'Date Filed        : ' + t.date,
    'Section / Program : ' + t.cohort,
    'Category          : ' + t.category,
    'Perceived Intent  : ' + t.intent,
    'Location          : ' + t.location,
    'Current Status    : ' + t.status,
    'Metadata Stripped : ' + (t.metadataStripped ? 'Yes' : 'No'),
    'Receipt Generated : ' + nowStamp(),
    '',
    '---------------- YOUR NARRATIVE ----------------',
    t.desc || '(no narrative provided)',
    '',
    '------------- COORDINATOR REMARKS --------------',
    t.remarks || 'No remarks yet.',
    '',
    '----------------- CHAT HISTORY -----------------',
    (t.chat && t.chat.length
      ? t.chat.map(m => `[${m.at}] ${m.from==='gad'?'GAD':'You'}: ${m.text}`).join('\n')
      : '(no messages yet)'),
    '',
    '==================================================',
    'KEEP THIS CODE PRIVATE.',
    'Anyone holding this code can view the status and',
    'chat thread of this case. There is no name or',
    'account attached to it.',
    '==================================================',
    ''
  ];
  downloadFile('SafeTrack_Receipt_' + t.id + '.txt', lines.join('\r\n'), 'text/plain;charset=utf-8;');
  toast('Receipt downloaded: SafeTrack_Receipt_' + t.id + '.txt');
  markCodeSaved();
}

/* ---------- FILE ---------- */
function downloadFile(filename, content, mime){
  const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 1500);
}

/* ---------- CSV ---------- */
function csvCell(value){
  const s = (value===null||value===undefined)?'':String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
  return s;
}
function csvRow(cells){ return cells.map(csvCell).join(','); }
function parseCSV(text){
  const rows=[]; let row=[]; let field=''; let inQuotes=false;
  const src = String(text||'').replace(/^\uFEFF/,'');
  for (let i=0;i<src.length;i++){
    const ch = src[i];
    if (inQuotes){
      if (ch==='"'){ if (src[i+1]==='"'){ field+='"'; i++; } else { inQuotes=false; } }
      else field += ch;
    } else {
      if (ch==='"') inQuotes = true;
      else if (ch===','){ row.push(field); field=''; }
      else if (ch==='\n'){ row.push(field); field=''; rows.push(row); row=[]; }
      else if (ch==='\r'){ /* ignore */ }
      else field += ch;
    }
  }
  if (field !== '' || row.length > 0){ row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

/* ---------- WF05 ---------- */
function computeStats(){
  const total = tickets.length;
  const open = tickets.filter(t => t.status !== 'Resolved').length;
  const resolved = tickets.filter(t => t.status === 'Resolved').length;
  const unaware = tickets.filter(t => t.intent === 'Unaware').length;
  const unawarePct = total ? (unaware/total)*100 : 0;
  return { total, open, resolved, unaware, unawarePct };
}
function kpiCard(label, value, sub, tone){
  return `
    <div class="kpi ${tone||''}">
      <span class="kpi-label">${esc(label)}</span>
      <span class="kpi-value">${esc(value)}</span>
      <span class="kpi-sub">${esc(sub)}</span>
    </div>`;
}
function renderWF05(){
  const denied = document.getElementById('wf05Denied');
  const content = document.getElementById('wf05Content');
  const isStaff = currentRole === 'gad' || currentRole === 'admin';
  if (!isStaff){ denied.classList.remove('hidden'); content.classList.add('hidden'); return; }
  denied.classList.add('hidden'); content.classList.remove('hidden');

  const isGad = currentRole === 'gad';
  const isAdmin = currentRole === 'admin';

  document.getElementById('wf05RoleNote').textContent = isGad
    ? 'Signed in as GAD Coordinator. You can open cases, reply to students, change status, and import or export CSV.'
    : 'Signed in as College Admin. You see totals only; individual cases stay hidden.';

  const exportBtn = document.getElementById('exportCsvBtn');
  exportBtn.textContent = isGad ? 'Export Full Triage CSV' : 'Export Aggregated Equity CSV';
  document.getElementById('importCsvBtn').classList.toggle('hidden', !isGad);
  document.getElementById('adminPrivacyShield').classList.toggle('hidden', !isAdmin);
  document.getElementById('wf05KanbanSection').classList.toggle('hidden', !isGad);
  document.getElementById('wf05TableSection').classList.toggle('hidden', !isGad);

  const stats = computeStats();
  const L = (v)=> hasLoaded ? v : '—';
  document.getElementById('kpiGrid').innerHTML = [
    kpiCard('Reports', L(stats.total), 'All submissions to date', 'tone-lime'),
    kpiCard('Open', L(stats.open), 'New or in review', 'tone-amber'),
    kpiCard('Resolved', L(stats.resolved), 'Closed by the committee', 'tone-mint'),
    kpiCard('Unawareness Index', L(stats.unawarePct.toFixed(1)+'%'), 'Seemed unintentional', 'tone-violet')
  ].join('');
  document.getElementById('wf05Content').classList.toggle('is-loading', !hasLoaded);

  document.getElementById('unawareSummary').textContent = hasLoaded
    ? stats.unawarePct.toFixed(1)+'% overall, '+stats.unaware+' of '+stats.total
    : 'Loading…';

  document.getElementById('unawareBars').innerHTML = CATEGORIES.map(cat=>{
    const items = tickets.filter(t=>t.category===cat);
    const n = items.length;
    const u = items.filter(t=>t.intent==='Unaware').length;
    const pct = n ? Math.round((u/n)*100) : 0;
    const masked = isAdmin && n>0 && n<5;
    const label = masked ? 'Hidden (fewer than 5)' : (n===0?'No reports':u+' of '+n);
    const width = masked ? 0 : pct;
    return `
      <div class="bar-row">
        <div class="bar-head">
          <span class="bar-name">${esc(cat)}</span>
          <span class="bar-val">${label}${masked?'':(n?'<b>'+pct+'%</b>':'')}</span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
      </div>`;
  }).join('');

  const cohortRows = COHORTS.map(cohort=>{
    const items = tickets.filter(t=>t.cohort===cohort);
    const n = items.length;
    if (n===0) return '';
    const u = items.filter(t=>t.intent==='Unaware').length;
    const r = items.filter(t=>t.status==='Resolved').length;
    const masked = n<5;
    const cell = (val)=> masked
      ? `<span class="suppressed">Hidden</span>`
      : esc(val);
    return `
      <tr>
        <td class="td-strong">${esc(cohort)}</td>
        <td class="num">${cell(n)}</td>
        <td class="num">${cell(u)}</td>
        <td class="num">${cell(r)}</td>
        <td class="num">${masked ? '<span class="suppressed">Hidden</span>' : esc(Math.round((u/n)*100)+'%')}</td>
      </tr>`;
  }).filter(Boolean).join('');

  document.getElementById('cohortTableBody').innerHTML = cohortRows ||
    `<tr><td colspan="5" class="td-empty">${hasLoaded ? 'No reports logged yet.' : 'Loading…'}</td></tr>`;

  if (isGad){
    const sorted = newestFirst(tickets);
    document.getElementById('kanbanBoard').innerHTML = ['New','In Review','Resolved'].map(status=>{
      const items = sorted.filter(t=>t.status===status);
      const cls = status==='New' ? 'k-new' : status==='In Review' ? 'k-review' : 'k-done';
      return `
        <div class="kcol ${cls}">
          <div class="kcol-head">
            <span class="kcol-name">${status}</span>
            <span class="kcol-count">${items.length}</span>
          </div>
          ${items.length ? items.map(kanbanCard).join('') : '<p class="kcol-empty">Nothing here</p>'}
        </div>`;
    }).join('');

    document.getElementById('logCount').textContent = tickets.length;
    renderTriageTable();
  }
}
function newestFirst(list){
  // Dates are "YYYY-MM-DD HH:MM" strings, so a string compare sorts chronologically
  return list.slice().sort((a,b)=> String(b.date).localeCompare(String(a.date)));
}
function setTriageFilter(key, value){
  triageFilter[key] = value;
  renderTriageTable();
}
function renderTriageTable(){
  const body = document.getElementById('triageTableBody');
  if (!body || currentRole !== 'gad') return;
  const q = triageFilter.q.trim().toLowerCase();
  const rows = newestFirst(tickets).filter(t=>{
    if (triageFilter.status && t.status !== triageFilter.status) return false;
    if (!q) return true;
    return [t.id, t.cohort, t.category, t.intent, t.location, t.date, t.desc]
      .some(v => String(v||'').toLowerCase().includes(q));
  });
  const countEl = document.getElementById('triageShown');
  if (countEl) countEl.textContent = (q || triageFilter.status) ? rows.length + ' shown' : '';

  body.innerHTML = rows.map(t=>{
    const busy = busyIds.has(t.id);
    const unread = (t.chat||[]).length && (t.chat[t.chat.length-1]||{}).from !== 'gad';
    return `
      <tr${busy?' class="is-busy"':''}>
        <td class="td-id">${esc(t.id)}</td>
        <td class="td-nowrap td-muted">${esc(t.date)}</td>
        <td class="td-strong">${esc(t.cohort)}</td>
        <td>${esc(t.category)}</td>
        <td class="td-muted">${esc(t.intent)}</td>
        <td>
          <select onchange="setStatus('${esc(t.id)}', this.value)" class="sel sel-mini" aria-label="Status for ${esc(t.id)}"${busy?' disabled':''}>
            ${STATUSES.map(s => `<option value="${s}"${s===t.status?' selected':''}>${s}</option>`).join('')}
          </select>
        </td>
        <td class="num td-muted">${(t.chat||[]).length}${unread?' <span class="dot-new dot-only" title="Awaiting your reply" aria-label="Needs reply"></span>':''}</td>
        <td class="td-action"><button onclick="openCase('${esc(t.id)}')" class="link-btn">Open</button></td>
      </tr>`;
  }).join('') || `<tr><td colspan="8" class="td-empty">${
    !hasLoaded ? 'Loading…' : tickets.length ? 'No cases match this filter.' : 'No reports logged yet.'
  }</td></tr>`;
}
function kanbanCard(t){
  const busy = busyIds.has(t.id);
  const buttons = (()=>{
    const make = (label, next, cls)=>
      `<button onclick="setStatus('${esc(t.id)}','${next}')" class="kbtn ${cls}"${busy?' disabled':''}>${label}</button>`;
    if (t.status === 'New') return make('Start Review','In Review','kbtn-amber') + make('Resolve','Resolved','kbtn-mint');
    if (t.status === 'In Review') return make('Resolve','Resolved','kbtn-mint') + make('Reopen','New','');
    return make('Reopen','New','');
  })();
  const chatN = (t.chat||[]).length;
  const unread = chatN && (t.chat[chatN-1]||{}).from !== 'gad';
  return `
    <div class="kcard${busy?' is-busy':''}">
      <div class="kcard-top">
        <button onclick="openCase('${esc(t.id)}')" class="kcard-id">${esc(t.id)}</button>
        <span class="kcard-date">${esc((t.date||'').slice(5,10))}</span>
      </div>
      <p class="kcard-cat">${esc(t.category)}</p>
      <p class="kcard-meta"><span>${esc(t.cohort)}</span><span>${esc(t.intent)}</span>${chatN ? `<span>${chatN} message${chatN>1?'s':''}</span>` : ''}${unread ? '<span class="dot-new" title="Awaiting your reply">Needs reply</span>' : ''}</p>
      <div class="kcard-actions">${buttons}</div>
    </div>`;
}
async function setStatus(id, status){
  const t = tickets.find(x=>x.id===id);
  if (!t) return;
  if (!STATUSES.includes(status)) return;
  if (busyIds.has(id) || t.status === status) return;
  busyIds.add(id);
  renderWF05();
  try {
    await updateTicket(id, { status });
    t.status = status;
    toast(id + ' moved to "' + status + '".');
  } catch (e) {
    console.error(e);
    toast('Could not update status — check your connection.', 'error');
  } finally {
    busyIds.delete(id);
    renderWF05();   // also snaps the dropdown back if the update failed
    if (activeTicketId === id && currentView === 'wf04') renderWF04();
  }
}
function openCase(id){
  if (currentRole !== 'gad'){ toast('Only the GAD Coordinator can open individual cases.'); return; }
  activeTicketId = id;
  go('wf04');
}

/* ---------- EXPORT ---------- */
function handleExport(){
  if (currentRole === 'gad') exportGadCsv();
  else if (currentRole === 'admin') exportAdminCsv();
  else toast('CSV export is available to staff accounts only.');
}
function exportGadCsv(){
  const headers = ['Ticket_ID','Date','Cohort','Category','Perceived_Intent','Status','Metadata_Stripped','Description','Chat_Count','Latest_Message'];
  const lines = [csvRow(headers)];
  tickets.forEach(t=>{
    const chat = Array.isArray(t.chat) ? t.chat : [];
    const last = chat.length ? chat[chat.length-1] : null;
    const latest = last ? (last.from==='gad'?'GAD: ':'Student: ') + last.text : '';
    lines.push(csvRow([t.id,t.date,t.cohort,t.category,t.intent,t.status,t.metadataStripped?'Yes':'No',t.desc,chat.length,latest]));
  });
  const filename = 'SafeTrack_GAD_Triage_' + todayStamp() + '.csv';
  downloadFile(filename, '\uFEFF'+lines.join('\r\n'), 'text/csv;charset=utf-8;');
  toast('Exported '+tickets.length+' ticket(s) to '+filename);
}
function exportAdminCsv(){
  const stats = computeStats();
  const headers = ['Section','Cohort','Category','Tickets','Unaware','Resolved','Unawareness_Rate'];
  const lines = [csvRow(headers)];
  lines.push(csvRow(['SUMMARY','ALL','ALL',stats.total,stats.unaware,stats.resolved,stats.unawarePct.toFixed(1)+'%']));
  COHORTS.forEach(cohort=>{
    const items = tickets.filter(t=>t.cohort===cohort);
    const n = items.length;
    if (n===0) return;
    if (n<5){
      lines.push(csvRow(['BY_COHORT',cohort,'ALL','Suppressed (<5)','Suppressed (<5)','Suppressed (<5)','Suppressed (<5)']));
    } else {
      const u = items.filter(t=>t.intent==='Unaware').length;
      const r = items.filter(t=>t.status==='Resolved').length;
      const pct = ((u/n)*100).toFixed(1)+'%';
      lines.push(csvRow(['BY_COHORT',cohort,'ALL',n,u,r,pct]));
    }
  });
  CATEGORIES.forEach(cat=>{
    const items = tickets.filter(t=>t.category===cat);
    const n = items.length;
    if (n===0) return;
    if (n<5){
      lines.push(csvRow(['BY_CATEGORY','ALL',cat,'Suppressed (<5)','Suppressed (<5)','Suppressed (<5)','Suppressed (<5)']));
    } else {
      const u = items.filter(t=>t.intent==='Unaware').length;
      const r = items.filter(t=>t.status==='Resolved').length;
      const pct = ((u/n)*100).toFixed(1)+'%';
      lines.push(csvRow(['BY_CATEGORY','ALL',cat,n,u,r,pct]));
    }
  });
  const filename = 'SafeTrack_Admin_Aggregated_' + todayStamp() + '.csv';
  downloadFile(filename, '\uFEFF'+lines.join('\r\n'), 'text/csv;charset=utf-8;');
  toast('Aggregated equity report exported: '+filename);
}

/* ---------- CSV IMPORT ---------- */
function onCsvFileChosen(event){
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (currentRole !== 'gad'){ toast('CSV import is restricted to GAD Coordinators.'); event.target.value=''; return; }
  const reader = new FileReader();
  const btn = document.getElementById('importCsvBtn');
  setBusy(btn, true, 'Importing…');
  reader.onload = async (e)=>{
    try { await importCsvText(String(e.target.result||'')); }
    catch(err){ console.error(err); toast('Could not parse that CSV file.', 'error'); }
    finally { setBusy(btn, false); }
    event.target.value = '';
  };
  reader.onerror = ()=>{ setBusy(btn, false); toast('Could not read that file.', 'error'); event.target.value=''; };
  reader.readAsText(file);
}
async function importCsvText(text){
  const rows = parseCSV(text);
  if (rows.length < 2){ toast('That CSV file has no data rows.'); return; }
  const header = rows[0].map(h=>String(h).trim().toLowerCase());
  const colIndex = (name)=> header.indexOf(name);
  const idIdx = colIndex('ticket_id');
  if (idIdx === -1){ toast('CSV must contain a "Ticket_ID" column.'); return; }

  try { tickets = await fetchTickets(); } catch(e){ /* continue */ }

  let added=0, updated=0, failed=0;

  for (let r=1; r<rows.length; r++){
    const row = rows[r];
    const rawId = (row[idIdx]||'').trim().toUpperCase();
    if (!rawId) continue;
    const get = (name)=>{ const i = colIndex(name); return i>-1 ? String(row[i]===undefined?'':row[i]).trim() : ''; };
    const existing = tickets.find(t=>t.id===rawId);
    const rawStatus = get('status');
    const status = STATUSES.find(s=>s.toLowerCase()===rawStatus.toLowerCase()) || (existing?existing.status:'New');
    const rawIntent = get('perceived_intent');
    const intent = INTENTS.find(i=>i.toLowerCase()===rawIntent.toLowerCase()) || (existing?existing.intent:'Unsure');
    const rawMeta = get('metadata_stripped').toLowerCase();
    const metadataStripped = rawMeta
      ? (rawMeta==='yes'||rawMeta==='true'||rawMeta==='1')
      : (existing?existing.metadataStripped:false);

    let chat = existing && Array.isArray(existing.chat) ? existing.chat.slice() : [];
    const latestMsg = get('latest_message');
    if (!existing && latestMsg){
      const m = latestMsg.match(/^(student|gad)\s*:\s*([\s\S]*)$/i);
      chat = [{ from: m && m[1].toLowerCase()==='gad' ? 'gad' : 'student', text: m ? m[2].trim() : latestMsg, at: nowStamp() }];
    }

    const record = {
      id: rawId,
      date: get('date') || (existing?existing.date:nowStamp()),
      cohort: get('cohort') || (existing?existing.cohort:'BSIS'),
      category: get('category') || (existing?existing.category:'Other Equity Concern'),
      intent,
      location: get('location') || (existing?existing.location:'Room 1'),
      desc: get('description') || (existing?existing.desc:''),
      status,
      metadataStripped,
      remarks: existing ? existing.remarks : 'Imported via CSV by the GAD Coordinator.',
      chat
    };

    try {
      if (existing){
        await updateTicket(rawId, {
          date: record.date, cohort: record.cohort, category: record.category,
          intent: record.intent, location: record.location, desc: record.desc,
          status: record.status, metadataStripped: record.metadataStripped,
          remarks: record.remarks, chat: record.chat
        });
        updated++;
      } else {
        await createTicket(record);
        added++;
      }
    } catch (e) {
      console.error('Import row failed:', rawId, e);
      failed++;
    }
  }

  await refreshData(false);
  toast('CSV import complete — '+added+' new, '+updated+' updated'+(failed?', '+failed+' failed':'')+'.');
}

/* ---------- BOOTSTRAP ---------- */
async function init(){
  currentRole = 'student';
  document.getElementById('roleSelect').value = currentRole;

  let storedDefense = '0';
  try { storedDefense = localStorage.getItem(DEFENSE_KEY) || '0'; } catch(e){}
  const defenseOn = storedDefense === '1';
  document.getElementById('defenseToggle').checked = defenseOn;
  document.body.classList.toggle('show-defense', defenseOn);

  updateRoleChrome();
  // Land on the view in the URL (role gating in go() still applies)
  go(HASH_VIEW[location.hash.slice(1)] || 'wf01', { replace:true });

  // Browser back / forward
  window.addEventListener('popstate', () => {
    go(HASH_VIEW[location.hash.slice(1)] || 'wf01', { fromHistory:true });
  });

  // Modal: Escape anywhere or a click on the backdrop cancels
  const modal = document.getElementById('authModal');
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) cancelPassword(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) cancelPassword();
  });

  // Warn before losing an unsent report or an unsaved ticket code
  window.addEventListener('beforeunload', (e) => {
    const unsentDraft = (draft.desc || '').trim().length > 0 && !submitting;
    const unsavedCode = justSubmittedId && !codeSaved;
    if (unsentDraft || unsavedCode){ e.preventDefault(); e.returnValue = ''; }
  });

  setSync('syncing');
  try {
    tickets = await fetchTickets();
    lastSig = JSON.stringify(tickets);
    hasLoaded = true;
    renderAll();
    setSync('ok');
  } catch (e) {
    console.warn('Initial fetch failed:', e);
    setSync('error');
    toast('Could not reach the shared database. Try refreshing.', 'error');
  }

  // Poll only while the tab is visible; catch up immediately when it returns
  setInterval(() => {
    if (document.hidden) return;
    if (currentView === 'wf04' || currentView === 'wf05') refreshData(false);
  }, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (currentView === 'wf04' || currentView === 'wf05')) refreshData(false);
  });
}
init();