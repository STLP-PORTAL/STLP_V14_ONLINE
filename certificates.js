// ============================================================
// STLP Certificates Module — certificates.js
// Isolated, additive module. Does NOT modify any existing function in app.js
// (app.js only gained two "Download PDF" buttons that call into this file).
// Phase 2: Template gallery (duplicate/edit), field-position designer
// (number/dropdown based — no drag canvas), real "My Certificates" page,
// Admin Certificate Dashboard, and template-backed PDF download.
// ============================================================

const CERT_TEMPLATE_BUCKET = "certificate_templates";

let _certTemplatesCache = [];
let _certAdminTab = "templates";        // "templates" | "dashboard"
let _certEditingTemplateId = null;      // set while the upload modal is in "edit" mode
let _certPosTemplateId = null;          // template currently open in the position editor
let _certPosDraft = null;               // working copy of field_positions while editing
let _certDashFilters = { training: "", from: "", to: "" };

// Standard fields every certificate can place. `sample` is only used for
// the live preview in the position editor.
const CERT_FIELD_DEFS = [
  { key: "employee_name",  label: "Employee Name",   sample: "Jasveer Singh" },
  { key: "employee_id",    label: "Employee ID",     sample: "EMP-1042" },
  { key: "training_title", label: "Training Title",  sample: "Fire Safety Induction" },
  { key: "score",          label: "Score",            sample: "96%" },
  { key: "cert_no",        label: "Certificate No.",  sample: "STLP-AB12CD34EF" },
  { key: "date",           label: "Date",             sample: "07 Sep 2026" }
];

const CERT_DEFAULT_POSITIONS = {
  employee_name:  { enabled: true, x: 50, y: 46, fontSize: 34, align: "center", bold: true,  color: "#1f2937" },
  employee_id:    { enabled: true, x: 50, y: 53, fontSize: 15, align: "center", bold: false, color: "#333333" },
  training_title: { enabled: true, x: 50, y: 63, fontSize: 22, align: "center", bold: true,  color: "#1f4d3a" },
  score:          { enabled: true, x: 50, y: 71, fontSize: 15, align: "center", bold: false, color: "#333333" },
  cert_no:        { enabled: true, x: 10, y: 93, fontSize: 11, align: "left",   bold: false, color: "#555555" },
  date:           { enabled: true, x: 90, y: 93, fontSize: 11, align: "right",  bold: false, color: "#555555" }
};

function _certMergedPositions(tpl){
  const stored = (tpl && tpl.field_positions && typeof tpl.field_positions === "object") ? tpl.field_positions : {};
  const merged = {};
  CERT_FIELD_DEFS.forEach(f => {
    merged[f.key] = Object.assign({}, CERT_DEFAULT_POSITIONS[f.key], stored[f.key] || {});
  });
  return merged;
}

// Fixed raster size the certificate is composed at, so percentage-based
// field positions line up the same way in the editor preview, the on-screen
// certificate and the exported PDF, regardless of the source image's own
// resolution (the background is stretched to fill this box).
function _certCanvasDims(tpl){
  const A4 = 297 / 210, LETTER = 11 / 8.5;
  let ratio = (tpl && tpl.page_size === "Letter") ? LETTER : A4;
  const portrait = tpl && tpl.orientation === "portrait";
  if(portrait) ratio = 1 / ratio;
  const w = 1600;
  const h = Math.round(w / ratio);
  return { w, h };
}

// Entry point wired from app.js route dispatcher: certificates: certificatesPage
async function certificatesPage(){
  const admin = profile.role === "admin";
  if(!admin) return myCertificatesPage();
  return _certAdminTab === "dashboard" ? certificateDashboardTab() : certificateTemplatesTab();
}

function _certAdminTabsHTML(){
  return `
    <div class="cert-tabs">
      <button class="btn ${_certAdminTab==="templates"?"blue":"light"}" onclick="_certAdminTab='templates';route('certificates')">🖼️ Templates</button>
      <button class="btn ${_certAdminTab==="dashboard"?"blue":"light"}" onclick="_certAdminTab='dashboard';route('certificates')">📊 Dashboard</button>
    </div>`;
}

