const $=id=>document.getElementById(id);
let sb, profile;
let pendingImportRows = [];

// Single Source of Truth Schema for User Export and User Import
const USER_EXCEL_COLUMNS = [
  "Employee ID",
  "Name",
  "Department",
  "Designation",
  "Company",
  "Status",
  "Username/Email"
];

// Single Source of Truth Schema for Pre-Test / Post Assessment Question Import
const QUESTION_EXCEL_COLUMNS = [
  "Question No",
  "Question Text",
  "Option A",
  "Option B",
  "Option C",
  "Option D",
  "Correct Option"
];
let pendingQuestionImportRows = [];

const configured = !window.SUPABASE_URL.includes("YOUR_") && !window.SUPABASE_ANON_KEY.includes("YOUR_");
if(configured) sb = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const esc = x => String(x??"").replace(/[&<>"']/g, c => ({
  "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
}[c]));

function cleanExcelVal(val) {
  if (val === null || val === undefined) return "";
  let str = String(val).trim();
  if (str.endsWith('.0')) {
    str = str.slice(0, -2);
  }
  return str;
}

function validateEmail(email) {
  if (!email) return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(String(email).toLowerCase().trim());
}

// --- UPLOAD PROGRESS OVERLAY (used by Training material + SOP file uploads) ---
// supabase-js's storage.upload() uses fetch() internally, which cannot report
// real progress. To show a genuine percentage instead of a fake/simulated one,
// we upload directly to the Supabase Storage REST endpoint via XMLHttpRequest,
// which does support upload progress events.
const UPLOAD_RING_CIRCUMFERENCE = 2 * Math.PI * 40;

function showUploadOverlay(label){
  hideUploadOverlay();
  document.body.insertAdjacentHTML("beforeend", `
    <div class="upload-overlay" id="uploadOverlay">
      <div class="upload-box">
        <div class="upload-ring">
          <svg viewBox="0 0 96 96">
            <circle class="track" cx="48" cy="48" r="40"></circle>
            <circle class="bar" id="uploadRingBar" cx="48" cy="48" r="40"
              stroke-dasharray="${UPLOAD_RING_CIRCUMFERENCE}"
              stroke-dashoffset="${UPLOAD_RING_CIRCUMFERENCE}"></circle>
          </svg>
          <div class="pct" id="uploadRingPct">0%</div>
        </div>
        <div class="upload-label">${esc(label || "Uploading file...")}</div>
        <div class="upload-sub">Please don't close this or click away till it finishes.</div>
      </div>
    </div>
  `);
}

function setUploadProgress(pct){
  const bar = $("uploadRingBar");
  const txt = $("uploadRingPct");
  if(!bar || !txt) return;
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  bar.setAttribute("stroke-dashoffset", String(UPLOAD_RING_CIRCUMFERENCE * (1 - p/100)));
  txt.textContent = p + "%";
}

function hideUploadOverlay(){
  $("uploadOverlay")?.remove();
}

// Uploads a file directly to Supabase Storage with real % progress.
// Returns {error:null} on success or {error:{message}} on failure — same shape
// as supabase-js's storage.upload() so existing error-handling code keeps working.
function uploadFileWithProgress(bucket, path, file, onProgress){
  return new Promise(async (resolve) => {
    const sessionRes = await sb.auth.getSession();
    const token = sessionRes.data?.session?.access_token;
    if(!token){ resolve({error:{message:"Not authenticated. Please log in again."}}); return; }

    const xhr = new XMLHttpRequest();
    const url = `${window.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`;
    xhr.open("POST", url, true);
    xhr.setRequestHeader("Authorization", "Bearer " + token);
    xhr.setRequestHeader("apikey", window.SUPABASE_ANON_KEY);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");

    xhr.upload.onprogress = (e) => {
      if(e.lengthComputable && onProgress) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if(xhr.status >= 200 && xhr.status < 300){
        if(onProgress) onProgress(100);
        resolve({error:null});
      } else {
        let msg = "Upload failed (status " + xhr.status + ")";
        try{ const j = JSON.parse(xhr.responseText); msg = j.message || j.error || msg; }catch(e){}
        resolve({error:{message:msg}});
      }
    };
    xhr.onerror = () => resolve({error:{message:"Network error during upload."}});
    xhr.send(file);
  });
}

function loginPage(msg=""){
  app.innerHTML = `<div class=login><div class=loginbox><h1>🛡️ Safety Training & Learning Portal</h1><p class=muted>Talwandi Sabo Thermal Plant</p><label>Email / Employee ID</label><input id=email><label>Password</label><input id=password type=password onkeydown="if(event.key==='Enter')login()"><button class="btn blue full" onclick=login()>Login</button><p class=muted>${esc(msg)}</p></div></div>`;
}

async function login(){
  if(!configured) return loginPage("Configure config.js first.");
  let inputVal = $('email').value.trim();
  let passVal = $('password').value;

  let emailToAuth = inputVal;
  let resolvedName = null;
  if(!inputVal.includes("@")){
    let pr = await sb.from("profiles").select("username,name").eq("employee_id", inputVal).single();
    if(pr.data && pr.data.username){
      emailToAuth = pr.data.username;
      resolvedName = pr.data.name;
    } else {
      emailToAuth = `${inputVal.toLowerCase()}@tsl.internal`;
    }
  } else {
    let pr = await sb.from("profiles").select("name").eq("username", inputVal).single();
    if(pr.data) resolvedName = pr.data.name;
  }

  let r = await sb.auth.signInWithPassword({ email: emailToAuth, password: passVal });
  if(r.error){
    _logSecurityEvent("login_failed", { attempted_identifier: resolvedName || inputVal });
    return loginPage(r.error.message);
  }

  let p = await sb.from("profiles").select("*").eq("id", r.data.user.id).single();
  if(p.data && p.data.active === false && p.data.role !== 'admin'){
    await sb.auth.signOut();
    return loginPage("Your account is deactivated. Please contact Admin.");
  }

  _logSecurityEvent("login_success", { attempted_identifier: p.data?.name || inputVal, user_id: r.data.user.id });
  start();
}

// Fire-and-forget security event logger. Never blocks or breaks login/logout
// if the write fails (e.g. offline) — security logging must not lock users out.
async function _logSecurityEvent(eventType, extra={}){
  try{
    await sb.from("security_logs").insert({
      event_type: eventType,
      attempted_identifier: extra.attempted_identifier || null,
      user_id: extra.user_id || null,
      admin_id: extra.admin_id || null,
      target_user_id: extra.target_user_id || null,
      user_agent: navigator.userAgent || null
    });
  }catch(e){ /* non-fatal */ }
}

// --- MEETING ATTENDANCE (Join / Rejoin / Return tracking) ---
let _pendingMeetReturn = null; // { trainingId } while a Meet tab is presumed open

async function _logMeetingEvent(trainingId, eventType){
  try{
    await sb.from("meeting_attendance").insert({
      training_id: trainingId,
      user_id: profile.id,
      event_type: eventType
    });
  }catch(e){ /* non-fatal */ }
}

function joinMeeting(trainingId, url){
  _logMeetingEvent(trainingId, "join");
  _pendingMeetReturn = { trainingId };
  window.open(url, "_blank", "noopener");
}

document.addEventListener("visibilitychange", () => {
  if(document.visibilityState === "visible" && _pendingMeetReturn && profile){
    _logMeetingEvent(_pendingMeetReturn.trainingId, "return");
    _pendingMeetReturn = null;
  }
});

async function start(){
  let r = await sb.auth.getUser();
  if(!r.data.user) return loginPage();
  let p = await sb.from("profiles").select("*").eq("id", r.data.user.id).single();
  if(p.error) return loginPage("Login works but no profile exists.");
  if(p.data.active === false && p.data.role !== 'admin'){
    await sb.auth.signOut();
    return loginPage("Your account is deactivated. Please contact Admin.");
  }
  profile = p.data;
  route("dash");
}

async function logout(){
  if(profile) _logSecurityEvent("logout", { user_id: profile.id, attempted_identifier: profile.name });
  window._impersonation = null;
  sessionStorage.removeItem("stlp_admin_session");
  await sb.auth.signOut();
  profile = null;
  loginPage();
}

// --- ADMIN "LOGIN AS USER" (IMPERSONATION) ---
// Uses an Edge Function (admin-impersonate-user) running with the service
// role key to mint a one-time sign-in token for the target user — the admin
// never sees or needs that user's password. The admin's own session is saved
// locally first so "Return to Admin" can restore it without re-entering a
// password. Every switch is logged server-side in security_logs.
async function impersonateUser(targetUserId, targetName){
  if(!confirm(`Login as ${targetName}? You'll be able to use the portal exactly as they would, and can return to your Admin account anytime from the banner at the top.`)) return;

  const sessionRes = await sb.auth.getSession();
  const adminSession = sessionRes.data?.session;
  if(!adminSession) return alert("Could not read your current session. Please re-login and try again.");

  let resp, body;
  try{
    resp = await fetch(`${window.SUPABASE_URL}/functions/v1/admin-impersonate-user`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + adminSession.access_token,
        "apikey": window.SUPABASE_ANON_KEY
      },
      body: JSON.stringify({ target_user_id: targetUserId })
    });
    body = await resp.json();
  }catch(e){
    return alert("Could not reach the impersonation service. Check your connection and try again.");
  }

  if(!resp.ok || body.error){
    return alert("Login as User failed: " + (body?.error || ("status " + resp.status)));
  }

  // Save the admin's session so we can restore it later without a password.
  sessionStorage.setItem("stlp_admin_session", JSON.stringify({
    access_token: adminSession.access_token,
    refresh_token: adminSession.refresh_token,
    admin_name: profile.name
  }));

  const otp = await sb.auth.verifyOtp({ token_hash: body.hashed_token, type: "email" });
  if(otp.error){
    sessionStorage.removeItem("stlp_admin_session");
    return alert("Login as User failed: " + otp.error.message);
  }

  const p = await sb.from("profiles").select("*").eq("id", targetUserId).single();
  if(p.error || !p.data){
    return alert("Signed in, but could not load that user's profile.");
  }

  window._impersonation = { adminName: profile.name, userName: p.data.name };
  profile = p.data;
  route("dash");
}

async function returnToAdmin(){
  const saved = sessionStorage.getItem("stlp_admin_session");
  if(!saved) return alert("No saved Admin session found — please log in again.");
  const adminSession = JSON.parse(saved);

  const r = await sb.auth.setSession({
    access_token: adminSession.access_token,
    refresh_token: adminSession.refresh_token
  });
  sessionStorage.removeItem("stlp_admin_session");

  if(r.error || !r.data?.user){
    window._impersonation = null;
    profile = null;
    return loginPage("Your Admin session expired — please log in again.");
  }

  const p = await sb.from("profiles").select("*").eq("id", r.data.user.id).single();
  if(p.error || !p.data){
    window._impersonation = null;
    profile = null;
    return loginPage("Could not restore Admin profile — please log in again.");
  }

  _logSecurityEvent("impersonate_end", { user_id: p.data.id, attempted_identifier: p.data.name });

  window._impersonation = null;
  profile = p.data;
  route("dash");
}

const MENU_ICONS = {
  dash:"📊", users:"👥", train:"📚", notes:"🔔", results:"📝",
  progress:"📈", reports:"📄", history:"🗂️", seclogs:"🔒", feedback:"💬", sop:"📁", trainers:"🎓",
  attendance:"🎥", certificates:"📜",
  _history_group:"🕒",
  _settings_group:"⚙️", mailintegration:"✉️", meetintegration:"🎥"
};

let currentRoute = "dash";

let _clockTimer = null;
function _sidebarCollapsedPref(){ return localStorage.getItem("stlp_sidebar_collapsed") === "1"; }
function toggleSidebar(){
  const side = $("sideEl"), main = $("mainEl");
  const nowCollapsed = !side.classList.contains("collapsed");
  side.classList.toggle("collapsed", nowCollapsed);
  main.classList.toggle("collapsed", nowCollapsed);
  localStorage.setItem("stlp_sidebar_collapsed", nowCollapsed ? "1" : "0");
}
function toggleMobileSidebar(){
  $("sideEl")?.classList.toggle("mobile-open");
  $("sideScrim")?.classList.toggle("show");
}

let _sideGroupOpen = { _history_group: null, _settings_group: null }; // null = auto (open if a sub-route of that group is active)
function toggleSideGroup(groupKey, fallbackRoute){
  const cur = _sideGroupOpen[groupKey];
  _sideGroupOpen[groupKey] = !(cur === null || cur === undefined ? true : cur);
  const stayOnCurrent = ["history","seclogs","mailintegration","meetintegration"].includes(currentRoute);
  route(stayOnCurrent ? currentRoute : fallbackRoute);
}
// Back-compat alias: existing History group button in the DOM/markup calls this name.
function toggleSideHistoryGroup(){ toggleSideGroup("_history_group", "history"); }

function renderSideMenu(menu, admin, active){
  return `<div class="nav">${menu.map(m => {
    const [key, label, sub] = m;
    if(sub){
      const isActiveGroup = sub.some(s => s[0] === active);
      const openState = _sideGroupOpen[key];
      const open = (openState === null || openState === undefined) ? isActiveGroup : openState;
      return `
        <button class="${isActiveGroup?"active":""}" data-tip="${esc(label)}" onclick="toggleSideGroup('${key}','${sub[0][0]}')">
          <span class="ico">${MENU_ICONS[key]||"🕒"}</span><span class="lbl">${esc(label)}</span>
          <span style="margin-left:auto;font-size:11px">${open?"▾":"▸"}</span>
        </button>
        ${open ? sub.map(s => `
          <button class="${active===s[0]?"active":""}" style="padding-left:34px" data-tip="${esc(s[1])}" onclick="route('${s[0]}')">
            <span class="ico">${MENU_ICONS[s[0]]||"•"}</span><span class="lbl">${esc(s[1])}</span><span class="dot"></span>
          </button>`).join("") : ""}
      `;
    }
    return `<button class="${active===key?"active":""}" data-tip="${esc(label)}" onclick="route('${key}')"><span class="ico">${MENU_ICONS[key]||"•"}</span><span class="lbl">${esc(label)}</span>${key==="sop"&&admin?'<span class="badge o" id="sopNavBadge" style="display:none;margin-left:auto"></span>':'<span class="dot"></span>'}</button>`;
  }).join("")}</div>`;
}

function layout(active, title, html){
  let admin = profile.role === "admin";
  let menu = admin ?
    [["dash","Dashboard"],["users","Users Management"],["train","Training"],["certificates","Certificates"],["sop","Library"],["trainers","Trainers"],["notes","Notifications"],["results","Results"],["progress","Progress"],["reports","Reports"],["attendance","Meeting Attendance"],
      ["_history_group","History",[["history","Audit Logs"],["seclogs","Security Logs"]]],
      ["feedback","Feedback"],
      ["_settings_group","Settings",[["mailintegration","Mail Integration"],["meetintegration","Meet Integration"]]]] :
    [["dash","Dashboard"],["train","My Trainings"],["certificates","My Certificates"],["sop","Library"],["notes","Notifications"],["results","Assessments"],["history","History"]];

  const collapsed = _sidebarCollapsedPref();
  const initials = (profile.name||"?").trim().split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase();

  app.innerHTML = `
    ${window._impersonation ? `
    <div id="impersonateBanner" style="position:fixed;top:0;left:0;right:0;z-index:150;background:#e8912c;color:#231400;padding:9px 16px;text-align:center;font-weight:700;font-size:13.5px;display:flex;justify-content:center;align-items:center;gap:14px">
      <span>🔓 Viewing as <b>${esc(window._impersonation.userName)}</b> (Admin: ${esc(window._impersonation.adminName)})</span>
      <button class="btn" style="background:#231400;color:#fff;padding:5px 12px;font-size:12.5px" onclick="returnToAdmin()">🔙 Return to Admin</button>
    </div>` : ""}
    <div class="side-scrim" id="sideScrim" onclick="toggleMobileSidebar()"></div>
    <aside class="side${collapsed?" collapsed":""}" id="sideEl" style="${window._impersonation?"margin-top:40px":""}">
      <button class="side-toggle" onclick="toggleSidebar()" title="Collapse sidebar">${collapsed?"›":"‹"}</button>
      <div class="brand"><span class="mark">🛡️</span><span class="txt">Safety Training &amp; Learning Portal<small>Talwandi Sabo Thermal Plant</small></span></div>
      ${renderSideMenu(menu, admin, active)}
      <div class="sidebar-foot"><button class="btn light full" onclick="logout()">🚪 <span class="lbl-logout">Logout</span></button></div>
    </aside>
    <main class="main${collapsed?" collapsed":""}" id="mainEl" style="${window._impersonation?"margin-top:40px":""}">
      <div class="top">
        <div style="display:flex;align-items:center;gap:12px">
          <button class="mobile-menu-btn" onclick="toggleMobileSidebar()">☰</button>
          <div><span class="eyebrow">${admin?"Administrator":"Employee"} Portal</span><h2>${esc(title)}</h2></div>
        </div>
        <div class="top-right">
          <div class="clock" id="topClock"><span class="t">--:--:--</span><span class="d">--</span></div>
          <button class="btn light" style="padding:9px 12px;font-size:12px" onclick="changeMyPasswordModal()">🔑 Change Password</button>
          <span class="chip"><span class="avatar">${esc(initials||"U")}</span>${esc(profile.name)}<span class="role-tag">${admin?"ADMIN":"USER"}</span></span>
        </div>
      </div>
      <div class="content-pad">${html}</div>
    </main>`;

  _startClock();
  if(admin) _refreshSopBadge();
}

function _startClock(){
  if(_clockTimer) clearInterval(_clockTimer);
  const tick = () => {
    const el = $("topClock");
    if(!el){ clearInterval(_clockTimer); return; }
    const now = new Date();
    el.querySelector(".t").textContent = now.toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",second:"2-digit"});
    el.querySelector(".d").textContent = now.toLocaleDateString("en-IN",{weekday:"short",day:"2-digit",month:"short",year:"numeric"});
  };
  tick();
  _clockTimer = setInterval(tick, 1000);
}

function metric(a,b){
  return `<div class=card><span class=muted>${a}</span><strong style="font-size:28px;display:block;margin-top:7px">${b}</strong></div>`;
}

function kpi(icon, colorClass, label, value, sub){
  return `<div class="kpi ${colorClass}"><span class="ico">${icon}</span><span class="val">${value}</span><span class="lbl">${esc(label)}</span>${sub?`<span class="sub">${esc(sub)}</span>`:""}</div>`;
}

let _dashCharts = {};
function _destroyDashCharts(){
  Object.values(_dashCharts).forEach(c => { try{ c.destroy(); }catch(e){} });
  _dashCharts = {};
}

const CHART_PALETTE = {
  teal:"#12979f", navy:"#15426e", amber:"#e8912c", green:"#1f9d55",
  red:"#d64545", purple:"#7c5cd6", blue:"#3d8fd6", slate:"#c9d4e0"
};

// Build a per-employee x per-training compliance matrix from existing tables/logic.
// Mirrors the calculation already used in the Progress module so figures stay consistent.
function _buildComplianceMatrix(employees, activeTrainings, attempts, progresses){
  const now = new Date();
  const getItemStatus = (emp, training) => {
    if(!training) return "MISSING";
    const empUuid = String(emp.id||"").toLowerCase().trim();
    const empCode = String(emp.employee_id||"").toLowerCase().trim();
    const empUser = String(emp.username||"").toLowerCase().trim();
    const tId = String(training.id||"").toLowerCase().trim();
    const tTitle = String(training.title||"").toLowerCase().trim();
    const matchUser = (rec) => {
      if(!rec) return false;
      const uVal = String(rec.user_id||rec.employee_id||rec.username||"").toLowerCase().trim();
      if(!uVal) return false;
      return uVal===empUuid || (empCode!==""&&uVal===empCode) || (empUser!==""&&uVal===empUser);
    };
    const matchTraining = (rec) => {
      if(!rec) return false;
      const recTId = String(rec.training_id||rec.training_title||"").toLowerCase().trim();
      const recRelTitle = String(rec.trainings?.title||"").toLowerCase().trim();
      return (recTId!==""&&recTId===tId) || (tTitle!==""&&recTId===tTitle) || (tTitle!==""&&recRelTitle===tTitle);
    };
    const userAttempts = attempts.filter(a=>matchUser(a)&&matchTraining(a));
    const passedAttempt = userAttempts.find(a=>
      a.passed===true || String(a.passed).toLowerCase()==='true' || a.passed===1 ||
      (a.score!==undefined && a.score!==null && training.passing_marks && Number(a.score)>=Number(training.passing_marks))
    );
    const prog = progresses.find(p=>matchUser(p)&&matchTraining(p));
    const isCompletedProg = prog && (prog.status==='completed' || String(prog.status).toLowerCase()==='completed');
    if(passedAttempt || isCompletedProg){
      let completionDate = null;
      if(passedAttempt && passedAttempt.created_at) completionDate = new Date(passedAttempt.created_at);
      else if(prog && (prog.updated_at||prog.created_at)) completionDate = new Date(prog.updated_at||prog.created_at);
      if(completionDate && !isNaN(completionDate.getTime()) && training.validity){
        const valStr = String(training.validity).toLowerCase().trim();
        const numMatch = valStr.match(/\d+/);
        const num = numMatch ? parseInt(numMatch[0],10) : 1;
        const expiryDate = new Date(completionDate.getTime());
        if(valStr.includes("month")) expiryDate.setMonth(expiryDate.getMonth()+num);
        else if(valStr.includes("day")) expiryDate.setDate(expiryDate.getDate()+num);
        else expiryDate.setFullYear(expiryDate.getFullYear()+num);
        if(now>expiryDate) return "EXPIRED";
      }
      return "COMPLETE";
    }
    return "PENDING";
  };

  let totals = {COMPLETE:0, PENDING:0, EXPIRED:0, MISSING:0};
  const matrixData = employees.map(emp=>{
    let cnt = {COMPLETE:0, PENDING:0, EXPIRED:0, MISSING:0};
    activeTrainings.forEach(t=>{ cnt[getItemStatus(emp,t)]++; });
    const totalReqs = activeTrainings.length;
    const progressPct = totalReqs>0 ? Math.round((cnt.COMPLETE/totalReqs)*100) : 0;
    let overallStatus = "COMPLETE";
    if(totalReqs===0) overallStatus="COMPLETE";
    else if(cnt.EXPIRED>0) overallStatus="EXPIRED";
    else if(cnt.PENDING>0) overallStatus="PENDING";
    else if(cnt.MISSING>0 && cnt.COMPLETE<totalReqs) overallStatus="MISSING";
    totals[overallStatus] = (totals[overallStatus]||0)+1;
    return {department: emp.department||"Unassigned", progressPct, overallStatus};
  });
  return {matrixData, totals};
}

function _gaugeSVG(pct){
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  const color = pct>=90 ? CHART_PALETTE.green : pct>=70 ? CHART_PALETTE.amber : CHART_PALETTE.red;
  const r=70, full=Math.PI*r, dash=(pct/100)*full;
  return `<svg viewBox="0 0 180 100">
    <path d="M10,95 A70,70 0 0 1 170,95" fill="none" stroke="#e1e8f0" stroke-width="16" stroke-linecap="round"/>
    <path d="M10,95 A70,70 0 0 1 170,95" fill="none" stroke="${color}" stroke-width="16" stroke-linecap="round"
      stroke-dasharray="${dash.toFixed(1)} ${full.toFixed(1)}"/>
  </svg>`;
}

function _monthKey(d){ return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; }
function _lastNMonths(n){
  const out=[]; const now=new Date();
  for(let i=n-1;i>=0;i--){ const d=new Date(now.getFullYear(), now.getMonth()-i, 1); out.push({key:_monthKey(d), label:d.toLocaleDateString("en-IN",{month:"short"})}); }
  return out;
}

function _renderHeatmap(attempts){
  const days = 84; // 12 weeks
  const now = new Date(); now.setHours(0,0,0,0);
  const counts = {};
  attempts.forEach(a=>{
    if(!a.created_at) return;
    const d = new Date(a.created_at); d.setHours(0,0,0,0);
    const diff = Math.round((now-d)/86400000);
    if(diff>=0 && diff<days){
      const key = d.toISOString().slice(0,10);
      counts[key] = (counts[key]||0)+1;
    }
  });
  let max = 1;
  Object.values(counts).forEach(v=>{ if(v>max) max=v; });
  const cells = [];
  for(let i=days-1;i>=0;i--){
    const d = new Date(now.getTime()-i*86400000);
    const key = d.toISOString().slice(0,10);
    const c = counts[key]||0;
    let lvl = 0;
    if(c>0){ const ratio=c/max; lvl = ratio>0.75?4 : ratio>0.5?3 : ratio>0.25?2 : 1; }
    cells.push(`<i data-lvl="${lvl}" title="${key} · ${c} activity"></i>`);
  }
  const hasActivity = Object.keys(counts).length>0;
  if(!hasActivity){
    return `<div class="chart-empty">No assessment activity recorded yet.</div>`;
  }
  return `<div class="heatmap-scroll"><div class="heatmap">${cells.join("")}</div></div>
    <div class="heatmap-legend">Less <i data-lvl="0" style="background:#eef2f7"></i><i data-lvl="1" style="background:#bfe9df"></i><i data-lvl="2" style="background:#7ed0c2"></i><i data-lvl="3" style="background:#3bb0a3"></i><i data-lvl="4" style="background:#0e7c86"></i> More</div>`;
}

// --- TRAINING SCHEDULE CALENDAR (admin dashboard) ---
let _calYear = null, _calMonth = null, _calDataByDate = {};

function _calBuildMap(trainings){
  const map = {};
  trainings.forEach(t=>{
    if(!t.training_date) return;
    const key = String(t.training_date).slice(0,10);
    if(!map[key]) map[key] = [];
    map[key].push(t);
  });
  return map;
}

