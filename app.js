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
let draft = {
  category:'', intent:'', cohort:'BSIS', location:'Room 1',
  desc:'', metadataStripped:false, fileName:''
};

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

function toast(msg){
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 2800);
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
  try {
    tickets = await fetchTickets();
    renderAll();
    if (showToast) toast('Data refreshed.');
  } catch (e) {
    console.error(e);
    if (showToast) toast('Could not refresh — check your connection.');
  }
}

/* ---------- RESET ---------- */
async function resetDemoData(){
  if (!confirm('Reset ALL data? This deletes every report and chat message in the shared Google Sheet — for everyone, on every device. This cannot be undone.')) return;
  try {
    await deleteAllTickets();
    tickets = [];
    activeTicketId = null;
    draft = { category:'', intent:'', cohort:'BSIS', location:'Room 1', desc:'', metadataStripped:false, fileName:'' };
    goRoleHome();
    toast('All shared data cleared.');
  } catch (e) {
    console.error(e);
    toast('Could not reset data — check your connection.');
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
function go(view){
  const isStudent = currentRole === 'student';
  const isGad = currentRole === 'gad';
  const isAdmin = currentRole === 'admin';
  if (isStudent && view === 'wf05') view = 'wf01';
  if ((isGad || isAdmin) && (view === 'wf01' || view === 'wf02' || view === 'wf03')) view = 'wf05';
  if (isAdmin && view === 'wf04') view = 'wf05';
  if (isGad && view === 'wf04' && !activeTicketId) view = 'wf05';
  currentView = view;
  document.querySelectorAll('.view').forEach(v=>v.classList.add('hidden'));
  const target = document.getElementById('view-'+view);
  if (target) target.classList.remove('hidden');
  document.querySelectorAll('.nav-tab').forEach(b=>b.classList.remove('is-active'));
  const tabId = TAB_FOR_VIEW[view] || 'wf01';
  const tabBtn = document.getElementById('tab-'+tabId);
  if (tabBtn) tabBtn.classList.add('is-active');
  window.scrollTo({ top:0, behavior:'smooth' });
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
  if (!draft.category){ toast('Please select the type of incident.'); return; }
  if (!draft.intent){ toast('Please tell us how the behavior seemed to you.'); return; }
  go('wf03');
}

/* ---------- WF03 ---------- */
function renderWF03(){
  const ta = document.getElementById('w3Desc');
  if (ta) ta.value = draft.desc || '';
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
async function submitReport(evt){
  draft.desc = (document.getElementById('w3Desc').value || '').trim();
  if (!draft.category){ toast('Please choose a category first.'); go('wf02'); return; }
  if (!draft.desc){ toast('Please describe what happened before submitting.'); return; }

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

  const submitBtn = evt && evt.target;
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Submitting…'; }

  try {
    await createTicket(ticket);
    sendToExternalFunnel(ticket);
    tickets = await fetchTickets();
    activeTicketId = ticket.id;
    draft = { category:'', intent:'', cohort:'BSIS', location:'Room 1', desc:'', metadataStripped:false, fileName:'' };
    const ta = document.getElementById('w3Desc'); if (ta) ta.value = '';
    const fi = document.getElementById('w3File'); if (fi) fi.value = '';
    const exif = document.getElementById('exifStatus'); if (exif){ exif.classList.add('hidden'); exif.innerHTML = ''; }
    go('wf04');
    toast('Report submitted. Your ticket code is ' + ticket.id);
  } catch (e) {
    console.error(e);
    toast('Submission failed — check your connection and try again.');
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Submit Confidential Report'; }
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
  const clean = String(code || '').trim().toUpperCase();
  if (!clean){ toast('Please enter a ticket code.'); return; }
  try { tickets = await fetchTickets(); } catch(e){ /* fall back to in-memory */ }
  const found = tickets.find(t => t.id === clean);
  if (!found){ toast('Ticket not found. Please check your code.'); return; }
  activeTicketId = found.id;
  go('wf04');
}
function lookupFromWf04(){
  const input = document.getElementById('wf04LookupInput');
  lookupTicket(input ? input.value : '');
}
function statusBadgeClass(status){
  if (status === 'Resolved') return 'badge-mint';
  if (status === 'In Review') return 'badge-amber';
  return 'badge-mute';
}
function renderWF04(){
  const body = document.getElementById('wf04Body');
  if (!body) return;

  const oldInput = document.getElementById('chatInput');
  const pendingText = oldInput ? oldInput.value : '';

  const t = tickets.find(x => x.id === activeTicketId);

  if (!t){
    if (currentRole !== 'student'){ body.innerHTML = ''; go('wf05'); return; }
    body.innerHTML = `
      <div class="card state">
        <div class="state-icon" style="background:rgba(148,0,255,.16);border-color:rgba(148,0,255,.45);color:#d4a3ff;">?</div>
        <h2>Open a case</h2>
        <p>Enter the private ticket code you received when you filed your report.</p>
        <div class="lookup-row" style="width:100%;max-width:460px;margin-top:8px;">
          <input id="wf04LookupInput" type="text" placeholder="SAFE-XXXX"
            onkeydown="if(event.key==='Enter'){lookupFromWf04();}" class="input" />
          <button onclick="lookupFromWf04()" class="btn btn-primary">Open</button>
        </div>
      </div>`;
    return;
  }

  const isGadCaseView = currentRole === 'gad';
  const steps = ['New','In Review','Resolved'];
  const activeIdx = Math.max(0, steps.indexOf(t.status));

  const timeline = steps.map((s,i)=>{
    const done = i <= activeIdx;
    return `<div class="tl-step ${done?'done':''}"><span class="tl-dot">${i+1}</span><span class="tl-label">${s}</span></div>`;
  }).join('<span class="tl-line"></span>');

  const chatHtml = (t.chat && t.chat.length)
    ? t.chat.map(m=>`
        <div class="msg ${m.from==='gad'?'msg-gad':'msg-me'}">
          <div class="bubble">
            <span class="msg-meta">${m.from==='gad'?'GAD Coordinator':(isGadCaseView?'Student':'You')} · ${esc(m.at)}</span>
            <span class="msg-text">${esc(m.text)}</span>
          </div>
        </div>`).join('')
    : `<p class="chat-empty">No messages yet. The GAD committee will reply here.</p>`;

  const chatPlaceholder = isGadCaseView ? 'Reply as GAD Coordinator…' : 'Write a message to the GAD committee…';

  body.innerHTML = `
    <div class="card">
      <div class="case-head-top">
        <div>
          <span class="eyebrow">${isGadCaseView ? 'Case Detail' : 'Anonymous Case Receipt'}</span>
          <span class="ticket-code">${esc(t.id)}</span>
          <span class="ticket-date">Filed ${esc(t.date)}</span>
        </div>
        <div class="case-head-actions">
          <button onclick="refreshData(true)" class="btn btn-glass btn-xs">↻ Refresh</button>
          <span class="badge ${statusBadgeClass(t.status)}">${esc(t.status)}</span>
        </div>
      </div>
      <div class="timeline">${timeline}</div>
      ${isGadCaseView ? '' : `
        <div class="row-2" style="margin-top:18px;">
          <button onclick="copyActiveCode()" class="btn btn-glass btn-xs">Copy Code</button>
          <button onclick="downloadReceipt()" class="btn btn-glass btn-xs">Download Receipt (.txt)</button>
        </div>
      `}
    </div>

    <div class="card stack-sm">
      <h3 class="card-title" style="font-size:15px;padding-bottom:14px;border-bottom:1px solid var(--stroke);">Case details</h3>
      <div class="detail-grid">
        <div class="detail-item"><span>Section</span><span>${esc(t.cohort)}</span></div>
        <div class="detail-item"><span>Category</span><span>${esc(t.category)}</span></div>
        <div class="detail-item"><span>Perceived Intent</span><span>${esc(t.intent)}</span></div>
        <div class="detail-item"><span>Location</span><span>${esc(t.location)}</span></div>
        <div class="detail-item"><span>Metadata Stripped</span><span>${t.metadataStripped ? 'Yes' : 'No'}</span></div>
        <div class="detail-item"><span>Messages</span><span>${(t.chat||[]).length}</span></div>
      </div>
      <div class="field" style="margin-top:6px;">
        <span class="field-label">${isGadCaseView ? 'Student narrative' : 'Your narrative'}</span>
        <p class="narrative">${esc(t.desc)}</p>
      </div>
      <div class="field">
        <span class="field-label">Coordinator remarks</span>
        <p class="narrative">${esc(t.remarks || 'No remarks yet.')}</p>
      </div>
    </div>

    <div class="card stack-sm">
      <div>
        <h3 class="card-title" style="font-size:15px;">Two-way anonymous chat</h3>
        <p class="card-sub">Neither side sees the other's identity — only the case code connects you.</p>
      </div>
      <div class="chat-scroll scroll-thin">${chatHtml}</div>
      <div class="chat-bar">
        <input id="chatInput" type="text" placeholder="${chatPlaceholder}"
          onkeydown="if(event.key==='Enter'){sendChat();}" class="input" />
        <button onclick="sendChat()" class="btn btn-primary">Send</button>
      </div>
    </div>
  `;

  const newInput = document.getElementById('chatInput');
  if (newInput && pendingText) newInput.value = pendingText;
  const chatScroll = document.querySelector('.chat-scroll');
  if (chatScroll) chatScroll.scrollTop = chatScroll.scrollHeight;
}

async function sendChat(){
  const t = tickets.find(x => x.id === activeTicketId);
  if (!t) return;
  const input = document.getElementById('chatInput');
  const text = input ? input.value.trim() : '';
  if (!text) return;

  const from = currentRole === 'gad' ? 'gad' : 'student';
  const newMsg = { from, text, at: nowStamp() };

  if (input) input.disabled = true;

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
    renderWF04();
    toast('Message sent.');
  } catch (e) {
    console.error(e);
    toast('Could not send message — check your connection.');
  } finally {
    if (input) input.disabled = false;
  }
}

function copyActiveCode(){
  const t = tickets.find(x => x.id === activeTicketId);
  if (!t) return;
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(t.id)
      .then(()=>toast('Ticket code copied: ' + t.id))
      .catch(()=>toast('Copy failed — your code is ' + t.id));
  } else { toast('Your ticket code is ' + t.id); }
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
    ? 'Full access: Kanban workflow, individual case triage, status transitions, CSV import and export.'
    : 'Aggregated view only. Individual cases are hidden by the Privacy Shield, and sections with fewer than 5 reports are suppressed.';

  const exportBtn = document.getElementById('exportCsvBtn');
  exportBtn.textContent = isGad ? 'Export Full Triage CSV' : 'Export Aggregated Equity CSV';
  document.getElementById('importCsvBtn').classList.toggle('hidden', !isGad);
  document.getElementById('adminPrivacyShield').classList.toggle('hidden', !isAdmin);
  document.getElementById('wf05KanbanSection').classList.toggle('hidden', !isGad);
  document.getElementById('wf05TableSection').classList.toggle('hidden', !isGad);

  const stats = computeStats();
  document.getElementById('kpiGrid').innerHTML = [
    kpiCard('Total Reports', stats.total, 'All anonymous submissions', 'tone-lime'),
    kpiCard('Open Cases', stats.open, 'New + In Review', 'tone-amber'),
    kpiCard('Resolved', stats.resolved, 'Closed by the GAD committee', 'tone-mint'),
    kpiCard('Unawareness Index', stats.unawarePct.toFixed(1)+'%', 'Reports perceived as unintentional', 'tone-violet')
  ].join('');

  document.getElementById('unawareSummary').textContent =
    stats.unawarePct.toFixed(1)+'% overall ('+stats.unaware+' of '+stats.total+')';

  document.getElementById('unawareBars').innerHTML = CATEGORIES.map(cat=>{
    const items = tickets.filter(t=>t.category===cat);
    const n = items.length;
    const u = items.filter(t=>t.intent==='Unaware').length;
    const pct = n ? Math.round((u/n)*100) : 0;
    const masked = isAdmin && n>0 && n<5;
    const label = masked ? 'Suppressed (&lt;5)' : (n===0?'No reports':u+' / '+n+' reports');
    const width = masked ? 0 : pct;
    return `
      <div class="bar-row">
        <div class="bar-head">
          <span class="bar-name">${esc(cat)}</span>
          <span class="bar-val">${label}${masked?'':(n?' · '+pct+'%':'')}</span>
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
      ? `<span style="color:var(--ink-3);font-style:italic;">Suppressed (&lt;5)</span>`
      : esc(val);
    return `
      <tr>
        <td style="font-weight:700;color:var(--ink);">${esc(cohort)}</td>
        <td>${cell(n)}</td>
        <td>${cell(u)}</td>
        <td>${cell(r)}</td>
        <td>${masked ? '<span style="color:var(--ink-3);font-style:italic;">Suppressed (&lt;5)</span>' : esc(Math.round((u/n)*100)+'%')}</td>
      </tr>`;
  }).filter(Boolean).join('');

  document.getElementById('cohortTableBody').innerHTML = cohortRows ||
    `<tr><td colspan="5" class="td-empty">No reports logged yet.</td></tr>`;

  if (isGad){
    document.getElementById('kanbanBoard').innerHTML = ['New','In Review','Resolved'].map(status=>{
      const items = tickets.filter(t=>t.status===status);
      const cls = status==='New' ? 'k-new' : status==='In Review' ? 'k-review' : 'k-done';
      return `
        <div class="kcol ${cls}">
          <div class="kcol-head">
            <span class="kcol-name">${status}</span>
            <span class="kcol-count">${items.length}</span>
          </div>
          ${items.length ? items.map(kanbanCard).join('') : '<p class="kcol-empty">No cases</p>'}
        </div>`;
    }).join('');

    document.getElementById('logCount').textContent = tickets.length;

    document.getElementById('triageTableBody').innerHTML = tickets.map(t=>`
      <tr>
        <td class="td-id">${esc(t.id)}</td>
        <td class="td-nowrap" style="color:var(--ink-3);">${esc(t.date)}</td>
        <td style="font-weight:500;color:var(--ink);">${esc(t.cohort)}</td>
        <td>${esc(t.category)}</td>
        <td style="color:var(--ink-3);">${esc(t.intent)}</td>
        <td>
          <select onchange="setStatus('${esc(t.id)}', this.value)" class="sel sel-mini">
            ${STATUSES.map(s => `<option value="${s}"${s===t.status?' selected':''}>${s}</option>`).join('')}
          </select>
        </td>
        <td style="color:var(--ink-3);">${(t.chat||[]).length}</td>
        <td><button onclick="openCase('${esc(t.id)}')" class="link-btn">View</button></td>
      </tr>
    `).join('') || `<tr><td colspan="8" class="td-empty">No reports logged yet.</td></tr>`;
  }
}
function kanbanCard(t){
  const buttons = (()=>{
    const make = (label, next, cls)=>
      `<button onclick="setStatus('${esc(t.id)}','${next}')" class="kbtn ${cls}">${label}</button>`;
    if (t.status === 'New') return make('Start Review','In Review','kbtn-amber') + make('Resolve','Resolved','kbtn-mint');
    if (t.status === 'In Review') return make('Resolve','Resolved','kbtn-mint') + make('Reopen','New','');
    return make('Reopen','New','');
  })();
  return `
    <div class="kcard">
      <div class="kcard-top">
        <button onclick="openCase('${esc(t.id)}')" class="kcard-id">${esc(t.id)}</button>
        <span class="kcard-date">${esc((t.date||'').slice(5,10))}</span>
      </div>
      <p class="kcard-cat">${esc(t.category)}</p>
      <p class="kcard-meta">${esc(t.cohort)} · ${esc(t.intent)}</p>
      <div class="kcard-actions">${buttons}</div>
    </div>`;
}
async function setStatus(id, status){
  const t = tickets.find(x=>x.id===id);
  if (!t) return;
  if (!STATUSES.includes(status)) return;
  try {
    await updateTicket(id, { status });
    t.status = status;
    renderWF05();
    if (activeTicketId === id && currentView === 'wf04') renderWF04();
    toast(id + ' moved to "' + status + '".');
  } catch (e) {
    console.error(e);
    toast('Could not update status — check your connection.');
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
  reader.onload = async (e)=>{
    try { await importCsvText(String(e.target.result||'')); }
    catch(err){ console.error(err); toast('Could not parse that CSV file.'); }
    event.target.value = '';
  };
  reader.onerror = ()=>{ toast('Could not read that file.'); event.target.value=''; };
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
  go('wf01');

  try {
    tickets = await fetchTickets();
    renderAll();
  } catch (e) {
    console.warn('Initial fetch failed:', e);
    toast('Could not reach the shared database. Try refreshing.');
  }

  setInterval(() => {
    if (currentView === 'wf04' || currentView === 'wf05') refreshData(false);
  }, 30000);
}
init();