// ------------------------------------------------------------
// TEMPLATE MANAGER (card gallery)
// ------------------------------------------------------------
async function certificateTemplatesTab(){
  const [tplRes, trainRes] = await Promise.all([
    sb.from("certificate_templates").select("*").order("created_at",{ascending:false}),
    sb.from("trainings").select("id,title").order("title")
  ]);

  if(tplRes.error){
    return layout("certificates","Certificates",`${_certAdminTabsHTML()}<div class="card"><b>Error:</b> ${esc(tplRes.error.message)}</div>`);
  }

  const templates = tplRes.data || [];
  const trainingsList = trainRes.data || [];
  _certTemplatesCache = templates;
  window._certTrainingsCache = trainingsList;

  const trainingName = (id) => trainingsList.find(t=>t.id===id)?.title || "";

  // Fetch thumbnails for image-type templates only (pdf gets a generic icon — no
  // client-side PDF rasterization library is loaded, so we don't fake a preview).
  const imageTpls = templates.filter(t => t.template_type !== "pdf");
  const thumbUrls = {};
  await Promise.all(imageTpls.map(async t => {
    const signed = await sb.storage.from(CERT_TEMPLATE_BUCKET).createSignedUrl(t.storage_path, 3600);
    if(!signed.error) thumbUrls[t.id] = signed.data.signedUrl;
  }));

  const cards = templates.length ? templates.map(tpl => `
    <div class="cert-tpl-card">
      <div class="cert-tpl-thumb" style="${thumbUrls[tpl.id] ? `background-image:url('${thumbUrls[tpl.id]}')` : ""}">
        ${thumbUrls[tpl.id] ? "" : `<span class="cert-tpl-filetype">📄 PDF</span>`}
      </div>
      <div class="cert-tpl-body">
        <p class="cert-tpl-name">${esc(tpl.template_name)}</p>
        <span class="cert-tpl-meta">${tpl.training_id ? esc(trainingName(tpl.training_id)) : "Reusable (any training)"}</span>
        <span class="cert-tpl-meta">${esc((tpl.template_type||"").toUpperCase())} · ${esc(tpl.orientation||"-")} / ${esc(tpl.page_size||"-")}</span>
        ${tpl.is_default ? '<span class="badge o" style="width:fit-content">Default</span>' : ""}
      </div>
      <div class="cert-tpl-actions">
        <button class="btn light" onclick="previewCertificateTemplate('${tpl.id}')">👁️ Preview</button>
        <button class="btn light" ${tpl.template_type==="pdf"?"disabled title='Position editing needs a JPG/PNG template'":""} onclick="openFieldPositionsModal('${tpl.id}')">🎯 Positions</button>
        <button class="btn light" onclick="openUploadCertificateTemplateModal('${tpl.id}')">✏️ Edit</button>
        <button class="btn light" onclick="duplicateCertificateTemplate('${tpl.id}')">🧬 Duplicate</button>
        <button class="btn light" style="color:#d32f2f" onclick="deleteCertificateTemplate('${tpl.id}')">🗑️ Delete</button>
      </div>
    </div>
  `).join("") : `<div class="card empty">No certificate templates uploaded yet.</div>`;

  return layout("certificates", "Certificates", `
    ${_certAdminTabsHTML()}
    <div class="card" style="margin-bottom:18px">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <div>
          <h3 style="margin:0 0 4px">Certificate Format Designer</h3>
          <p class="muted" style="margin:0">Upload a certificate background (PDF, JPG or PNG) that trainings can use to generate certificates. Set field positions on JPG/PNG templates so employee name, training, score, etc. print in the right spot.</p>
        </div>
        <button class="btn blue" id="certificate-generate-btn" onclick="openUploadCertificateTemplateModal()">⬆️ Upload Certificate Template</button>
      </div>
    </div>
    <div class="cert-tpl-grid">${cards}</div>
  `);
}