function _calRenderGrid(){
  const now = new Date();
  if(_calYear===null){ _calYear = now.getFullYear(); _calMonth = now.getMonth(); }
  const first = new Date(_calYear, _calMonth, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(_calYear, _calMonth+1, 0).getDate();
  const monthLabel = first.toLocaleDateString("en-IN",{month:"long",year:"numeric"});
  const todayKey = new Date(now.getFullYear(),now.getMonth(),now.getDate()).toISOString().slice(0,10);

  const dows = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  let cells = dows.map(d=>`<div class="cal-dow">${d}</div>`).join("");
  for(let i=0;i<startDow;i++) cells += `<div class="cal-day cal-empty"></div>`;
  for(let day=1; day<=daysInMonth; day++){
    const dateObj = new Date(_calYear, _calMonth, day);
    const key = dateObj.toISOString().slice(0,10);
    const items = _calDataByDate[key] || [];
    const isToday = key === todayKey;
    const hasTr = items.length>0;
    cells += `<div class="cal-day ${isToday?"cal-today":""} ${hasTr?"cal-has":""}" onclick="openCalendarDay('${key}')">
      <span class="cal-num">${day}</span>
      ${hasTr ? `<span class="cal-badge">${items.length} training${items.length>1?"s":""}</span>` : `<span class="cal-plus">+</span>`}
    </div>`;
  }

  return `
    <div class="cal-head">
      <span class="cal-title">🗓️ ${esc(monthLabel)}</span>
      <div class="cal-nav">
        <button class="cal-today-btn" onclick="calGoToday()">Today</button>
        <button class="cal-nav-btn" onclick="calNavMonth(-1)">‹</button>
        <button class="cal-nav-btn" onclick="calNavMonth(1)">›</button>
      </div>
    </div>
    <div class="cal-grid">${cells}</div>
  `;
}

function _calRefresh(){
  const el = $("trainingCalGrid");
  if(el) el.innerHTML = _calRenderGrid();
}

function calNavMonth(delta){
  _calMonth += delta;
  if(_calMonth<0){ _calMonth=11; _calYear--; }
  if(_calMonth>11){ _calMonth=0; _calYear++; }
  _calRefresh();
}

function calGoToday(){
  const now = new Date();
  _calYear = now.getFullYear(); _calMonth = now.getMonth();
  _calRefresh();
}

function openCalendarDay(dateStr){
  const items = _calDataByDate[dateStr] || [];
  const dateLabel = new Date(dateStr+"T00:00:00").toLocaleDateString("en-IN",{weekday:"long",day:"numeric",month:"long",year:"numeric"});
  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal">
        <h2>${esc(dateLabel)}</h2>
        ${items.length ? items.map(t=>`
          <div class="cal-daylist-item">
            <div>
              <b>${esc(t.title)}</b><br>
              <span class="muted" style="font-size:12px">${esc(t.category||"General")} · ${t.published?"Published":"Draft"}</span>
            </div>
            <button class="btn light" onclick="closeModal();trainingForm('${t.id}')">Edit</button>
          </div>
        `).join("") : `<p class="muted">No training scheduled on this date yet.</p>`}
        <div class="actions" style="margin-top:15px">
          <button class="btn blue" onclick="closeModal();trainingForm(null,'${dateStr}')">+ Add Training on this date</button>
          <button class="btn light" onclick="closeModal()">Close</button>
        </div>
      </div>
    </div>
  `);
}

async function dash(){
  if(profile.role==="admin"){
    const [uRes, tRes, attRes, progRes] = await Promise.all([
      sb.from("profiles").select("*").eq("role","user"),
      sb.from("trainings").select("*"),
      sb.from("assessment_attempts").select("*"),
      sb.from("training_progress").select("*")
    ]);

    const employees = uRes.data || [];
    const allTrainings = tRes.data || [];
    const attempts = attRes.data || [];
    const progresses = progRes.data || [];
    const activeTrainings = allTrainings.filter(t=>t.archived!==true);
    const publishedTrainings = allTrainings.filter(t=>t.published && !t.archived);

    // Completed count — same fallback logic previously used on this dashboard
    let completedCount = progresses.filter(p=>p.status==="completed").length;
    if(completedCount===0){
      const uniqueSet = new Set(attempts.filter(a=>a.passed===true).map(x=>`${x.user_id}_${x.training_id}`));
      completedCount = uniqueSet.size;
    }

    _calDataByDate = _calBuildMap(allTrainings);

    const {matrixData, totals} = _buildComplianceMatrix(employees, activeTrainings, attempts, progresses);
    const overallCompliancePct = employees.length>0 ? Math.round((totals.COMPLETE/employees.length)*100) : 0;

    // Department-wise compliance (average progress % per department)
    const deptMap = {};
    matrixData.forEach(m=>{
      if(!deptMap[m.department]) deptMap[m.department] = {sum:0, n:0};
      deptMap[m.department].sum += m.progressPct;
      deptMap[m.department].n += 1;
    });
    const deptLabels = Object.keys(deptMap).sort();
    const deptValues = deptLabels.map(d=>Math.round(deptMap[d].sum/deptMap[d].n));

    // Certificate status — derived from actual assessment attempts per user/training
    let certCertified=0, certFailed=0, certNotAttempted=0;
    const requiredTrainings = publishedTrainings.filter(t=>t.assessment_required);
    if(requiredTrainings.length>0 && employees.length>0){
      employees.forEach(emp=>{
        requiredTrainings.forEach(t=>{
          const uVal = (r)=>String(r.user_id||"").toLowerCase().trim();
          const empId = String(emp.id||"").toLowerCase().trim();
          const userAtt = attempts.filter(a=>uVal(a)===empId && String(a.training_id)===String(t.id));
          if(userAtt.length===0) certNotAttempted++;
          else if(userAtt.some(a=>a.passed===true)) certCertified++;
          else certFailed++;
        });
      });
    }

    // Monthly training completion trend (last 6 months, based on passed attempts)
    const months = _lastNMonths(6);
    const monthlyCompletions = months.map(m=>
      attempts.filter(a=>a.passed===true && a.created_at && _monthKey(new Date(a.created_at))===m.key).length
    );

    // Assessment score trend (average score per month, last 6 months)
    const monthlyScores = months.map(m=>{
      const inMonth = attempts.filter(a=>a.created_at && _monthKey(new Date(a.created_at))===m.key && a.score!==null && a.score!==undefined);
      if(inMonth.length===0) return null;
      return Math.round(inMonth.reduce((s,a)=>s+Number(a.score||0),0)/inMonth.length);
    });
    const hasScoreData = monthlyScores.some(v=>v!==null);

    const html = `
      <div class="chart-row cols-1" style="grid-template-columns:1fr">
        <div class="chart-card">
          <div id="trainingCalGrid">${_calRenderGrid()}</div>
        </div>
      </div>

      <div class="kpi-grid" style="margin-top:22px">
        ${kpi("👥","c1","Total Employees",employees.length)}
        ${kpi("📚","c6","Active Trainings",activeTrainings.length,`${publishedTrainings.length} published`)}
        ${kpi("✅","c3","Completed",completedCount)}
        ${kpi("📝","c2","Assessments Taken",attempts.length)}
        ${kpi("🎓","c5","Certificates Issued",certCertified)}
        ${kpi("📊","c4","Overall Compliance",overallCompliancePct+"%")}
      </div>

      <div class="chart-row cols-2" style="margin-top:22px">
        <div class="chart-card">
          <h4>📈 Monthly Training Completion</h4>
          <span class="chart-sub">Passed assessments by month · last 6 months</span>
          <div class="chart-box"><canvas id="chLine"></canvas></div>
        </div>
        <div class="chart-card">
          <h4>🟢 Compliance Overview</h4>
          <span class="chart-sub">Employee status across active trainings</span>
          <div class="chart-box short"><canvas id="chPie"></canvas></div>
        </div>
      </div>

      <div class="chart-row cols-2">
        <div class="chart-card">
          <h4>🏭 Department-wise Compliance</h4>
          <span class="chart-sub">Average completion % by department</span>
          <div class="chart-box">${deptLabels.length?'<canvas id="chBar"></canvas>':'<div class="chart-empty">No department data available yet.</div>'}</div>
        </div>
        <div class="chart-card">
          <div class="gauge-wrap">
            <h4 style="align-self:flex-start">🎯 Overall Compliance</h4>
            <span class="chart-sub" style="align-self:flex-start">Employees fully compliant vs total workforce</span>
            <div class="gauge">${_gaugeSVG(overallCompliancePct)}<div class="gauge-val"><span class="n">${overallCompliancePct}%</span><span class="l">Compliant</span></div></div>
            <div class="gauge-legend"><span><i style="background:${CHART_PALETTE.green}"></i>≥90%</span><span><i style="background:${CHART_PALETTE.amber}"></i>70–89%</span><span><i style="background:${CHART_PALETTE.red}"></i>&lt;70%</span></div>
          </div>
        </div>
      </div>

      <div class="chart-row cols-2">
        <div class="chart-card">
          <h4>📉 Assessment Score Trend</h4>
          <span class="chart-sub">Average score by month · last 6 months</span>
          <div class="chart-box">${hasScoreData?'<canvas id="chArea"></canvas>':'<div class="chart-empty">No assessment score data available yet.</div>'}</div>
        </div>
        <div class="chart-card">
          <h4>🎓 Certificate Status</h4>
          <span class="chart-sub">Across published trainings requiring assessment</span>
          <div class="chart-box short">${requiredTrainings.length?'<canvas id="chDonut"></canvas>':'<div class="chart-empty">No assessment-required trainings published yet.</div>'}</div>
        </div>
      </div>

      <div class="card" style="margin-top:16px"><h3>Welcome</h3><p class="muted">Use Users Management to add, import, edit or delete portal employees.</p></div>
    `;

    layout("dash","Admin Dashboard", html);
    _destroyDashCharts();

    if(window.Chart){
      Chart.defaults.font.family = "Inter, system-ui, sans-serif";
      Chart.defaults.color = "#64748b";

      const lineEl = $("chLine");
      if(lineEl) _dashCharts.line = new Chart(lineEl, {
        type:"line",
        data:{ labels: months.map(m=>m.label), datasets:[{
          label:"Completions", data: monthlyCompletions, borderColor: CHART_PALETTE.teal,
          backgroundColor:"rgba(18,151,159,.12)", fill:true, tension:.35, pointRadius:3,
          pointBackgroundColor: CHART_PALETTE.teal
        }]},
        options:{ plugins:{legend:{display:false}}, scales:{ y:{beginAtZero:true, ticks:{precision:0}, grid:{color:"#eef2f7"}}, x:{grid:{display:false}} }, maintainAspectRatio:false }
      });

      const pieEl = $("chPie");
      if(pieEl) _dashCharts.pie = new Chart(pieEl, {
        type:"pie",
        data:{ labels:["Completed","Pending","Expired"], datasets:[{
          data:[totals.COMPLETE, totals.PENDING+totals.MISSING, totals.EXPIRED],
          backgroundColor:[CHART_PALETTE.green, CHART_PALETTE.amber, CHART_PALETTE.red],
          borderWidth:2, borderColor:"#fff"
        }]},
        options:{ plugins:{legend:{position:"bottom", labels:{boxWidth:10, padding:14, font:{size:11}}}}, maintainAspectRatio:false }
      });

      const barEl = $("chBar");
      if(barEl) _dashCharts.bar = new Chart(barEl, {
        type:"bar",
        data:{ labels: deptLabels, datasets:[{
          label:"Compliance %", data: deptValues, backgroundColor: CHART_PALETTE.navy, borderRadius:6, maxBarThickness:38
        }]},
        options:{ plugins:{legend:{display:false}}, scales:{ y:{beginAtZero:true, max:100, grid:{color:"#eef2f7"}}, x:{grid:{display:false}} }, maintainAspectRatio:false }
      });

      const areaEl = $("chArea");
      if(areaEl) _dashCharts.area = new Chart(areaEl, {
        type:"line",
        data:{ labels: months.map(m=>m.label), datasets:[{
          label:"Avg Score", data: monthlyScores, borderColor: CHART_PALETTE.purple,
          backgroundColor:"rgba(124,92,214,.15)", fill:true, tension:.35, spanGaps:true, pointRadius:3,
          pointBackgroundColor: CHART_PALETTE.purple
        }]},
        options:{ plugins:{legend:{display:false}}, scales:{ y:{beginAtZero:true, max:100, grid:{color:"#eef2f7"}}, x:{grid:{display:false}} }, maintainAspectRatio:false }
      });

      const donutEl = $("chDonut");
      if(donutEl) _dashCharts.donut = new Chart(donutEl, {
        type:"doughnut",
        data:{ labels:["Certified","Failed","Not Attempted"], datasets:[{
          data:[certCertified, certFailed, certNotAttempted],
          backgroundColor:[CHART_PALETTE.green, CHART_PALETTE.red, CHART_PALETTE.slate],
          borderWidth:2, borderColor:"#fff"
        }]},
        options:{ cutout:"62%", plugins:{legend:{position:"bottom", labels:{boxWidth:10, padding:14, font:{size:11}}}}, maintainAspectRatio:false }
      });
    }
  } else {
    const [p, a, passedAtt] = await Promise.all([
      sb.from("training_progress").select("*",{count:"exact",head:true}).eq("user_id",profile.id).eq("status","completed"),
      sb.from("assessment_attempts").select("*",{count:"exact",head:true}).eq("user_id",profile.id),
      sb.from("assessment_attempts").select("*",{count:"exact",head:true}).eq("user_id",profile.id).eq("passed",true)
    ]);

    let userCompleted = p.count || 0;
    if(userCompleted === 0 && (passedAtt.count || 0) > 0){
      userCompleted = passedAtt.count;
    }

    layout("dash","Welcome, "+esc(profile.name),`<div class="kpi-grid">${kpi("✅","c3","Completed",userCompleted)}${kpi("📝","c2","Assessments",a.count||0)}</div>`);
  }
}

// --- USERS MANAGEMENT MODULE ---

let usersModuleCache = null;
let usersCurrentPage = 1;
const USERS_PAGE_SIZE = 10;
let usersSortCol = "name";
let usersSortDir = "asc";

async function users(){
  let r = await sb.from("profiles").select("*").eq("role","user").order("created_at",{ascending:false});
  const usersList = r.data || [];

  const departments = [...new Set(usersList.map(u => u.department).filter(Boolean))].sort();
  const companies = [...new Set(usersList.map(u => u.company).filter(Boolean))].sort();

  const totalUsers = usersList.length;
  const activeCount = usersList.filter(u => u.active !== false).length;
  const inactiveCount = usersList.filter(u => u.active === false).length;

  usersModuleCache = {
    allUsers: usersList,
    departments: departments,
    companies: companies,
    summary: { total: totalUsers, active: activeCount, inactive: inactiveCount }
  };
  usersCurrentPage = 1;

  layout("users","Users Management",`
    <div class="grid" style="margin-bottom:20px">
      ${metric("Total Users", usersModuleCache.summary.total)}
      ${metric("Active Users", usersModuleCache.summary.active)}
      ${metric("Inactive Users", usersModuleCache.summary.inactive)}
    </div>

    <div class="actions">
      <button class="btn blue" onclick="addUserForm()">➕ Add Manual User</button>
      <button class="btn light" onclick="importExcelModal()">📥 Import Employees from Excel</button>
      <button class="btn light" onclick="downloadUserExcelFormat()">📥 View Format</button>
      <button class="btn light" onclick="exportUsersToExcel()">📤 Export User Details</button>
    </div>

    <div class="card" style="margin-top:16px;margin-bottom:16px;padding:16px">
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:12px;align-items:end">
        <div>
          <label style="font-size:12px;font-weight:bold">Search</label>
          <input id="userSearchInput" placeholder="Name, Emp ID, Dept, Desig..." oninput="renderUsersTable(1)" style="width:100%;margin:4px 0 0">
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Department</label>
          <select id="userFilterDept" onchange="renderUsersTable(1)" style="width:100%;margin:4px 0 0">
            <option value="ALL">All Departments</option>
            ${departments.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Company</label>
          <select id="userFilterComp" onchange="renderUsersTable(1)" style="width:100%;margin:4px 0 0">
            <option value="ALL">All Companies</option>
            ${companies.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Status</label>
          <select id="userFilterStatus" onchange="renderUsersTable(1)" style="width:100%;margin:4px 0 0">
            <option value="ALL">All Statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </select>
        </div>
      </div>
    </div>

    <div class="card" style="padding:16px">
      <div id="usersTableContent"></div>
      <div id="usersPaginationContent" style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;flex-wrap:wrap;gap:8px"></div>
    </div>
  `);

  renderUsersTable(1);
}

function handleUsersSort(colKey) {
  if (usersSortCol === colKey) {
    usersSortDir = usersSortDir === "asc" ? "desc" : "asc";
  } else {
    usersSortCol = colKey;
    usersSortDir = "asc";
  }
  renderUsersTable(usersCurrentPage);
}

function renderUsersTable(page = 1) {
  if (!usersModuleCache) return;
  usersCurrentPage = page;

  const searchQ = ($("userSearchInput")?.value || "").toLowerCase().trim();
  const deptF = $("userFilterDept")?.value || "ALL";
  const compF = $("userFilterComp")?.value || "ALL";
  const statusF = $("userFilterStatus")?.value || "ALL";

  let filtered = usersModuleCache.allUsers.filter(u => {
    if (deptF !== "ALL" && String(u.department || "") !== deptF) return false;
    if (compF !== "ALL" && String(u.company || "") !== compF) return false;
    
    const isActive = u.active !== false;
    if (statusF === "ACTIVE" && !isActive) return false;
    if (statusF === "INACTIVE" && isActive) return false;

    if (searchQ) {
      const haystack = `${u.name || ""} ${u.employee_id || ""} ${u.department || ""} ${u.designation || ""} ${u.company || ""}`.toLowerCase();
      if (!haystack.includes(searchQ)) return false;
    }

    return true;
  });

  filtered.sort((a, b) => {
    let valA = "", valB = "";
    if (usersSortCol === "name") { valA = a.name || ""; valB = b.name || ""; }
    else if (usersSortCol === "employee_id") { valA = a.employee_id || ""; valB = b.employee_id || ""; }
    else if (usersSortCol === "department") { valA = a.department || ""; valB = b.department || ""; }
    else if (usersSortCol === "company") { valA = a.company || ""; valB = b.company || ""; }
    else if (usersSortCol === "status") { valA = a.active !== false ? "Active" : "Inactive"; valB = b.active !== false ? "Active" : "Inactive"; }

    let cmp = String(valA).localeCompare(String(valB), undefined, { numeric: true, sensitivity: 'base' });
    return usersSortDir === "asc" ? cmp : -cmp;
  });

  const totalFiltered = filtered.length;
  const totalPages = Math.ceil(totalFiltered / USERS_PAGE_SIZE) || 1;
  if (usersCurrentPage > totalPages) usersCurrentPage = totalPages;

  const startIndex = (usersCurrentPage - 1) * USERS_PAGE_SIZE;
  const pageUsers = filtered.slice(startIndex, startIndex + USERS_PAGE_SIZE);

  const container = $("usersTableContent");
  const paginationContainer = $("usersPaginationContent");

  if (totalFiltered === 0) {
    container.innerHTML = `<div class="card empty" style="text-align:center;padding:30px">No matching employees found.</div>`;
    paginationContainer.innerHTML = "";
    return;
  }

  const getSortIcon = (colKey) => {
    if (usersSortCol !== colKey) return "↕";
    return usersSortDir === "asc" ? "↑" : "↓";
  };

  container.innerHTML = `
    <div class="tablewrap" style="overflow-x:auto">
      <table class="table">
        <thead>
          <tr>
            <th style="cursor:pointer;white-space:nowrap" onclick="handleUsersSort('name')">Name ${getSortIcon('name')}</th>
            <th style="cursor:pointer;white-space:nowrap" onclick="handleUsersSort('employee_id')">Employee ID ${getSortIcon('employee_id')}</th>
            <th style="cursor:pointer;white-space:nowrap" onclick="handleUsersSort('department')">Department ${getSortIcon('department')}</th>
            <th style="white-space:nowrap">Designation</th>
            <th style="cursor:pointer;white-space:nowrap" onclick="handleUsersSort('company')">Company ${getSortIcon('company')}</th>
            <th style="cursor:pointer;white-space:nowrap" onclick="handleUsersSort('status')">Status ${getSortIcon('status')}</th>
            <th style="white-space:nowrap;text-align:center">Action</th>
          </tr>
        </thead>
        <tbody>
          ${pageUsers.map(u => `
            <tr>
              <td><b>${esc(u.name)}</b></td>
              <td>${esc(u.employee_id || "-")}</td>
              <td>${esc(u.department || "-")}</td>
              <td>${esc(u.designation || "-")}</td>
              <td>${esc(u.company || "-")}</td>
              <td><span class="badge ${u.active===false?"o":"g"}">${u.active===false?"🟠 Inactive":"🟢 Active"}</span></td>
              <td style="white-space:nowrap;text-align:center">
                <button class="btn light" style="color:#12979f" onclick="impersonateUser('${u.id}','${esc(u.name)}')">🔓 Login as User</button>
                <button class="btn light" onclick="editUser('${u.id}')">Edit</button>
                <button class="btn light" style="color:#ed6c02" onclick="adminResetPassword('${u.id}', '${esc(u.name)}')">Reset Pass</button>
                <button class="btn light" style="color:#d32f2f" onclick="confirmDeleteUser('${u.id}', '${esc(u.name)}', '${esc(u.employee_id)}')">Delete</button>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  paginationContainer.innerHTML = `
    <span class="muted" style="font-size:13px">Showing <b>${startIndex + 1}</b> - <b>${Math.min(startIndex + USERS_PAGE_SIZE, totalFiltered)}</b> of <b>${totalFiltered}</b> employees</span>
    <div style="display:flex;gap:6px">
      <button class="btn light" ${usersCurrentPage === 1 ? 'disabled style="opacity:0.5"' : ''} onclick="renderUsersTable(${usersCurrentPage - 1})">Previous</button>
      <span class="chip" style="align-self:center">${usersCurrentPage} / ${totalPages}</span>
      <button class="btn light" ${usersCurrentPage === totalPages ? 'disabled style="opacity:0.5"' : ''} onclick="renderUsersTable(${usersCurrentPage + 1})">Next</button>
    </div>
  `;
}

function adminResetPassword(userId, userName) {
  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:450px">
        <h2>Reset Password</h2>
        <p>Are you sure you want to reset password for <b>${esc(userName)}</b>?</p>
        <p class="muted" style="font-size:13px;margin-top:8px">This will set the employee's password back to the default temporary password (<b>TSL@1234</b>). Current passwords are secure and cannot be viewed.</p>
        <div class="actions" style="justify-content:flex-end;margin-top:16px">
          <button class="btn light" onclick="closeModal()">Cancel</button>
          <button class="btn blue" onclick="executeAdminResetPassword('${userId}')">Confirm Reset</button>
        </div>
      </div>
    </div>
  `);
}

async function executeAdminResetPassword(userId) {
  let s = (await sb.auth.getSession()).data.session;
  if(!s) return alert("Session expired. Please login again.");

  let r = await fetch(`${window.SUPABASE_URL}/functions/v1/admin-create-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + s.access_token,
      "apikey": window.SUPABASE_ANON_KEY
    },
    body: JSON.stringify({ target_user_id: userId, reset_password: "TSL@1234" })
  });

  let d = await r.json().catch(()=>({}));
  closeModal();

  if(!r.ok && !d.success) {
    alert(d.error || d.message || "Failed to reset password via Admin API.");
  } else {
    alert("Password reset successfully. Temporary password set to TSL@1234.");
  }
}

function changeMyPasswordModal() {
  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:450px">
        <h2>Change Password</h2>
        <div style="margin-top:12px">
          <label>Current Password *</label>
          <input type="password" id="myCurrPass" style="width:100%;margin-bottom:12px">
          <label>New Password *</label>
          <input type="password" id="myNewPass" style="width:100%;margin-bottom:12px">
          <label>Confirm New Password *</label>
          <input type="password" id="myConfirmPass" style="width:100%;margin-bottom:12px">
        </div>
        <div class="actions" style="justify-content:flex-end;margin-top:16px">
          <button class="btn light" onclick="closeModal()">Cancel</button>
          <button class="btn blue" onclick="executeChangeMyPassword()">Update Password</button>
        </div>
      </div>
    </div>
  `);
}

async function executeChangeMyPassword() {
  const currPass = $("myCurrPass")?.value;
  const newPass = $("myNewPass")?.value;
  const confirmPass = $("myConfirmPass")?.value;

  if (!currPass || !newPass || !confirmPass) {
    return alert("All password fields are required.");
  }

  if (newPass !== confirmPass) {
    return alert("New Password and Confirm New Password do not match.");
  }

  if (newPass.length < 6) {
    return alert("Password must be at least 6 characters long.");
  }

  const verifyRes = await sb.auth.signInWithPassword({
    email: profile.username || `${String(profile.employee_id).toLowerCase()}@tsl.internal`,
    password: currPass
  });

  if (verifyRes.error) {
    return alert("Current password is incorrect.");
  }

  const updateRes = await sb.auth.updateUser({ password: newPass });

  if (updateRes.error) {
    return alert("Password update failed: " + updateRes.error.message);
  }

  closeModal();
  alert("Password changed successfully!");
}

function addUserForm(){
  document.body.insertAdjacentHTML("beforeend",`
    <div class=modalbg id=modal>
      <div class=modal>
        <h2>Add Manual User</h2>
        <div class=formgrid>
          <div><label>Employee ID *</label><input id=uid placeholder="e.g. EMP001"></div>
          <div><label>Name *</label><input id=un placeholder="Full Name"></div>
          <div><label>Email Address *</label><input id=ue type="email" placeholder="e.g. ravi.kumar@company.com"></div>
          <div><label>Password *</label><input id=up type=password value="TSL@1234"></div>
          <div><label>Department</label><input id=ud placeholder="Electrical"></div>
          <div><label>Designation</label><input id=udes placeholder="Engineer"></div>
          <div class=fullfield><label>Company</label><input id=uc value="Talwandi Sabo Thermal Plant"></div>
          <div>
            <label>Status</label>
            <select id=ustatus>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </select>
          </div>
        </div>
        <div class=actions style="margin-top:15px">
          <button class="btn blue" onclick=createUser()>Create User</button>
          <button class="btn light" onclick=closeModal()>Cancel</button>
        </div>
      </div>
    </div>
  `);
}

async function createUser(){
  let s = (await sb.auth.getSession()).data.session;
  if(!s) return alert("Please login again.");

  let empId = $("uid").value.trim();
  let name = $("un").value.trim();
  let username = $("ue").value.trim();
  let password = $("up").value;

  if(!empId || !name || !password){
    return alert("Employee ID, Name and Password are required.");
  }

  if(!username){
    return alert("Email Address is required. STLP uses this to send training, certificate and other notification emails to the employee.");
  }
  if(!validateEmail(username)){
    return alert("Please enter a valid email address.");
  }
  if(username.toLowerCase().endsWith("@tsl.internal")){
    return alert("Please enter the employee's real email address, not a placeholder.");
  }

  let payload = {
    employee_id: empId,
    name: name,
    username: username,
    password: password,
    department: $("ud").value.trim(),
    designation: $("udes").value.trim(),
    company: $("uc").value.trim(),
    active: $("ustatus").value === "true"
  };

  let r = await fetch(`${window.SUPABASE_URL}/functions/v1/admin-create-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + s.access_token,
      "apikey": window.SUPABASE_ANON_KEY
    },
    body: JSON.stringify(payload)
  });

  let rawText = await r.text().catch(() => "");
  let d = {};
  try { d = JSON.parse(rawText); } catch(e) {}

  if(!r.ok) {
    let mainErr = d.error || `HTTP ${r.status}: ${r.statusText}`;
    let detailErr = d.details || d.message || rawText;
    let formattedMsg = mainErr;
    if(detailErr && detailErr !== mainErr) {
      formattedMsg += ` - ${typeof detailErr === 'object' ? JSON.stringify(detailErr) : detailErr}`;
    }
    return alert("Could not create user: " + formattedMsg);
  }

  closeModal();
  alert("User created successfully.");
  route("users");
}

async function editUser(id){
  let r = await sb.from("profiles").select("*").eq("id",id).single();
  if(r.error) return alert(r.error.message);
  let u = r.data;

  document.body.insertAdjacentHTML("beforeend",`
    <div class=modalbg id=modal>
      <div class=modal>
        <h2>Edit Employee</h2>
        <div class=formgrid>
          <div><label>Employee ID *</label><input id=eid value="${esc(u.employee_id||"")}"></div>
          <div><label>Name *</label><input id=en value="${esc(u.name||"")}"></div>
          <div><label>Email Address *</label><input id=eu type="email" value="${esc((u.username||"").endsWith("@tsl.internal")?"":(u.username||""))}" placeholder="e.g. ravi.kumar@company.com"></div>
          <div><label>Department</label><input id=ed value="${esc(u.department||"")}"></div>
          <div><label>Designation</label><input id=edes value="${esc(u.designation||"")}"></div>
          <div><label>Company</label><input id=ec value="${esc(u.company||"")}"></div>
          <div>
            <label>Status</label>
            <select id=ea>
              <option value="true" ${u.active!==false?"selected":""}>Active</option>
              <option value="false" ${u.active===false?"selected":""}>Inactive</option>
            </select>
          </div>
        </div>
        <div class=actions style="margin-top:15px">
          <button class="btn blue" onclick="saveUser('${id}')">Save Changes</button>
          <button class="btn light" onclick=closeModal()>Cancel</button>
        </div>
      </div>
    </div>
  `);
}

async function saveUser(id){
  let email = $("eu").value.trim();

  let payload = {
    employee_id: $("eid").value.trim(),
    name: $("en").value.trim(),
    username: email,
    department: $("ed").value.trim(),
    designation: $("edes").value.trim(),
    company: $("ec").value.trim(),
    active: $("ea").value === "true"
  };

  if(!payload.employee_id || !payload.name){
    return alert("Employee ID and Name are required.");
  }
  if(!email){
    return alert("Email Address is required. STLP uses this to send training, certificate and other notification emails to the employee.");
  }
  if(!validateEmail(email)){
    return alert("Please enter a valid email address.");
  }
  if(email.toLowerCase().endsWith("@tsl.internal")){
    return alert("Please enter the employee's real email address, not a placeholder.");
  }

  let r = await sb.from("profiles").update(payload).eq("id", id);
  if(r.error){
    alert("Update failed: " + r.error.message);
  } else {
    closeModal();
    alert("Employee updated successfully.");
    route("users");
  }
}

function confirmDeleteUser(id, name, empId){
  document.body.insertAdjacentHTML("beforeend",`
    <div class=modalbg id=modal>
      <div class=modal style="max-width:450px">
        <h2>Confirm Delete</h2>
        <p>Are you sure you want to delete this employee?</p>
        <div class="card" style="margin:12px 0;background:#f9f9f9">
          <p><b>Employee:</b> ${esc(name)}</p>
          <p><b>Employee ID:</b> ${esc(empId||"-")}</p>
        </div>
        <div class=actions style="justify-content:flex-end">
          <button class="btn light" onclick="closeModal()">Cancel</button>
          <button class="btn red" style="background:#d32f2f;color:#fff" onclick="executeDeleteUser('${id}')">Delete</button>
        </div>
      </div>
    </div>
  `);
}

async function executeDeleteUser(id){
  let s = (await sb.auth.getSession()).data.session;
  if(!s) return alert("Session expired. Please login again.");

  let r = await fetch(`${window.SUPABASE_URL}/functions/v1/admin-delete-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + s.access_token,
      "apikey": window.SUPABASE_ANON_KEY
    },
    body: JSON.stringify({ target_user_id: id })
  });

  let d = await r.json().catch(()=>({}));
  if(!r.ok) return alert(d.error || d.message || "Failed to delete user.");

  closeModal();
  alert("Employee deleted successfully.");
  route("users");
}

// --- EXCEL IMPORT / EXPORT MODULE ---

function downloadUserExcelFormat(){
  if(typeof XLSX === "undefined"){
    return alert("XLSX library is not loaded. Please ensure index.html includes the SheetJS script.");
  }
  const sampleRows = [
    { "Employee ID":"EMP001", "Name":"Ravi Kumar", "Department":"Production", "Designation":"Supervisor", "Company":"ABC Pvt Ltd", "Status":"Active", "Username/Email":"ravi.kumar@example.com" },
    { "Employee ID":"EMP002", "Name":"Simran Kaur", "Department":"HR", "Designation":"Executive", "Company":"ABC Pvt Ltd", "Status":"Active", "Username/Email":"simran.kaur@example.com" }
  ];
  const worksheet = XLSX.utils.json_to_sheet(sampleRows, { header: USER_EXCEL_COLUMNS });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Format");
  XLSX.writeFile(workbook, "STLP_Employee_Import_Format.xlsx");
}

function importExcelModal(){
  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal">
        <h2>📥 Import Employees from Excel</h2>
        <p class="muted">File must use the exact format produced by Export User Details.</p>
        <p class="muted" style="margin-top:-8px">⚠️ <b>Username/Email</b> is mandatory for every row — STLP uses it to send training, certificate and other notification emails.</p>
        <div style="margin:20px 0">
          <label>Select Excel File</label>
          <input type="file" id="excelfile" accept=".xlsx, .xls, .csv">
        </div>
        <div class="actions">
          <button class="btn blue" onclick="previewExcelImport()">Parse & Preview</button>
          <button class="btn light" onclick="closeModal()">Cancel</button>
        </div>
      </div>
    </div>
  `);
}

async function previewExcelImport(){
  const fileInput = $("excelfile");
  if(!fileInput.files.length) return alert("Please select an Excel file first.");

  const file = fileInput.files[0];
  const reader = new FileReader();

  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawJson = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

      if(!rawJson || rawJson.length < 2) return alert("The selected Excel file is empty or missing data rows.");

      const fileHeaders = rawJson[0].map(h => String(h||"").trim());
      
      const missingHeaders = USER_EXCEL_COLUMNS.filter(col => !fileHeaders.includes(col));
      if(missingHeaders.length > 0){
        return alert(`Invalid Excel format. Missing required columns:\n\n${missingHeaders.join(", ")}\n\nPlease use the file generated by 'Export User Details'.`);
      }

      const rows = XLSX.utils.sheet_to_json(worksheet);

      const validRows = rows.filter(r => {
        let empId = cleanExcelVal(r["Employee ID"]);
        let name = cleanExcelVal(r["Name"]);
        let email = cleanExcelVal(r["Username/Email"]);
        return empId !== "" || name !== "" || email !== "";
      });

      if(!validRows.length) return alert("No valid employee rows found in the Excel file.");

      pendingImportRows = validRows;
      closeModal();

      let previewRowsHtml = validRows.slice(0, 10).map((r, i) => `
        <tr>
          <td>${i + 2}</td>
          <td>${esc(cleanExcelVal(r["Employee ID"]))}</td>
          <td>${esc(cleanExcelVal(r["Name"]))}</td>
          <td>${esc(cleanExcelVal(r["Username/Email"]) || "-")}</td>
          <td>${esc(cleanExcelVal(r["Department"]) || "-")}</td>
          <td>${esc(cleanExcelVal(r["Designation"]) || "-")}</td>
          <td>${esc(cleanExcelVal(r["Company"]) || "-")}</td>
          <td>${esc(cleanExcelVal(r["Status"]) || "Active")}</td>
        </tr>
      `).join("");

      document.body.insertAdjacentHTML("beforeend", `
        <div class="modalbg" id="modal">
          <div class="modal" style="max-width:900px">
            <h2>Employee Import Preview</h2>
            <p class="muted">Total Rows Detected: <b>${rows.length}</b> (Showing first 10 rows preview)</p>
            <div class="tablewrap" style="max-height:300px;overflow-y:auto;margin:15px 0">
              <table class="table">
                <tr><th>Row</th><th>Emp ID</th><th>Name</th><th>Email</th><th>Dept</th><th>Desig</th><th>Company</th><th>Status</th></tr>
                ${previewRowsHtml}
              </table>
            </div>
            <div class="actions">
              <button class="btn blue" onclick="executeExcelImport()">Confirm & Process Import</button>
              <button class="btn light" onclick="closeModal()">Cancel</button>
            </div>
          </div>
        </div>
      `);

    } catch(err) {
      alert("Error reading Excel file: " + err.message);
    }
  };

  reader.readAsArrayBuffer(file);
}

async function executeExcelImport(){
  if(!pendingImportRows.length) return alert("No data to import.");

  let totalRows = pendingImportRows.length;
  let addedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let invalidEmailCount = 0;
  let duplicateEmailCount = 0;
  let failedCount = 0;

  let rowDetails = [];

  let s = (await sb.auth.getSession()).data.session;
  if(!s) return alert("Session expired. Please login again.");

  let existingRes = await sb.from("profiles").select("id, employee_id, username");
  let existingEmpMap = {};
  let existingEmailMap = {};

  if(existingRes.data){
    existingRes.data.forEach(p => {
      if(p.employee_id) existingEmpMap[cleanExcelVal(p.employee_id).toLowerCase()] = p.id;
      if(p.username) existingEmailMap[cleanExcelVal(p.username).toLowerCase()] = p.id;
    });
  }

  const processedEmpIds = new Set();
  const processedEmails = new Set();

  for (let idx = 0; idx < pendingImportRows.length; idx++) {
    let rowNum = idx + 2;
    let row = pendingImportRows[idx];

    try {
      let empId = cleanExcelVal(row["Employee ID"]);
      let name = cleanExcelVal(row["Name"]);
      let dept = cleanExcelVal(row["Department"]);
      let desig = cleanExcelVal(row["Designation"]);
      let comp = cleanExcelVal(row["Company"]) || "Talwandi Sabo Thermal Plant";
      let statusStr = cleanExcelVal(row["Status"]).toLowerCase();
      let emailVal = cleanExcelVal(row["Username/Email"]);

      if(!empId && !name && !emailVal) {
        continue;
      }

      let active = statusStr !== "inactive" && statusStr !== "false";

      if(!empId || !name){
        skippedCount++;
        rowDetails.push(`Row ${rowNum} (${empId || 'No ID'}): Missing required Employee ID or Name.`);
        continue;
      }

      let empKey = empId.toLowerCase();
      let emailKey = emailVal.toLowerCase();

      if(!emailVal){
        invalidEmailCount++;
        failedCount++;
        rowDetails.push(`Row ${rowNum} (${empId}): Email Address is required (used for training/certificate notification emails).`);
        continue;
      }
      if(!validateEmail(emailVal)){
        invalidEmailCount++;
        failedCount++;
        rowDetails.push(`Row ${rowNum} (${empId}): Invalid email format '${emailVal}'.`);
        continue;
      }
      if(emailKey.endsWith("@tsl.internal")){
        invalidEmailCount++;
        failedCount++;
        rowDetails.push(`Row ${rowNum} (${empId}): Please provide the employee's real email address, not a placeholder.`);
        continue;
      }

      if(processedEmpIds.has(empKey)){
        skippedCount++;
        rowDetails.push(`Row ${rowNum} (${empId}): Duplicate Employee ID in uploaded file - skipped.`);
        continue;
      }
      if(emailKey && processedEmails.has(emailKey)){
        duplicateEmailCount++;
        skippedCount++;
        rowDetails.push(`Row ${rowNum} (${empId}): Duplicate Email '${emailVal}' in uploaded file - skipped.`);
        continue;
      }

      processedEmpIds.add(empKey);
      if(emailKey) processedEmails.add(emailKey);

      let targetEmail = emailVal;
      let existingId = existingEmpMap[empKey] || (emailKey ? existingEmailMap[emailKey] : null);

      if(existingId){
        let up = await sb.from("profiles").update({
          name: name,
          department: dept,
          designation: desig,
          company: comp,
          active: active,
          username: targetEmail
        }).eq("id", existingId);

        if(up.error){
          failedCount++;
          let dbErr = up.error.details || up.error.message || JSON.stringify(up.error);
          rowDetails.push(`Row ${rowNum} (${empId}): Profile update failed - ${dbErr}`);
        } else {
          updatedCount++;
          rowDetails.push(`Row ${rowNum} (${empId}): Existing user updated successfully.`);
        }
      } else {
        let res = await fetch(`${window.SUPABASE_URL}/functions/v1/admin-create-user`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + s.access_token,
            "apikey": window.SUPABASE_ANON_KEY
          },
          body: JSON.stringify({
            employee_id: empId,
            name: name,
            username: targetEmail,
            password: "TSL@1234",
            department: dept,
            designation: desig,
            company: comp,
            active: active
          })
        });

        let rawText = await res.text().catch(() => "");
        let resData = {};
        try { resData = JSON.parse(rawText); } catch(e) {}

        if(res.ok && resData.success){
          addedCount++;
          rowDetails.push(`Row ${rowNum} (${empId}): User created successfully.`);
        } else {
          let mainErr = resData.error || `HTTP ${res.status}: ${res.statusText}`;
          let detailErr = resData.details || resData.message || resData.hint || rawText;

          let formattedMsg = mainErr;
          if(detailErr && detailErr !== mainErr) {
            formattedMsg += ` - ${typeof detailErr === 'object' ? JSON.stringify(detailErr) : detailErr}`;
          }

          failedCount++;
          rowDetails.push(`Row ${rowNum} (${empId}): ${formattedMsg}`);
        }
      }

    } catch(err) {
      failedCount++;
      rowDetails.push(`Row ${rowNum}: Exception - ${err.message || err}`);
    }
  }

  closeModal();
  pendingImportRows = [];

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:600px">
        <h2>Import Completed</h2>
        <div class="card" style="text-align:left;margin:15px 0">
          <p><b>Total Rows:</b> ${totalRows}</p>
          <p style="color:#2e7d32"><b>Successfully Added:</b> ${addedCount}</p>
          <p style="color:#0288d1"><b>Updated Existing:</b> ${updatedCount}</p>
          <p style="color:#ed6c02"><b>Duplicate / Skipped:</b> ${skippedCount}</p>
          ${invalidEmailCount > 0 ? `<p style="color:#ed6c02"><b>Invalid Email:</b> ${invalidEmailCount}</p>` : ''}
          ${duplicateEmailCount > 0 ? `<p style="color:#ed6c02"><b>Duplicate Email:</b> ${duplicateEmailCount}</p>` : ''}
          <p style="color:#d32f2f"><b>Failed:</b> ${failedCount}</p>
        </div>
        
        <details style="text-align:left;margin-bottom:15px">
          <summary style="cursor:pointer;font-weight:bold;margin-bottom:8px">View Row-Level Details (${rowDetails.length})</summary>
          <div style="max-height:180px;overflow-y:auto;background:#f8f9fa;padding:10px;border-radius:6px;font-size:13px">
            <ul style="margin:0;padding-left:18px">
              ${rowDetails.map(d => `<li>${esc(d)}</li>`).join("")}
            </ul>
          </div>
        </details>

        <button class="btn blue full" onclick="closeModal();route('users')">OK</button>
      </div>
    </div>
  `);
}

async function exportUsersToExcel(){
  try {
    if (typeof XLSX === "undefined") {
      return alert("XLSX library is not loaded. Please ensure index.html includes the SheetJS script.");
    }

    const r = await sb.from("profiles").select("*").eq("role","user").order("created_at",{ascending:false});
    if(r.error) return alert("Export error: " + r.error.message);

    const users = r.data || [];
    let exportData = [];

    if(users.length > 0){
      exportData = users.map(u => ({
        "Employee ID": cleanExcelVal(u.employee_id),
        "Name": u.name || "",
        "Department": u.department || "",
        "Designation": u.designation || "",
        "Company": u.company || "",
        "Status": u.active !== false ? "Active" : "Inactive",
        "Username/Email": u.username || ""
      }));
    } else {
      exportData = [{
        "Employee ID": "EMP001",
        "Name": "Sample Employee",
        "Department": "Electrical",
        "Designation": "Engineer",
        "Company": "Talwandi Sabo Thermal Plant",
        "Status": "Active",
        "Username/Email": "emp001@tsl.internal"
      }];
    }

    const worksheet = XLSX.utils.json_to_sheet(exportData, { header: USER_EXCEL_COLUMNS });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Employees");
    XLSX.writeFile(workbook, `STLP_Employee_Master_${Date.now()}.xlsx`);
  } catch (err) {
    alert("Export failed: " + err.message);
  }
}

// --- TRAINING MANAGER MODULE ---

let myTrainingsCache = null;
let userTrainingFilterKey = "ALL";
let adminTrainingDetailsCache = null;
let adminTrainingUserFilter = "ALL";

function confirmDeleteTraining(id, title) {
  if (profile.role !== "admin") return alert("Unauthorized action.");

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:450px">
        <h2>Delete Training?</h2>
        <p>Are you sure you want to permanently delete:</p>
        <p style="font-size:16px;font-weight:bold;margin:12px 0;color:#1f4d3a">"${esc(title)}"?</p>
        <p class="muted" style="font-size:13px">This action cannot be undone.</p>
        <div class="actions" style="justify-content:flex-end;margin-top:18px">
          <button class="btn light" onclick="closeModal()">Cancel</button>
          <button class="btn red" style="background:#d32f2f;color:#fff" onclick="executeDeleteTraining('${id}')">Delete Permanently</button>
        </div>
      </div>
    </div>
  `);
}

