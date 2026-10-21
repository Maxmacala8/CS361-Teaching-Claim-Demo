// ใส่ Invoke URL ของ API Gateway
const API = "https://6n0mb8bvze.execute-api.us-east-1.amazonaws.com";

const $ = (id) => document.getElementById(id);
const baht = (n) => Number(n).toLocaleString("th-TH") + " บาท";
const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let types = [];
let globalClaims = [];
let currentEditClaimId = null;
let existingAttachments = [];
let files = [];

const STATUS = {
  DRAFT: "ร่าง", SUBMITTED: "ยื่นแล้ว", VERIFIED: "ตรวจแล้ว",
  APPROVED: "อนุมัติ", REJECTED: "ไม่อนุมัติ", RETURNED: "ส่งกลับแก้ไข",
};

// ---------- เรียก API (แนบ ID token ทุกครั้ง) ----------
async function api(path, opts) {
  const token = sessionStorage.getItem("id_token");
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json", ...(token && { Authorization: `Bearer ${token}` }) },
    ...opts,
  });
  if (res.status === 401 && path !== "/types") { login(); throw new Error("กรุณาเข้าสู่ระบบ"); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "เกิดข้อผิดพลาด");
  return data;
}

// ---------- ประเภทค่าตอบแทน (เปิดดูได้โดยไม่ต้องล็อกอิน) ----------
async function loadTypes() {
  try {
    types = await api("/types");
    $("typeSelect").innerHTML =
      '<option value="">เลือกประเภท</option>' +
      types.map((t) => `<option value="${escapeHtml(t.typeId)}">${escapeHtml(t.name)}</option>`).join("");
    $("typeRows").innerHTML = types
      .map((t) => `<tr><td><strong>${escapeHtml(t.name)}</strong></td>
        <td>${escapeHtml(t.roles.join(", "))}</td>
        <td>${escapeHtml((t.requiredDocs || []).join(", ") || "-")}</td>
        <td class="rate">${baht(t.rate)} / ${escapeHtml(t.unit)}</td></tr>`)
      .join("");
  } catch (e) {
    $("typeRows").innerHTML = `<tr><td colspan="4">โหลดข้อมูลไม่ได้: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function preview() {
  const t = types.find((x) => x.typeId === $("typeSelect").value);
  const h = Number($("hours").value);
  $("estimate").textContent =
    t && h > 0 ? `ยอดโดยประมาณ ${baht(t.rate * h)} (ระบบจะคำนวณอีกครั้งตอนยื่น)` : "";
}

// ---------- อัปโหลดไฟล์ผ่าน presigned URL ----------
async function uploadToS3(file, status) {
  const { uploadURL, fileKey } = await api("/get-upload-url", {
    method: "POST",
    body: JSON.stringify({ fileName: file.name, fileType: file.type, status }),
  });
  const res = await fetch(uploadURL, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
  if (!res.ok) throw new Error(`อัปโหลดไฟล์ ${file.name} ไม่สำเร็จ`);
  return fileKey;
}

// ---------- ยื่น / บันทึกร่าง (ไม่ส่ง role: ระบบดูจาก token) ----------
async function submitClaim(status) {
  const msg = $("formMsg");
  msg.className = "msg";
  msg.textContent = "กำลังอัปโหลดเอกสารประกอบ..."; // เปลี่ยนข้อความให้สอดคล้อง
  
  try {
    const uploaded = [];
    
    // 1) อัปโหลดไฟล์ใหม่ขึ้น S3 ก่อน ถ้ามีไฟล์ที่ต้องอัป
    if (files.length > 0) {
      for (const f of files) {
        uploaded.push(await uploadToS3(f, status));
      }
    }

    // 2) จัดเตรียมข้อมูลทั้งหมด พร้อมแนบ key ของไฟล์ส่งไปให้ Lambda บันทึกรอบเดียว
    msg.textContent = "กำลังบันทึกข้อมูล...";
    const body = {
      claimId: currentEditClaimId,
      status,
      claimantName: $("name").value.trim(),
      typeId: $("typeSelect").value,
      course: $("course").value.trim(),
      term: $("term").value,
      date: $("date").value,
      hours: Number($("hours").value),
      attachments: [...existingAttachments, ...uploaded] // รวมไฟล์เก่าและใหม่
    };

    // ส่ง POST request เพื่อบันทึกจริง ไม่ส่ง dryRun แล้ว
    const claim = await api("/claims", { method: "POST", body: JSON.stringify(body) });

    msg.textContent = `บันทึกแล้ว (รหัส ${claim.claimId.slice(0, 8)}) ยอด ${baht(claim.amount)}`;
    msg.classList.add("ok");
    resetForm(false);
    loadClaims();
    
  } catch (e) {
    msg.textContent = e.message;
    msg.classList.add("err");
  }
}

function resetForm(clearMsg = true) {
  ["name", "course", "date", "hours"].forEach((id) => ($(id).value = ""));
  $("typeSelect").value = "";
  currentEditClaimId = null;
  existingAttachments = [];
  files = [];
  $("btnCancel").hidden = true;
  $("estimate").textContent = "";
  if (clearMsg) $("formMsg").textContent = "";
  renderFiles();
  renderExistingFiles();
}

// ---------- ชื่อไฟล์ / ไอคอน ----------
const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;
const getRealFileName = (key) => key.split("/").pop().replace(UUID_PREFIX, "");

const ICONS = {
  pdf: "pdf.png", doc: "word.png", docx: "word.png", txt: "word.png",
  xls: "sheets.png", xlsx: "sheets.png", csv: "sheets.png", ppt: "folder.png", pptx: "folder.png",
  jpg: "jpg.png", jpeg: "jpeg.png", png: "png.png", mp4: "mp4.png", mov: "mov.png",
};
function getFileIcon(name) {
  const ext = name.split(".").pop().toLowerCase();
  return `<img src="png/icon/${ICONS[ext] || "question-mark.png"}" alt="${escapeHtml(ext)}" class="file-icon">`;
}

// ---------- รายการคำขอ ----------
async function loadClaims() {
  const q = new URLSearchParams();
  if ($("fTerm").value) q.set("term", $("fTerm").value);
  if ($("fStatus").value) q.set("status", $("fStatus").value);
  try {
    const rows = await api("/claims?" + q);
    globalClaims = rows;
    $("claimRows").innerHTML = rows.length
      ? rows.map(claimRow).join("")
      : '<tr><td colspan="10">ยังไม่มีคำขอ</td></tr>';
  } catch (e) {
    $("claimRows").innerHTML = `<tr><td colspan="10">โหลดข้อมูลไม่ได้: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function claimRow(c) {
  const fileLinks = (c.attachments || []).map((key) => {
    const name = getRealFileName(key);
    const short = name.length > 20 ? name.slice(0, 15) + "..." + name.split(".").pop() : name;
    return `<a href="#" class="file-link" data-act="open" data-id="${c.claimId}" data-key="${escapeHtml(key)}" title="${escapeHtml(name)}">
      ${getFileIcon(name)}<span>${escapeHtml(short)}</span></a>`;
  }).join("") || "-";

  const mine = ME && c.ownerSub === ME.sub;
  const editable = mine && ["DRAFT", "RETURNED"].includes(c.status);
  // เช็กว่าเป็น Administrator หรือไม่ (ดึงฟังก์ชัน hasRole มาจาก auth.js)
  const isAdmin = typeof hasRole === 'function' ? hasRole("Administrators") : false;
  // แสดงปุ่มโอนเงินเมื่อเป็น Admin และสถานะคือ APPROVED
  const canPay = isAdmin && c.status === "APPROVED"; 

  const actions =
    (editable
      ? `<button class="icon-btn" data-act="edit" data-id="${c.claimId}" title="แก้ไข">✏️</button>
         <button class="icon-btn" data-act="delete" data-id="${c.claimId}" title="ลบ">🗑️</button>` : "") +
    (c.status !== "DRAFT"
      ? `<button class="btn small ghost" data-act="history" data-id="${c.claimId}">ประวัติ</button>` : "") +
    (canPay
      ? `<button class="btn small" data-act="pay" data-id="${c.claimId}" style="background-color: #2e7d32; color: white;">โอนเงิน</button>` : "");

  return `<tr>
    <td>${c.claimId.slice(0, 8)}</td><td>${escapeHtml(c.claimantName)}</td><td>${escapeHtml(c.typeName)}</td>
    <td>${escapeHtml(c.course)}</td><td>${escapeHtml(c.term)}</td><td>${c.hours}</td>
    <td class="rate">${baht(c.amount)}</td>
    <td><span class="status ${c.status}">${STATUS[c.status] || c.status}</span></td>
    <td>${fileLinks}</td><td>${actions || "-"}</td></tr>`;
}

$("claimRows").addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  e.preventDefault();
  const { act, id, key } = el.dataset;
  if (act === "open") openFile(id, key);
  else if (act === "edit") editClaim(id);
  else if (act === "delete") deleteClaim(id);
  else if (act === "history") showHistory(id);
  else if (act === "pay") openPaymentModal(id);
});