function openUploadCertificateTemplateModal(editId){
  _certEditingTemplateId = editId || null;
  const trainingsList = window._certTrainingsCache || [];
  const tpl = editId ? _certTemplatesCache.find(t=>t.id===editId) : null;
  const isEdit = !!tpl;

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal">
        <h2>${isEdit ? "Edit Certificate Template" : "Upload Certificate Template"}</h2>
        <div class="formgrid">
          <div class="fullfield"><label>Template Name *</label><input id="ctname" placeholder="e.g. Safety Training Certificate" value="${isEdit ? esc(tpl.template_name) : ""}"></div>

          <div class="fullfield">
            <label>Applies To</label>
            <select id="cttraining">
              <option value="">Reusable — not tied to a specific training</option>
              ${trainingsList.map(t => `<option value="${t.id}" ${isEdit && tpl.training_id===t.id ? "selected" : ""}>${esc(t.title)}</option>`).join("")}
            </select>
          </div>

          <div>
            <label>Orientation</label>
            <select id="ctorient">
              <option value="landscape" ${isEdit && tpl.orientation==="landscape" ? "selected" : ""}>Landscape</option>
              <option value="portrait" ${isEdit && tpl.orientation==="portrait" ? "selected" : ""}>Portrait</option>
            </select>
          </div>
          <div>
            <label>Page Size</label>
            <select id="ctpagesize">
              <option value="A4" ${isEdit && tpl.page_size==="A4" ? "selected" : ""}>A4</option>
              <option value="Letter" ${isEdit && tpl.page_size==="Letter" ? "selected" : ""}>Letter</option>
            </select>
          </div>

          <div class="fullfield" style="display:flex;align-items:center;gap:8px">
            <input type="checkbox" id="ctdefault" style="width:auto" ${isEdit && tpl.is_default ? "checked" : ""}>
            <label style="margin:0" for="ctdefault">Set as Default Template</label>
          </div>

          <div class="fullfield">
            <label>Template File (PDF, JPG or PNG)${isEdit ? " — leave empty to keep the current file" : " *"}</label>
            <input id="ctfile" type="file" accept=".pdf,.jpg,.jpeg,.png">
          </div>
        </div>
        <div class="actions" style="margin-top:15px">
          <button class="btn blue" id="ctSaveBtn" onclick="saveCertificateTemplate()">${isEdit ? "Save Changes" : "Save Template"}</button>
          <button class="btn light" onclick="closeModal()">Cancel</button>
        </div>
      </div>
    </div>
  `);
}

async function saveCertificateTemplate(){
  const editId = _certEditingTemplateId;
  const existing = editId ? _certTemplatesCache.find(t=>t.id===editId) : null;

  const name = $("ctname").value.trim();
  const trainingId = $("cttraining").value || null;
  const orientation = $("ctorient").value;
  const pageSize = $("ctpagesize").value;
  const isDefault = $("ctdefault").checked;
  const file = $("ctfile").files[0];

  if(!name) return alert("Template Name is required.");
  if(!editId && !file) return alert("Please choose a template file (PDF, JPG or PNG).");

  const btn = $("ctSaveBtn");
  const originalLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = editId ? "Saving..." : "Uploading...";

  try{
    let templateType = existing ? existing.template_type : null;
    let storagePath = existing ? existing.storage_path : null;
    const templateId = editId || crypto.randomUUID();

    if(file){
      const ext = (file.name.split(".").pop()||"").toLowerCase();
      templateType = ext === "pdf" ? "pdf" : (ext === "png" ? "png" : "jpg");
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g,"_");
      storagePath = `${templateId}/${safeName}`;
      const up = await sb.storage.from(CERT_TEMPLATE_BUCKET).upload(storagePath, file, { upsert:true });
      if(up.error){ alert("Upload failed: " + up.error.message); return; }
    }

    // If this is being set as default, clear any existing default in the same scope
    // (same training_id, or the reusable/global scope when training_id is null).
    if(isDefault){
      let clearQuery = sb.from("certificate_templates").update({ is_default:false });
      clearQuery = trainingId ? clearQuery.eq("training_id", trainingId) : clearQuery.is("training_id", null);
      await clearQuery;
    }

    if(editId){
      const updateRes = await sb.from("certificate_templates").update({
        template_name: name,
        training_id: trainingId,
        template_type: templateType,
        storage_path: storagePath,
        orientation: orientation,
        page_size: pageSize,
        is_default: isDefault
      }).eq("id", editId);
      if(updateRes.error){ alert("Could not save changes: " + updateRes.error.message); return; }
    } else {
      const insertRes = await sb.from("certificate_templates").insert({
        id: templateId,
        template_name: name,
        training_id: trainingId,
        template_type: templateType,
        storage_path: storagePath,
        orientation: orientation,
        page_size: pageSize,
        is_default: isDefault,
        field_positions: CERT_DEFAULT_POSITIONS,
        created_by: profile.id
      });
      if(insertRes.error){ alert("Could not save template: " + insertRes.error.message); return; }
    }

    _certEditingTemplateId = null;
    closeModal();
    route("certificates");
  }catch(e){
    alert("Unexpected error: " + e.message);
  }finally{
    btn.disabled = false;
    btn.textContent = originalLabel;
  }
}

async function duplicateCertificateTemplate(templateId){
  const tpl = _certTemplatesCache.find(t=>t.id===templateId);
  if(!tpl) return;
  if(!confirm(`Duplicate template "${tpl.template_name}"?`)) return;

  try{
    const newId = crypto.randomUUID();
    const fileName = tpl.storage_path.split("/").pop();
    const newPath = `${newId}/${fileName}`;

    // Copy the underlying file in storage so the duplicate is fully independent.
    const dl = await sb.storage.from(CERT_TEMPLATE_BUCKET).download(tpl.storage_path);
    if(dl.error){ alert("Could not read source file: " + dl.error.message); return; }
    const up = await sb.storage.from(CERT_TEMPLATE_BUCKET).upload(newPath, dl.data, { upsert:true });
    if(up.error){ alert("Could not copy file: " + up.error.message); return; }

    const insertRes = await sb.from("certificate_templates").insert({
      id: newId,
      template_name: tpl.template_name + " (Copy)",
      training_id: tpl.training_id,
      template_type: tpl.template_type,
      storage_path: newPath,
      orientation: tpl.orientation,
      page_size: tpl.page_size,
      is_default: false, // never duplicate the default flag — avoids two defaults in one scope
      field_positions: tpl.field_positions || CERT_DEFAULT_POSITIONS,
      created_by: profile.id
    });
    if(insertRes.error){ alert("Could not save duplicate: " + insertRes.error.message); return; }

    route("certificates");
  }catch(e){
    alert("Unexpected error: " + e.message);
  }
}

async function previewCertificateTemplate(templateId){
  const tpl = _certTemplatesCache.find(t=>t.id===templateId);
  if(!tpl) return;
  const signed = await sb.storage.from(CERT_TEMPLATE_BUCKET).createSignedUrl(tpl.storage_path, 3600);
  if(signed.error) return alert("Could not open preview: " + signed.error.message);
  window.open(signed.data.signedUrl, "_blank");
}

async function deleteCertificateTemplate(templateId){
  const tpl = _certTemplatesCache.find(t=>t.id===templateId);
  if(!tpl) return;
  if(!confirm(`Delete template "${tpl.template_name}"? Trainings using it as their certificate format will need a new template assigned.`)) return;

  const delFile = await sb.storage.from(CERT_TEMPLATE_BUCKET).remove([tpl.storage_path]);
  if(delFile.error){
    alert("Could not delete template file: " + delFile.error.message);
    return;
  }
  const delRow = await sb.from("certificate_templates").delete().eq("id", templateId);
  if(delRow.error){
    alert("Could not delete template record: " + delRow.error.message);
    return;
  }
  route("certificates");
}

// ------------------------------------------------------------
// FIELD POSITION EDITOR (number/dropdown based — no drag canvas)
// ------------------------------------------------------------
async function openFieldPositionsModal(templateId){
  const tpl = _certTemplatesCache.find(t=>t.id===templateId);
  if(!tpl) return;
  if(tpl.template_type === "pdf"){
    return alert("Field positioning currently supports JPG/PNG templates only. Upload an image version of this template to position fields on it.");
  }

  const signed = await sb.storage.from(CERT_TEMPLATE_BUCKET).createSignedUrl(tpl.storage_path, 3600);
  if(signed.error) return alert("Could not load template image: " + signed.error.message);

  _certPosTemplateId = templateId;
  _certPosDraft = _certMergedPositions(tpl);
  const dims = _certCanvasDims(tpl);
  const previewW = 480;
  const scale = previewW / dims.w;
  const previewH = Math.round(dims.h * scale);

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modalbg" id="modal">
      <div class="modal" style="max-width:1000px">
        <h2>Field Positions — ${esc(tpl.template_name)}</h2>
        <p class="muted" style="margin-top:-6px">Set where each field prints on the certificate using X/Y % position, font size and alignment. Preview updates as you type.</p>
        <div class="cert-pos-wrap">
          <div class="cert-pos-stagebox" style="width:${previewW}px;height:${previewH}px">
            <div class="cert-pos-stage-outer" style="width:${previewW}px;height:${previewH}px">
              <div class="cert-pos-stage-inner" id="certPosStage" style="width:${dims.w}px;height:${dims.h}px;transform:scale(${scale});background-image:url('${signed.data.signedUrl}');background-size:100% 100%;">
              </div>
            </div>
          </div>
          <div class="cert-pos-fields" id="certPosFields"></div>
        </div>
        <div class="actions" style="margin-top:15px">
          <button class="btn blue" id="certPosSaveBtn" onclick="saveFieldPositions()">Save Positions</button>
          <button class="btn light" onclick="_certPosDraft=JSON.parse(JSON.stringify(CERT_DEFAULT_POSITIONS));_certRenderPositionEditor()">Reset to Default Layout</button>
          <button class="btn light" onclick="closeModal()">Cancel</button>
        </div>
      </div>
    </div>
  `);

  _certRenderPositionEditor();
}