async function executeDeleteTraining(id) {
  if (profile.role !== "admin") return alert("Unauthorized action.");

  closeModal();

  try {
    // 1. Linked Records Check (training_progress & assessment_attempts)
    const [progCheck, attCheck] = await Promise.all([
      sb.from("training_progress").select("id", { count: "exact", head: true }).eq("training_id", id),
      sb.from("assessment_attempts").select("id", { count: "exact", head: true }).eq("training_id", id)
    ]);

    if (progCheck.error) console.error("Progress check error:", progCheck.error);
    if (attCheck.error) console.error("Attempts check error:", attCheck.error);

    const hasProgress = (progCheck.count || 0) > 0;
    const hasAttempts = (attCheck.count || 0) > 0;

    if (hasProgress || hasAttempts) {
      alert("Training cannot be permanently deleted because it has linked records. Please Archive the training instead.");
      return;
    }

    // 2. Safely clean up associated assessment questions before deleting the training module
    const qDelete = await sb.from("assessment_questions").delete().eq("training_id", id);
    if (qDelete.error) {
      console.error("Questions cleanup failed:", qDelete.error);
      alert("Training could not be deleted due to associated questions: " + qDelete.error.message);
      await route("train");
      return;
    }

    // 3. Perform DELETE on trainings table and verify modified row count via .select()
    const r = await sb.from("trainings").delete().eq("id", id).select();

    if (r.error) {
      console.error("Supabase DELETE error:", r.error);
      alert("Training could not be deleted: " + r.error.message);
      await route("train");
      return;
    }

    // Strict validation: Check if 0 rows were affected (e.g. missing RLS delete policy or permission failure)
    if (!r.data || r.data.length === 0) {
      console.error("DELETE returned 0 modified rows. Verify RLS DELETE policy for 'trainings' table.");
      alert("Training could not be deleted from database (0 rows affected). Please verify Supabase RLS DELETE permissions for the 'trainings' table.");
      await route("train");
      return;
    }

    // 4. Confirmed Success: Notify admin and re-fetch fresh training list from database
    alert("Training deleted successfully.");
    await route("train");

  } catch (err) {
    console.error("Unexpected error during training delete:", err);
    alert("An unexpected error occurred while deleting training: " + (err.message || err));
    await route("train");
  }
}

async function training(){
  const admin = profile.role === "admin";
  
  if (admin) {
    const [tRes, uRes, attRes, progRes] = await Promise.all([
      sb.from("trainings").select("*").order("created_at",{ascending:false}),
      sb.from("profiles").select("*").eq("role","user"),
      sb.from("assessment_attempts").select("*, trainings(title)"),
      sb.from("training_progress").select("*, trainings(title)")
    ]);

    if(tRes.error) return layout("train","Training",`<div class="card"><b>Error:</b> ${esc(tRes.error.message)}</div>`);
    
    const rows = tRes.data || [];
    const employees = uRes.data || [];
    const attempts = attRes.data || [];
    const progresses = progRes.data || [];
    const now = new Date();

    const totalTrainingsCount = rows.length;
    const publishedCount = rows.filter(t => t.published && !t.archived).length;
    const draftCount = rows.filter(t => !t.published && !t.archived).length;
    const archivedCount = rows.filter(t => t.archived).length;

    const getTrainingUserStats = (t) => {
      const tId = String(t.id || "").toLowerCase().trim();
      const tTitle = String(t.title || "").toLowerCase().trim();

      const matchTraining = (rec) => {
        if (!rec) return false;
        const recTId = String(rec.training_id || rec.training_title || "").toLowerCase().trim();
        const recRelTitle = String(rec.trainings?.title || "").toLowerCase().trim();
        return (
          (recTId !== "" && recTId === tId) ||
          (tTitle !== "" && recTId === tTitle) ||
          (tTitle !== "" && recRelTitle === tTitle)
        );
      };

      let assigned = employees.length;
      let completed = 0;
      let pending = 0;
      let expired = 0;

      employees.forEach(emp => {
        const empUuid = String(emp.id || "").toLowerCase().trim();
        const empCode = String(emp.employee_id || "").toLowerCase().trim();
        const empUser = String(emp.username || "").toLowerCase().trim();

        const matchUser = (rec) => {
          if (!rec) return false;
          const uVal = String(rec.user_id || rec.employee_id || rec.username || "").toLowerCase().trim();
          if (!uVal) return false;
          return uVal === empUuid || (empCode !== "" && uVal === empCode) || (empUser !== "" && uVal === empUser);
        };

        const userAttempts = attempts.filter(a => matchUser(a) && matchTraining(a));
        const passedAttempt = userAttempts.find(a => 
          a.passed === true || 
          String(a.passed).toLowerCase() === 'true' || 
          a.passed === 1 ||
          (a.score !== undefined && a.score !== null && t.passing_marks && Number(a.score) >= Number(t.passing_marks))
        );

        const prog = progresses.find(p => matchUser(p) && matchTraining(p));
        const isCompletedProg = prog && (
          prog.status === 'completed' || 
          String(prog.status).toLowerCase() === 'completed'
        );

        if (passedAttempt || isCompletedProg) {
          let completionDate = null;
          if (passedAttempt && passedAttempt.created_at) {
            completionDate = new Date(passedAttempt.created_at);
          } else if (prog && (prog.updated_at || prog.created_at)) {
            completionDate = new Date(prog.updated_at || prog.created_at);
          }

          if (completionDate && !isNaN(completionDate.getTime()) && t.validity) {
            const valStr = String(t.validity).toLowerCase().trim();
            const valNumMatch = valStr.match(/\d+/);
            const num = valNumMatch ? parseInt(valNumMatch[0], 10) : 1;

            const expiryDate = new Date(completionDate.getTime());
            if (valStr.includes("month")) {
              expiryDate.setMonth(expiryDate.getMonth() + num);
            } else if (valStr.includes("day")) {
              expiryDate.setDate(expiryDate.getDate() + num);
            } else {
              expiryDate.setFullYear(expiryDate.getFullYear() + num);
            }

            if (now > expiryDate) {
              expired++;
            } else {
              completed++;
            }
          } else {
            completed++;
          }
        } else {
          pending++;
        }
      });

      return { assigned, completed, pending, expired };
    };

    return layout("train", "Training Management", `
      <p class="muted">Create and manage training requirements, schedules & assigned employee metrics</p>
      
      <div class="grid" style="margin-bottom:20px">
        ${metric("Total Requirements", totalTrainingsCount)}
        ${metric("Published", publishedCount)}
        ${metric("Draft", draftCount)}
        ${metric("Archived", archivedCount)}
      </div>

      <div class="actions"><button class="btn blue" onclick="trainingForm()">+ Add Training</button></div>
      
      <div style="margin-top:16px">
      ${rows.map(t => {
        const stats = getTrainingUserStats(t);
        const tDateStr = t.created_at ? new Date(t.created_at).toLocaleDateString("en-IN") : "-";
        
        return `
          <div class="card item" style="margin-bottom:16px">
            <div style="flex:1">
              <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
                <h3 style="margin:0">${esc(t.title)}</h3>
                <span class="badge ${t.archived ? "o" : t.published ? "g" : "o"}">${t.archived ? "Archived" : t.published ? "Published" : "Draft"}</span>
                ${t.meet_link ? `<span class="badge b">🎥 Live Meet Set</span>` : ""}
              </div>
              <p class="muted" style="margin:4px 0">${esc(t.category||"General")} · Duration: ${esc(t.duration||"1 Hour")} · Validity: ${esc(t.validity||"1 Year")}</p>
              <p style="margin:4px 0"><span class="badge b">🏭 ${t.target_departments && t.target_departments.length ? esc(t.target_departments.join(", ")) : "All Departments"}</span></p>
              <p style="margin:8px 0">${esc(t.description||"")}</p>
              
              <div style="display:flex;gap:16px;font-size:13px;margin-top:8px;color:#555">
                <div>📅 <b>Training Date:</b> ${tDateStr}</div>
                <div>🕐 <b>Duration:</b> ${esc(t.duration||"1 Hour")}</div>
              </div>

              <div style="display:flex;gap:12px;font-size:12px;margin-top:10px;background:#f8f9fa;padding:8px 12px;border-radius:6px;width:fit-content">
                <div>👥 <b>Assigned:</b> ${stats.assigned}</div>
                <div style="color:#2e7d32">🟢 <b>Completed:</b> ${stats.completed}</div>
                <div style="color:#ed6c02">🟡 <b>Pending:</b> ${stats.pending}</div>
                <div style="color:#d32f2f">🔴 <b>Expired:</b> ${stats.expired}</div>
              </div>
            </div>

            <div class="actions" style="align-self:center;flex-wrap:wrap;gap:6px">
              <button class="btn blue" onclick="viewTrainingDetailsModal('${t.id}')">👥 View Users & Stats</button>
              <button class="btn light" onclick="trainingForm('${t.id}')">Edit</button>
              <button class="btn light" onclick="togglePublish('${t.id}',${!t.published})">${t.published ? "Unpublish" : "Publish"}</button>
              <button class="btn light" onclick="toggleArchive('${t.id}',${!t.archived})">${t.archived ? "Unarchive" : "Archive"}</button>
              <button class="btn light" onclick="manageAssessment('${t.id}')">Assessment</button>
              <button class="btn light" style="color:#d32f2f;border-color:#f8d7da" onclick="confirmDeleteTraining('${t.id}', '${esc(t.title)}')">Delete</button>
            </div>
          </div>
        `;
      }).join("") || '<div class="card empty">No training found.</div>'}
      </div>
    `);
  }

  // --- USER SIDE "MY TRAININGS" VIEW ---
  const [tRes, attRes, progRes] = await Promise.all([
    sb.from("trainings").select("*").eq("published", true).eq("archived", false).order("created_at", { ascending: true }),
    sb.from("assessment_attempts").select("*, trainings(title)").eq("user_id", profile.id).order("created_at", { ascending: false }),
    sb.from("training_progress").select("*, trainings(title)").eq("user_id", profile.id)
  ]);

  const myDept = (profile.department || "").trim();
  const activeTrainings = (tRes.data || []).filter(t =>
    !t.target_departments || t.target_departments.length === 0 || t.target_departments.includes(myDept)
  );
  const userAttempts = attRes.data || [];
  const userProgresses = progRes.data || [];
  const now = new Date();

  let completedCount = 0;
  let pendingCount = 0;
  let expiredCount = 0;

  const processedTrainings = activeTrainings.map(t => {
    const tId = String(t.id || "").toLowerCase().trim();
    const tTitle = String(t.title || "").toLowerCase().trim();

    const matchTraining = (rec) => {
      if (!rec) return false;
      const recTId = String(rec.training_id || rec.training_title || "").toLowerCase().trim();
      const recRelTitle = String(rec.trainings?.title || "").toLowerCase().trim();
      return (
        (recTId !== "" && recTId === tId) ||
        (tTitle !== "" && recTId === tTitle) ||
        (tTitle !== "" && recRelTitle === tTitle)
      );
    };

    const attemptsForT = userAttempts.filter(a => matchTraining(a));
    const passedAttempt = attemptsForT.find(a => 
      a.passed === true || 
      String(a.passed).toLowerCase() === 'true' || 
      a.passed === 1 ||
      (a.score !== undefined && a.score !== null && t.passing_marks && Number(a.score) >= Number(t.passing_marks))
    );

    const prog = userProgresses.find(p => matchTraining(p));
    const isCompletedProg = prog && (
      prog.status === 'completed' || 
      String(prog.status).toLowerCase() === 'completed'
    );

    let status = "PENDING";
    let completionDate = null;
    let expiryDate = null;
    let attemptId = passedAttempt ? passedAttempt.id : null;

    if (passedAttempt || isCompletedProg) {
      if (passedAttempt && passedAttempt.created_at) {
        completionDate = new Date(passedAttempt.created_at);
      } else if (prog && (prog.updated_at || prog.created_at)) {
        completionDate = new Date(prog.updated_at || prog.created_at);
      }

      if (completionDate && !isNaN(completionDate.getTime()) && t.validity) {
        const valStr = String(t.validity).toLowerCase().trim();
        const valNumMatch = valStr.match(/\d+/);
        const num = valNumMatch ? parseInt(valNumMatch[0], 10) : 1;

        expiryDate = new Date(completionDate.getTime());
        if (valStr.includes("month")) {
          expiryDate.setMonth(expiryDate.getMonth() + num);
        } else if (valStr.includes("day")) {
          expiryDate.setDate(expiryDate.getDate() + num);
        } else {
          expiryDate.setFullYear(expiryDate.getFullYear() + num);
        }

        if (now > expiryDate) {
          status = "EXPIRED";
        } else {
          status = "COMPLETED";
        }
      } else {
        status = "COMPLETED";
      }
    } else {
      status = "PENDING";
    }

    if (status === "COMPLETED") completedCount++;
    else if (status === "PENDING") pendingCount++;
    else if (status === "EXPIRED") expiredCount++;

    return {
      ...t,
      computedStatus: status,
      completionDate: completionDate,
      expiryDate: expiryDate,
      attemptId: attemptId
    };
  });

  myTrainingsCache = {
    trainings: processedTrainings,
    summary: {
      total: activeTrainings.length,
      pending: pendingCount,
      completed: completedCount,
      expired: expiredCount
    }
  };

  layout("train", "My Trainings", `
    <p class="muted">Available published trainings assigned to you</p>

    <div class="grid" style="margin-bottom:20px">
      ${metric("Total Assigned", myTrainingsCache.summary.total)}
      ${metric("Pending", myTrainingsCache.summary.pending)}
      ${metric("Completed", myTrainingsCache.summary.completed)}
      ${metric("Expired", myTrainingsCache.summary.expired)}
    </div>

    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap">
      <button id="trFilterAllBtn" class="btn ${userTrainingFilterKey==='ALL'?'blue':'light'}" onclick="filterUserTrainings('ALL')">All (${myTrainingsCache.summary.total})</button>
      <button id="trFilterPendingBtn" class="btn ${userTrainingFilterKey==='PENDING'?'blue':'light'}" onclick="filterUserTrainings('PENDING')">Pending (${myTrainingsCache.summary.pending})</button>
      <button id="trFilterCompletedBtn" class="btn ${userTrainingFilterKey==='COMPLETED'?'blue':'light'}" onclick="filterUserTrainings('COMPLETED')">Completed (${myTrainingsCache.summary.completed})</button>
      <button id="trFilterExpiredBtn" class="btn ${userTrainingFilterKey==='EXPIRED'?'blue':'light'}" onclick="filterUserTrainings('EXPIRED')">Expired (${myTrainingsCache.summary.expired})</button>
    </div>

    <div id="userTrainingsCardsList"></div>
  `);

  renderUserTrainingsCards();
}

async function viewTrainingDetailsModal(trainingId) {
  const [tRes, uRes, attRes, progRes] = await Promise.all([
    sb.from("trainings").select("*").eq("id", trainingId).single(),
    sb.from("profiles").select("*").eq("role", "user").order("created_at", { ascending: false }),
    sb.from("assessment_attempts").select("*").eq("training_id", trainingId),
    sb.from("training_progress").select("*").eq("training_id", trainingId)
  ]);

  if (tRes.error) return alert("Error loading training details: " + tRes.error.message);

  const t = tRes.data;
  const employees = uRes.data || [];
  const attempts = attRes.data || [];
  const progresses = progRes.data || [];
  const now = new Date();

  let completeCount = 0;
  let pendingCount = 0;
  let expiredCount = 0;

  const userStatusList = employees.map(emp => {
    const empUuid = String(emp.id || "").toLowerCase().trim();
    const empCode = String(emp.employee_id || "").toLowerCase().trim();
    const empUser = String(emp.username || "").toLowerCase().trim();

    const matchUser = (rec) => {
      if (!rec) return false;
      const uVal = String(rec.user_id || rec.employee_id || rec.username || "").toLowerCase().trim();
      return uVal === empUuid || (empCode !== "" && uVal === empCode) || (empUser !== "" && uVal === empUser);
    };

    const passedAttempt = attempts.find(a => matchUser(a) && (
      a.passed === true || String(a.passed).toLowerCase() === 'true' || a.passed === 1 ||
      (a.score !== undefined && a.score !== null && t.passing_marks && Number(a.score) >= Number(t.passing_marks))
    ));

    const prog = progresses.find(p => matchUser(p) && (p.status === 'completed' || String(p.status).toLowerCase() === 'completed'));

    let status = "PENDING";
    let completionDate = null;
    let expiryDate = null;

    if (passedAttempt || prog) {
      if (passedAttempt && passedAttempt.created_at) {
        completionDate = new Date(passedAttempt.created_at);
      } else if (prog && (prog.updated_at || prog.created_at)) {
        completionDate = new Date(prog.updated_at || prog.created_at);
      }

      if (completionDate && !isNaN(completionDate.getTime()) && t.validity) {
        const valStr = String(t.validity).toLowerCase().trim();
        const valNumMatch = valStr.match(/\d+/);
        const num = valNumMatch ? parseInt(valNumMatch[0], 10) : 1;

        expiryDate = new Date(completionDate.getTime());
        if (valStr.includes("month")) {
          expiryDate.setMonth(expiryDate.getMonth() + num);
        } else if (valStr.includes("day")) {
          expiryDate.setDate(expiryDate.getDate() + num);
        } else {
          expiryDate.setFullYear(expiryDate.getFullYear() + num);
        }

        if (now > expiryDate) {
          status = "EXPIRED";
          expiredCount++;
        } else {
          status = "COMPLETE";
          completeCount++;
        }
      } else {
        status = "COMPLETE";
        completeCount++;
      }
    } else {
      status = "PENDING";
      pendingCount++;
    }

    return {
      empId: emp.employee_id || "-",
      name: emp.name || "Employee",
      dept: emp.department || "-",
      status: status,
      cDateStr: completionDate ? completionDate.toLocaleDateString("en-IN") : "-",
      eDateStr: expiryDate ? expiryDate.toLocaleDateString("en-IN") : "-"
    };
  });

  adminTrainingDetailsCache = {
    training: t,
    userList: userStatusList
  };
  adminTrainingUserFilter = "ALL";

  const tDateStr = t.created_at ? new Date(t.created_at).toLocaleDateString("en-IN") : "-";

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:950px">
        <h2>${esc(t.title)} — Training Details</h2>
        <p class="muted">${esc(t.category||"General")} · Duration: ${esc(t.duration||"1 Hour")} · Validity: ${esc(t.validity||"1 Year")}</p>
        
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(140px, 1fr));gap:10px;margin:15px 0">
          <div class="card" style="padding:10px">👥 <b>Total Assigned:</b> ${employees.length}</div>
          <div class="card" style="padding:10px;color:#2e7d32">🟢 <b>Complete:</b> ${completeCount}</div>
          <div class="card" style="padding:10px;color:#ed6c02">🟡 <b>Pending:</b> ${pendingCount}</div>
          <div class="card" style="padding:10px;color:#d32f2f">🔴 <b>Expired:</b> ${expiredCount}</div>
        </div>

        <div style="display:flex;gap:20px;font-size:13px;margin-bottom:15px;background:#f8f9fa;padding:10px;border-radius:6px">
          <div>📅 <b>Creation/Scheduled Date:</b> ${tDateStr}</div>
          <div>Status: <b>${t.published ? 'Published' : 'Draft'}</b></div>
          <div>Passing Marks: <b>${t.passing_marks||90}%</b></div>
        </div>

        <div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">
          <button id="trUserFAll" class="btn blue" onclick="filterTrainingUsersList('ALL')">All (${employees.length})</button>
          <button id="trUserFComp" class="btn light" onclick="filterTrainingUsersList('COMPLETE')">Complete (${completeCount})</button>
          <button id="trUserFPend" class="btn light" onclick="filterTrainingUsersList('PENDING')">Pending (${pendingCount})</button>
          <button id="trUserFExp" class="btn light" onclick="filterTrainingUsersList('EXPIRED')">Expired (${expiredCount})</button>
        </div>

        <div class="tablewrap" style="max-height:300px;overflow-y:auto;margin-bottom:15px">
          <table class="table" id="trainingUsersDetailsTable">
            <thead>
              <tr>
                <th>Employee ID</th>
                <th>Name</th>
                <th>Department</th>
                <th>Status</th>
                <th>Completion Date</th>
                <th>Expiry Date</th>
              </tr>
            </thead>
            <tbody id="trainingUsersDetailsTableBody"></tbody>
          </table>
        </div>

        <div class="actions" style="justify-content:flex-end">
          <button class="btn light" onclick="closeModal()">Close</button>
        </div>
      </div>
    </div>
  `);

  renderTrainingUsersDetailsTableBody();
}

function filterTrainingUsersList(filterKey) {
  adminTrainingUserFilter = filterKey;
  if ($("trUserFAll")) $("trUserFAll").className = filterKey === 'ALL' ? "btn blue" : "btn light";
  if ($("trUserFComp")) $("trUserFComp").className = filterKey === 'COMPLETE' ? "btn blue" : "btn light";
  if ($("trUserFPend")) $("trUserFPend").className = filterKey === 'PENDING' ? "btn blue" : "btn light";
  if ($("trUserFExp")) $("trUserFExp").className = filterKey === 'EXPIRED' ? "btn blue" : "btn light";

  renderTrainingUsersDetailsTableBody();
}

function renderTrainingUsersDetailsTableBody() {
  if (!adminTrainingDetailsCache) return;
  const tbody = $("trainingUsersDetailsTableBody");
  if (!tbody) return;

  let list = adminTrainingDetailsCache.userList;
  if (adminTrainingUserFilter !== "ALL") {
    list = list.filter(u => u.status === adminTrainingUserFilter);
  }

  if (list.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">No employees found for status filter '${adminTrainingUserFilter}'.</td></tr>`;
    return;
  }

  const getBadge = (st) => {
    switch(st) {
      case "COMPLETE": return `<span class="badge g">✓ COMPLETE</span>`;
      case "PENDING": return `<span class="badge o" style="background:#fff3cd;color:#856404">⏳ PENDING</span>`;
      case "EXPIRED": return `<span class="badge o" style="background:#f8d7da;color:#721c24">⚠ EXPIRED</span>`;
      default: return `<span class="badge muted">${st}</span>`;
    }
  };

  tbody.innerHTML = list.map(u => `
    <tr>
      <td><b>${esc(u.empId)}</b></td>
      <td>${esc(u.name)}</td>
      <td>${esc(u.dept)}</td>
      <td>${getBadge(u.status)}</td>
      <td>${esc(u.cDateStr)}</td>
      <td>${esc(u.eDateStr)}</td>
    </tr>
  `).join("");
}