// ---------- เปิดไฟล์ (Lambda ตรวจสิทธิ์จาก claimId + fileKey) ----------
async function openFile(claimId, fileKey) {
  try {
    const res = await api("/get-download-url", { method: "POST", body: JSON.stringify({ claimId, fileKey }) });
    if (res.downloadURL) window.open(res.downloadURL, "_blank");
  } catch (e) {
    alert("ไม่สามารถเปิดไฟล์ได้: " + e.message);
  }
}

// ---------- แก้ไข / ลบ ----------
function editClaim(claimId) {
  const c = globalClaims.find((x) => x.claimId === claimId);
  if (!c || !["DRAFT", "RETURNED"].includes(c.status)) return;
  currentEditClaimId = claimId;
  existingAttachments = [...(c.attachments || [])];
  files = [];
  renderFiles();
  renderExistingFiles();
  $("name").value = c.claimantName;
  $("typeSelect").value = c.typeId;
  $("course").value = c.course;
  $("term").value = c.term;
  $("date").value = c.date;
  $("hours").value = c.hours;
  $("btnCancel").hidden = false;
  preview();
  $("claim").scrollIntoView({ behavior: "smooth" });
}

async function deleteClaim(claimId) {
  if (!confirm("ต้องการลบคำขอนี้ทิ้งหรือไม่?")) return;
  try {
    await api("/claims", { method: "DELETE", body: JSON.stringify({ claimId }) });
    loadClaims();
  } catch (e) {
    alert("ไม่สามารถลบข้อมูลได้: " + e.message);
  }
}