function _certRenderPositionEditor(){
  _certRenderStageSpans();
  const fieldsBox = $("certPosFields");
  if(!fieldsBox) return;

  fieldsBox.innerHTML = CERT_FIELD_DEFS.map(f => {
    const p = _certPosDraft[f.key];
    return `
      <div class="cert-pos-field-row ${p.enabled ? "" : "disabled"}" id="certPosRow_${f.key}">
        <div class="cert-pos-field-head">
          <input type="checkbox" style="width:auto" ${p.enabled ? "checked" : ""} onchange="_certPosUpdate('${f.key}','enabled',this.checked)">
          <span>${esc(f.label)}</span>
        </div>
        <div class="cert-pos-field-grid">
          <div><label>X %</label><input type="number" min="0" max="100" value="${p.x}" oninput="_certPosUpdate('${f.key}','x',parseFloat(this.value)||0)"></div>
          <div><label>Y %</label><input type="number" min="0" max="100" value="${p.y}" oninput="_certPosUpdate('${f.key}','y',parseFloat(this.value)||0)"></div>
          <div><label>Font Size</label><input type="number" min="6" max="120" value="${p.fontSize}" oninput="_certPosUpdate('${f.key}','fontSize',parseInt(this.value)||16)"></div>
          <div><label>Align</label>
            <select onchange="_certPosUpdate('${f.key}','align',this.value)">
              <option value="left" ${p.align==="left"?"selected":""}>Left</option>
              <option value="center" ${p.align==="center"?"selected":""}>Center</option>
              <option value="right" ${p.align==="right"?"selected":""}>Right</option>
            </select>
          </div>
          <div><label>Bold</label>
            <select onchange="_certPosUpdate('${f.key}','bold',this.value==='true')">
              <option value="false" ${!p.bold?"selected":""}>Normal</option>
              <option value="true" ${p.bold?"selected":""}>Bold</option>
            </select>
          </div>
          <div><label>Color</label><input type="color" value="${p.color}" oninput="_certPosUpdate('${f.key}','color',this.value)"></div>
        </div>
      </div>`;
  }).join("");
}