function filterUserTrainings(filterKey) {
  userTrainingFilterKey = filterKey;
  if ($("trFilterAllBtn")) $("trFilterAllBtn").className = filterKey === 'ALL' ? "btn blue" : "btn light";
  if ($("trFilterPendingBtn")) $("trFilterPendingBtn").className = filterKey === 'PENDING' ? "btn blue" : "btn light";
  if ($("trFilterCompletedBtn")) $("trFilterCompletedBtn").className = filterKey === 'COMPLETED' ? "btn blue" : "btn light";
  if ($("trFilterExpiredBtn")) $("trFilterExpiredBtn").className = filterKey === 'EXPIRED' ? "btn blue" : "btn light";

  renderUserTrainingsCards();
}

function renderUserTrainingsCards() {
  if (!myTrainingsCache) return;
  const container = $("userTrainingsCardsList");
  if (!container) return;

  let list = myTrainingsCache.trainings;
  if (userTrainingFilterKey !== "ALL") {
    list = list.filter(t => t.computedStatus === userTrainingFilterKey);
  }

  if (list.length === 0) {
    container.innerHTML = `<div class="card empty" style="text-align:center;padding:30px">No trainings found for status filter '${userTrainingFilterKey}'.</div>`;
    return;
  }

  const getStatusBadge = (st) => {
    switch(st) {
      case "COMPLETED": return `<span class="badge g" style="white-space:nowrap">✓ Completed</span>`;
      case "PENDING": return `<span class="badge o" style="white-space:nowrap;background:#fff3cd;color:#856404">⏳ Pending</span>`;
      case "EXPIRED": return `<span class="badge o" style="white-space:nowrap;background:#f8d7da;color:#721c24">⚠ Expired</span>`;
      default: return `<span class="badge muted">${st}</span>`;
    }
  };

  container.innerHTML = list.map(t => {
    const cDateStr = t.completionDate ? new Date(t.completionDate).toLocaleDateString("en-IN") : "-";
    const eDateStr = t.expiryDate ? new Date(t.expiryDate).toLocaleDateString("en-IN") : "-";

    let actionButtonHtml = "";
    if (t.computedStatus === "COMPLETED" && t.attemptId) {
      actionButtonHtml = `<button class="btn blue" onclick="showCertificate('${t.attemptId}')">View Certificate</button>`;
    } else if (t.computedStatus === "COMPLETED" && !t.assessment_required) {
      actionButtonHtml = `<button class="btn blue" onclick="showDeclarationCertificate('${t.id}')">View Certificate</button>`;
    } else if (t.computedStatus === "COMPLETED") {
      actionButtonHtml = `<button class="btn light" onclick="openTraining('${t.id}')">Review Material</button>`;
    } else {
      actionButtonHtml = `<button class="btn blue" onclick="openTraining('${t.id}')">Open / Start Training</button>`;
    }
    const meetBtnHtml = t.meet_link ? `<button type="button" class="btn success" onclick="joinMeeting('${t.id}','${esc(t.meet_link)}')">🎥 Join Meeting</button>` : "";

    return `
      <div class="card item" style="margin-bottom:16px">
        <div style="flex:1">
          <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
            <h3 style="margin:0">${esc(t.title)}</h3>
            ${getStatusBadge(t.computedStatus)}
          </div>
          <p class="muted" style="margin:4px 0">${esc(t.category||"General")} · Duration: ${esc(t.duration||"N/A")} · Validity: ${esc(t.validity||"1 Year")}</p>
          <p style="margin:8px 0">${esc(t.description||"")}</p>
          
          <div style="display:flex;gap:20px;font-size:13px;margin-top:10px;color:#555">
            ${t.computedStatus === 'COMPLETED' ? `<div><b>Completed:</b> ${cDateStr}</div><div><b>Expiry:</b> ${eDateStr}</div>` : ''}
            ${t.computedStatus === 'EXPIRED' ? `<div><b>Last Completed:</b> ${cDateStr}</div><div style="color:#d32f2f"><b>Expired On:</b> ${eDateStr}</div>` : ''}
            ${t.computedStatus === 'PENDING' ? `<div><b>Status:</b> Pending Completion</div>` : ''}
          </div>
        </div>
        <div class="actions" style="align-self:center;flex-direction:column;gap:8px">
          ${meetBtnHtml}
          ${actionButtonHtml}
        </div>
      </div>
    `;
  }).join("");
}

async function generateGoogleMeetLink(){
  const btn = $("tmeetGenBtn");
  const input = $("tmeet");
  const titleVal = ($("tt")?.value || "").trim() || "STLP Training";
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Generating…";
  try{
    const s = (await sb.auth.getSession()).data.session;
    if(!s){ alert("Session expired. Please log in again."); return; }
    const r = await fetch(`${window.SUPABASE_URL}/functions/v1/meet-create`, {
      method: "POST",
      headers: { "Content-Type":"application/json", "Authorization":"Bearer "+s.access_token, "apikey": window.SUPABASE_ANON_KEY },
      body: JSON.stringify({ summary: titleVal })
    });
    const data = await r.json();
    if(!r.ok || !data.success || !data.meetingUri){
      alert("Could not generate Meet link: " + (data.error || "Unknown error") + (data.error && data.error.includes("not connected") ? "\n\nGo to Settings → Meet Integration and connect a Google account first." : ""));
      return;
    }
    input.value = data.meetingUri;
  }catch(e){
    alert("Could not generate Meet link: " + e.message);
  }finally{
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

async function trainingForm(id, presetDate){
  let t = {
    title:"", category:"", description:"", duration:"", validity:"1 Year",
    material_url:"", assessment_required:false, passing_marks:90,
    allowed_attempts:1, published:false, target_departments:null, training_date:presetDate||"",
    certificate_validity_months:null, certificate_template_id:null
  };

  if(id){
    const r = await sb.from("trainings").select("*").eq("id",id).single();
    if(r.error) return alert(r.error.message);
    t = r.data;
  }

  const tdateVal = t.training_date ? String(t.training_date).slice(0,10) : (presetDate||"");

  const deptRes = await sb.from("profiles").select("department").eq("role","user");
  const allDepts = [...new Set((deptRes.data||[]).map(u=>u.department).filter(Boolean))].sort();
  const selectedDepts = new Set(t.target_departments || []);
  const isAllDepts = !t.target_departments || t.target_departments.length === 0;

  // Certificates module: templates available to this training are either "reusable"
  // (template.training_id is null) or already scoped specifically to this training.
  let tplQuery = sb.from("certificate_templates").select("id,template_name,training_id,is_default").order("template_name");
  tplQuery = id ? tplQuery.or(`training_id.is.null,training_id.eq.${id}`) : tplQuery.is("training_id", null);
  const tplRes = await tplQuery;
  const availableTemplates = tplRes.data || [];

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal">
        <h2>${id ? "Edit Training" : "Add Training"}</h2>
        <div class="formgrid">
          <div class="fullfield"><label>Training Title *</label><input id="tt" value="${esc(t.title)}"></div>
          <div><label>Category</label><input id="tc" value="${esc(t.category||"")}"></div>
          <div><label>Duration</label><input id="td" value="${esc(t.duration||"")}"></div>
          <div class="fullfield"><label>Description</label><textarea id="tdesc" rows="4">${esc(t.description||"")}</textarea></div>
          <div><label>Validity</label><input id="tv" value="${esc(t.validity||"1 Year")}"></div>
          <div><label>Training Date</label><input id="ttdate" type="date" value="${esc(tdateVal)}"></div>
          <div class="fullfield">
            <label>Assign To (Departments)</label>
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <input type="checkbox" id="tdeptAll" style="width:auto" ${isAllDepts?"checked":""} onchange="document.querySelectorAll('.tdept-chk').forEach(c=>{c.disabled=this.checked; if(this.checked)c.checked=false;})">
              <label style="margin:0;font-weight:600" for="tdeptAll">All Departments</label>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:10px 18px;padding:10px 12px;border:1.5px solid var(--slate-200);border-radius:10px;max-height:140px;overflow:auto">
              ${allDepts.length ? allDepts.map(d=>`
                <label style="display:flex;align-items:center;gap:6px;font-weight:500;margin:0;font-size:13.5px">
                  <input type="checkbox" class="tdept-chk" style="width:auto" value="${esc(d)}" ${selectedDepts.has(d)?"checked":""} ${isAllDepts?"disabled":""}>
                  ${esc(d)}
                </label>`).join("") : '<span class="muted" style="font-size:12.5px">No departments found yet — add users with a Department first.</span>'}
            </div>
          </div>
          <div class="fullfield">
            <label>Training Material File</label>
            <input id="tfile" type="file" accept=".ppt,.pptx,.pdf,.png,.jpg,.jpeg,.webp,.mp4,.webm,.mov">
          </div>
          <div class="fullfield"><label>YouTube / External Material URL</label><input id="tm" value="${esc((t.material_url||"").startsWith("storage:")?"":(t.material_url||""))}"></div>
          <div class="fullfield">
            <label>Google Meet Link (for Live Training)</label>
            <div style="display:flex;gap:8px">
              <input id="tmeet" value="${esc(t.meet_link||"")}" placeholder="https://meet.google.com/xxx-xxxx-xxx" style="flex:1">
              <button type="button" class="btn light" id="tmeetGenBtn" style="white-space:nowrap" onclick="generateGoogleMeetLink()">🎥 Generate New Link</button>
            </div>
            <span class="muted" style="font-size:11.5px;display:block;margin-top:4px">Generates a live Google Meet link via the Google account connected in Settings → Meet Integration (Admin only).</span>
          </div>
          <div>
            <label>Assessment Required</label>
            <select id="ta">
              <option value="false" ${!t.assessment_required?"selected":""}>No</option>
              <option value="true" ${t.assessment_required?"selected":""}>Yes</option>
            </select>
          </div>
          <div><label>Passing Marks (%)</label><input id="tp" type="number" min="1" max="100" value="${t.passing_marks||90}"></div>
          <div><label>Allowed Attempts</label><input id="tatt" type="number" min="1" value="${t.allowed_attempts||1}"></div>
          <div>
            <label>Certificate Validity (months)</label>
            <input id="tcvm" type="number" min="0" placeholder="Blank = never expires" value="${t.certificate_validity_months ?? ""}">
          </div>
          <div>
            <label>Certificate Template</label>
            <select id="tctpl">
              <option value="">-- None (certificate stays Pending) --</option>
              ${availableTemplates.map(tpl => `
                <option value="${tpl.id}" ${t.certificate_template_id===tpl.id?"selected":""}>
                  ${esc(tpl.template_name)}${tpl.is_default?" (Default)":""}${tpl.training_id?"":" — Reusable"}
                </option>`).join("")}
            </select>
            <span class="muted" style="font-size:11.5px;display:block;margin-top:4px">Manage formats under Certificates &gt; Certificate Format Designer.</span>
          </div>
          <div>
            <label>Status</label>
            <select id="tpub">
              <option value="false" ${!t.published?"selected":""}>Draft</option>
              <option value="true" ${t.published?"selected":""}>Publish</option>
            </select>
          </div>
        </div>
        <div class="actions" style="margin-top:15px">
          <button class="btn blue" onclick="saveTraining('${id||""}')">Save Training</button>
          <button class="btn light" onclick="closeModal()">Cancel</button>
        </div>
      </div>
    </div>
  `);
}

async function saveTraining(id){
  const file = $("tfile").files[0];
  const external = $("tm").value.trim();

  const deptAll = $("tdeptAll")?.checked;
  const selectedDepts = Array.from(document.querySelectorAll(".tdept-chk:checked")).map(c=>c.value);

  const payload = {
    title: $("tt").value.trim(),
    category: $("tc").value.trim(),
    description: $("tdesc").value.trim(),
    duration: $("td").value.trim(),
    validity: $("tv").value.trim() || "1 Year",
    material_url: external,
    assessment_required: $("ta").value === "true",
    passing_marks: Math.max(1, Math.min(100, parseInt($("tp").value||90))),
    allowed_attempts: Math.max(1, parseInt($("tatt").value||1)),
    published: $("tpub").value === "true",
    target_departments: deptAll ? null : (selectedDepts.length ? selectedDepts : null),
    training_date: $("ttdate").value || null,
    meet_link: $("tmeet").value.trim() || null,
    certificate_validity_months: $("tcvm").value.trim() === "" ? null : Math.max(0, parseInt($("tcvm").value)),
    certificate_template_id: $("tctpl").value || null,
    updated_at: new Date().toISOString()
  };

  if(!payload.title) return alert("Training Title is required.");

  let trainingId = id;
  let r;

  if(id){
    r = await sb.from("trainings").update(payload).eq("id",id);
  } else {
    payload.created_by = profile.id;
    r = await sb.from("trainings").insert(payload).select("id").single();
    if(!r.error) trainingId = r.data.id;
  }

  if(r.error) return alert(r.error.message);

  // Auto in-app + push notification when a training is newly created AND published,
  // using the existing notifications table/push pipeline (same one "+ Add Notification" uses).
  // No admin action needed, no new system — just an automatic insert into `notifications`.
  if(!id && payload.published){
    notifyNewTrainingAvailable(payload.title, payload.target_departments).catch(()=>{});
  }

  if(file){
    const safe = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
    const path = `training/${trainingId}/${Date.now()}_${safe}`;

    showUploadOverlay("Uploading training material...");
    const up = await uploadFileWithProgress("training-materials", path, file, setUploadProgress);
    hideUploadOverlay();

    if(up.error) return alert("Training saved, but file upload failed: "+up.error.message);

    await sb.from("trainings")
      .update({material_url:`storage:training-materials/${path}`, updated_at:new Date().toISOString()})
      .eq("id", trainingId);
  }

  closeModal();
  route("train");
}

async function togglePublish(id, value){
  const r = await sb.from("trainings").update({published:value, updated_at:new Date().toISOString()}).eq("id",id);
  if(r.error) return alert(r.error.message);

  if(value){
    const t = await sb.from("trainings").select("title,target_departments").eq("id",id).single();
    if(!t.error) notifyNewTrainingAvailable(t.data.title, t.data.target_departments).catch(()=>{});
  }

  route("train");
}

async function toggleArchive(id, value){
  const r = await sb.from("trainings").update({archived:value, updated_at:new Date().toISOString()}).eq("id",id);
  if(r.error) return alert(r.error.message);
  route("train");
}

async function openTraining(id){
  const r = await sb.from("trainings").select("*").eq("id",id).single();
  if(r.error) return alert(r.error.message);
  const t = r.data;

  // --- PRE-TEST GATE ---
  // If this training has Pre-Test questions and the user hasn't taken it yet,
  // show only the Pre-Test here — material & Post Assessment stay hidden
  // until it's submitted, at which point openTraining() re-runs and the
  // material opens automatically.
  const preQR = await sb.from("pretest_questions").select("id").eq("training_id", id);
  const preQuestions = preQR.data || [];
  if(preQuestions.length){
    const preAttR = await sb.from("pretest_attempts").select("id,score,correct_answers,total_questions").eq("training_id", id).eq("user_id", profile.id).order("created_at",{ascending:false}).limit(1);
    const preDone = (preAttR.data||[])[0];
    if(!preDone){
      document.body.insertAdjacentHTML("beforeend", `
        <div class="modalbg" id="modal">
          <div class="modal" style="max-width:650px">
            <h2>${esc(t.title)}</h2>
            <div class="card" style="margin-top:10px">
              <h3>📝 Pre-Test</h3>
              <p class="muted">Please answer a quick ${preQuestions.length}-question Pre-Test before the training material opens. This is just to record what you already know — there's no pass/fail, and the material will open automatically right after.</p>
              <button class="btn blue" onclick="startPretest('${id}')">Start Pre-Test</button>
            </div>
            <div class="actions"><button class="btn light" onclick="closeModal()">Close</button></div>
          </div>
        </div>
      `);
      return;
    }
  }

  let material = "<p class=muted>No training material added yet.</p>";

  if(t.material_url){
    let url = t.material_url;
    if(url.startsWith("storage:")){
      const raw = url.substring("storage:".length);
      const slash = raw.indexOf("/");
      const bucket = raw.substring(0, slash);
      const path = raw.substring(slash + 1);
      const sr = await sb.storage.from(bucket).createSignedUrl(path, 3600);
      if(!sr.error){
        url = sr.data.signedUrl;
        const lower = path.toLowerCase();
        if(lower.endsWith(".pdf")){
          material = `<h3>Training Material</h3><iframe src="${esc(url)}" style="width:100%;height:600px;border:1px solid #ddd;border-radius:10px"></iframe>`;
        } else if(/\.(png|jpg|jpeg|webp|gif)$/i.test(lower)){
          material = `<h3>Training Material</h3><img src="${esc(url)}" style="max-width:100%;max-height:600px;display:block;margin:auto;border-radius:10px">`;
        } else if(/\.(mp4|webm|mov)$/i.test(lower)){
          material = `<h3>Training Material</h3><video controls style="width:100%;max-height:600px" src="${esc(url)}"></video>`;
        } else if(/\.(ppt|pptx)$/i.test(lower)){
          const viewer = "https://view.officeapps.live.com/op/embed.aspx?src=" + encodeURIComponent(url);
          material = `<h3>Training Material</h3><iframe src="${viewer}" style="width:100%;height:650px;border:1px solid #ddd;border-radius:10px" allowfullscreen></iframe>`;
        } else {
          material = `<h3>Training Material</h3><iframe src="${esc(url)}" style="width:100%;height:600px;border:1px solid #ddd;border-radius:10px"></iframe>`;
        }
      }
    } else if(/youtube\.com|youtu\.be/i.test(url)){
      let vid = "";
      const m = url.match(/(?:v=|youtu\.be\/|embed\/)([^&?\/]+)/i);
      if(m) vid = m[1];
      material = vid ? `<h3>Training Material</h3><iframe width="100%" height="500" src="https://www.youtube.com/embed/${esc(vid)}" frameborder="0" allowfullscreen></iframe>` : `<p><a href="${esc(url)}" target="_blank">Open YouTube Material</a></p>`;
    } else {
      material = `<h3>Training Material</h3><iframe src="${esc(url)}" style="width:100%;height:600px;border:1px solid #ddd;border-radius:10px"></iframe>`;
    }
  }

  let assess = "";
  if(t.assessment_required){
    const a = await sb.from("assessment_attempts").select("id,score,passed,created_at").eq("training_id",id).eq("user_id",profile.id).order("created_at",{ascending:false}).limit(1);
    const last = (a.data||[])[0];
    assess = `<div class="card" style="margin-top:16px">
      <h3>Post Assessment</h3>
      <p class="muted">Passing marks: ${t.passing_marks||90}% · Allowed attempts: ${t.allowed_attempts||1}</p>
      ${last ? `<p>Last result: <b>${last.score}%</b> — ${last.passed ? "Passed" : "Failed"}</p>` : "<p class=muted>Not attempted yet.</p>"}
      ${last && last.passed
        ? `<button class="btn blue" onclick="showCertificate('${last.id}')">View Certificate</button>`
        : `<button class="btn blue" onclick="startAssessment('${id}')">Start Assessment</button>`}
    </div>`;
  }

  // Declaration-based completion — only for trainings that do not have an assessment,
  // since without an assessment there was previously no way to mark them completed.
  let declaration = "";
  if(!t.assessment_required){
    const pr = await sb.from("training_progress").select("*").eq("training_id",id).eq("user_id",profile.id).order("created_at",{ascending:false}).limit(1);
    const prog = (pr.data||[])[0];
    const isDone = prog && (prog.status==="completed" || String(prog.status).toLowerCase()==="completed");
    if(isDone){
      const doneDate = prog.updated_at || prog.created_at;
      declaration = `<div class="card" style="margin-top:16px;border-left:4px solid var(--green-600,#1f9d55)">
        <h3>✅ Training Completed</h3>
        <p class="muted">You declared this training read and completed${doneDate ? " on "+new Date(doneDate).toLocaleDateString("en-IN") : ""}.</p>
        <button class="btn blue" onclick="showDeclarationCertificate('${id}')">View Certificate</button>
      </div>`;
    } else {
      declaration = `<div class="card" style="margin-top:16px">
        <h3>Declaration</h3>
        <label style="display:flex;align-items:flex-start;gap:10px;font-weight:500;margin:10px 0">
          <input type="checkbox" id="declareCheck" style="width:auto;margin-top:3px" onchange="$('declareBtn').disabled=!this.checked">
          <span>I confirm that I have read and gone through this training material carefully and understood its content.</span>
        </label>
        <button id="declareBtn" class="btn blue" disabled onclick="markTrainingComplete('${id}')">OK · Mark Training as Complete</button>
      </div>`;
    }
  }

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:1000px">
        <h2>${esc(t.title)}</h2>
        <p>${esc(t.description||"")}</p>
        ${material}${assess}${declaration}
        <div class="actions"><button class="btn light" onclick="closeModal()">Close</button></div>
      </div>
    </div>
  `);
}

async function markTrainingComplete(trainingId){
  const chk = $("declareCheck");
  if(!chk || !chk.checked){
    return alert("Please tick the declaration checkbox to confirm you have read the training material.");
  }
  const btn = $("declareBtn");
  if(btn){ btn.disabled = true; btn.textContent = "Saving..."; }

  const existing = await sb.from("training_progress").select("id").eq("training_id",trainingId).eq("user_id",profile.id).limit(1);

  // Note: training_progress has no updated_at column (see README V8 fix) — only status/created_at are written.
  let r;
  if(existing.data && existing.data.length){
    r = await sb.from("training_progress").update({ status:"completed" }).eq("id", existing.data[0].id);
  } else {
    r = await sb.from("training_progress").insert({ training_id: trainingId, user_id: profile.id, status:"completed" });
  }

  if(r.error){
    if(btn){ btn.disabled = false; btn.textContent = "OK · Mark Training as Complete"; }
    return alert(r.error.message);
  }

  closeModal();
  showDeclarationCertificate(trainingId);
}

// --- ASSESSMENT MODULE ---

// --- PRE-TEST TAKING FLOW ---
async function startPretest(trainingId){
  closeModal();
  const tr = await sb.from("trainings").select("title").eq("id",trainingId).single();
  const qr = await sb.from("pretest_questions").select("*").eq("training_id",trainingId).order("question_no",{ascending:true});
  const qs = qr.data || [];
  if(!qs.length) return openTraining(trainingId);

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:900px">
        <h2>${esc(tr.data?.title||"")} — Pre-Test</h2>
        <form id="pretestForm">${qs.map((q,i) => `
          <div class="card" style="margin-bottom:12px">
            <b>Q${i+1}. ${esc(q.question_text)}</b>
            ${["A","B","C","D"].map(o => `<label class="optrow">
              <input type="radio" class="assess-radio" name="q${q.id}" value="${o}" required><span>${o}. ${esc(q["option_"+o.toLowerCase()])}</span>
            </label>`).join("")}
          </div>`).join("")}
        </form>
        <div class="actions">
          <button class="btn blue" onclick="submitPretest('${trainingId}')">Submit Pre-Test</button>
        </div>
      </div>
    </div>
  `);
}

async function submitPretest(trainingId){
  const form = $("pretestForm");
  if(!form || !form.reportValidity()) return;

  const qr = await sb.from("pretest_questions").select("id,correct_option").eq("training_id",trainingId);
  const qs = qr.data || [];

  let correct = 0;
  qs.forEach(q => {
    const el = document.querySelector(`input[name="q${q.id}"]:checked`);
    if(el && el.value === q.correct_option) correct++;
  });
  const total = qs.length;
  const score = total ? Math.round((correct/total)*100) : 0;

  const ins = await sb.from("pretest_attempts").insert({
    training_id: trainingId, user_id: profile.id,
    score, total_questions: total, correct_answers: correct
  });
  if(ins.error) return alert(ins.error.message);

  closeModal();
  // Material opens automatically right after the Pre-Test, as requested.
  openTraining(trainingId);
}


async function manageAssessment(trainingId, tab){
  tab = tab || "post";
  const tr = await sb.from("trainings").select("*").eq("id",trainingId).single();
  if(tr.error) return alert(tr.error.message);

  let bodyHtml = "";
  if(tab === "pre"){
    const r = await sb.from("pretest_questions").select("*").eq("training_id",trainingId).order("question_no",{ascending:true});
    const qs = r.data || [];
    bodyHtml = `
      <p class="muted" style="margin-top:0">Asked once, before the training material opens. No pass/fail — just recorded for reference.</p>
      <div class="actions">
        <button class="btn blue" onclick="preQuestionForm('${trainingId}')">+ Add Pre-Test Question</button>
        <button class="btn light" onclick="importQuestionsExcelModal('${trainingId}','pre')">📥 Import Questions from Excel</button>
        <button class="btn light" onclick="downloadQuestionExcelFormat()">📥 View Format</button>
      </div>
      <div style="margin-top:16px">${qs.map(q => `
        <div class="card" style="margin-bottom:10px">
          <b>Q${q.question_no}. ${esc(q.question_text)}</b>
          <ol type="A">${[q.option_a, q.option_b, q.option_c, q.option_d].map((o,i) => `<li>${esc(o)} ${q.correct_option===String.fromCharCode(65+i) ? "<b>(Correct)</b>" : ""}</li>`).join("")}</ol>
          <div class="actions"><button class="btn light" onclick="preQuestionForm('${trainingId}','${q.id}')">Edit</button><button class="btn light" onclick="deletePreQuestion('${q.id}','${trainingId}')">Delete</button></div>
        </div>`).join("") || '<div class="card empty">No Pre-Test questions added yet. Training material will open directly for users until you add some.</div>'}</div>
    `;
  } else {
    if(!tr.data.assessment_required){
      bodyHtml = `<div class="card empty">Enable 'Assessment Required' in Edit Training first to add Post Assessment questions.</div>`;
    } else {
      const r = await sb.from("assessment_questions").select("*").eq("training_id",trainingId).order("question_no",{ascending:true});
      const qs = r.data || [];
      bodyHtml = `
        <div class="actions">
          <button class="btn blue" onclick="questionForm('${trainingId}')">+ Add Question</button>
          <button class="btn light" onclick="importQuestionsExcelModal('${trainingId}','post')">📥 Import Questions from Excel</button>
          <button class="btn light" onclick="downloadQuestionExcelFormat()">📥 View Format</button>
        </div>
        <div style="margin-top:16px">${qs.map(q => `
          <div class="card" style="margin-bottom:10px">
            <b>Q${q.question_no}. ${esc(q.question_text)}</b>
            <ol type="A">${[q.option_a, q.option_b, q.option_c, q.option_d].map((o,i) => `<li>${esc(o)} ${q.correct_option===String.fromCharCode(65+i) ? "<b>(Correct)</b>" : ""}</li>`).join("")}</ol>
            <div class="actions"><button class="btn light" onclick="questionForm('${trainingId}','${q.id}')">Edit</button><button class="btn light" onclick="deleteQuestion('${q.id}','${trainingId}')">Delete</button></div>
          </div>`).join("") || '<div class="card empty">No questions added yet.</div>'}</div>
      `;
    }
  }

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:900px">
        <h2>Assessment — ${esc(tr.data.title)}</h2>
        <div class="actions" style="margin-bottom:6px">
          <button class="btn ${tab==='pre'?'blue':'light'}" onclick="closeModal();manageAssessment('${trainingId}','pre')">A. Pre-Test</button>
          <button class="btn ${tab==='post'?'blue':'light'}" onclick="closeModal();manageAssessment('${trainingId}','post')">B. Post Assessment</button>
          <button class="btn light" style="margin-left:auto" onclick="closeModal()">Close</button>
        </div>
        ${bodyHtml}
      </div>
    </div>
  `);
}

async function questionForm(trainingId, id){
  let q = {question_text:"", option_a:"", option_b:"", option_c:"", option_d:"", correct_option:"A", question_no:1};
  if(id){
    const r = await sb.from("assessment_questions").select("*").eq("id",id).single();
    if(!r.error) q = r.data;
  } else {
    const r = await sb.from("assessment_questions").select("question_no").eq("training_id",trainingId).order("question_no",{ascending:false}).limit(1);
    q.question_no = ((r.data||[])[0]?.question_no || 0) + 1;
  }

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal2">
      <div class="modal">
        <h2>${id ? "Edit" : "Add"} Question</h2>
        <label>Question *</label><textarea id="qtext" rows="3">${esc(q.question_text)}</textarea>
        <div class="formgrid">
          <div><label>Option A *</label><input id="qa" value="${esc(q.option_a)}"></div>
          <div><label>Option B *</label><input id="qb" value="${esc(q.option_b)}"></div>
          <div><label>Option C *</label><input id="qc" value="${esc(q.option_c)}"></div>
          <div><label>Option D *</label><input id="qd" value="${esc(q.option_d)}"></div>
          <div>
            <label>Correct Answer</label>
            <select id="qcorrect">
              ${["A","B","C","D"].map(x => `<option value="${x}" ${q.correct_option===x?"selected":""}>${x}</option>`).join("")}
            </select>
          </div>
          <div><label>Question No.</label><input id="qno" type="number" min="1" value="${q.question_no}"></div>
        </div>
        <div class="actions" style="margin-top:15px">
          <button class="btn blue" onclick="saveQuestion('${trainingId}','${id||""}')">Save Question</button>
          <button class="btn light" onclick="closeQuestionModal()">Cancel</button>
        </div>
      </div>
    </div>
  `);
}

function closeQuestionModal(){ $("modal2")?.remove(); }

async function saveQuestion(trainingId, id){
  const payload = {
    training_id: trainingId,
    question_text: $("qtext").value.trim(),
    option_a: $("qa").value.trim(),
    option_b: $("qb").value.trim(),
    option_c: $("qc").value.trim(),
    option_d: $("qd").value.trim(),
    correct_option: $("qcorrect").value,
    question_no: parseInt($("qno").value || 1)
  };

  if(!payload.question_text || !payload.option_a || !payload.option_b || !payload.option_c || !payload.option_d){
    return alert("Question and all options are required.");
  }

  const r = id ? await sb.from("assessment_questions").update(payload).eq("id",id) : await sb.from("assessment_questions").insert(payload);
  if(r.error) return alert(r.error.message);

  closeQuestionModal();
  closeModal();
  manageAssessment(trainingId);
}

async function deleteQuestion(id, trainingId){
  if(!confirm("Delete this question?")) return;
  await sb.from("assessment_questions").delete().eq("id",id);
  closeModal();
  manageAssessment(trainingId,"post");
}

// --- PRE-TEST QUESTION CRUD (mirrors the Post Assessment question CRUD above) ---
async function preQuestionForm(trainingId, id){
  let q = {question_text:"", option_a:"", option_b:"", option_c:"", option_d:"", correct_option:"A", question_no:1};
  if(id){
    const r = await sb.from("pretest_questions").select("*").eq("id",id).single();
    if(!r.error) q = r.data;
  } else {
    const r = await sb.from("pretest_questions").select("question_no").eq("training_id",trainingId).order("question_no",{ascending:false}).limit(1);
    q.question_no = ((r.data||[])[0]?.question_no || 0) + 1;
  }

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal2">
      <div class="modal">
        <h2>${id ? "Edit" : "Add"} Pre-Test Question</h2>
        <label>Question *</label><textarea id="pqtext" rows="3">${esc(q.question_text)}</textarea>
        <div class="formgrid">
          <div><label>Option A *</label><input id="pqa" value="${esc(q.option_a)}"></div>
          <div><label>Option B *</label><input id="pqb" value="${esc(q.option_b)}"></div>
          <div><label>Option C *</label><input id="pqc" value="${esc(q.option_c)}"></div>
          <div><label>Option D *</label><input id="pqd" value="${esc(q.option_d)}"></div>
          <div>
            <label>Correct Answer</label>
            <select id="pqcorrect">
              ${["A","B","C","D"].map(x => `<option value="${x}" ${q.correct_option===x?"selected":""}>${x}</option>`).join("")}
            </select>
          </div>
          <div><label>Question No.</label><input id="pqno" type="number" min="1" value="${q.question_no}"></div>
        </div>
        <div class="actions" style="margin-top:15px">
          <button class="btn blue" onclick="savePreQuestion('${trainingId}','${id||""}')">Save Question</button>
          <button class="btn light" onclick="closeQuestionModal()">Cancel</button>
        </div>
      </div>
    </div>
  `);
}