// ---------- ไฟล์แนบในฟอร์ม ----------
const MAX_FILES = 5;
const MAX_SIZE = 100 * 1024 * 1024;
const ALLOWED = ["pdf","doc","docx","xls","xlsx","ppt","pptx","txt","csv","jpg","jpeg","png","gif","webp","mp4","mov","webm","avi","mkv"];

const formatSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");

$("addBtn").onclick = () => $("file").click();

$("file").addEventListener("change", () => {
  const errors = [];
  for (const f of $("file").files) {
    const ext = f.name.split(".").pop().toLowerCase();
    if (existingAttachments.length + files.length >= MAX_FILES) errors.push(`เพิ่ม "${f.name}" ไม่ได้: ครบ ${MAX_FILES} ไฟล์แล้ว`);
    else if (!ALLOWED.includes(ext)) errors.push(`เพิ่ม "${f.name}" ไม่ได้: ไม่รองรับไฟล์ .${ext}`);
    else if (f.size > MAX_SIZE) errors.push(`เพิ่ม "${f.name}" ไม่ได้: ขนาด ${formatSize(f.size)} เกิน 100MB`);
    else if (files.some((x) => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified))
      errors.push(`เพิ่ม "${f.name}" ไม่ได้: เลือกไฟล์นี้ไปแล้ว`);
    else files.push(f);
  }
  $("error").innerHTML = errors.map(escapeHtml).join("<br>");
  $("file").value = "";
  renderFiles();
});

function fileItem(label, onRemove, extraClass = "") {
  const li = document.createElement("li");
  li.className = "file-item " + extraClass;
  li.innerHTML = `<span>${label}</span>`;
  const del = document.createElement("button");
  del.type = "button";
  del.className = "btn-remove";
  del.textContent = "✕";
  del.title = "ลบไฟล์";
  del.onclick = onRemove;
  li.appendChild(del);
  return li;
}

function renderFiles() {
  $("fileList").innerHTML = "";
  files.forEach((f, i) =>
    $("fileList").appendChild(fileItem(
      `${escapeHtml(f.name)} <small class="file-size">(${formatSize(f.size)})</small>`,
      () => { files.splice(i, 1); $("error").textContent = ""; renderFiles(); }
    )));
}

function renderExistingFiles() {
  $("existingFileList").innerHTML = "";
  existingAttachments.forEach((key, i) =>
    $("existingFileList").appendChild(fileItem(
      `📎 ${escapeHtml(getRealFileName(key))} <small>(ไฟล์เดิม)</small>`,
      () => { existingAttachments.splice(i, 1); renderExistingFiles(); },
      "existing"
    )));
}