function _certPosUpdate(key, prop, value){
  _certPosDraft[key][prop] = value;
  const row = $("certPosRow_" + key);
  if(row) row.classList.toggle("disabled", !_certPosDraft[key].enabled);
  _certRenderStageSpans();
}

function _certRenderStageSpans(){
  const stage = $("certPosStage");
  if(!stage) return;
  stage.innerHTML = CERT_FIELD_DEFS.map(f => {
    const p = _certPosDraft[f.key];
    if(!p.enabled) return "";
    return _certFieldSpanHTML(f.key, p, f.sample);
  }).join("");
}

function _certFieldSpanHTML(key, p, value){
  const alignTx = p.align === "center" ? "translate(-50%,-50%)" : p.align === "right" ? "translate(-100%,-50%)" : "translate(0,-50%)";
  return `<span class="cert-field-span" data-field="${key}" style="left:${p.x}%;top:${p.y}%;transform:${alignTx};font-size:${p.fontSize}px;font-weight:${p.bold?700:400};color:${p.color};font-family:Arial,Helvetica,sans-serif">${esc(value)}</span>`;
}

async function saveFieldPositions(){
  const templateId = _certPosTemplateId;
  if(!templateId) return;
  const btn = $("certPosSaveBtn");
  const original = btn.textContent;
  btn.disabled = true; btn.textContent = "Saving...";

  const r = await sb.from("certificate_templates").update({ field_positions: _certPosDraft }).eq("id", templateId);

  btn.disabled = false; btn.textContent = original;
  if(r.error) return alert("Could not save positions: " + r.error.message);

  closeModal();
  route("certificates");
}

// ------------------------------------------------------------
// TEMPLATE-BACKED CERTIFICATE RENDERING + PDF DOWNLOAD
// (Used by both the employee "My Certificates" page and the
// "Download PDF" button added to app.js's showCertificate /
// showDeclarationCertificate modals.)
// ------------------------------------------------------------

// Picks the best matching template for a training: one mapped directly to
// this training, else the global default (training_id null, is_default true),
// else null (caller falls back to the plain certificate design).
async function _certPickTemplateForTraining(trainingId){
  const specific = await sb.from("certificate_templates").select("*").eq("training_id", trainingId).limit(1);
  if(!specific.error && specific.data && specific.data.length) return specific.data[0];

  const def = await sb.from("certificate_templates").select("*").is("training_id", null).eq("is_default", true).limit(1);
  if(!def.error && def.data && def.data.length) return def.data[0];

  return null;
}

async function _certBuildStageForExport(tpl, values){
  const dims = _certCanvasDims(tpl);
  const signed = await sb.storage.from(CERT_TEMPLATE_BUCKET).createSignedUrl(tpl.storage_path, 3600);
  if(signed.error) return null;

  const positions = _certMergedPositions(tpl);
  const spans = CERT_FIELD_DEFS.map(f => {
    const p = positions[f.key];
    const value = values[f.key];
    if(!p.enabled || !value) return "";
    return _certFieldSpanHTML(f.key, p, value);
  }).join("");

  const holder = document.createElement("div");
  holder.style.position = "fixed";
  holder.style.left = "-99999px";
  holder.style.top = "0";
  holder.style.width = dims.w + "px";
  holder.style.height = dims.h + "px";
  holder.style.backgroundImage = `url('${signed.data.signedUrl}')`;
  holder.style.backgroundSize = "100% 100%";
  holder.innerHTML = spans;
  document.body.appendChild(holder);

  // Let the background image actually finish loading before html2canvas snapshots it.
  await new Promise(resolve => {
    const img = new Image();
    img.onload = resolve; img.onerror = resolve;
    img.src = signed.data.signedUrl;
  });

  return { holder, dims };
}