async function savePreQuestion(trainingId, id){
  const payload = {
    training_id: trainingId,
    question_text: $("pqtext").value.trim(),
    option_a: $("pqa").value.trim(),
    option_b: $("pqb").value.trim(),
    option_c: $("pqc").value.trim(),
    option_d: $("pqd").value.trim(),
    correct_option: $("pqcorrect").value,
    question_no: parseInt($("pqno").value || 1)
  };

  if(!payload.question_text || !payload.option_a || !payload.option_b || !payload.option_c || !payload.option_d){
    return alert("Question and all options are required.");
  }

  const r = id ? await sb.from("pretest_questions").update(payload).eq("id",id) : await sb.from("pretest_questions").insert(payload);
  if(r.error) return alert(r.error.message);

  closeQuestionModal();
  closeModal();
  manageAssessment(trainingId,"pre");
}

async function deletePreQuestion(id, trainingId){
  if(!confirm("Delete this Pre-Test question?")) return;
  await sb.from("pretest_questions").delete().eq("id",id);
  closeModal();
  manageAssessment(trainingId,"pre");
}

// --- QUESTION EXCEL IMPORT (shared by Pre-Test & Post Assessment) ---

function downloadQuestionExcelFormat(){
  if(typeof XLSX === "undefined"){
    return alert("XLSX library is not loaded. Please ensure index.html includes the SheetJS script.");
  }
  const sampleRows = [
    { "Question No":1, "Question Text":"What is the first step before starting any machine?", "Option A":"Check safety guards", "Option B":"Switch on directly", "Option C":"Ignore the manual", "Option D":"Leave the area", "Correct Option":"A" },
    { "Question No":2, "Question Text":"Which PPE is mandatory in the production area?", "Option A":"Sandals", "Option B":"Safety shoes & helmet", "Option C":"No PPE required", "Option D":"Casual wear", "Correct Option":"B" }
  ];
  const worksheet = XLSX.utils.json_to_sheet(sampleRows, { header: QUESTION_EXCEL_COLUMNS });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Format");
  XLSX.writeFile(workbook, "STLP_Question_Import_Format.xlsx");
}

function importQuestionsExcelModal(trainingId, tab){
  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal2">
      <div class="modal">
        <h2>📥 Import ${tab==='pre'?'Pre-Test':'Post Assessment'} Questions from Excel</h2>
        <p class="muted">Columns required: ${QUESTION_EXCEL_COLUMNS.join(" | ")}</p>
        <div style="margin:20px 0">
          <label>Select Excel File</label>
          <input type="file" id="qexcelfile" accept=".xlsx, .xls, .csv">
        </div>
        <div class="actions">
          <button class="btn blue" onclick="previewQuestionsExcelImport('${trainingId}','${tab}')">Parse & Preview</button>
          <button class="btn light" onclick="closeQuestionModal()">Cancel</button>
        </div>
      </div>
    </div>
  `);
}

function previewQuestionsExcelImport(trainingId, tab){
  const fileInput = $("qexcelfile");
  if(!fileInput.files.length) return alert("Please select an Excel file first.");

  const file = fileInput.files[0];
  const reader = new FileReader();

  reader.onload = function(e){
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawJson = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

      if(!rawJson || rawJson.length < 2) return alert("The selected Excel file is empty or missing data rows.");

      const fileHeaders = rawJson[0].map(h => String(h||"").trim());
      const missingHeaders = QUESTION_EXCEL_COLUMNS.filter(col => !fileHeaders.includes(col));
      if(missingHeaders.length > 0){
        return alert(`Invalid Excel format. Missing required columns:\n\n${missingHeaders.join(", ")}\n\nUse "View Format" to download the correct template.`);
      }

      const rows = XLSX.utils.sheet_to_json(worksheet);

      const validRows = rows.map(r => ({
        question_no: parseInt(cleanExcelVal(r["Question No"])) || 1,
        question_text: cleanExcelVal(r["Question Text"]),
        option_a: cleanExcelVal(r["Option A"]),
        option_b: cleanExcelVal(r["Option B"]),
        option_c: cleanExcelVal(r["Option C"]),
        option_d: cleanExcelVal(r["Option D"]),
        correct_option: cleanExcelVal(r["Correct Option"]).toUpperCase()
      })).filter(q => q.question_text !== "");

      if(!validRows.length) return alert("No valid question rows found in the Excel file.");

      const invalidCorrect = validRows.filter(q => !["A","B","C","D"].includes(q.correct_option));
      if(invalidCorrect.length){
        return alert(`Row(s) with an invalid "Correct Option" found (must be A, B, C or D):\n\nQ: ${invalidCorrect.map(q=>q.question_text).join("\n")}`);
      }
      const incompleteRows = validRows.filter(q => !q.option_a || !q.option_b || !q.option_c || !q.option_d);
      if(incompleteRows.length){
        return alert(`Row(s) missing one or more options (A-D):\n\nQ: ${incompleteRows.map(q=>q.question_text).join("\n")}`);
      }

      pendingQuestionImportRows = validRows;
      closeQuestionModal();

      let previewRowsHtml = validRows.slice(0, 10).map(q => `
        <tr>
          <td>${q.question_no}</td>
          <td>${esc(q.question_text)}</td>
          <td>${esc(q.option_a)}</td>
          <td>${esc(q.option_b)}</td>
          <td>${esc(q.option_c)}</td>
          <td>${esc(q.option_d)}</td>
          <td><b>${esc(q.correct_option)}</b></td>
        </tr>
      `).join("");

      document.body.insertAdjacentHTML("beforeend", `
        <div class="modalbg" id="modal2">
          <div class="modal" style="max-width:900px">
            <h2>Question Import Preview</h2>
            <p class="muted">Total Questions Detected: <b>${validRows.length}</b> (Showing first 10 preview) — these will be <b>added</b> to the existing ${tab==='pre'?'Pre-Test':'Post Assessment'} questions.</p>
            <div class="tablewrap" style="max-height:300px;overflow-y:auto;margin:15px 0">
              <table class="table">
                <tr><th>No.</th><th>Question</th><th>A</th><th>B</th><th>C</th><th>D</th><th>Correct</th></tr>
                ${previewRowsHtml}
              </table>
            </div>
            <div class="actions">
              <button class="btn blue" onclick="executeQuestionsExcelImport('${trainingId}','${tab}')">Confirm & Import</button>
              <button class="btn light" onclick="closeQuestionModal()">Cancel</button>
            </div>
          </div>
        </div>
      `);

    } catch(err){
      alert("Error reading Excel file: " + err.message);
    }
  };

  reader.readAsArrayBuffer(file);
}

async function executeQuestionsExcelImport(trainingId, tab){
  if(!pendingQuestionImportRows.length) return alert("No data to import.");

  const table = tab === "pre" ? "pretest_questions" : "assessment_questions";
  const payload = pendingQuestionImportRows.map(q => ({
    training_id: trainingId,
    question_no: q.question_no,
    question_text: q.question_text,
    option_a: q.option_a,
    option_b: q.option_b,
    option_c: q.option_c,
    option_d: q.option_d,
    correct_option: q.correct_option
  }));

  const r = await sb.from(table).insert(payload);
  pendingQuestionImportRows = [];

  if(r.error) return alert("Import failed: " + r.error.message);

  closeQuestionModal();
  closeModal();
  alert(`${payload.length} question(s) imported successfully.`);
  manageAssessment(trainingId, tab);
}

async function startAssessment(trainingId){
  closeModal();
  const tr = await sb.from("trainings").select("*").eq("id",trainingId).single();
  const t = tr.data;
  const qr = await sb.from("assessment_questions").select("*").eq("training_id",trainingId).order("question_no",{ascending:true});
  const qs = qr.data || [];
  if(!qs.length) return alert("No questions available.");

  const ar = await sb.from("assessment_attempts").select("*").eq("training_id",trainingId).eq("user_id",profile.id).order("created_at",{ascending:false});
  const attempts = ar.data || [];
  const last = attempts[0];
  if(last?.passed) return showCertificate(last.id);

  if(attempts.length >= (t.allowed_attempts || 1) && !attempts.some(x => x.retry_allowed)){
    return alert("Allowed attempts exhausted. Contact Admin.");
  }

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:900px">
        <h2>${esc(t.title)} — Assessment</h2>
        <form id="assessmentForm">${qs.map((q,i) => `
          <div class="card" style="margin-bottom:12px">
            <b>Q${i+1}. ${esc(q.question_text)}</b>
            ${["A","B","C","D"].map(o => `<label class="optrow">
              <input type="radio" class="assess-radio" name="q${q.id}" value="${o}" required><span>${o}. ${esc(q["option_"+o.toLowerCase()])}</span>
            </label>`).join("")}
          </div>`).join("")}
        </form>
        <div class="actions">
          <button class="btn blue" onclick="submitAssessment('${trainingId}')">Submit Assessment</button>
          <button class="btn light" onclick="closeModal()">Cancel</button>
        </div>
      </div>
    </div>
  `);
}

async function submitAssessment(trainingId){
  const form = $("assessmentForm");
  if(!form || !form.reportValidity()) return;

  const qr = await sb.from("assessment_questions").select("id").eq("training_id",trainingId);
  const answers = {};
  qr.data.forEach(q => {
    const el = document.querySelector(`input[name="q${q.id}"]:checked`);
    if(el) answers[q.id] = el.value;
  });

  const res = await sb.rpc("submit_assessment", { p_training_id: trainingId, p_answers: answers });
  if(res.error) return alert(res.error.message);

  const d = res.data;
  closeModal();

  if(d.passed){
    // Additive, non-blocking: email the employee that their certificate is ready.
    sb.from("trainings").select("title").eq("id", trainingId).single().then(tr => {
      notifyByEmail(
        "certificate_issued",
        profile.id,
        "Certificate Available — STLP",
        `Congratulations! You scored ${d.score}% and passed "${tr.data?.title || "your training"}". Your certificate of completion is now available in STLP under "My Certificates".`
      );
    });
  }

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:650px;text-align:center">
        <h2>${d.passed ? "Assessment Passed" : "Assessment Failed"}</h2>
        <p style="font-size:42px;font-weight:700;margin:15px 0">${d.score}%</p>
        <p>${d.correct} of ${d.total} correct.</p>
        <div class="actions" style="justify-content:center">
          ${d.passed ? `<button class="btn blue" onclick="showCertificate('${d.attempt_id}')">View Certificate</button>` : ""}
          <button class="btn light" onclick="closeModal();route('results')">View Results</button>
        </div>
      </div>
    </div>
  `);
}

async function showCertificate(attemptId){
  closeModal();
  const r = await sb.from("assessment_attempts")
    .select("id,training_id,score,passed,created_at,trainings(title),profiles(name,employee_id)")
    .eq("id",attemptId).single();

  if(r.error) return alert(r.error.message);
  const a = r.data;
  const certNo = "STLP-" + String(a.id).replace(/-/g,"").substring(0,10).toUpperCase();

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:900px">
        <div id="certificate" style="border:8px double #1f4d3a;padding:55px 45px;text-align:center;background:#fff">
          <div style="font-size:18px;font-weight:700">TALWANDI SABO THERMAL PLANT</div>
          <h1 style="font-size:38px;margin:30px 0 10px">CERTIFICATE OF COMPLETION</h1>
          <p>This is to certify that</p>
          <h2 style="font-size:28px;margin:10px 0">${esc(a.profiles?.name||"")}</h2>
          <p>Employee ID: <b>${esc(a.profiles?.employee_id||"-")}</b></p>
          <p>has successfully completed training</p>
          <h2>${esc(a.trainings?.title||"")}</h2>
          <p>Score: <b>${a.score}%</b></p>
          <div style="display:flex;justify-content:space-between;margin-top:40px;font-size:12px">
            <div>Cert No: <b>${certNo}</b></div>
            <div>Date: <b>${new Date(a.created_at).toLocaleDateString("en-IN")}</b></div>
          </div>
        </div>
        <div class="actions" style="justify-content:center;margin-top:15px">
          <button class="btn blue" onclick="printCertificate()">Print / Save PDF</button>
          <button class="btn light" onclick="maybeShowFeedback('${a.training_id}')">Close</button>
        </div>
      </div>
    </div>
  `);
}

// Certificate for trainings completed via the read-and-declare flow (no assessment attached).
async function showDeclarationCertificate(trainingId){
  closeModal();
  const [tRes, pRes] = await Promise.all([
    sb.from("trainings").select("title").eq("id",trainingId).single(),
    sb.from("training_progress").select("id,created_at").eq("training_id",trainingId).eq("user_id",profile.id).order("created_at",{ascending:false}).limit(1)
  ]);

  if(tRes.error) return alert(tRes.error.message);
  if(pRes.error) return alert(pRes.error.message);
  const prog = (pRes.data||[])[0];
  if(!prog) return alert("No completion record found for this training yet.");

  const dateVal = prog.created_at;
  const certNo = "STLP-" + String(prog.id).replace(/-/g,"").substring(0,10).toUpperCase();

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:900px">
        <div id="certificate" style="border:8px double #1f4d3a;padding:55px 45px;text-align:center;background:#fff">
          <div style="font-size:18px;font-weight:700">TALWANDI SABO THERMAL PLANT</div>
          <h1 style="font-size:38px;margin:30px 0 10px">CERTIFICATE OF COMPLETION</h1>
          <p>This is to certify that</p>
          <h2 style="font-size:28px;margin:10px 0">${esc(profile.name||"")}</h2>
          <p>Employee ID: <b>${esc(profile.employee_id||"-")}</b></p>
          <p>has successfully completed training</p>
          <h2>${esc(tRes.data.title||"")}</h2>
          <p class="muted">Completed via read &amp; declaration acknowledgement</p>
          <div style="display:flex;justify-content:space-between;margin-top:40px;font-size:12px">
            <div>Cert No: <b>${certNo}</b></div>
            <div>Date: <b>${dateVal ? new Date(dateVal).toLocaleDateString("en-IN") : "-"}</b></div>
          </div>
        </div>
        <div class="actions" style="justify-content:center;margin-top:15px">
          <button class="btn blue" onclick="printCertificate()">Print / Save PDF</button>
          <button class="btn light" onclick="maybeShowFeedback('${trainingId}', true)">Close</button>
        </div>
      </div>
    </div>
  `);
}

function printCertificate(){
  const cert = $("certificate");
  if(!cert) return;
  const w = window.open("","_blank","width=1000,height=800");
  w.document.write(`<html><head><title>Certificate</title><style>body{font-family:Arial;margin:40px}</style></head><body>${cert.outerHTML}</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(()=>w.print(),400);
}

// --- FEEDBACK MODULE ---
// Feedback popup shown once, right after a user first views their certificate for a
// completed training (assessment-passed or declaration-based). If feedback was already
// given for this training, re-viewing the certificate later no longer prompts again.
let _feedbackStarSel = 0;

async function maybeShowFeedback(trainingId, thenGoToTraining){
  closeModal();
  const existing = await sb.from("training_feedback").select("id").eq("training_id",trainingId).eq("user_id",profile.id).limit(1);
  if(existing.error){
    // If the check itself fails, don't block the user's normal flow.
    if(thenGoToTraining) training();
    return;
  }
  if(existing.data && existing.data.length){
    if(thenGoToTraining) training();
    return;
  }
  showFeedbackPopup(trainingId, thenGoToTraining);
}

async function showFeedbackPopup(trainingId, thenGoToTraining){
  const tr = await sb.from("trainings").select("title").eq("id",trainingId).single();
  const tTitle = tr.data?.title || "";
  _feedbackStarSel = 0;

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:520px">
        <h2>Training Feedback</h2>
        <p class="muted">${esc(tTitle)}</p>
        <p>Please rate this training *</p>
        <div id="fbStars" style="font-size:34px;letter-spacing:6px;cursor:pointer;margin:8px 0 18px">
          ${[1,2,3,4,5].map(n=>`<span data-n="${n}" onclick="setFeedbackStar(${n})" style="color:#d9d9d9">★</span>`).join("")}
        </div>
        <label>Comments (optional)</label>
        <textarea id="fbComments" rows="4" placeholder="Any suggestions or comments about this training..."></textarea>
        <div class="actions" style="margin-top:15px">
          <button class="btn blue" onclick="submitFeedback('${trainingId}', ${thenGoToTraining ? "true" : "false"})">Submit Feedback</button>
          <button class="btn light" onclick="skipFeedback(${thenGoToTraining ? "true" : "false"})">Skip</button>
        </div>
      </div>
    </div>
  `);
}

function setFeedbackStar(n){
  _feedbackStarSel = n;
  document.querySelectorAll("#fbStars span").forEach(s => {
    s.style.color = parseInt(s.dataset.n) <= n ? "#e8912c" : "#d9d9d9";
  });
}

function skipFeedback(thenGoToTraining){
  closeModal();
  if(thenGoToTraining) training();
}

async function submitFeedback(trainingId, thenGoToTraining){
  if(!_feedbackStarSel){
    return alert("Please select a star rating before submitting.");
  }
  const btn = document.querySelector("#modal .btn.blue");
  if(btn){ btn.disabled = true; btn.textContent = "Submitting..."; }

  const r = await sb.from("training_feedback").insert({
    training_id: trainingId,
    user_id: profile.id,
    rating: _feedbackStarSel,
    comments: ($("fbComments")?.value || "").trim() || null
  });

  if(r.error){
    if(btn){ btn.disabled = false; btn.textContent = "Submit Feedback"; }
    return alert(r.error.message);
  }

  closeModal();
  if(thenGoToTraining) training();
}

async function feedbackPage(){
  const [fRes, tRes, uRes] = await Promise.all([
    sb.from("training_feedback").select("*, trainings(title), profiles(name,employee_id)").order("created_at",{ascending:false}),
    sb.from("trainings").select("id,title").order("title",{ascending:true}),
    sb.from("profiles").select("id,name,employee_id").eq("role","user").order("name",{ascending:true})
  ]);

  if(fRes.error) return layout("feedback","Feedback",`<div class="card"><b>Error:</b> ${esc(fRes.error.message)}</div>`);

  window._feedbackCache = fRes.data || [];
  const trainingsList = tRes.data || [];
  const usersList = uRes.data || [];

  const total = window._feedbackCache.length;
  const avgRating = total ? (window._feedbackCache.reduce((s,f)=>s+(f.rating||0),0)/total).toFixed(1) : "-";

  layout("feedback","Feedback",`
    <div class="grid" style="margin-bottom:20px">
      ${metric("Total Feedback", total)}
      ${metric("Average Rating", total ? avgRating+" / 5" : "-")}
    </div>

    <div class="card" style="margin-bottom:16px;padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0;font-size:16px">Filters</h3>
        <button class="btn blue" onclick="exportFeedbackCSV()">⬇️ Download CSV</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(170px, 1fr));gap:12px;align-items:end">
        <div>
          <label style="font-size:12px;font-weight:bold">Search Keyword</label>
          <input id="fbSearch" placeholder="Search user, training, comments..." oninput="renderFeedbackTable()" style="width:100%;margin:4px 0 0">
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Training</label>
          <select id="fbFilterTraining" onchange="renderFeedbackTable()" style="width:100%;margin:4px 0 0">
            <option value="ALL">All Trainings</option>
            ${trainingsList.map(t=>`<option value="${t.id}">${esc(t.title)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">User</label>
          <select id="fbFilterUser" onchange="renderFeedbackTable()" style="width:100%;margin:4px 0 0">
            <option value="ALL">All Users</option>
            ${usersList.map(u=>`<option value="${u.id}">${esc(u.name)} (${esc(u.employee_id||"-")})</option>`).join("")}
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Rating</label>
          <select id="fbFilterRating" onchange="renderFeedbackTable()" style="width:100%;margin:4px 0 0">
            <option value="ALL">All Ratings</option>
            ${[5,4,3,2,1].map(n=>`<option value="${n}">${n} Star${n>1?"s":""}</option>`).join("")}
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Date From</label>
          <input type="date" id="fbFilterDateFrom" onchange="renderFeedbackTable()" style="width:100%;margin:4px 0 0">
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Date To</label>
          <input type="date" id="fbFilterDateTo" onchange="renderFeedbackTable()" style="width:100%;margin:4px 0 0">
        </div>
      </div>
    </div>

    <div class="card" style="padding:16px">
      <div id="feedbackTableContent"></div>
    </div>
  `);

  renderFeedbackTable();
}

function _getFilteredFeedback(){
  const searchQ = ($("fbSearch")?.value || "").toLowerCase().trim();
  const trainingF = $("fbFilterTraining")?.value || "ALL";
  const userF = $("fbFilterUser")?.value || "ALL";
  const ratingF = $("fbFilterRating")?.value || "ALL";
  const dateFromVal = $("fbFilterDateFrom")?.value || "";
  const dateToVal = $("fbFilterDateTo")?.value || "";

  const dFrom = dateFromVal ? new Date(dateFromVal + "T00:00:00") : null;
  const dTo = dateToVal ? new Date(dateToVal + "T23:59:59") : null;

  return (window._feedbackCache || []).filter(f => {
    if(trainingF !== "ALL" && f.training_id !== trainingF) return false;
    if(userF !== "ALL" && f.user_id !== userF) return false;
    if(ratingF !== "ALL" && String(f.rating) !== ratingF) return false;

    const ts = new Date(f.created_at);
    if(dFrom && ts < dFrom) return false;
    if(dTo && ts > dTo) return false;

    if(searchQ){
      const haystack = `${f.profiles?.name||""} ${f.profiles?.employee_id||""} ${f.trainings?.title||""} ${f.comments||""}`.toLowerCase();
      if(!haystack.includes(searchQ)) return false;
    }
    return true;
  });
}

function exportFeedbackCSV(){
  const filtered = _getFilteredFeedback();
  if(!filtered.length) return alert("No feedback to export for the current filters.");

  let csv = "Date,User,Employee ID,Training,Rating,Comments\n";
  filtered.forEach(f => {
    const dateStr = new Date(f.created_at).toLocaleString("en-IN");
    const row = [
      dateStr,
      f.profiles?.name || "",
      f.profiles?.employee_id || "",
      f.trainings?.title || "",
      f.rating || "",
      f.comments || ""
    ];
    csv += row.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",") + "\n";
  });

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `STLP_Feedback_${Date.now()}.csv`;
  a.click();
}

function renderFeedbackTable(){
  const container = $("feedbackTableContent");
  if(!container) return;

  const filtered = _getFilteredFeedback();

  if(!filtered.length){
    container.innerHTML = `<div class="card empty" style="text-align:center;padding:30px">No feedback found.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="tablewrap" style="overflow-x:auto">
      <table class="table">
        <thead>
          <tr>
            <th style="white-space:nowrap">Date</th>
            <th style="white-space:nowrap">User</th>
            <th style="white-space:nowrap">Training</th>
            <th style="white-space:nowrap">Rating</th>
            <th>Comments</th>
          </tr>
        </thead>
        <tbody>
          ${filtered.map(f => `
            <tr>
              <td style="white-space:nowrap">${new Date(f.created_at).toLocaleDateString("en-IN")}</td>
              <td><b>${esc(f.profiles?.name||"")}</b><br><span class="muted" style="font-size:12px">${esc(f.profiles?.employee_id||"-")}</span></td>
              <td>${esc(f.trainings?.title||"")}</td>
              <td style="white-space:nowrap;color:#e8912c">${"★".repeat(f.rating||0)}${"☆".repeat(5-(f.rating||0))}</td>
              <td>${esc(f.comments||"-")}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
  `;
}

// --- OTHER SYSTEM MODULES ---

async function assessmentResults(){
  if(profile.role==="admin"){
    const r = await sb.from("assessment_attempts").select("*, trainings(title), profiles(name,employee_id)").order("created_at",{ascending:false});
    layout("results","Assessment Results",`<div class=tablewrap><table class=table><tr><th>User</th><th>Emp ID</th><th>Training</th><th>Score</th><th>Status</th><th>Date</th></tr>${(r.data||[]).map(a=>`<tr><td>${esc(a.profiles?.name||"")}</td><td>${esc(a.profiles?.employee_id||"")}</td><td>${esc(a.trainings?.title||"")}</td><td>${a.score}%</td><td><span class="badge ${a.passed?"g":"o"}">${a.passed?"Passed":"Failed"}</span></td><td>${new Date(a.created_at).toLocaleString()}</td></tr>`).join("")||'<tr><td colspan=6 class=empty>No attempts.</td></tr>'}</table></div>`);
  } else {
    const r = await sb.from("assessment_attempts").select("*, trainings(title)").eq("user_id",profile.id).order("created_at",{ascending:false});
    layout("results","My Assessments",`<div class=tablewrap><table class=table><tr><th>Training</th><th>Score</th><th>Status</th><th>Date</th></tr>${(r.data||[]).map(a=>`<tr><td>${esc(a.trainings?.title||"")}</td><td>${a.score}%</td><td><span class="badge ${a.passed?"g":"o"}">${a.passed?"Passed":"Failed"}</span></td><td>${new Date(a.created_at).toLocaleString()}</td></tr>`).join("")||'<tr><td colspan=4 class=empty>No attempts.</td></tr>'}</table></div>`);
  }
}

async function notifications(){
  const admin = profile.role === "admin";

  // Clear the Home Screen app badge + any pending OS notifications whenever
  // the user opens this page (covers the case where they opened the app
  // icon directly instead of tapping a push notification).
  if("clearAppBadge" in navigator) navigator.clearAppBadge().catch(()=>{});
  if("serviceWorker" in navigator){
    navigator.serviceWorker.ready.then(reg =>
      reg.getNotifications().then(list => list.forEach(n => n.close()))
    ).catch(()=>{});
  }

  const r = await sb.from("notifications").select("*").order("created_at",{ascending:false});
  const myDept = (profile.department || "").trim();
  const visibleNotifications = admin ? (r.data||[]) : (r.data||[]).filter(n =>
    !n.target_departments || n.target_departments.length === 0 || n.target_departments.includes(myDept)
  );
  layout("notes","Notifications",`
    <div class="actions">
      ${admin ? `<button class="btn blue" onclick="addNotificationForm()">+ Add Notification</button>` : ""}
      <button class="btn light" id="pushEnableBtn" onclick="enablePushNotifications()">🔔 Enable Notifications</button>
    </div>
    <div style="margin-top:16px">${visibleNotifications.map(n=>`
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
          <h3 style="margin:0">${esc(n.title)}</h3>
          <span class="muted" style="font-size:12px;white-space:nowrap">🕐 ${n.created_at ? new Date(n.created_at).toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short"}) : "-"}</span>
        </div>
        <p style="margin:8px 0 0">${esc(n.message)}</p>
        ${admin ? `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px">
          <span class="badge b">🏭 ${n.target_departments && n.target_departments.length ? esc(n.target_departments.join(", ")) : "All Departments"}</span>
          <button class="btn light" style="padding:4px 10px;font-size:12px;color:#c0392b" onclick="deleteNotification('${n.id}')">🗑️ Delete</button>
        </div>` : ""}
      </div>`).join("")||'<div class="card empty">No notifications.</div>'}</div>
  `);
}

async function deleteNotification(id){
  if(!confirm("Delete this notification? This cannot be undone.")) return;
  const r = await sb.from("notifications").delete().eq("id", id);
  if(r.error) return alert("Could not delete: " + r.error.message);
  notifications();
}

async function addNotificationForm(){
  const deptRes = await sb.from("profiles").select("department").eq("role","user");
  const allDepts = [...new Set((deptRes.data||[]).map(u=>u.department).filter(Boolean))].sort();

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal"><div class="modal">
      <h2>Add Notification</h2>
      <label>Title</label><input id="ntitle">
      <label>Message</label><textarea id="nmsg" rows="4"></textarea>
      <div class="fullfield" style="margin-top:10px">
        <label>Send To (Departments)</label>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <input type="checkbox" id="ndeptAll" style="width:auto" checked onchange="document.querySelectorAll('.ndept-chk').forEach(c=>{c.disabled=this.checked; if(this.checked)c.checked=false;})">
          <label style="margin:0;font-weight:600" for="ndeptAll">All Departments</label>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:10px 18px;padding:10px 12px;border:1.5px solid var(--slate-200);border-radius:10px;max-height:140px;overflow:auto">
          ${allDepts.length ? allDepts.map(d=>`
            <label style="display:flex;align-items:center;gap:6px;font-weight:500;margin:0;font-size:13.5px">
              <input type="checkbox" class="ndept-chk" style="width:auto" value="${esc(d)}" disabled>
              ${esc(d)}
            </label>`).join("") : '<span class="muted" style="font-size:12.5px">No departments found yet — add users with a Department first.</span>'}
        </div>
      </div>
      <div class="fullfield" style="margin-top:10px;display:flex;align-items:center;gap:8px">
        <input type="checkbox" id="nSendEmail" style="width:auto">
        <label style="margin:0;font-weight:600" for="nSendEmail">Also send by email</label>
      </div>
      <div class="actions" style="margin-top:15px"><button class="btn blue" onclick="saveNotification()">Publish</button><button class="btn light" onclick="closeModal()">Cancel</button></div>
    </div></div>
  `);
}

async function saveNotification(){
  const deptAll = $("ndeptAll")?.checked;
  const selectedDepts = Array.from(document.querySelectorAll(".ndept-chk:checked")).map(c=>c.value);
  const sendEmail = $("nSendEmail")?.checked;
  const title = $("ntitle").value.trim();
  const message = $("nmsg").value.trim();

  await sb.from("notifications").insert({
    title,
    message,
    target_departments: deptAll ? null : (selectedDepts.length ? selectedDepts : null)
  });

  if(sendEmail){
    // Additive, non-blocking: fan out to matching active employees by email too.
    try{
      let q = sb.from("profiles").select("id").eq("role","user").eq("active", true);
      if(!deptAll && selectedDepts.length) q = q.in("department", selectedDepts);
      const usersRes = await q;
      (usersRes.data || []).forEach(u => {
        notifyByEmail("manual_notification", u.id, title, message);
      });
    }catch(e){ /* non-blocking */ }
  }

  closeModal();
  notifications();
}

// Auto-notification for newly published trainings. Reuses the exact same
// `notifications` table/pipeline as the admin's manual "+ Add Notification"
// button — so it goes out via in-app + push the same way, automatically,
// with no admin action required. target_departments mirrors the training's
// own department targeting, so only assigned employees see/get it.
async function notifyNewTrainingAvailable(trainingTitle, targetDepartments){
  const deptNote = (targetDepartments && targetDepartments.length)
    ? ` (for ${targetDepartments.join(", ")})`
    : "";
  const r = await sb.from("notifications").insert({
    title: "New Training Assigned",
    message: `A new training "${trainingTitle}" has been added${deptNote}. Open "My Trainings" to view and complete it.`,
    target_departments: (targetDepartments && targetDepartments.length) ? targetDepartments : null
  });

  // Additive: also email every targeted (active) employee. Best-effort —
  // never blocks/undoes the in-app notification above if email fails.
  try{
    let q = sb.from("profiles").select("id").eq("role","user").eq("active", true);
    if(targetDepartments && targetDepartments.length) q = q.in("department", targetDepartments);
    const usersRes = await q;
    (usersRes.data || []).forEach(u => {
      notifyByEmail(
        "training_assigned",
        u.id,
        "New Training Assigned — STLP",
        `A new training "${trainingTitle}" has been assigned to you. Please log in to STLP and open "My Trainings" to view and complete it.`
      );
    });
  }catch(e){ /* non-blocking */ }

  return r;
}