let currentPayClaimId = null;

// เปิด Modal พร้อมแสดงข้อมูลบัญชี
function openPaymentModal(claimId) {
  const c = globalClaims.find((x) => x.claimId === claimId);
  if (!c) return;
  
  currentPayClaimId = claimId;
  
  // สมมติว่าใน API ได้ Join ข้อมูลบัญชีแนบมาใน Object ชื่อ bankInfo แล้ว
  const bankHtml = c.bankInfo 
    ? `<p><strong>ธนาคาร:</strong> ${escapeHtml(c.bankInfo.bankCode)}</p>
       <p><strong>เลขบัญชี:</strong> ${escapeHtml(c.bankInfo.accountNumber)}</p>
       <p><strong>ชื่อบัญชี:</strong> ${escapeHtml(c.bankInfo.accountName)}</p>`
    : `<p style="color: red;"><strong>ยังไม่พบข้อมูลบัญชีของเบิกผู้เบิก!</strong></p>`;

  $("paymentBankInfo").innerHTML = `
    <p><strong>ชื่อผู้ขอเบิก:</strong> ${escapeHtml(c.claimantName)}</p>
    <p><strong>ยอดเงินที่ต้องโอน:</strong> <span class="rate">${baht(c.amount)}</span></p>
    <hr style="margin: 10px 0;">
    ${bankHtml}
  `;

  // เคลียร์ค่าเก่าในฟอร์ม
  $("slipFile").value = "";
  $("paymentMsg").textContent = "";
  $("paymentMsg").className = "msg";
  $("btnConfirmPayment").disabled = false;

  document.getElementById('paymentDlg').showModal();
}

// เมื่อกดยืนยันการโอนเงิน
$("btnConfirmPayment").addEventListener("click", async () => {
  const fileInput = $("slipFile");
  if (!fileInput.files || fileInput.files.length === 0) {
    $("paymentMsg").textContent = "กรุณาแนบไฟล์สลิปหลักฐานการโอนเงิน";
    $("paymentMsg").className = "msg err";
    return;
  }

  const file = fileInput.files[0];
  const msg = $("paymentMsg");
  
  msg.textContent = "กำลังอัปโหลดสลิปไปยัง S3...";
  msg.className = "msg";
  $("btnConfirmPayment").disabled = true;

  try {
    // 1. เรียกใช้ฟังก์ชันเดิมเพื่ออัปโหลดไฟล์ขึ้น S3 (อาจจะตั้ง status เป็น PAID เพื่อให้แยกโฟลเดอร์ใน S3 ง่ายๆ)
    const slipS3Key = await uploadToS3(file, "PAID");

    msg.textContent = "อัปโหลดสำเร็จ กำลังอัปเดตสถานะการเบิกจ่าย...";

    // 2. เรียก API (Lambda) เพื่อเปลี่ยนสถานะคำขอเป็น PAID พร้อมส่ง Key ของสลิปไปเก็บใน DB
    await api("/claims/pay", {
      method: "POST", // หรือ PUT ตามที่คุณออกแบบ API ไว้
      body: JSON.stringify({
        claimId: currentPayClaimId,
        paymentSlipKey: slipS3Key,
        status: "PAID"
      })
    });

    document.getElementById('paymentDlg').close();
    
    // โหลดข้อมูลตารางใหม่เพื่อดูสถานะล่าสุด
    loadClaims();
    alert("บันทึกการโอนเงินและอัปเดตสถานะสำเร็จ!");

  } catch (e) {
    msg.textContent = "เกิดข้อผิดพลาด: " + e.message;
    msg.className = "msg err";
    $("btnConfirmPayment").disabled = false;
  }
});
// ---------- อีเวนต์ ----------
$("hours").addEventListener("keydown", (e) => { if (["e", "E", "+", "-"].includes(e.key)) e.preventDefault(); });
$("hours").addEventListener("input", preview);
$("typeSelect").addEventListener("change", preview);
$("btnDraft").addEventListener("click", () => submitClaim("DRAFT"));
$("btnSubmit").addEventListener("click", () => submitClaim("SUBMITTED"));
$("btnCancel").addEventListener("click", () => resetForm());
$("fTerm").addEventListener("change", loadClaims);
$("fStatus").addEventListener("change", loadClaims);

// loadClaims() / loadReview() ถูกเรียกใน review.js ตอน auth-ready
loadTypes();