// Plain fallback design (mirrors app.js's existing on-screen certificate) used
// whenever a training has no matching JPG/PNG template — Download PDF should
// still produce something rather than doing nothing.
function _certBuildPlainStage(values){
  const dims = { w: 1600, h: 1131 };
  const holder = document.createElement("div");
  holder.style.position = "fixed";
  holder.style.left = "-99999px";
  holder.style.top = "0";
  holder.style.width = dims.w + "px";
  holder.style.height = dims.h + "px";
  holder.style.background = "#fff";
  holder.style.boxSizing = "border-box";
  holder.style.border = "16px double #1f4d3a";
  holder.style.padding = "70px 80px";
  holder.style.textAlign = "center";
  holder.style.fontFamily = "Arial,Helvetica,sans-serif";
  holder.innerHTML = `
    <div style="font-size:26px;font-weight:700">TALWANDI SABO THERMAL PLANT</div>
    <div style="font-size:54px;margin:40px 0 14px;font-weight:800;color:#1f4d3a">CERTIFICATE OF COMPLETION</div>
    <div style="font-size:20px">This is to certify that</div>
    <div style="font-size:40px;margin:16px 0;font-weight:700">${esc(values.employee_name||"")}</div>
    <div style="font-size:18px">Employee ID: <b>${esc(values.employee_id||"-")}</b></div>
    <div style="font-size:20px;margin-top:16px">has successfully completed training</div>
    <div style="font-size:30px;margin:10px 0;font-weight:700">${esc(values.training_title||"")}</div>
    ${values.score ? `<div style="font-size:18px">Score: <b>${esc(values.score)}</b></div>` : ""}
    <div style="display:flex;justify-content:space-between;margin-top:60px;font-size:16px">
      <div>Cert No: <b>${esc(values.cert_no||"")}</b></div>
      <div>Date: <b>${esc(values.date||"")}</b></div>
    </div>`;
  document.body.appendChild(holder);
  return { holder, dims };
}

async function _certExportPDF(stageInfo, tpl, filename){
  if(!window.html2canvas || !window.jspdf){
    stageInfo.holder.remove();
    return alert("PDF export libraries did not load — check your internet connection and try again.");
  }
  try{
    const canvas = await window.html2canvas(stageInfo.holder, { scale: 1, useCORS: true, backgroundColor: "#ffffff" });
    const { jsPDF } = window.jspdf;
    const orientation = (tpl && tpl.orientation === "portrait") ? "portrait" : "landscape";
    const pageSize = (tpl && tpl.page_size === "Letter") ? "letter" : "a4";
    const pdf = new jsPDF({ orientation, unit: "pt", format: pageSize });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const imgData = canvas.toDataURL("image/jpeg", 0.95);
    pdf.addImage(imgData, "JPEG", 0, 0, pageW, pageH);
    pdf.save(filename);
  }catch(e){
    alert("Could not generate PDF: " + e.message);
  }finally{
    stageInfo.holder.remove();
  }
}

async function downloadCertificatePDF(attemptId){
  const r = await sb.from("assessment_attempts")
    .select("id,training_id,score,passed,created_at,trainings(title),profiles(name,employee_id)")
    .eq("id", attemptId).single();
  if(r.error) return alert(r.error.message);
  const a = r.data;
  const certNo = "STLP-" + String(a.id).replace(/-/g,"").substring(0,10).toUpperCase();

  const values = {
    employee_name: a.profiles?.name || "",
    employee_id: a.profiles?.employee_id || "-",
    training_title: a.trainings?.title || "",
    score: a.score + "%",
    cert_no: certNo,
    date: new Date(a.created_at).toLocaleDateString("en-IN")
  };

  const tpl = await _certPickTemplateForTraining(a.training_id);
  const stageInfo = tpl ? await _certBuildStageForExport(tpl, values) : null;
  const finalStage = stageInfo || _certBuildPlainStage(values);
  await _certExportPDF(finalStage, tpl, `Certificate_${(a.trainings?.title||"Training").replace(/[^a-z0-9]+/gi,"_")}.pdf`);
}