// --- WEB PUSH SUBSCRIPTION (iOS 16.4+ requires "Add to Home Screen" first) ---

function urlBase64ToUint8Array(base64String){
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

async function enablePushNotifications(){
  if(!("serviceWorker" in navigator) || !("PushManager" in window)){
    return alert("Push notifications aren't supported in this browser. On iPhone: open this site in Safari, tap Share → 'Add to Home Screen', then open the app icon from your Home Screen and try again (needs iOS 16.4+).");
  }
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if(isIOS && !isStandalone){
    return alert("On iPhone, notifications only work after adding this app to your Home Screen.\n\nTap the Share icon in Safari → 'Add to Home Screen' → open STLP from the Home Screen icon → then tap 'Enable Notifications' again.");
  }

  try {
    const permission = await Notification.requestPermission();
    if(permission !== "granted") return alert("Notification permission was not granted.");

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if(!sub){
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(window.VAPID_PUBLIC_KEY)
      });
    }

    const subJson = sub.toJSON();
    const r = await sb.from("push_subscriptions").upsert({
      user_id: profile.id,
      endpoint: subJson.endpoint,
      p256dh: subJson.keys.p256dh,
      auth: subJson.keys.auth,
      user_agent: navigator.userAgent
    }, { onConflict: "endpoint" });

    if(r.error) return alert("Could not save subscription: " + r.error.message);

    const btn = $("pushEnableBtn");
    if(btn) btn.textContent = "🔔 Notifications Enabled";
    alert("Notifications enabled on this device.");
  } catch(err){
    alert("Could not enable notifications: " + err.message);
  }
}

async function progress(){
  const admin = profile.role === "admin";
  
  if(!admin){
    return layout("progress","My Progress",`<div class="card"><p class="muted">Check "My Trainings" or "Assessments" for your personal progress.</p></div>`);
  }

  const [uRes, tRes, attRes, progRes] = await Promise.all([
    sb.from("profiles").select("*").eq("role","user").order("created_at",{ascending:false}),
    sb.from("trainings").select("*").order("created_at",{ascending:true}),
    sb.from("assessment_attempts").select("*, trainings(title)"),
    sb.from("training_progress").select("*, trainings(title)")
  ]);

  const employees = uRes.data || [];
  const rawTrainings = tRes.data || [];
  const attempts = attRes.data || [];
  const progresses = progRes.data || [];

  const activeTrainings = rawTrainings.filter(t => t.archived !== true);
  const now = new Date();

  const getItemStatus = (emp, training) => {
    if (!training) return "MISSING";

    const empUuid = String(emp.id || "").toLowerCase().trim();
    const empCode = String(emp.employee_id || "").toLowerCase().trim();
    const empUser = String(emp.username || "").toLowerCase().trim();
    const tId = String(training.id || "").toLowerCase().trim();
    const tTitle = String(training.title || "").toLowerCase().trim();

    const matchUser = (rec) => {
      if (!rec) return false;
      const uVal = String(rec.user_id || rec.employee_id || rec.username || "").toLowerCase().trim();
      if (!uVal) return false;
      return uVal === empUuid || (empCode !== "" && uVal === empCode) || (empUser !== "" && uVal === empUser);
    };

    const matchTraining = (rec) => {
      if (!rec) return false;
      const recTId = String(rec.training_id || rec.training_title || "").toLowerCase().trim();
      const recRelTitle = String(rec.trainings?.title || "").toLowerCase().trim();
      
      return (
        (recTId !== "" && recTId === tId) ||
        (tTitle !== "" && recTId === tTitle) ||
        (tTitle !== "" && recRelTitle === tTitle)
      );
    };

    const userAttempts = attempts.filter(a => matchUser(a) && matchTraining(a));
    const passedAttempt = userAttempts.find(a => 
      a.passed === true || 
      String(a.passed).toLowerCase() === 'true' || 
      a.passed === 1 ||
      (a.score !== undefined && a.score !== null && training.passing_marks && Number(a.score) >= Number(training.passing_marks))
    );

    const prog = progresses.find(p => matchUser(p) && matchTraining(p));
    const isCompletedProg = prog && (
      prog.status === 'completed' || 
      String(prog.status).toLowerCase() === 'completed'
    );

    if (passedAttempt || isCompletedProg) {
      let completionDate = null;
      if (passedAttempt && passedAttempt.created_at) {
        completionDate = new Date(passedAttempt.created_at);
      } else if (prog && (prog.updated_at || prog.created_at)) {
        completionDate = new Date(prog.updated_at || prog.created_at);
      }

      if (completionDate && !isNaN(completionDate.getTime()) && training.validity) {
        const valStr = String(training.validity).toLowerCase().trim();
        const valNumMatch = valStr.match(/\d+/);
        const num = valNumMatch ? parseInt(valNumMatch[0], 10) : 1;

        const expiryDate = new Date(completionDate.getTime());
        if (valStr.includes("month")) {
          expiryDate.setMonth(expiryDate.getMonth() + num);
        } else if (valStr.includes("day")) {
          expiryDate.setDate(expiryDate.getDate() + num);
        } else {
          expiryDate.setFullYear(expiryDate.getFullYear() + num);
        }

        if (now > expiryDate) {
          return "EXPIRED";
        }
      }
      return "COMPLETE";
    }

    return "PENDING";
  };

  let totalCompliantCount = 0;
  let totalPendingCount = 0;
  let totalExpiredCount = 0;
  let totalMissingCount = 0;

  const matrixData = employees.map(emp => {
    let empCompliant = 0;
    let empPending = 0;
    let empExpired = 0;
    let empMissing = 0;

    const items = activeTrainings.map(t => {
      const st = getItemStatus(emp, t);
      if (st === "COMPLETE" || st === "COMPLIANT") empCompliant++;
      else if (st === "PENDING") empPending++;
      else if (st === "EXPIRED") empExpired++;
      else if (st === "MISSING") empMissing++;
      return { trainingId: t.id, title: t.title, status: st };
    });

    const totalReqs = activeTrainings.length;
    const progressPct = totalReqs > 0 ? Math.round((empCompliant / totalReqs) * 100) : 0;

    let overallStatus = "COMPLETE";
    if (totalReqs === 0) {
      overallStatus = "COMPLETE";
    } else if (empExpired > 0) {
      overallStatus = "EXPIRED";
    } else if (empPending > 0) {
      overallStatus = "PENDING";
    } else if (empMissing > 0 && empCompliant < totalReqs) {
      overallStatus = "MISSING";
    }

    if (overallStatus === "COMPLETE" || overallStatus === "COMPLIANT") totalCompliantCount++;
    else if (overallStatus === "PENDING") totalPendingCount++;
    else if (overallStatus === "EXPIRED") totalExpiredCount++;
    else if (overallStatus === "MISSING") totalMissingCount++;

    return {
      empId: emp.employee_id || "-",
      name: emp.name || "Employee",
      department: emp.department || "-",
      overallStatus: overallStatus,
      progressPct: progressPct,
      items: items
    };
  });

  const getStatusBadge = (st) => {
    switch(st) {
      case "COMPLETE":
      case "COMPLIANT": return `<span class="badge g" style="white-space:nowrap">✓ COMPLETE</span>`;
      case "PENDING": return `<span class="badge o" style="white-space:nowrap;background:#fff3cd;color:#856404">⏳ PENDING</span>`;
      case "EXPIRED": return `<span class="badge o" style="white-space:nowrap">⚠ EXPIRED</span>`;
      case "MISSING": return `<span class="badge r" style="white-space:nowrap;background:#f8d7da;color:#721c24">✕ MISSING</span>`;
      default: return `<span class="badge muted">${st}</span>`;
    }
  };

  const getIconStatus = (st) => {
    switch(st) {
      case "COMPLETE":
      case "COMPLIANT": return `<span title="COMPLETE" style="color:#2e7d32;font-weight:bold;font-size:16px">✓</span>`;
      case "PENDING": return `<span title="PENDING" style="color:#ed6c02;font-weight:bold;font-size:16px">⏳</span>`;
      case "EXPIRED": return `<span title="EXPIRED" style="color:#d32f2f;font-weight:bold;font-size:16px">⚠</span>`;
      case "MISSING": return `<span title="MISSING" style="color:#c62828;font-weight:bold;font-size:16px">✕</span>`;
      default: return `-`;
    }
  };

  layout("progress", "Detailed Progress", `
    <p class="muted">Users Compliance Matrix</p>
    
    <div class="grid" style="margin-bottom:20px">
      ${metric("Total Managed Employees", employees.length)}
      ${metric("Complete", totalCompliantCount)}
      ${metric("Pending", totalPendingCount)}
      ${metric("Expired", totalExpiredCount)}
      ${metric("Missing", totalMissingCount)}
    </div>

    <div class="card" style="margin-bottom:16px;padding:12px;display:flex;gap:12px;flex-wrap:wrap;align-items:center">
      <div style="flex:1;min-width:200px">
        <input id="matrixSearch" placeholder="Search Employee ID or Name..." oninput="filterMatrix()" style="margin:0;width:100%">
      </div>
      <div>
        <select id="matrixFilter" onchange="filterMatrix()" style="margin:0">
          <option value="ALL">Filter: All Statuses</option>
          <option value="COMPLETE">Complete</option>
          <option value="PENDING">Pending</option>
          <option value="EXPIRED">Expired</option>
          <option value="MISSING">Missing</option>
        </select>
      </div>
    </div>

    <div class="tablewrap" style="overflow-x:auto;max-width:100%">
      <table class="table" id="matrixTable">
        <thead>
          <tr>
            <th style="white-space:nowrap">Employee ID</th>
            <th style="white-space:nowrap">Employee Name</th>
            <th style="white-space:nowrap">Overall Progress</th>
            <th style="white-space:nowrap">Overall Status</th>
            ${activeTrainings.map(t => `<th style="white-space:nowrap;text-align:center" title="${esc(t.title)}">${esc(t.title.length > 20 ? t.title.substring(0,18)+'...' : t.title)}</th>`).join("")}
          </tr>
        </thead>
        <tbody>
          ${matrixData.map(r => `
            <tr data-status="${r.overallStatus}" data-search="${esc(r.empId.toLowerCase() + ' ' + r.name.toLowerCase())}">
              <td><b>${esc(r.empId)}</b></td>
              <td>${esc(r.name)}</td>
              <td>
                <div style="display:flex;align-items:center;gap:8px">
                  <div style="flex:1;background:#eee;height:8px;border-radius:4px;overflow:hidden;min-width:60px">
                    <div style="width:${r.progressPct}%;background:${r.progressPct===100?'#2e7d32':'#0288d1'};height:100%"></div>
                  </div>
                  <span style="font-size:12px;font-weight:bold">${r.progressPct}%</span>
                </div>
              </td>
              <td>${getStatusBadge(r.overallStatus)}</td>
              ${r.items.map(it => `<td style="text-align:center">${getIconStatus(it.status)}</td>`).join("")}
            </tr>
          `).join("") || '<tr><td colspan="' + (4 + activeTrainings.length) + '" class="empty">No employee progress data available.</td></tr>'}
        </tbody>
      </table>
    </div>
  `);
}

function filterMatrix(){
  const q = ($("matrixSearch")?.value || "").toLowerCase().trim();
  const st = $("matrixFilter")?.value || "ALL";
  const rows = document.querySelectorAll("#matrixTable tbody tr");

  rows.forEach(r => {
    const rowStatus = r.getAttribute("data-status");
    const rowSearch = r.getAttribute("data-search") || "";

    const matchesSearch = !q || rowSearch.includes(q);
    const matchesFilter = st === "ALL" || rowStatus === st || (st === "COMPLETE" && (rowStatus === "COMPLIANT" || rowStatus === "COMPLETE"));

    if (matchesSearch && matchesFilter) {
      r.style.display = "";
    } else {
      r.style.display = "none";
    }
  });
}

// Global cached dataset for Reports & Analytics
let reportsDataCache = null;

async function reports(){
  const admin = profile.role === "admin";
  
  if(!admin){
    return layout("reports", "Reports & Analytics", `<div class="card"><p class="muted">Reports and export functionality are accessible to Administrators.</p></div>`);
  }

  const [uRes, tRes, attRes, progRes] = await Promise.all([
    sb.from("profiles").select("*").eq("role","user").order("created_at",{ascending:false}),
    sb.from("trainings").select("*").order("created_at",{ascending:true}),
    sb.from("assessment_attempts").select("*, trainings(title)"),
    sb.from("training_progress").select("*, trainings(title)")
  ]);

  const employees = uRes.data || [];
  const rawTrainings = tRes.data || [];
  const attempts = attRes.data || [];
  const progresses = progRes.data || [];

  const activeTrainings = rawTrainings.filter(t => t.archived !== true);
  const now = new Date();

  const getItemStatusDetail = (emp, training) => {
    if (!training) return { status: "MISSING", completionDate: null, expiryDate: null };

    const empUuid = String(emp.id || "").toLowerCase().trim();
    const empCode = String(emp.employee_id || "").toLowerCase().trim();
    const empUser = String(emp.username || "").toLowerCase().trim();
    const tId = String(training.id || "").toLowerCase().trim();
    const tTitle = String(training.title || "").toLowerCase().trim();

    const matchUser = (rec) => {
      if (!rec) return false;
      const uVal = String(rec.user_id || rec.employee_id || rec.username || "").toLowerCase().trim();
      if (!uVal) return false;
      return uVal === empUuid || (empCode !== "" && uVal === empCode) || (empUser !== "" && uVal === empUser);
    };

    const matchTraining = (rec) => {
      if (!rec) return false;
      const recTId = String(rec.training_id || rec.training_title || "").toLowerCase().trim();
      const recRelTitle = String(rec.trainings?.title || "").toLowerCase().trim();
      return (
        (recTId !== "" && recTId === tId) ||
        (tTitle !== "" && recTId === tTitle) ||
        (tTitle !== "" && recRelTitle === tTitle)
      );
    };

    const userAttempts = attempts.filter(a => matchUser(a) && matchTraining(a));
    const passedAttempt = userAttempts.find(a => 
      a.passed === true || 
      String(a.passed).toLowerCase() === 'true' || 
      a.passed === 1 ||
      (a.score !== undefined && a.score !== null && training.passing_marks && Number(a.score) >= Number(training.passing_marks))
    );

    const prog = progresses.find(p => matchUser(p) && matchTraining(p));
    const isCompletedProg = prog && (
      prog.status === 'completed' || 
      String(prog.status).toLowerCase() === 'completed'
    );

    if (passedAttempt || isCompletedProg) {
      let completionDate = null;
      if (passedAttempt && passedAttempt.created_at) {
        completionDate = new Date(passedAttempt.created_at);
      } else if (prog && (prog.updated_at || prog.created_at)) {
        completionDate = new Date(prog.updated_at || prog.created_at);
      }

      let expiryDate = null;
      if (completionDate && !isNaN(completionDate.getTime()) && training.validity) {
        const valStr = String(training.validity).toLowerCase().trim();
        const valNumMatch = valStr.match(/\d+/);
        const num = valNumMatch ? parseInt(valNumMatch[0], 10) : 1;

        expiryDate = new Date(completionDate.getTime());
        if (valStr.includes("month")) {
          expiryDate.setMonth(expiryDate.getMonth() + num);
        } else if (valStr.includes("day")) {
          expiryDate.setDate(expiryDate.getDate() + num);
        } else {
          expiryDate.setFullYear(expiryDate.getFullYear() + num);
        }

        if (now > expiryDate) {
          return { status: "EXPIRED", completionDate, expiryDate };
        }
      }
      return { status: "COMPLETE", completionDate, expiryDate };
    }

    return { status: "PENDING", completionDate: null, expiryDate: null };
  };

  let summaryComplete = 0;
  let summaryPending = 0;
  let summaryExpired = 0;
  let summaryMissing = 0;

  const compiledEmployees = employees.map(emp => {
    let empComplete = 0;
    let empPending = 0;
    let empExpired = 0;
    let empMissing = 0;

    const items = activeTrainings.map(t => {
      const detail = getItemStatusDetail(emp, t);
      if (detail.status === "COMPLETE" || detail.status === "COMPLIANT") empComplete++;
      else if (detail.status === "PENDING") empPending++;
      else if (detail.status === "EXPIRED") empExpired++;
      else if (detail.status === "MISSING") empMissing++;

      return {
        trainingId: t.id,
        trainingTitle: t.title,
        status: detail.status,
        completionDate: detail.completionDate,
        expiryDate: detail.expiryDate
      };
    });

    const totalReqs = activeTrainings.length;
    const progressPct = totalReqs > 0 ? Math.round((empComplete / totalReqs) * 100) : 0;

    let overallStatus = "COMPLETE";
    if (totalReqs === 0) {
      overallStatus = "COMPLETE";
    } else if (empExpired > 0) {
      overallStatus = "EXPIRED";
    } else if (empPending > 0) {
      overallStatus = "PENDING";
    } else if (empMissing > 0 && empComplete < totalReqs) {
      overallStatus = "MISSING";
    }

    if (overallStatus === "COMPLETE" || overallStatus === "COMPLIANT") summaryComplete++;
    else if (overallStatus === "PENDING") summaryPending++;
    else if (overallStatus === "EXPIRED") summaryExpired++;
    else if (overallStatus === "MISSING") summaryMissing++;

    return {
      id: emp.id,
      empId: emp.employee_id || "-",
      name: emp.name || "Employee",
      department: emp.department || "-",
      designation: emp.designation || "-",
      company: emp.company || "-",
      overallStatus: overallStatus,
      progressPct: progressPct,
      items: items
    };
  });

  reportsDataCache = {
    employees: compiledEmployees,
    activeTrainings: activeTrainings,
    summary: {
      totalEmployees: employees.length,
      complete: summaryComplete,
      pending: summaryPending,
      expired: summaryExpired,
      missing: summaryMissing
    },
    activeTab: 'emp'
  };

  layout("reports", "Reports & Analytics", `
    <p class="muted">Detailed Compliance Metrics, Auditing Preview & Filtered Export Options</p>
    
    <div class="grid" style="margin-bottom:20px">
      ${metric("Total Managed Employees", reportsDataCache.summary.totalEmployees)}
      ${metric("Complete", reportsDataCache.summary.complete)}
      ${metric("Pending", reportsDataCache.summary.pending)}
      ${metric("Expired", reportsDataCache.summary.expired)}
      ${metric("Missing", reportsDataCache.summary.missing)}
    </div>

    <div class="card" style="margin-bottom:16px;padding:16px">
      <h3 style="margin-top:0;margin-bottom:12px;font-size:16px">Report Filters</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:12px;align-items:end">
        <div>
          <label style="font-size:12px;font-weight:bold">Employee</label>
          <select id="rptFilterEmp" onchange="renderReportTab()" style="width:100%;margin:4px 0 0">
            <option value="ALL">All Employees</option>
            ${compiledEmployees.map(e => `<option value="${esc(e.id)}">${esc(e.empId)} - ${esc(e.name)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Training Requirement</label>
          <select id="rptFilterTraining" onchange="renderReportTab()" style="width:100%;margin:4px 0 0">
            <option value="ALL">All Trainings</option>
            ${activeTrainings.map(t => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Status</label>
          <select id="rptFilterStatus" onchange="renderReportTab()" style="width:100%;margin:4px 0 0">
            <option value="ALL">All Statuses</option>
            <option value="COMPLETE">Complete</option>
            <option value="PENDING">Pending</option>
            <option value="EXPIRED">Expired</option>
            <option value="MISSING">Missing</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Date From</label>
          <input type="date" id="rptFilterDateFrom" onchange="renderReportTab()" style="width:100%;margin:4px 0 0">
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Date To</label>
          <input type="date" id="rptFilterDateTo" onchange="renderReportTab()" style="width:100%;margin:4px 0 0">
        </div>
      </div>
    </div>

    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:12px">
      <div style="display:flex;gap:8px">
        <button id="rptTabEmpBtn" class="btn blue" onclick="switchReportTab('emp')">Employee Compliance Report</button>
        <button id="rptTabStatusBtn" class="btn light" onclick="switchReportTab('status')">Training Status Report</button>
        <button id="rptTabSummaryBtn" class="btn light" onclick="switchReportTab('summary')">Training Summary Report</button>
      </div>
      <div>
        <button id="rptExportBtn" class="btn blue" onclick="exportSelectedReport()">📥 Export Report (CSV)</button>
      </div>
    </div>

    <div class="card" style="padding:16px">
      <div id="reportPreviewContent"></div>
    </div>
  `);

  renderReportTab();
}

function switchReportTab(tabKey) {
  if (!reportsDataCache) return;
  reportsDataCache.activeTab = tabKey;

  $("rptTabEmpBtn").className = tabKey === 'emp' ? "btn blue" : "btn light";
  $("rptTabStatusBtn").className = tabKey === 'status' ? "btn blue" : "btn light";
  $("rptTabSummaryBtn").className = tabKey === 'summary' ? "btn blue" : "btn light";

  renderReportTab();
}

function filterReportRecords() {
  if (!reportsDataCache) return { employees: [], trainings: [] };

  const empFilter = $("rptFilterEmp")?.value || "ALL";
  const trainingFilter = $("rptFilterTraining")?.value || "ALL";
  const statusFilter = $("rptFilterStatus")?.value || "ALL";
  const dateFromVal = $("rptFilterDateFrom")?.value || "";
  const dateToVal = $("rptFilterDateTo")?.value || "";

  const dFrom = dateFromVal ? new Date(dateFromVal + "T00:00:00") : null;
  const dTo = dateToVal ? new Date(dateToVal + "T23:59:59") : null;

  let activeTrainings = reportsDataCache.activeTrainings;
  if (trainingFilter !== "ALL") {
    activeTrainings = activeTrainings.filter(t => String(t.id) === String(trainingFilter));
  }

  let employees = reportsDataCache.employees;
  if (empFilter !== "ALL") {
    employees = employees.filter(e => String(e.id) === String(empFilter));
  }

  const processedEmployees = employees.map(emp => {
    let items = emp.items;

    if (trainingFilter !== "ALL") {
      items = items.filter(it => String(it.trainingId) === String(trainingFilter));
    }

    if (statusFilter !== "ALL") {
      items = items.filter(it => {
        if (statusFilter === "COMPLETE" || statusFilter === "COMPLIANT") {
          return it.status === "COMPLETE" || it.status === "COMPLIANT";
        }
        return it.status === statusFilter;
      });
    }

    if (dFrom || dTo) {
      items = items.filter(it => {
        if (!it.completionDate) return false;
        const cDate = new Date(it.completionDate);
        if (dFrom && cDate < dFrom) return false;
        if (dTo && cDate > dTo) return false;
        return true;
      });
    }

    return { ...emp, items: items };
  }).filter(emp => {
    if (statusFilter !== "ALL") {
      const matchesOverall = statusFilter === "COMPLETE" 
        ? (emp.overallStatus === "COMPLETE" || emp.overallStatus === "COMPLIANT") 
        : emp.overallStatus === statusFilter;
      return matchesOverall || emp.items.length > 0;
    }
    return emp.items.length > 0 || trainingFilter === "ALL";
  });

  return { employees: processedEmployees, trainings: activeTrainings };
}

function renderReportTab() {
  if (!reportsDataCache) return;

  const tab = reportsDataCache.activeTab;
  const container = $("reportPreviewContent");
  if (!container) return;

  const { employees, trainings } = filterReportRecords();
  const getBadge = (st) => {
    switch(st) {
      case "COMPLETE":
      case "COMPLIANT": return `<span class="badge g">✓ COMPLETE</span>`;
      case "PENDING": return `<span class="badge o" style="background:#fff3cd;color:#856404">⏳ PENDING</span>`;
      case "EXPIRED": return `<span class="badge o">⚠ EXPIRED</span>`;
      case "MISSING": return `<span class="badge r" style="background:#f8d7da;color:#721c24">✕ MISSING</span>`;
      default: return `<span class="badge muted">${st}</span>`;
    }
  };

  if (tab === 'emp') {
    $("rptExportBtn").innerText = "📥 Export Employee Compliance CSV";
    container.innerHTML = `
      <h4 style="margin-top:0;margin-bottom:12px">Report Preview — Employee Compliance (${employees.length} Records)</h4>
      <div class="tablewrap" style="overflow-x:auto">
        <table class="table">
          <thead>
            <tr>
              <th>Employee ID</th>
              <th>Employee Name</th>
              <th>Department</th>
              <th>Overall Progress</th>
              <th>Overall Status</th>
              ${trainings.map(t => `<th style="text-align:center">${esc(t.title)}</th>`).join("")}
            </tr>
          </thead>
          <tbody>
            ${employees.map(e => `
              <tr>
                <td><b>${esc(e.empId)}</b></td>
                <td>${esc(e.name)}</td>
                <td>${esc(e.department)}</td>
                <td><b>${e.progressPct}%</b></td>
                <td>${getBadge(e.overallStatus)}</td>
                ${trainings.map(t => {
                  const rawEmp = reportsDataCache.employees.find(rE => String(rE.id) === String(e.id));
                  const it = rawEmp ? rawEmp.items.find(i => String(i.trainingId) === String(t.id)) : null;
                  return `<td style="text-align:center">${it ? getBadge(it.status) : '<span class="badge muted">-</span>'}</td>`;
                }).join("")}
              </tr>
            `).join("") || '<tr><td colspan="' + (5 + trainings.length) + '" class="empty">No matching records found for selected filters.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  } else if (tab === 'status') {
    $("rptExportBtn").innerText = "📥 Export Training Status CSV";
    let statusRows = [];
    employees.forEach(e => {
      const rawEmp = reportsDataCache.employees.find(rE => String(rE.id) === String(e.id));
      const targetItems = ($("rptFilterStatus")?.value !== "ALL" || $("rptFilterTraining")?.value !== "ALL") ? e.items : (rawEmp ? rawEmp.items : e.items);

      targetItems.forEach(it => {
        statusRows.push({
          empId: e.empId,
          name: e.name,
          dept: e.department,
          trainingTitle: it.trainingTitle,
          status: it.status,
          completionDate: it.completionDate ? new Date(it.completionDate).toLocaleDateString("en-IN") : "-",
          expiryDate: it.expiryDate ? new Date(it.expiryDate).toLocaleDateString("en-IN") : "-"
        });
      });
    });

    container.innerHTML = `
      <h4 style="margin-top:0;margin-bottom:12px">Report Preview — Training Status (${statusRows.length} Items)</h4>
      <div class="tablewrap" style="overflow-x:auto">
        <table class="table">
          <thead>
            <tr>
              <th>Employee ID</th>
              <th>Employee Name</th>
              <th>Department</th>
              <th>Training Requirement</th>
              <th>Status</th>
              <th>Completion Date</th>
              <th>Expiry Date</th>
            </tr>
          </thead>
          <tbody>
            ${statusRows.map(r => `
              <tr>
                <td><b>${esc(r.empId)}</b></td>
                <td>${esc(r.name)}</td>
                <td>${esc(r.dept)}</td>
                <td>${esc(r.trainingTitle)}</td>
                <td>${getBadge(r.status)}</td>
                <td>${esc(r.completionDate)}</td>
                <td>${esc(r.expiryDate)}</td>
              </tr>
            `).join("") || '<tr><td colspan="7" class="empty">No matching training status items found for selected filters.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  } else if (tab === 'summary') {
    $("rptExportBtn").innerText = "📥 Export Training Summary CSV";
    const summaryRows = trainings.map(t => {
      let assigned = 0, complete = 0, pending = 0, expired = 0, missing = 0;
      reportsDataCache.employees.forEach(e => {
        const it = e.items.find(i => String(i.trainingId) === String(t.id));
        if (it) {
          assigned++;
          if (it.status === "COMPLETE" || it.status === "COMPLIANT") complete++;
          else if (it.status === "PENDING") pending++;
          else if (it.status === "EXPIRED") expired++;
          else if (it.status === "MISSING") missing++;
        }
      });

      const compPct = assigned > 0 ? Math.round((complete / assigned) * 100) : 0;
      return { title: t.title, assigned, complete, pending, expired, missing, compPct };
    });

    container.innerHTML = `
      <h4 style="margin-top:0;margin-bottom:12px">Report Preview — Training Requirements Summary (${summaryRows.length} Modules)</h4>
      <div class="tablewrap" style="overflow-x:auto">
        <table class="table">
          <thead>
            <tr>
              <th>Training Name</th>
              <th>Total Assigned</th>
              <th>Complete</th>
              <th>Pending</th>
              <th>Expired</th>
              <th>Missing</th>
              <th>Completion Rate</th>
            </tr>
          </thead>
          <tbody>
            ${summaryRows.map(s => `
              <tr>
                <td><b>${esc(s.title)}</b></td>
                <td>${s.assigned}</td>
                <td><b style="color:#2e7d32">${s.complete}</b></td>
                <td><b style="color:#ed6c02">${s.pending}</b></td>
                <td><b style="color:#d32f2f">${s.expired}</b></td>
                <td><b style="color:#c62828">${s.missing}</b></td>
                <td>
                  <div style="display:flex;align-items:center;gap:8px">
                    <div style="flex:1;background:#eee;height:8px;border-radius:4px;overflow:hidden;min-width:60px">
                      <div style="width:${s.compPct}%;background:${s.compPct===100?'#2e7d32':'#0288d1'};height:100%"></div>
                    </div>
                    <span style="font-size:12px;font-weight:bold">${s.compPct}%</span>
                  </div>
                </td>
              </tr>
            `).join("") || '<tr><td colspan="7" class="empty">No active training requirements available.</td></tr>'}
          </tbody>
        </table>
      </div>
    `;
  }
}

function exportSelectedReport() {
  if (!reportsDataCache) return alert("Report data is not ready.");

  const tab = reportsDataCache.activeTab;
  const { employees, trainings } = filterReportRecords();
  let csv = "";

  if (tab === 'emp') {
    csv += "Employee ID,Employee Name,Department,Designation,Company,Overall Progress %,Overall Status";
    trainings.forEach(t => { csv += `,"${t.title.replace(/"/g, '""')}"`; });
    csv += "\n";

    employees.forEach(e => {
      csv += `"${e.empId}","${e.name.replace(/"/g, '""')}","${e.department.replace(/"/g, '""')}","${e.designation.replace(/"/g, '""')}","${e.company.replace(/"/g, '""')}",${e.progressPct}%,"${e.overallStatus}"`;
      trainings.forEach(t => {
        const rawEmp = reportsDataCache.employees.find(rE => String(rE.id) === String(e.id));
        const it = rawEmp ? rawEmp.items.find(i => String(i.trainingId) === String(t.id)) : null;
        csv += `,"${it ? it.status : '-'}"`;
      });
      csv += "\n";
    });
  } else if (tab === 'status') {
    csv += "Employee ID,Employee Name,Department,Training Name,Status,Completion Date,Expiry Date\n";
    employees.forEach(e => {
      const rawEmp = reportsDataCache.employees.find(rE => String(rE.id) === String(e.id));
      const targetItems = ($("rptFilterStatus")?.value !== "ALL" || $("rptFilterTraining")?.value !== "ALL") ? e.items : (rawEmp ? rawEmp.items : e.items);

      targetItems.forEach(it => {
        const cDate = it.completionDate ? new Date(it.completionDate).toLocaleDateString("en-IN") : "-";
        const eDate = it.expiryDate ? new Date(it.expiryDate).toLocaleDateString("en-IN") : "-";
        csv += `"${e.empId}","${e.name.replace(/"/g, '""')}","${e.department.replace(/"/g, '""')}","${it.trainingTitle.replace(/"/g, '""')}","${it.status}","${cDate}","${eDate}"\n`;
      });
    });
  } else if (tab === 'summary') {
    csv += "Training Name,Total Assigned,Complete,Pending,Expired,Missing,Completion Rate %\n";
    trainings.forEach(t => {
      let assigned = 0, complete = 0, pending = 0, expired = 0, missing = 0;
      reportsDataCache.employees.forEach(e => {
        const it = e.items.find(i => String(i.trainingId) === String(t.id));
        if (it) {
          assigned++;
          if (it.status === "COMPLETE" || it.status === "COMPLIANT") complete++;
          else if (it.status === "PENDING") pending++;
          else if (it.status === "EXPIRED") expired++;
          else if (it.status === "MISSING") missing++;
        }
      });
      const compPct = assigned > 0 ? Math.round((complete / assigned) * 100) : 0;
      csv += `"${t.title.replace(/"/g, '""')}",${assigned},${complete},${pending},${expired},${missing},${compPct}%\n`;
    });
  }

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `STLP_${tab.toUpperCase()}_Report_${Date.now()}.csv`;
  a.click();
}

async function exportProgressReport(){
  exportSelectedReport();
}

// Global cached dataset for History Log
let historyLogCache = null;
let historyCurrentPage = 1;
const HISTORY_PAGE_SIZE = 15;

async function history(){
  const admin = profile.role === "admin";

  let attQuery = sb.from("assessment_attempts").select("*, trainings(title), profiles(name, employee_id, username)").order("created_at", { ascending: false });
  // Note: training_progress has no defined FK relationship to profiles, so it cannot be embedded
  // in the select (that silently fails the whole query). User names are resolved below via profilesById instead.
  let progQuery = sb.from("training_progress").select("*, trainings(title)").order("created_at", { ascending: false });
  let trQuery = sb.from("trainings").select("*, profiles(name, employee_id)").order("updated_at", { ascending: false });
  let profQuery = sb.from("profiles").select("*").order("created_at", { ascending: false });

  if (!admin) {
    attQuery = attQuery.eq("user_id", profile.id);
    progQuery = progQuery.eq("user_id", profile.id);
    trQuery = trQuery.eq("created_by", profile.id);
    profQuery = profQuery.eq("id", profile.id);
  }

  const [attRes, progRes, trRes, profRes] = await Promise.all([
    attQuery,
    progQuery,
    trQuery,
    profQuery
  ]);

  const attempts = attRes.data || [];
  const progresses = progRes.data || [];
  const trainingsList = trRes.data || [];
  const profilesList = profRes.data || [];

  const profilesById = {};
  profilesList.forEach(pr => { if(pr.id) profilesById[String(pr.id).toLowerCase()] = pr; });

  let auditRecords = [];

  attempts.forEach(a => {
    const isPassed = a.passed === true || String(a.passed).toLowerCase() === 'true' || a.passed === 1;
    auditRecords.push({
      id: `att_${a.id}`,
      timestamp: new Date(a.created_at || Date.now()),
      user: a.profiles?.name ? `${a.profiles.name} (${a.profiles.employee_id || '-'})` : (a.user_id || "User"),
      action: "Assessment Submitted",
      module: "Assessments",
      target: a.trainings?.title || "Assessment Requirement",
      details: `Submitted score: ${a.score !== undefined ? a.score + '%' : 'N/A'}. ${isPassed ? 'Passed assessment requirements.' : 'Failed assessment threshold.'}`,
      status: isPassed ? "Success" : "Failed",
      raw: a
    });
  });

  progresses.forEach(p => {
    const isCompleted = p.status === 'completed' || String(p.status).toLowerCase() === 'completed';
    const pProfile = profilesById[String(p.user_id || "").toLowerCase()];
    auditRecords.push({
      id: `prog_${p.id}`,
      timestamp: new Date(p.created_at || Date.now()),
      user: pProfile?.name ? `${pProfile.name} (${pProfile.employee_id || '-'})` : (p.user_id || "User"),
      action: isCompleted ? "Training Completed" : "Training Started",
      module: "Training",
      target: p.trainings?.title || "Training Module",
      details: `Module status updated to '${p.status || 'in_progress'}'.`,
      status: "Success",
      raw: p
    });
  });

  trainingsList.forEach(t => {
    auditRecords.push({
      id: `tr_${t.id}`,
      timestamp: new Date(t.updated_at || t.created_at || Date.now()),
      user: t.profiles?.name ? `${t.profiles.name}` : "Admin",
      action: "Training Created / Modified",
      module: "Training",
      target: t.title || "Training Requirement",
      details: `Category: ${t.category || 'General'} | Duration: ${t.duration || 'N/A'} | Published: ${t.published ? 'Yes' : 'No'}`,
      status: "Success",
      raw: t
    });
  });

  profilesList.forEach(pr => {
    auditRecords.push({
      id: `prof_${pr.id}`,
      timestamp: new Date(pr.created_at || Date.now()),
      user: pr.role === 'admin' ? "System Admin" : "Admin / Excel Import",
      action: "Employee Account Created",
      module: "Users / Profiles",
      target: `${pr.name || 'User'} (${pr.employee_id || '-'})`,
      details: `Account registered for department '${pr.department || 'N/A'}' with designation '${pr.designation || 'N/A'}'. Active status: ${pr.active !== false ? 'Active' : 'Inactive'}.`,
      status: "Success",
      raw: pr
    });
  });

  auditRecords.sort((a, b) => b.timestamp - a.timestamp);

  const totalCount = auditRecords.length;
  const successCount = auditRecords.filter(r => r.status === "Success").length;
  const failedCount = auditRecords.filter(r => r.status === "Failed").length;

  historyLogCache = {
    allRecords: auditRecords,
    summary: { total: totalCount, success: successCount, failed: failedCount }
  };
  historyCurrentPage = 1;

  layout("history", "Audit Logs", `
    <p class="muted">Audit Trail & System Activity History Log</p>
    
    <div class="grid" style="margin-bottom:20px">
      ${metric("Total Activities", historyLogCache.summary.total)}
      ${metric("Successful", historyLogCache.summary.success)}
      ${metric("Failed / Unsuccessful", historyLogCache.summary.failed)}
    </div>

    <div class="card" style="margin-bottom:16px;padding:16px">
      <h3 style="margin-top:0;margin-bottom:12px;font-size:16px">Audit Log Filters</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(170px, 1fr));gap:12px;align-items:end">
        <div>
          <label style="font-size:12px;font-weight:bold">Search Keyword</label>
          <input id="histSearch" placeholder="Search User, Target or Details..." oninput="renderHistoryLog(1)" style="width:100%;margin:4px 0 0">
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Action</label>
          <select id="histFilterAction" onchange="renderHistoryLog(1)" style="width:100%;margin:4px 0 0">
            <option value="ALL">All Actions</option>
            <option value="Assessment Submitted">Assessment Submitted</option>
            <option value="Training Completed">Training Completed</option>
            <option value="Training Started">Training Started</option>
            <option value="Training Created / Modified">Training Created / Modified</option>
            <option value="Employee Account Created">Employee Account Created</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Module</label>
          <select id="histFilterModule" onchange="renderHistoryLog(1)" style="width:100%;margin:4px 0 0">
            <option value="ALL">All Modules</option>
            <option value="Assessments">Assessments</option>
            <option value="Training">Training</option>
            <option value="Users / Profiles">Users / Profiles</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Status</label>
          <select id="histFilterStatus" onchange="renderHistoryLog(1)" style="width:100%;margin:4px 0 0">
            <option value="ALL">All Statuses</option>
            <option value="Success">Success</option>
            <option value="Failed">Failed</option>
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Date From</label>
          <input type="date" id="histFilterDateFrom" onchange="renderHistoryLog(1)" style="width:100%;margin:4px 0 0">
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Date To</label>
          <input type="date" id="histFilterDateTo" onchange="renderHistoryLog(1)" style="width:100%;margin:4px 0 0">
        </div>
      </div>
    </div>

    <div class="card" style="padding:16px">
      <div id="historyTableContent"></div>
      <div id="historyPaginationContent" style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;flex-wrap:wrap;gap:8px"></div>
    </div>
  `);

  renderHistoryLog(1);
}

function renderHistoryLog(page = 1) {
  if (!historyLogCache) return;
  historyCurrentPage = page;

  const searchQ = ($("histSearch")?.value || "").toLowerCase().trim();
  const actionF = $("histFilterAction")?.value || "ALL";
  const moduleF = $("histFilterModule")?.value || "ALL";
  const statusF = $("histFilterStatus")?.value || "ALL";
  const dateFromVal = $("histFilterDateFrom")?.value || "";
  const dateToVal = $("histFilterDateTo")?.value || "";

  const dFrom = dateFromVal ? new Date(dateFromVal + "T00:00:00") : null;
  const dTo = dateToVal ? new Date(dateToVal + "T23:59:59") : null;

  let filtered = historyLogCache.allRecords.filter(r => {
    if (actionF !== "ALL" && r.action !== actionF) return false;
    if (moduleF !== "ALL" && r.module !== moduleF) return false;
    if (statusF !== "ALL" && r.status !== statusF) return false;

    if (dFrom && r.timestamp < dFrom) return false;
    if (dTo && r.timestamp > dTo) return false;

    if (searchQ) {
      const haystack = (r.user + " " + r.action + " " + r.module + " " + r.target + " " + r.details).toLowerCase();
      if (!haystack.includes(searchQ)) return false;
    }

    return true;
  });

  const totalFiltered = filtered.length;
  const totalPages = Math.ceil(totalFiltered / HISTORY_PAGE_SIZE) || 1;
  if (historyCurrentPage > totalPages) historyCurrentPage = totalPages;

  const startIndex = (historyCurrentPage - 1) * HISTORY_PAGE_SIZE;
  const pageRecords = filtered.slice(startIndex, startIndex + HISTORY_PAGE_SIZE);

  const container = $("historyTableContent");
  const paginationContainer = $("historyPaginationContent");

  if (totalFiltered === 0) {
    container.innerHTML = `<div class="card empty" style="text-align:center;padding:30px">No activity history found.</div>`;
    paginationContainer.innerHTML = "";
    return;
  }

  const getBadge = (st) => {
    return st === "Success" 
      ? `<span class="badge g">✓ Success</span>` 
      : `<span class="badge r" style="background:#f8d7da;color:#721c24">✕ Failed</span>`;
  };

  container.innerHTML = `
    <div class="tablewrap" style="overflow-x:auto">
      <table class="table">
        <thead>
          <tr>
            <th style="white-space:nowrap">Date & Time</th>
            <th style="white-space:nowrap">User / Initiator</th>
            <th style="white-space:nowrap">Action</th>
            <th style="white-space:nowrap">Module</th>
            <th style="white-space:nowrap">Target / Employee</th>
            <th style="white-space:nowrap">Details</th>
            <th style="white-space:nowrap">Status</th>
            <th style="white-space:nowrap;text-align:center">Action</th>
          </tr>
        </thead>
        <tbody>
          ${pageRecords.map(r => `
            <tr>
              <td style="white-space:nowrap">${r.timestamp.toLocaleDateString("en-IN")} ${r.timestamp.toLocaleTimeString("en-IN", {hour:'2-digit', minute:'2-digit'})}</td>
              <td><b>${esc(r.user)}</b></td>
              <td>${esc(r.action)}</td>
              <td><span class="badge muted">${esc(r.module)}</span></td>
              <td>${esc(r.target)}</td>
              <td style="max-width:280px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(r.details)}">${esc(r.details)}</td>
              <td>${getBadge(r.status)}</td>
              <td style="text-align:center"><button class="btn light" style="padding:2px 8px;font-size:12px" onclick="viewActivityDetail('${r.id}')">View</button></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;

  paginationContainer.innerHTML = `
    <span class="muted" style="font-size:13px">Showing <b>${startIndex + 1}</b> - <b>${Math.min(startIndex + HISTORY_PAGE_SIZE, totalFiltered)}</b> of <b>${totalFiltered}</b> activities</span>
    <div style="display:flex;gap:6px">
      <button class="btn light" ${historyCurrentPage === 1 ? 'disabled style="opacity:0.5"' : ''} onclick="renderHistoryLog(${historyCurrentPage - 1})">Previous</button>
      <span class="chip" style="align-self:center">${historyCurrentPage} / ${totalPages}</span>
      <button class="btn light" ${historyCurrentPage === totalPages ? 'disabled style="opacity:0.5"' : ''} onclick="renderHistoryLog(${historyCurrentPage + 1})">Next</button>
    </div>
  `;
}

function viewActivityDetail(recordId) {
  if (!historyLogCache) return;
  const rec = historyLogCache.allRecords.find(r => r.id === recordId);
  if (!rec) return;

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:550px">
        <h2>Activity Audit Detail</h2>
        <div class="card" style="margin:15px 0;background:#f8f9fa">
          <p><b>Date & Time:</b> ${rec.timestamp.toLocaleString("en-IN")}</p>
          <p><b>User / Initiator:</b> ${esc(rec.user)}</p>
          <p><b>Action:</b> ${esc(rec.action)}</p>
          <p><b>Module:</b> ${esc(rec.module)}</p>
          <p><b>Target:</b> ${esc(rec.target)}</p>
          <p><b>Status:</b> ${rec.status}</p>
          <hr style="border:none;border-top:1px solid #ddd;margin:10px 0">
          <p><b>Details:</b></p>
          <p class="muted" style="white-space:pre-wrap;margin-top:4px">${esc(rec.details)}</p>
        </div>
        <div class="actions" style="justify-content:flex-end">
          <button class="btn light" onclick="closeModal()">Close</button>
        </div>
      </div>
    </div>
  `);
}

function closeModal(){ $("modal")?.remove(); }

// --- SECURITY LOGS ---
let securityLogsCache = null;

const SECURITY_EVENT_LABELS = {
  login_success: "Login Success",
  login_failed: "Login Failed",
  logout: "Logout",
  impersonate_start: "Admin Login-as-User",
  impersonate_end: "Return to Admin"
};

async function securityLogsPage(){
  const r = await sb.from("security_logs")
    .select("*, profiles!security_logs_user_id_fkey(name,employee_id), admin:profiles!security_logs_admin_id_fkey(name), target:profiles!security_logs_target_user_id_fkey(name)")
    .order("created_at",{ascending:false})
    .limit(2000);

  if(r.error) return layout("seclogs","Security Logs",`<div class="card"><b>Error:</b> ${esc(r.error.message)}</div>`);

  const rows = (r.data || []).filter(x => x.event_type !== "impersonate_start");
  securityLogsCache = rows;

  const totalCount = rows.length;
  const failedCount = rows.filter(x=>x.event_type==="login_failed").length;

  layout("seclogs","Security Logs",`
    <p class="muted">Login, logout, and Admin "Login as User" activity — who logged in, who failed, who logged out.</p>
    <div class="grid" style="margin-bottom:20px">
      ${metric("Total Events", totalCount)}
      ${metric("Failed Logins", failedCount)}
    </div>

    <div class="card" style="margin-bottom:16px;padding:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0;font-size:16px">Filters</h3>
        <button class="btn blue" onclick="exportSecurityLogsCSV()">⬇️ Download CSV</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(170px, 1fr));gap:12px;align-items:end">
        <div>
          <label style="font-size:12px;font-weight:bold">Search (name)</label>
          <input id="secSearch" placeholder="Search user name..." oninput="renderSecurityLogs()" style="width:100%;margin:4px 0 0">
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Event</label>
          <select id="secFilterEvent" onchange="renderSecurityLogs()" style="width:100%;margin:4px 0 0">
            <option value="ALL">All Events</option>
            ${Object.entries(SECURITY_EVENT_LABELS).filter(([k])=>k!=="impersonate_start").map(([k,v])=>`<option value="${k}">${v}</option>`).join("")}
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Date From</label>
          <input type="date" id="secFilterDateFrom" onchange="renderSecurityLogs()" style="width:100%;margin:4px 0 0">
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Date To</label>
          <input type="date" id="secFilterDateTo" onchange="renderSecurityLogs()" style="width:100%;margin:4px 0 0">
        </div>
      </div>
    </div>

    <div class="card" style="padding:16px">
      <div id="secLogsTableContent"></div>
    </div>
  `);

  renderSecurityLogs();
}

function _getFilteredSecurityLogs(){
  const searchQ = ($("secSearch")?.value || "").toLowerCase().trim();
  const eventF = $("secFilterEvent")?.value || "ALL";
  const dateFromVal = $("secFilterDateFrom")?.value || "";
  const dateToVal = $("secFilterDateTo")?.value || "";
  const dFrom = dateFromVal ? new Date(dateFromVal + "T00:00:00") : null;
  const dTo = dateToVal ? new Date(dateToVal + "T23:59:59") : null;

  return (securityLogsCache || []).filter(x => {
    if(eventF !== "ALL" && x.event_type !== eventF) return false;
    const ts = new Date(x.created_at);
    if(dFrom && ts < dFrom) return false;
    if(dTo && ts > dTo) return false;
    if(searchQ){
      const name = _securityLogDisplayName(x).toLowerCase();
      if(!name.includes(searchQ)) return false;
    }
    return true;
  });
}

function _securityLogDisplayName(x){
  if(x.event_type === "impersonate_start") return `${x.admin?.name||"Admin"} → ${x.target?.name || x.profiles?.name || x.attempted_identifier || "-"}`;
  if(x.event_type === "impersonate_end") return x.profiles?.name || x.attempted_identifier || "Admin";
  return x.profiles?.name || x.attempted_identifier || "-";
}

function renderSecurityLogs(){
  const container = $("secLogsTableContent");
  if(!container) return;
  const filtered = _getFilteredSecurityLogs();

  if(!filtered.length){
    container.innerHTML = `<div class="card empty" style="text-align:center;padding:30px">No security events found.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="tablewrap" style="overflow-x:auto">
      <table class="table">
        <thead><tr><th>Date & Time</th><th>Event</th><th>User</th><th>Employee ID</th><th>Status</th></tr></thead>
        <tbody>
          ${filtered.map(x => `
            <tr>
              <td style="white-space:nowrap">${new Date(x.created_at).toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short"})}</td>
              <td><span class="badge ${x.event_type==='login_failed'?'r':(x.event_type==='login_success'?'g':'o')}">${SECURITY_EVENT_LABELS[x.event_type]||x.event_type}</span></td>
              <td><b>${esc(_securityLogDisplayName(x))}</b></td>
              <td>${esc(x.profiles?.employee_id || "-")}</td>
              <td>${x.event_type==='login_failed' ? '❌ Failed' : '✅ Success'}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <p class="muted" style="font-size:12.5px;margin-top:10px">Showing ${filtered.length} of ${securityLogsCache.length} events (most recent 2000 loaded).</p>
  `;
}

function exportSecurityLogsCSV(){
  const filtered = _getFilteredSecurityLogs();
  if(!filtered.length) return alert("No security events to export for the current filters.");

  let csv = "Date & Time,Event,User,Employee ID,Status\n";
  filtered.forEach(x => {
    const row = [
      new Date(x.created_at).toLocaleString("en-IN"),
      SECURITY_EVENT_LABELS[x.event_type] || x.event_type,
      _securityLogDisplayName(x),
      x.profiles?.employee_id || "",
      x.event_type==='login_failed' ? "Failed" : "Success"
    ];
    csv += row.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",") + "\n";
  });

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `STLP_SecurityLogs_${Date.now()}.csv`;
  a.click();
}

// --- MEETING ATTENDANCE PAGE (admin only) ---
let meetingAttendanceCache = [];
let _maFilterTraining = "ALL";

function _buildMeetingSessions(records){
  const groups = {};
  records.forEach(r=>{
    const key = r.training_id + "|" + r.user_id;
    if(!groups[key]) groups[key] = { trainingId:r.training_id, training:r.trainings, userId:r.user_id, user:r.profiles, events: [] };
    groups[key].events.push(r);
  });
  const sessions = [];
  Object.values(groups).forEach(g=>{
    g.events.sort((a,b)=> new Date(a.event_at) - new Date(b.event_at));
    let openJoin = null;
    g.events.forEach(e=>{
      if(e.event_type === "join"){
        if(openJoin) sessions.push({ trainingId:g.trainingId, training:g.training, userId:g.userId, user:g.user, joinedAt:openJoin.event_at, leftAt:null });
        openJoin = e;
      } else if(e.event_type === "return" && openJoin){
        sessions.push({ trainingId:g.trainingId, training:g.training, userId:g.userId, user:g.user, joinedAt:openJoin.event_at, leftAt:e.event_at });
        openJoin = null;
      }
    });
    if(openJoin) sessions.push({ trainingId:g.trainingId, training:g.training, userId:g.userId, user:g.user, joinedAt:openJoin.event_at, leftAt:null });
  });
  sessions.sort((a,b)=> new Date(b.joinedAt) - new Date(a.joinedAt));
  return sessions;
}

function _maDuration(joinedAt, leftAt){
  if(!leftAt) return "—";
  const mins = Math.round((new Date(leftAt) - new Date(joinedAt)) / 60000);
  if(mins < 1) return "<1 min";
  if(mins < 60) return mins + " min";
  return Math.floor(mins/60) + "h " + (mins%60) + "m";
}

async function meetingAttendancePage(){
  const r = await sb.from("meeting_attendance")
    .select("*, profiles(name,employee_id), trainings(title)")
    .order("event_at",{ascending:false})
    .limit(5000);

  if(r.error) return layout("attendance","Meeting Attendance",`<div class="card"><b>Error:</b> ${esc(r.error.message)}</div>`);

  meetingAttendanceCache = r.data || [];
  const trainingsList = [...new Map(meetingAttendanceCache.filter(x=>x.trainings).map(x=>[x.training_id, x.trainings.title])).entries()];

  layout("attendance","Meeting Attendance",`
    <div class="card" style="padding:16px;margin-bottom:16px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0;font-size:16px">Filters</h3>
        <button class="btn blue" onclick="exportMeetingAttendanceCSV()">⬇️ Download CSV</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(170px, 1fr));gap:12px;align-items:end">
        <div>
          <label style="font-size:12px;font-weight:bold">Search (name)</label>
          <input id="maSearch" placeholder="Search user name..." oninput="renderMeetingAttendance()" style="width:100%;margin:4px 0 0">
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Training</label>
          <select id="maFilterTraining" onchange="_maFilterTraining=this.value;renderMeetingAttendance()" style="width:100%;margin:4px 0 0">
            <option value="ALL">All Trainings</option>
            ${trainingsList.map(([id,title])=>`<option value="${id}">${esc(title)}</option>`).join("")}
          </select>
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Date From</label>
          <input type="date" id="maFilterDateFrom" onchange="renderMeetingAttendance()" style="width:100%;margin:4px 0 0">
        </div>
        <div>
          <label style="font-size:12px;font-weight:bold">Date To</label>
          <input type="date" id="maFilterDateTo" onchange="renderMeetingAttendance()" style="width:100%;margin:4px 0 0">
        </div>
      </div>
    </div>
    <div class="card" style="padding:16px">
      <div id="maTableContent"></div>
    </div>
  `);

  renderMeetingAttendance();
}

function _getFilteredMeetingSessions(){
  const sessions = _buildMeetingSessions(meetingAttendanceCache);
  const searchQ = ($("maSearch")?.value || "").toLowerCase().trim();
  const dateFromVal = $("maFilterDateFrom")?.value || "";
  const dateToVal = $("maFilterDateTo")?.value || "";
  const dFrom = dateFromVal ? new Date(dateFromVal + "T00:00:00") : null;
  const dTo = dateToVal ? new Date(dateToVal + "T23:59:59") : null;

  return sessions.filter(s=>{
    if(_maFilterTraining !== "ALL" && s.trainingId !== _maFilterTraining) return false;
    if(searchQ && !(s.user?.name||"").toLowerCase().includes(searchQ)) return false;
    const joinedTs = new Date(s.joinedAt);
    if(dFrom && joinedTs < dFrom) return false;
    if(dTo && joinedTs > dTo) return false;
    return true;
  });
}

function renderMeetingAttendance(){
  const container = $("maTableContent");
  if(!container) return;
  const filtered = _getFilteredMeetingSessions();

  if(!filtered.length){
    container.innerHTML = `<div class="card empty" style="text-align:center;padding:30px">No meeting attendance recorded yet.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="tablewrap" style="overflow-x:auto">
      <table class="table">
        <thead><tr><th>User</th><th>Employee ID</th><th>Training</th><th>Joined At</th><th>Left At</th><th>Duration</th></tr></thead>
        <tbody>
          ${filtered.map(s => `
            <tr>
              <td><b>${esc(s.user?.name||"-")}</b></td>
              <td>${esc(s.user?.employee_id||"-")}</td>
              <td>${esc(s.training?.title||"-")}</td>
              <td style="white-space:nowrap">${new Date(s.joinedAt).toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short"})}</td>
              <td style="white-space:nowrap">${s.leftAt ? new Date(s.leftAt).toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short"}) : '<span class="badge b">In progress / unknown</span>'}</td>
              <td>${_maDuration(s.joinedAt, s.leftAt)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    <p class="muted" style="font-size:12.5px;margin-top:10px">Showing ${filtered.length} session(s). "Left At" is approximate — logged when the user returns focus to STLP after joining.</p>
  `;
}

function exportMeetingAttendanceCSV(){
  const filtered = _getFilteredMeetingSessions();
  if(!filtered.length) return alert("No attendance records to export for the current filters.");

  let csv = "User,Employee ID,Training,Joined At,Left At,Duration\n";
  filtered.forEach(s => {
    const row = [
      s.user?.name || "",
      s.user?.employee_id || "",
      s.training?.title || "",
      new Date(s.joinedAt).toLocaleString("en-IN"),
      s.leftAt ? new Date(s.leftAt).toLocaleString("en-IN") : "In progress / unknown",
      _maDuration(s.joinedAt, s.leftAt)
    ];
    csv += row.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",") + "\n";
  });

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `STLP_MeetingAttendance_${Date.now()}.csv`;
  a.click();
}

// --- TRAINERS MODULE ---
async function trainersPage(){
  const [tr, ur] = await Promise.all([
    sb.from("trainers").select("*, profiles!trainers_user_id_fkey(name,employee_id,department,designation)").order("created_at",{ascending:false}),
    sb.from("profiles").select("id,name,employee_id,department").eq("role","user").order("name")
  ]);

  if(tr.error) return layout("trainers","Trainers",`<div class="card"><b>Error:</b> ${esc(tr.error.message)}</div>`);

  const trainersList = tr.data || [];
  const allUsers = ur.data || [];
  window._trainersCache = trainersList;
  window._trainerEligibleUsers = allUsers.filter(u => !trainersList.some(t => t.user_id === u.id));

  layout("trainers","Trainers",`
    <p class="muted">Certified trainers directory. Every trainer must already have a user account — Admin can add or remove trainer status anytime without affecting their normal login.</p>
    <div class="actions" style="margin-bottom:16px">
      <button class="btn blue" onclick="addTrainerForm()">+ Add Trainer</button>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">
      ${trainersList.map(t => `
        <div class="card">
          <h3 style="margin:0">${esc(t.profiles?.name||"-")}</h3>
          <p class="muted" style="margin:4px 0">${esc(t.profiles?.employee_id||"-")} · ${esc(t.profiles?.department||"-")}</p>
          <p style="font-size:13px;margin:6px 0">📞 ${esc(t.contact_number||"-")}</p>
          <p style="font-size:13px;margin:6px 0">🎓 Experience: ${esc(t.experience||"-")}</p>
          <p style="font-size:12.5px;color:var(--slate-500);margin:6px 0">📎 ${t.certificate_paths?.length||0} certificate(s)</p>
          <div class="actions" style="margin-top:10px">
            ${(t.certificate_paths||[]).map((p,i) => `<button class="btn light" onclick="viewTrainerCertificate('${p}')">View Cert ${i+1}</button>`).join("")}
          </div>
          <div class="actions" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--slate-100)">
            <button class="btn light" style="color:#d32f2f" onclick="removeTrainer('${t.id}','${esc(t.profiles?.name||"this trainer")}')">Remove Trainer</button>
          </div>
        </div>
      `).join("") || '<div class="card empty">No trainers added yet.</div>'}
    </div>
  `);
}

function addTrainerForm(){
  const eligible = window._trainerEligibleUsers || [];
  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal">
        <h2>+ Add Trainer</h2>
        <label>Select User *</label>
        <select id="trUser">
          <option value="">-- Select an existing user --</option>
          ${eligible.map(u => `<option value="${u.id}">${esc(u.name)} (${esc(u.employee_id||"-")})</option>`).join("")}
        </select>
        ${!eligible.length ? '<p class="muted" style="font-size:12.5px">All users are already trainers, or no users exist yet.</p>' : ""}
        <div class="formgrid" style="margin-top:10px">
          <div><label>Experience</label><input id="trExp" placeholder="e.g. 5 years"></div>
          <div><label>Contact Number</label><input id="trPhone" placeholder="e.g. 98xxxxxxxx"></div>
        </div>
        <div class="fullfield">
          <label>Certificate(s)</label>
          <input id="trCerts" type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" multiple>
        </div>
        <div class="actions" style="margin-top:15px">
          <button class="btn blue" id="trSubmitBtn" onclick="saveTrainer()">Save Trainer</button>
          <button class="btn light" onclick="closeModal()">Cancel</button>
        </div>
      </div>
    </div>
  `);
}

async function saveTrainer(){
  const userId = $("trUser").value;
  if(!userId) return alert("Please select a user.");

  const btn = $("trSubmitBtn");
  if(btn){ btn.disabled = true; btn.textContent = "Saving..."; }

  const files = Array.from($("trCerts").files || []);
  const certPaths = [];

  if(files.length){
    showUploadOverlay(`Uploading certificate 1 of ${files.length}...`);
    for(let i=0;i<files.length;i++){
      const f = files[i];
      const safe = f.name.replace(/[^a-zA-Z0-9._-]/g,"_");
      const path = `trainer/${userId}/${Date.now()}_${i}_${safe}`;
      const up = await uploadFileWithProgress("trainer-certificates", path, f, (pct)=>{
        setUploadProgress(pct);
      });
      if(up.error){
        hideUploadOverlay();
        if(btn){ btn.disabled = false; btn.textContent = "Save Trainer"; }
        return alert(`Certificate upload failed: ${up.error.message}`);
      }
      certPaths.push(path);
    }
    hideUploadOverlay();
  }

  const r = await sb.from("trainers").insert({
    user_id: userId,
    experience: $("trExp").value.trim(),
    contact_number: $("trPhone").value.trim(),
    certificate_paths: certPaths,
    added_by: profile.id
  });

  if(r.error){
    if(btn){ btn.disabled = false; btn.textContent = "Save Trainer"; }
    return alert(r.error.message);
  }

  closeModal();
  route("trainers");
}

async function removeTrainer(id, name){
  if(!confirm(`Remove ${name} as a trainer? Their normal user login will not be affected.`)) return;
  const r = await sb.from("trainers").delete().eq("id", id);
  if(r.error) return alert(r.error.message);
  route("trainers");
}

async function viewTrainerCertificate(path){
  const sr = await sb.storage.from("trainer-certificates").createSignedUrl(path, 3600);
  if(sr.error) return alert(sr.error.message);
  window.open(sr.data.signedUrl, "_blank");
}

async function route(x){
  if(!configured) return loginPage();
  if(!profile) return start();
  currentRoute = x;
  return ({dash, users, train:training, sop:sopPage, trainers:trainersPage, notes:notifications, results:assessmentResults, progress, reports, history, seclogs:securityLogsPage, feedback:feedbackPage, attendance:meetingAttendancePage, certificates:certificatesPage, mailintegration:mailIntegrationPage, meetintegration:meetIntegrationPage}[x] || dash)();
}

// --- SOP MODULE ---

async function _refreshSopBadge(){
  const el = $("sopNavBadge");
  if(!el) return;
  const r = await sb.from("sops").select("id",{count:"exact",head:true}).eq("status","pending");
  const n = r.count || 0;
  if(n > 0){ el.textContent = n; el.style.display = "inline-flex"; }
  else { el.style.display = "none"; }
}

let _sopFilter = "pending";
let _sopFolderFilter = "all";

async function sopPage(){
  const admin = profile.role === "admin";

  const [r, fr] = await Promise.all([
    sb.from("sops")
      .select("*, profiles!sops_uploaded_by_fkey(name,employee_id), reviewer:profiles!sops_reviewed_by_fkey(name)")
      .order("created_at",{ascending:false}),
    sb.from("sop_folders").select("*").order("name",{ascending:true})
  ]);

  if(r.error) return layout("sop","Library",`<div class="card"><b>Error:</b> ${esc(r.error.message)}</div>`);

  const all = r.data || [];
  const folders = fr.data || [];
  window._sopCache = all;
  window._sopFoldersCache = folders;

  const statusScoped = admin
    ? all.filter(s => _sopFilter==="all" ? true : s.status===_sopFilter)
    : all.filter(s => (s.status==="approved" && !s.is_hidden) || s.uploaded_by===profile.id);

  const visible = statusScoped.filter(s => {
    if(_sopFolderFilter==="all") return true;
    if(_sopFolderFilter==="uncat") return !s.folder_id;
    return s.folder_id === _sopFolderFilter;
  });

  const pendingCount = all.filter(s=>s.status==="pending").length;

  const tabs = admin ? `
    <div class="actions" style="margin-bottom:14px">
      ${[["pending","Pending"],["approved","Approved"],["rejected","Rejected"],["all","All"]].map(t=>`
        <button class="btn ${_sopFilter===t[0]?"blue":"light"}" onclick="_sopFilter='${t[0]}';route('sop')">
          ${t[1]}${t[0]==="pending"&&pendingCount>0?` <span class="badge o">${pendingCount}</span>`:""}
        </button>`).join("")}
    </div>` : "";

  const folderTabs = `
    <div class="actions" style="margin-bottom:16px">
      <button class="btn ${_sopFolderFilter==="all"?"blue":"light"}" onclick="_sopFolderFilter='all';route('sop')">📁 All Folders</button>
      <button class="btn ${_sopFolderFilter==="uncat"?"blue":"light"}" onclick="_sopFolderFilter='uncat';route('sop')">📄 Uncategorized</button>
      ${folders.map(f=>`
        <button class="btn ${_sopFolderFilter===f.id?"blue":"light"}" onclick="_sopFolderFilter='${f.id}';route('sop')">📁 ${esc(f.name)}</button>
      `).join("")}
      ${admin ? `<button class="btn ghost" onclick="createSopFolderPrompt()">+ New Folder</button>` : ""}
    </div>`;

  layout("sop","Library",`
    <div class="actions" style="margin-bottom:14px;justify-content:space-between">
      <div class="muted">${admin ? "Review SOPs uploaded by users, then approve to publish them for everyone. Organize them into folders, hide, or delete as needed." : "Browse approved SOPs, or upload a new one for admin review."}</div>
      <button class="btn blue" onclick="sopUploadForm()">+ Upload SOP</button>
    </div>
    ${tabs}
    ${folderTabs}
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px">
      ${visible.map(s=>{
        const folderName = s.folder_id ? (folders.find(f=>f.id===s.folder_id)?.name || "Unknown Folder") : "Uncategorized";
        const uploadedStamp = s.created_at ? new Date(s.created_at).toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short"}) : "-";
        return `
        <div class="card" style="${s.is_hidden?"opacity:.6":""}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <h3 style="margin:0">${esc(s.title)}</h3>
            <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
              <span class="badge ${s.status==="approved"?"g":s.status==="rejected"?"r":"o"}">${s.status}</span>
              ${s.is_hidden ? `<span class="badge r">Hidden</span>` : ""}
            </div>
          </div>
          <p style="margin:6px 0"><span class="badge b">📁 ${esc(folderName)}</span></p>
          ${s.description ? `<p class="muted" style="margin:6px 0">${esc(s.description)}</p>` : ""}
          <p style="font-size:12.5px;color:var(--slate-500);margin:6px 0">
            📎 ${esc(s.file_name)}<br>
            Uploaded by <b>${esc(s.profiles?.name||"-")}</b> (${esc(s.profiles?.employee_id||"-")})<br>
            🕐 ${uploadedStamp}
          </p>
          ${s.status==="rejected" && s.review_remarks ? `<p style="font-size:12.5px;color:#a32d2d"><b>Remarks:</b> ${esc(s.review_remarks)}</p>` : ""}
          ${s.status==="approved" && s.reviewer?.name ? `<p style="font-size:12px;color:var(--slate-500)">Approved by ${esc(s.reviewer.name)}</p>` : ""}
          <div class="actions" style="margin-top:10px">
            <button class="btn light" onclick="viewSopFile('${s.file_path}')">📄 View</button>
            ${admin && s.status==="pending" ? `
              <button class="btn blue" onclick="approveSop('${s.id}')">✅ Approve</button>
              <button class="btn light" onclick="rejectSop('${s.id}')">❌ Reject</button>
            ` : ""}
          </div>
          ${admin ? `
            <div class="actions" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--slate-100)">
              <select style="width:auto;padding:7px 10px;font-size:12.5px" onchange="moveSopFolder('${s.id}', this.value)">
                <option value="">Move to folder...</option>
                <option value="__none__">Uncategorized</option>
                ${folders.map(f=>`<option value="${f.id}" ${s.folder_id===f.id?"selected":""}>${esc(f.name)}</option>`).join("")}
              </select>
              <button class="btn light" onclick="toggleHideSop('${s.id}', ${!s.is_hidden})">${s.is_hidden?"👁️ Unhide":"🙈 Hide"}</button>
              <button class="btn light" style="color:#d32f2f;border-color:#f8d7da" onclick="deleteSop('${s.id}','${s.file_path}','${esc(s.title)}')">🗑️ Delete</button>
            </div>
          ` : ""}
        </div>
      `}).join("") || '<div class="card empty">No SOPs to show here yet.</div>'}
    </div>
  `);
}

function createSopFolderPrompt(){
  const name = prompt("New folder name (e.g. Electrical, Mechanical, Boiler):", "");
  if(name === null) return;
  const trimmed = name.trim();
  if(!trimmed) return;
  createSopFolder(trimmed);
}

async function createSopFolder(name){
  const r = await sb.from("sop_folders").insert({ name, created_by: profile.id });
  if(r.error){
    if(String(r.error.message||"").toLowerCase().includes("duplicate")) return alert("A folder with this name already exists.");
    return alert(r.error.message);
  }
  route("sop");
}

async function moveSopFolder(id, folderId){
  if(!folderId) return; // "Move to folder..." placeholder selected, no-op
  const r = await sb.from("sops").update({
    folder_id: folderId === "__none__" ? null : folderId,
    updated_at: new Date().toISOString()
  }).eq("id", id);
  if(r.error) return alert(r.error.message);
  route("sop");
}

async function toggleHideSop(id, hide){
  if(!confirm(hide ? "Hide this SOP from users? Admins can still see and unhide it anytime." : "Unhide this SOP so users can see it again?")) return;
  const r = await sb.from("sops").update({
    is_hidden: hide,
    updated_at: new Date().toISOString()
  }).eq("id", id);
  if(r.error) return alert(r.error.message);
  route("sop");
}

async function deleteSop(id, filePath, title){
  if(!confirm(`Permanently delete "${title}"? This will remove the file and cannot be undone.`)) return;
  const del = await sb.storage.from("sop-documents").remove([filePath]);
  if(del.error && !String(del.error.message||"").toLowerCase().includes("not found")){
    if(!confirm("Could not delete the stored file (" + del.error.message + "). Delete the SOP record anyway?")) return;
  }
  const r = await sb.from("sops").delete().eq("id", id);
  if(r.error) return alert(r.error.message);
  route("sop");
}

function sopUploadForm(){
  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal"><div class="modal">
      <h2>Upload SOP</h2>
      <label>Title *</label><input id="sopTitle" placeholder="e.g. Boiler Lockout-Tagout Procedure">
      <label>Description</label><textarea id="sopDesc" rows="3" placeholder="Optional notes about this SOP"></textarea>
      <label>File *</label><input id="sopFile" type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.jpg,.jpeg,.png">
      <p class="muted" style="font-size:12px;margin-top:6px">Your upload will be reviewed by an admin before it becomes visible to others.</p>
      <div class="actions" style="margin-top:15px">
        <button class="btn blue" id="sopSubmitBtn" onclick="saveSop()">Submit for Review</button>
        <button class="btn light" onclick="closeModal()">Cancel</button>
      </div>
    </div></div>
  `);
}

async function saveSop(){
  const title = $("sopTitle").value.trim();
  const file = $("sopFile").files[0];
  if(!title) return alert("Title is required.");
  if(!file) return alert("Please choose a file to upload.");

  const btn = $("sopSubmitBtn");
  if(btn){ btn.disabled = true; btn.textContent = "Uploading..."; }

  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
  const path = `sop/${profile.id}/${Date.now()}_${safe}`;

  showUploadOverlay("Uploading SOP document...");
  const up = await uploadFileWithProgress("sop-documents", path, file, setUploadProgress);
  hideUploadOverlay();

  if(up.error){
    if(btn){ btn.disabled = false; btn.textContent = "Submit for Review"; }
    return alert("Upload failed: " + up.error.message);
  }

  const r = await sb.from("sops").insert({
    title,
    description: $("sopDesc").value.trim() || null,
    file_path: path,
    file_name: file.name,
    uploaded_by: profile.id,
    status: "pending"
  });

  if(r.error){
    if(btn){ btn.disabled = false; btn.textContent = "Submit for Review"; }
    return alert(r.error.message);
  }

  closeModal();
  route("sop");
}

async function viewSopFile(path){
  const sr = await sb.storage.from("sop-documents").createSignedUrl(path, 3600);
  if(sr.error) return alert(sr.error.message);
  window.open(sr.data.signedUrl, "_blank");
}

async function approveSop(id){
  if(!confirm("Approve this SOP? It will become visible to all users.")) return;
  const r = await sb.from("sops").update({
    status: "approved",
    reviewed_by: profile.id,
    reviewed_at: new Date().toISOString(),
    review_remarks: null
  }).eq("id", id);
  if(r.error) return alert(r.error.message);
  route("sop");
}

async function rejectSop(id){
  const remarks = prompt("Reason for rejecting this SOP (shown to the uploader):", "");
  if(remarks === null) return; // cancelled
  const r = await sb.from("sops").update({
    status: "rejected",
    reviewed_by: profile.id,
    reviewed_at: new Date().toISOString(),
    review_remarks: remarks.trim() || null
  }).eq("id", id);
  if(r.error) return alert(r.error.message);
  route("sop");
}

// ============================================================================
// MAIL INTEGRATION (Settings > Mail Integration) — STLP V15
// Google Workspace/Gmail OAuth2 email notifications.
// This module ONLY talks to Supabase Edge Functions below — it never touches
// OAuth Client Secrets, access tokens, or refresh tokens directly. Those stay
// server-side. See mail_integration_setup.sql and /supabase-functions/mail-*.
// ============================================================================

async function _mailFn(name, opts){
  const s = (await sb.auth.getSession()).data.session;
  if(!s) throw new Error("Session expired. Please login again.");
  const r = await fetch(`${window.SUPABASE_URL}/functions/v1/${name}`, {
    method: opts?.method || "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + s.access_token,
      "apikey": window.SUPABASE_ANON_KEY
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await r.text().catch(()=>"");
  let d = {};
  try { d = text ? JSON.parse(text) : {}; } catch(e) {}
  if(!r.ok) throw new Error(d.error || d.message || `Request failed (${r.status})`);
  return d;
}

async function mailIntegrationPage(){
  if(profile.role !== "admin"){
    return layout("mailintegration","Mail Integration",`<div class="card"><b>Access denied.</b> Only STLP Admin can manage Mail Integration.</div>`);
  }

  let status;
  try{
    status = await _mailFn("mail-status", { method: "GET" });
  }catch(e){
    return layout("mailintegration","Mail Integration",`<div class="card"><b>Error:</b> ${esc(e.message)}<br><span class="muted" style="font-size:13px">Make sure the mail-status Edge Function is deployed in Supabase.</span></div>`);
  }

  window._mailStatusCache = status;

  const statusCard = !status.configured ? `
    <div class="card" style="padding:16px;margin-bottom:16px">
      <b>🔴 Mail Not Connected</b>
      <p class="muted" style="margin-top:6px">Automatic email notifications are currently unavailable. Set up the Google connection below to enable them.</p>
    </div>
  ` : !status.connected ? `
    <div class="card" style="padding:16px;margin-bottom:16px">
      <b>🔴 Mail Not Connected</b>
      <p class="muted" style="margin-top:6px">Google credentials are saved. Click "Connect Google Workspace Mail" below to authorize an account.</p>
    </div>
  ` : `
    <div class="card" style="padding:16px;margin-bottom:16px">
      <b>${status.notifications_enabled ? "🟢 Mail Connected" : "🟡 Mail Connected"}</b>
      <div style="margin-top:8px;font-size:14px;line-height:1.8">
        <div><b>Connected Account:</b> ${esc(status.connected_email)}</div>
        <div><b>Provider:</b> Google Workspace / Gmail</div>
        <div><b>Permission:</b> Send Email (gmail.send)</div>
        <div><b>Notifications:</b> ${status.notifications_enabled ? "ON" : "OFF"}</div>
      </div>
    </div>
  `;

  const redirectUriValue = esc(status.redirect_uri || (window.SUPABASE_URL + "/functions/v1/mail-oauth-callback"));

  const howToCard = `
    <div class="card" style="padding:16px;margin-bottom:16px;background:#f7f9fc">
      <details>
        <summary style="cursor:pointer;font-weight:600;font-size:14px">📘 How to get your Google Client ID &amp; Client Secret (click to expand)</summary>
        <ol style="margin:12px 0 4px;padding-left:20px;font-size:13px;line-height:1.7">
          <li>Go to <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a> and sign in with the Google Workspace account you want to send emails from (e.g. your organisation's account).</li>
          <li>Create a new Project (or pick an existing one) from the project dropdown at the top.</li>
          <li>Go to <b>APIs &amp; Services → Library</b>, search for <b>Gmail API</b> and click <b>Enable</b>.</li>
          <li>Go to <b>APIs &amp; Services → OAuth consent screen</b>. Choose <b>Internal</b> (if using Google Workspace) or <b>External</b>, fill the required app name/email fields, and save.</li>
          <li>Go to <b>APIs &amp; Services → Credentials → Create Credentials → OAuth client ID</b>. Choose Application type <b>Web application</b>.</li>
          <li>Under <b>Authorized redirect URIs</b>, click <b>Add URI</b> and paste this exact link:
            <div style="margin:6px 0"><input readonly value="${redirectUriValue}" onclick="this.select()" style="width:100%;font-size:12px"></div>
          </li>
          <li>Click <b>Create</b>. Google will show a <b>Client ID</b> and <b>Client Secret</b> — copy both.</li>
          <li>Paste them into the two fields below and click <b>Save Configuration</b>, then click <b>Connect Google Workspace Mail</b> in Step 2 and sign in with the same account.</li>
        </ol>
        <p class="muted" style="font-size:12px;margin-top:8px">Note: these credentials belong to whichever Google account creates them — that account's mailbox will be used to send all notification emails.</p>
      </details>
    </div>
  `;

  const step1Card = `
    <div class="card" style="padding:16px;margin-bottom:16px">
      <h3 style="margin:0 0 4px;font-size:16px">Step 1 — Google OAuth Credentials ${status.configured ? "✅" : ""}</h3>
      <p class="muted" style="font-size:13px;margin-bottom:12px">One-time setup. Paste the Client ID and Client Secret generated in Google Cloud Console (APIs &amp; Services → Credentials). This is saved encrypted on the server — it is never shown again in full.</p>
      <div class="formgrid">
        <div><label>Google Client ID *</label><input id="mailClientId" placeholder="xxxx.apps.googleusercontent.com" value="${status.configured ? "" : ""}"></div>
        <div><label>Google Client Secret *</label><input id="mailClientSecret" type="password" placeholder="${status.configured ? "•••••••• (saved — leave blank to keep)" : "GOCSPX-..."}"></div>
        <div class="fullfield">
          <label>Authorized Redirect URI (copy this into Google Cloud Console → Credentials)</label>
          <input id="mailRedirectUri" readonly value="${redirectUriValue}" onclick="this.select()">
        </div>
      </div>
      <div class="actions" style="margin-top:12px">
        <button class="btn blue" onclick="saveMailConfig()">💾 Save Configuration</button>
      </div>
    </div>
  `;

  const step2Card = `
    <div class="card" style="padding:16px;margin-bottom:16px">
      <h3 style="margin:0 0 4px;font-size:16px">Step 2 — Connect Account</h3>
      <div class="actions" style="margin-top:8px;flex-wrap:wrap;gap:8px">
        <button class="btn blue" ${!status.configured?"disabled style=\"opacity:.5\"":""} onclick="connectGoogleMail()">🔗 ${status.connected ? "Change / Reconnect Account" : "Connect Google Workspace Mail"}</button>
        ${status.connected ? `<button class="btn light" onclick="toggleMailNotifications(${!status.notifications_enabled})">${status.notifications_enabled ? "⏸ Turn Notifications OFF" : "▶️ Turn Notifications ON"}</button>` : ""}
        ${status.connected ? `<button class="btn light" onclick="openTestEmailModal()">✉️ Test Email</button>` : ""}
        ${status.connected ? `<button class="btn light" style="color:#d32f2f" onclick="confirmDisconnectMail()">🗑️ Remove Configuration</button>` : ""}
      </div>
    </div>
  `;

  layout("mailintegration","Mail Integration",`
    <p class="muted" style="margin:-6px 0 16px">Settings &nbsp;›&nbsp; Mail Integration — automatic email notifications sent from your Google Workspace/Gmail account for training, certificate and safety events.</p>
    ${howToCard}
    ${statusCard}
    ${step1Card}
    ${step2Card}
  `);
}

async function saveMailConfig(){
  const clientId = $("mailClientId").value.trim();
  const clientSecret = $("mailClientSecret").value.trim();
  const redirectUri = $("mailRedirectUri").value.trim();

  if(!clientId || !redirectUri){
    return alert("Client ID is required.");
  }
  if(!clientSecret && !(window._mailStatusCache && window._mailStatusCache.configured)){
    return alert("Client Secret is required for first-time setup.");
  }
  if(!clientSecret){
    return alert("Enter the Client Secret again to update the configuration (it cannot be pre-filled for security reasons).");
  }

  try{
    await _mailFn("mail-config", { body: { client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri } });
    alert("Configuration saved.");
    route("mailintegration");
  }catch(e){
    alert("Could not save configuration: " + e.message);
  }
}

async function connectGoogleMail(){
  try{
    const r = await _mailFn("mail-oauth-start", { method: "GET" });
    if(!r.url) throw new Error("No authorization URL returned.");
    window.location.href = r.url; // hands off to Google's consent screen
  }catch(e){
    alert("Could not start Google authorization: " + e.message);
  }
}

async function toggleMailNotifications(enabled){
  try{
    await _mailFn("mail-toggle", { body: { enabled } });
    route("mailintegration");
  }catch(e){
    alert("Could not update notification setting: " + e.message);
  }
}

function confirmDisconnectMail(){
  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:450px">
        <h2>Remove Mail Integration?</h2>
        <p class="muted">This will stop STLP automatic email notifications until a new mail account is connected.</p>
        <div class="actions" style="justify-content:flex-end;margin-top:16px">
          <button class="btn light" onclick="closeModal()">Cancel</button>
          <button class="btn light" style="color:#d32f2f" onclick="executeDisconnectMail()">Remove</button>
        </div>
      </div>
    </div>
  `);
}

async function executeDisconnectMail(){
  try{
    await _mailFn("mail-disconnect");
    closeModal();
    alert("Mail Integration removed.");
    route("mailintegration");
  }catch(e){
    alert("Could not remove Mail Integration: " + e.message);
  }
}

function openTestEmailModal(){
  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:450px">
        <h2>Send Test Email</h2>
        <div class="formgrid">
          <div class="fullfield"><label>Recipient</label><input id="mailTestRecipient" type="email" placeholder="you@company.com"></div>
        </div>
        <div class="actions" style="justify-content:flex-end;margin-top:16px">
          <button class="btn light" onclick="closeModal()">Cancel</button>
          <button class="btn blue" onclick="sendTestMail()">Send Test Email</button>
        </div>
      </div>
    </div>
  `);
}

async function sendTestMail(){
  const to = $("mailTestRecipient").value.trim();
  if(!to || !validateEmail(to)) return alert("Please enter a valid email address.");
  try{
    await _mailFn("mail-test", { body: { recipient: to } });
    closeModal();
    alert("✓ Test email sent successfully.");
  }catch(e){
    alert("Could not send test email: " + e.message);
  }
}

// ---------------------------------------------------------------------------
// Central notification-email helper. Existing STLP modules call this AFTER
// their normal database action succeeds. It never throws to the caller and
// never blocks the underlying STLP action — email failures are logged
// server-side (mail_log table) and swallowed here.
// eventType must be one of: training_assigned | training_completed |
// certificate_issued | manual_notification
// ---------------------------------------------------------------------------
async function notifyByEmail(eventType, recipientProfileId, subject, message){
  try{
    if(!recipientProfileId || !subject) return;
    await _mailFn("mail-send", {
      body: { event_type: eventType, recipient_profile_id: recipientProfileId, subject, message }
    });
  }catch(e){
    console.warn("Email notification skipped/failed (non-blocking):", e.message);
  }
}

// ============================================================================
// MEET INTEGRATION (Settings > Meet Integration)
// Lets the client connect their OWN Google account (Calendar API, scope
// calendar.events) so that "Generate New Link" on the Training form creates
// a live Google Meet link through THEIR account — not a developer/personal
// account. Reuses the same _mailFn() request helper (it is generic).
// See meet_integration_setup.sql and /supabase-functions/meet-*.
// ============================================================================

async function meetIntegrationPage(){
  if(profile.role !== "admin"){
    return layout("meetintegration","Meet Integration",`<div class="card"><b>Access denied.</b> Only STLP Admin can manage Meet Integration.</div>`);
  }

  let status;
  try{
    status = await _mailFn("meet-status", { method: "GET" });
  }catch(e){
    return layout("meetintegration","Meet Integration",`<div class="card"><b>Error:</b> ${esc(e.message)}<br><span class="muted" style="font-size:13px">Make sure the meet-status Edge Function is deployed in Supabase.</span></div>`);
  }

  window._meetStatusCache = status;

  const statusCard = !status.configured ? `
    <div class="card" style="padding:16px;margin-bottom:16px">
      <b>🔴 Meet Not Connected</b>
      <p class="muted" style="margin-top:6px">Live Google Meet link generation is currently unavailable. Set up the Google connection below to enable it.</p>
    </div>
  ` : !status.connected ? `
    <div class="card" style="padding:16px;margin-bottom:16px">
      <b>🔴 Meet Not Connected</b>
      <p class="muted" style="margin-top:6px">Google credentials are saved. Click "Connect Google Account" below to authorize an account.</p>
    </div>
  ` : `
    <div class="card" style="padding:16px;margin-bottom:16px">
      <b>🟢 Meet Connected</b>
      <div style="margin-top:8px;font-size:14px;line-height:1.8">
        <div><b>Connected Account:</b> ${esc(status.connected_email)}</div>
        <div><b>Provider:</b> Google Calendar / Meet</div>
        <div><b>Permission:</b> Create Calendar Events (calendar.events)</div>
      </div>
    </div>
  `;

  const redirectUriValue = esc(status.redirect_uri || (window.SUPABASE_URL + "/functions/v1/meet-oauth-callback"));

  const howToCard = `
    <div class="card" style="padding:16px;margin-bottom:16px;background:#f7f9fc">
      <details>
        <summary style="cursor:pointer;font-weight:600;font-size:14px">📘 How to get your Google Client ID &amp; Client Secret (click to expand)</summary>
        <ol style="margin:12px 0 4px;padding-left:20px;font-size:13px;line-height:1.7">
          <li>Go to <a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud Console</a> and sign in with the Google account you want to generate Meet links from.</li>
          <li>Create a new Project (or pick an existing one) from the project dropdown at the top. <span class="muted">(You can reuse the same project as Mail Integration if you already made one.)</span></li>
          <li>Go to <b>APIs &amp; Services → Library</b>, search for <b>Google Calendar API</b> and click <b>Enable</b>.</li>
          <li>Go to <b>APIs &amp; Services → OAuth consent screen</b>. Choose <b>Internal</b> (if using Google Workspace) or <b>External</b>, fill the required app name/email fields, and save.</li>
          <li>Go to <b>APIs &amp; Services → Credentials → Create Credentials → OAuth client ID</b>. Choose Application type <b>Web application</b>. (You may reuse the same OAuth Client as Mail Integration, or create a separate one.)</li>
          <li>Under <b>Authorized redirect URIs</b>, click <b>Add URI</b> and paste this exact link:
            <div style="margin:6px 0"><input readonly value="${redirectUriValue}" onclick="this.select()" style="width:100%;font-size:12px"></div>
          </li>
          <li>Click <b>Create</b> (or <b>Save</b> if reusing an existing client). Copy the <b>Client ID</b> and <b>Client Secret</b>.</li>
          <li>Paste them into the two fields below and click <b>Save Configuration</b>, then click <b>Connect Google Account</b> in Step 2 and sign in with the account whose calendar/Meet you want to use.</li>
        </ol>
        <p class="muted" style="font-size:12px;margin-top:8px">Note: whichever Google account is connected here is the account that will own every generated Meet link.</p>
      </details>
    </div>
  `;

  const step1Card = `
    <div class="card" style="padding:16px;margin-bottom:16px">
      <h3 style="margin:0 0 4px;font-size:16px">Step 1 — Google OAuth Credentials ${status.configured ? "✅" : ""}</h3>
      <p class="muted" style="font-size:13px;margin-bottom:12px">One-time setup. Paste the Client ID and Client Secret generated in Google Cloud Console (APIs &amp; Services → Credentials). This is saved encrypted on the server — it is never shown again in full.</p>
      <div class="formgrid">
        <div><label>Google Client ID *</label><input id="meetClientId" placeholder="xxxx.apps.googleusercontent.com"></div>
        <div><label>Google Client Secret *</label><input id="meetClientSecret" type="password" placeholder="${status.configured ? "•••••••• (saved — leave blank to keep)" : "GOCSPX-..."}"></div>
        <div class="fullfield">
          <label>Authorized Redirect URI (copy this into Google Cloud Console → Credentials)</label>
          <input id="meetRedirectUri" readonly value="${redirectUriValue}" onclick="this.select()">
        </div>
      </div>
      <div class="actions" style="margin-top:12px">
        <button class="btn blue" onclick="saveMeetConfig()">💾 Save Configuration</button>
      </div>
    </div>
  `;

  const step2Card = `
    <div class="card" style="padding:16px;margin-bottom:16px">
      <h3 style="margin:0 0 4px;font-size:16px">Step 2 — Connect Account</h3>
      <div class="actions" style="margin-top:8px;flex-wrap:wrap;gap:8px">
        <button class="btn blue" ${!status.configured?"disabled style=\"opacity:.5\"":""} onclick="connectGoogleMeet()">🔗 ${status.connected ? "Change / Reconnect Account" : "Connect Google Account"}</button>
        ${status.connected ? `<button class="btn light" style="color:#d32f2f" onclick="confirmDisconnectMeet()">🗑️ Remove Configuration</button>` : ""}
      </div>
    </div>
  `;

  layout("meetintegration","Meet Integration",`
    <p class="muted" style="margin:-6px 0 16px">Settings &nbsp;›&nbsp; Meet Integration — generate live Google Meet links (for Training) through your own connected Google account.</p>
    ${howToCard}
    ${statusCard}
    ${step1Card}
    ${step2Card}
  `);
}

async function saveMeetConfig(){
  const clientId = $("meetClientId").value.trim();
  const clientSecret = $("meetClientSecret").value.trim();
  const redirectUri = $("meetRedirectUri").value.trim();

  if(!clientId || !redirectUri){
    return alert("Client ID is required.");
  }
  if(!clientSecret && !(window._meetStatusCache && window._meetStatusCache.configured)){
    return alert("Client Secret is required for first-time setup.");
  }
  if(!clientSecret){
    return alert("Enter the Client Secret again to update the configuration (it cannot be pre-filled for security reasons).");
  }

  try{
    await _mailFn("meet-config", { body: { client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri } });
    alert("Configuration saved.");
    route("meetintegration");
  }catch(e){
    alert("Could not save configuration: " + e.message);
  }
}

async function connectGoogleMeet(){
  try{
    const r = await _mailFn("meet-oauth-start", { method: "GET" });
    if(!r.url) throw new Error("No authorization URL returned.");
    window.location.href = r.url; // hands off to Google's consent screen
  }catch(e){
    alert("Could not start Google authorization: " + e.message);
  }
}

function confirmDisconnectMeet(){
  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:450px">
        <h2>Remove Meet Integration?</h2>
        <p class="muted">This will stop live Meet link generation until a new Google account is connected.</p>
        <div class="actions" style="justify-content:flex-end;margin-top:16px">
          <button class="btn light" onclick="closeModal()">Cancel</button>
          <button class="btn light" style="color:#d32f2f" onclick="executeDisconnectMeet()">Remove</button>
        </div>
      </div>
    </div>
  `);
}

async function executeDisconnectMeet(){
  try{
    await _mailFn("meet-disconnect", { body: { full_reset: false } });
    closeModal();
    alert("Meet Integration disconnected.");
    route("meetintegration");
  }catch(e){
    alert("Could not remove Meet Integration: " + e.message);
  }
}

(async()=>{
  if(configured){
    let r = await sb.auth.getSession();
    r.data.session ? start() : loginPage();
  } else loginPage();
})();

// --- PWA: register service worker (needed for iOS/Android Push Notifications) ---
if("serviceWorker" in navigator){
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(err => {
      console.warn("Service worker registration failed:", err);
    });
  });
}