async function downloadDeclarationCertificatePDF(trainingId){
  const [tRes, pRes] = await Promise.all([
    sb.from("trainings").select("title").eq("id", trainingId).single(),
    sb.from("training_progress").select("id,created_at").eq("training_id", trainingId).eq("user_id", profile.id).order("created_at",{ascending:false}).limit(1)
  ]);
  if(tRes.error) return alert(tRes.error.message);
  if(pRes.error) return alert(pRes.error.message);
  const prog = (pRes.data||[])[0];
  if(!prog) return alert("No completion record found for this training yet.");

  const certNo = "STLP-" + String(prog.id).replace(/-/g,"").substring(0,10).toUpperCase();
  const values = {
    employee_name: profile.name || "",
    employee_id: profile.employee_id || "-",
    training_title: tRes.data.title || "",
    score: "",
    cert_no: certNo,
    date: prog.created_at ? new Date(prog.created_at).toLocaleDateString("en-IN") : ""
  };

  const tpl = await _certPickTemplateForTraining(trainingId);
  const stageInfo = tpl ? await _certBuildStageForExport(tpl, values) : null;
  const finalStage = stageInfo || _certBuildPlainStage(values);
  await _certExportPDF(finalStage, tpl, `Certificate_${(tRes.data.title||"Training").replace(/[^a-z0-9]+/gi,"_")}.pdf`);
}

// ------------------------------------------------------------
// MY CERTIFICATES (employee-facing)
// ------------------------------------------------------------
async function myCertificatesPage(){
  const [attemptsRes, progressRes] = await Promise.all([
    sb.from("assessment_attempts")
      .select("id,training_id,score,created_at,trainings(title)")
      .eq("user_id", profile.id).eq("passed", true)
      .order("created_at",{ascending:false}),
    sb.from("training_progress")
      .select("id,training_id,created_at,trainings(title,assessment_required)")
      .eq("user_id", profile.id).eq("status", "completed")
      .order("created_at",{ascending:false})
  ]);

  if(attemptsRes.error) return layout("certificates","My Certificates",`<div class="card"><b>Error:</b> ${esc(attemptsRes.error.message)}</div>`);
  if(progressRes.error) return layout("certificates","My Certificates",`<div class="card"><b>Error:</b> ${esc(progressRes.error.message)}</div>`);

  const items = [];
  (attemptsRes.data||[]).forEach(a => items.push({
    type: "assessment", refId: a.id, trainingId: a.training_id,
    title: a.trainings?.title || "Training", score: a.score, date: a.created_at
  }));
  // Declaration-based certs only apply to trainings that don't carry an assessment,
  // matching the same rule app.js uses to decide which certificate flow a training uses.
  (progressRes.data||[]).forEach(p => {
    if(p.trainings && p.trainings.assessment_required === false){
      items.push({ type: "declaration", refId: p.training_id, trainingId: p.training_id, title: p.trainings.title || "Training", score: null, date: p.created_at });
    }
  });
  items.sort((a,b) => new Date(b.date) - new Date(a.date));

  const cards = items.length ? items.map(it => `
    <div class="cert-my-card">
      <div style="display:flex;justify-content:space-between;align-items:start;gap:8px">
        <b>${esc(it.title)}</b>
        <span class="badge ${it.type==='assessment'?'g':'o'}">${it.type==='assessment' ? 'Assessment Passed' : 'Completed'}</span>
      </div>
      ${it.score!==null ? `<span class="muted">Score: ${it.score}%</span>` : ""}
      <span class="muted">Date: ${new Date(it.date).toLocaleDateString("en-IN")}</span>
      <div class="cert-tpl-actions">
        <button class="btn light" onclick="${it.type==='assessment' ? `showCertificate('${it.refId}')` : `showDeclarationCertificate('${it.refId}')`}">View</button>
        <button class="btn blue" onclick="${it.type==='assessment' ? `downloadCertificatePDF('${it.refId}')` : `downloadDeclarationCertificatePDF('${it.refId}')`}">⬇️ Download PDF</button>
      </div>
    </div>
  `).join("") : `<div class="card empty">No certificates yet. Complete a training's assessment (or its read &amp; declare step) to see your certificate here.</div>`;

  return layout("certificates", "My Certificates", `<div class="cert-my-grid">${cards}</div>`);
}

// ------------------------------------------------------------
// ADMIN CERTIFICATE DASHBOARD
// ------------------------------------------------------------
async function certificateDashboardTab(){
  const [attemptsRes, progressRes, trainingsRes, templatesRes, profilesRes] = await Promise.all([
    sb.from("assessment_attempts").select("id,training_id,user_id,score,created_at,trainings(title)").eq("passed", true),
    sb.from("training_progress").select("id,training_id,user_id,created_at,trainings(title,assessment_required)").eq("status","completed"),
    sb.from("trainings").select("id,title").order("title"),
    sb.from("certificate_templates").select("id"),
    sb.from("profiles").select("id,name,employee_id")
  ]);

  if(attemptsRes.error) return layout("certificates","Certificates",`${_certAdminTabsHTML()}<div class="card"><b>Error:</b> ${esc(attemptsRes.error.message)}</div>`);

  const profileMap = {};
  (profilesRes.data||[]).forEach(p => profileMap[p.id] = p);
  const trainingsList = trainingsRes.data || [];

  let items = [];
  (attemptsRes.data||[]).forEach(a => items.push({
    type: "assessment", trainingId: a.training_id, trainingTitle: a.trainings?.title || "Training",
    userId: a.user_id, score: a.score, date: a.created_at
  }));
  (progressRes.data||[]).forEach(p => {
    if(p.trainings && p.trainings.assessment_required === false){
      items.push({ type: "declaration", trainingId: p.training_id, trainingTitle: p.trainings.title || "Training", userId: p.user_id, score: null, date: p.created_at });
    }
  });

  // Apply filters
  if(_certDashFilters.training) items = items.filter(i => i.trainingId === _certDashFilters.training);
  if(_certDashFilters.from) items = items.filter(i => new Date(i.date) >= new Date(_certDashFilters.from));
  if(_certDashFilters.to) items = items.filter(i => new Date(i.date) <= new Date(_certDashFilters.to + "T23:59:59"));

  items.sort((a,b) => new Date(b.date) - new Date(a.date));
  window._certDashItemsCache = items.map(i => Object.assign({}, i, { employeeName: profileMap[i.userId]?.name || "", employeeCode: profileMap[i.userId]?.employee_id || "" }));

  const now = new Date();
  const thisMonthCount = items.filter(i => { const d = new Date(i.date); return d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear(); }).length;
  const assessmentCount = items.filter(i=>i.type==="assessment").length;
  const declarationCount = items.filter(i=>i.type==="declaration").length;
  const trainingsWithCerts = new Set(items.map(i=>i.trainingId)).size;

  const kpis = [
    ["Total Certificates", items.length],
    ["Issued This Month", thisMonthCount],
    ["Via Assessment", assessmentCount],
    ["Via Declaration", declarationCount],
    ["Trainings Covered", trainingsWithCerts],
    ["Templates Uploaded", (templatesRes.data||[]).length]
  ];

  const rows = window._certDashItemsCache.slice(0, 300).map(i => `
    <tr>
      <td>${esc(i.employeeName)}</td>
      <td>${esc(i.employeeCode)}</td>
      <td>${esc(i.trainingTitle)}</td>
      <td>${i.type==="assessment" ? "Assessment" : "Declaration"}</td>
      <td>${i.score!==null ? i.score+"%" : "-"}</td>
      <td>${new Date(i.date).toLocaleString("en-IN")}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="empty">No certificates match the current filters.</td></tr>`;

  return layout("certificates", "Certificates", `
    ${_certAdminTabsHTML()}
    <div class="cert-kpi-grid">
      ${kpis.map(([label,num]) => `<div class="cert-kpi-card"><div class="cert-kpi-num">${num}</div><div class="cert-kpi-label">${esc(label)}</div></div>`).join("")}
    </div>
    <div class="card" style="margin-bottom:14px">
      <div class="cert-filters">
        <div><label>Training</label>
          <select id="certDashTraining" onchange="_certDashFilters.training=this.value;route('certificates')">
            <option value="">All Trainings</option>
            ${trainingsList.map(t=>`<option value="${t.id}" ${_certDashFilters.training===t.id?"selected":""}>${esc(t.title)}</option>`).join("")}
          </select>
        </div>
        <div><label>From</label><input type="date" id="certDashFrom" value="${_certDashFilters.from}" onchange="_certDashFilters.from=this.value;route('certificates')"></div>
        <div><label>To</label><input type="date" id="certDashTo" value="${_certDashFilters.to}" onchange="_certDashFilters.to=this.value;route('certificates')"></div>
        <button class="btn light" onclick="_certDashFilters={training:'',from:'',to:''};route('certificates')">Clear Filters</button>
        <button class="btn blue" onclick="exportCertificatesCSV()">⬇️ Export CSV</button>
      </div>
    </div>
    <div class="tablewrap">
      <table class="table">
        <thead><tr><th>Employee</th><th>Employee ID</th><th>Training</th><th>Type</th><th>Score</th><th>Date</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    ${window._certDashItemsCache.length > 300 ? `<p class="muted" style="margin-top:8px">Showing latest 300 of ${window._certDashItemsCache.length} — narrow with filters or use Export CSV for the full list.</p>` : ""}
  `);
}

function exportCertificatesCSV(){
  const items = window._certDashItemsCache || [];
  if(!items.length) return alert("No certificates to export for the current filters.");

  let csv = "Employee,Employee ID,Training,Type,Score,Date\n";
  items.forEach(i => {
    const row = [
      i.employeeName, i.employeeCode, i.trainingTitle,
      i.type==="assessment" ? "Assessment" : "Declaration",
      i.score!==null ? i.score+"%" : "",
      new Date(i.date).toLocaleString("en-IN")
    ];
    csv += row.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",") + "\n";
  });

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `STLP_Certificates_${Date.now()}.csv`;
  a.click();
}
