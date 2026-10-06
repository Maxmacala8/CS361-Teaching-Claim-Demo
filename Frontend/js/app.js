// ใส่ URL ของ API Gateway (Invoke URL) ที่นี่ เช่น https://abc123.execute-api.ap-southeast-1.amazonaws.com

const API = "https://6n0mb8bvze.execute-api.us-east-1.amazonaws.com";

const $ = (id) => document.getElementById(id);
let types = [];
let currentEditClaimId = null;//for edit
let existingAttachments = [];
const existingList = document.getElementById('existingFileList');
let globalClaims = []; // เก็บข้อมูลคำขอทั้งหมดไว้ดึงมาใส่ฟอร์ม

async function api(path, opts) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "เกิดข้อผิดพลาด");
  return data;
}

const baht = (n) => Number(n).toLocaleString("th-TH") + " บาท";

// ---------- ประเภทค่าตอบแทน (อ่านจาก DynamoDB) ----------
async function loadTypes() {
  try {
    types = await api("/types");
    $("typeSelect").innerHTML =
      '<option value="">เลือกประเภท</option>' +
      types.map((t) => `<option value="${t.typeId}">${t.name}</option>`).join("");
    $("typeRows").innerHTML = types
      .map(
        (t) => `<tr><td><strong>${t.name}</strong></td>
        <td>${t.roles.join(", ")}</td>
        <td>${(t.requiredDocs || []).join(", ") || "-"}</td>
        <td class="rate">${baht(t.rate)} / ${t.unit}</td></tr>`
      )
      .join("");
  } catch (e) {
    $("typeRows").innerHTML = `<tr><td colspan="4">โหลดข้อมูลไม่ได้: ${e.message}</td></tr>`;
  }
}

// ---------- แสดงยอดโดยประมาณทันทีที่กรอก ----------
function preview() {
  const t = types.find((x) => x.typeId === $("typeSelect").value);
  const h = Number($("hours").value);
  $("estimate").textContent =
    t && h > 0 ? `ยอดโดยประมาณ ${baht(t.rate * h)} (ระบบจะคำนวณอีกครั้งตอนยื่น)` : "";
}

// ---------- ส่งคำขอ (ร่าง / ยื่น) ----------

async function submitClaim(status) {
  const msg = $("formMsg");
  msg.className = "msg";
  msg.textContent = "กำลังตรวจสอบเงื่อนไข..."; // เปลี่ยนข้อความให้ผู้ใช้รู้ว่ากำลังทำอะไร

  try {
    // เตรียมข้อมูลจากแบบฟอร์ม
    const body = {
      claimId: currentEditClaimId,
      status,
      claimantName: $("name").value.trim(),
      role: $("role").value,
      typeId: $("typeSelect").value,
      course: $("course").value.trim(),
      term: $("term").value,
      date: $("date").value,
      hours: Number($("hours").value)
    };

    // --- สเตปที่ 1: ส่งข้อมูลไปให้ Backend ตรวจก่อน (แนบ dryRun: true ไปด้วย) ---
    await api("/claims", { 
      method: "POST", 
      body: JSON.stringify({ ...body, dryRun: true }) 
    });

    // --- สเตปที่ 2: ถ้า Backend ไม่ด่าอะไรกลับมา (แปลว่าผ่าน) ค่อยอัปโหลดไฟล์เข้า S3 ---
    let uploadedFilesKeys = [];
    if (files.length > 0) {
      msg.textContent = "ข้อมูลถูกต้อง กำลังอัปโหลดไฟล์แนบ...";
      for (let f of files) {
        const savedKey = await uploadToS3(f, status); 
        uploadedFilesKeys.push(savedKey);
      }
    }

    // --- สเตปที่ 3: ส่งข้อมูล + รายชื่อไฟล์ ไปบันทึกจริง ---
    msg.textContent = "กำลังบันทึกข้อมูล...";
    body.attachments = [...existingAttachments, ...uploadedFilesKeys]; // แนบไฟล์ที่เพิ่งอัปโหลดเสร็จเข้าไป
    const claim = await api("/claims", { method: "POST", body: JSON.stringify(body) });

    msg.textContent = `บันทึกแล้ว (รหัส ${claim.claimId}) ยอด ${baht(claim.amount)}`;
    msg.classList.add("ok");
    
    // เคลียร์ฟอร์ม
    files = [];
    render();

    currentEditClaimId = null;
    existingAttachments = [];
    loadClaims();

  } catch (e) {
    // ถ้าติดเงื่อนไขตั้งแต่สเตปแรก (เช่น TA เบิกไม่ได้) มันจะกระโดดมาที่นี่ทันที โดยยังไม่ได้อัปโหลดไฟล์
    msg.textContent = e.message;
    msg.classList.add("err");
  }
}
async function uploadToS3(file, status) {
  const { uploadURL, fileKey } = await api("/get-upload-url", {
    method: "POST",
    body: JSON.stringify({ fileName: file.name, fileType: file.type, status: status })
  });

  const res = await fetch(uploadURL, {
    method: "PUT",
    headers: { "Content-Type": file.type },
    body: file
  });

  if (!res.ok) throw new Error(`อัปโหลดไฟล์ ${file.name} ไม่สำเร็จ`);
  
  return fileKey; 
}
// ---------- รายการคำขอ + กรอง ----------
const STATUS = { DRAFT: "ร่าง", SUBMITTED: "ยื่นแล้ว" };

function getRealFileName(key) {
  // 1. ตัดชื่อโฟลเดอร์ออก ไม่ว่าจะเป็น claims/ หรือ drafts/
  let nameWithoutPrefix = key.replace("claims/", "").replace("drafts/", "");
  
  // 2. ใช้ Regex ตรวจจับรหัส UUID (ที่มี 36 ตัวอักษรและมีขีด 4 ตัว) เพื่อตัดออกทั้งก้อน
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;
  
  if (uuidRegex.test(nameWithoutPrefix)) {
    return nameWithoutPrefix.replace(uuidRegex, ""); // ตัดก้อน UUID ออกให้เหลือแค่ชื่อไฟล์แท้ๆ
  }

  // 3. (สำรองไว้) ลอจิกเดิมของคุณ เผื่ออนาคตมีไฟล์ที่ไม่ได้ตั้งชื่อด้วย UUID
  const dashIndex = nameWithoutPrefix.indexOf("-");
  if (dashIndex !== -1) {
    return nameWithoutPrefix.substring(dashIndex + 1);
  }
  
  return nameWithoutPrefix;
}
function getFileIcon(fileName) {
  const ext = fileName.split('.').pop().toLowerCase();
  let iconFile = 'question-mark.png'; 
  
  if (['pdf'].includes(ext)) iconFile = 'pdf.png';
  else if (['doc', 'docx', 'txt'].includes(ext)) iconFile = 'word.png';
  else if (['xls', 'xlsx', 'csv'].includes(ext)) iconFile = 'sheets.png';
  else if (['ppt', 'pptx'].includes(ext)) iconFile = 'folder.png';
  else if (['jpg'].includes(ext)) iconFile = 'jpg.png';
  else if (['jpeg'].includes(ext)) iconFile = 'jpeg.png';
  else if (['png'].includes(ext)) iconFile = 'png.png';
  else if (['gif', 'webp'].includes(ext)) iconFile = 'question-mark.png';
  else if (['mp4'].includes(ext)) iconFile = 'mp4.png';
  else if (['mov'].includes(ext)) iconFile = 'mov.png';
  else if (['webm', 'avi', 'mkv'].includes(ext)) iconFile = 'question-mark.png';
  
  return `<img src="png/icon/${iconFile}" alt="${ext}" class="file-icon">`;
}
async function loadClaims() {
  const q = new URLSearchParams();
  if ($("fTerm").value) q.set("term", $("fTerm").value);
  if ($("fStatus").value) q.set("status", $("fStatus").value);
  
  try {
    const rows = await api("/claims?" + q);
    globalClaims = rows;

    $("claimRows").innerHTML = rows.length
      ? rows
          .map((c) => {
            let fileLinks = "-";
            // เช็คว่าคำขอนี้มีไฟล์แนบหรือไม่
            if (c.attachments && c.attachments.length > 0) {
              fileLinks = c.attachments
                .map((key) => {
                  const realName = getRealFileName(key); // ดึงชื่อไฟล์จริง
                  const iconTag = getFileIcon(realName); // เอาแท็ก <img> รูปไอคอนมา
                  
                  // ย่อชื่อไฟล์ถ้ามันยาวไป ป้องกันตารางล้น
                  const shortName = realName.length > 20 
                                    ? realName.substring(0, 15) + "..." + realName.split('.').pop() 
                                    : realName;

                  return `<a href="#" onclick="openFile('${key}'); return false;" 
                             style="display:flex; align-items:center; font-size:0.9em; margin-bottom:4px; text-decoration:none; color:#333;" 
                             title="${realName}">
                            ${iconTag} <span>${shortName}</span>
                          </a>`;
                })
                .join("");
            }
            let actionBtn = "-";
            if (c.status === "DRAFT") {
              actionBtn = `
                <button onclick="editClaim('${c.claimId}')" style="background:none; border:none; cursor:pointer; font-size:1.2em; margin-right:8px;" title="แก้ไขแบบร่าง">✏️</button>
                <button onclick="deleteClaim('${c.claimId}')" style="background:none; border:none; cursor:pointer; color:red; font-size:1.2em;" title="ลบแบบร่าง">🗑️</button>
              `;
            }
            return `<tr>
              <td>${c.claimId.slice(0, 8)}</td>
              <td>${c.claimantName}</td>
              <td>${c.typeName}</td>
              <td>${c.course}</td>
              <td>${c.term}</td>
              <td>${c.hours}</td>
              <td class="rate">${baht(c.amount)}</td>
              <td><span class="status ${c.status}">${STATUS[c.status] || c.status}</span></td>
              <td>${fileLinks}</td>
              <td>${actionBtn}</td>
            </tr>`;
          })
          .join("")
      : '<tr><td colspan="9">ยังไม่มีคำขอ เริ่มสร้างคำขอแรกจากแบบฟอร์มด้านบน</td></tr>';
  } catch (e) {
    $("claimRows").innerHTML = `<tr><td colspan="10">โหลดข้อมูลไม่ได้: ${e.message}</td></tr>`;
  }
}
// ---------- เปิดไฟล์แนบ ----------
async function openFile(fileKey) {
  try {
    // 1. ยิงไปขอ Pre-signed URL สำหรับอ่านไฟล์จาก Backend
    const res = await api("/get-download-url", {
      method: "POST",
      body: JSON.stringify({ fileKey: fileKey })
    });

    // 2. ถ้าได้ URL มาแล้ว ให้เปิดแท็บใหม่
    if (res.downloadURL) {
      window.open(res.downloadURL, "_blank");
    }
  } catch (e) {
    alert("ไม่สามารถเปิดไฟล์ได้: " + e.message);
  }
}

$("typeSelect").addEventListener("change", preview);
$("hours").addEventListener("input", preview);
$("btnDraft").addEventListener("click", () => submitClaim("DRAFT"));
$("btnSubmit").addEventListener("click", () => submitClaim("SUBMITTED"));
$("fTerm").addEventListener("change", loadClaims);
$("fStatus").addEventListener("change", loadClaims);

loadTypes();
loadClaims();
//---------- การจัดการไฟล์แนบ (เอกสาร, รูปภาพ, วิดีโอ) ----------
const MAX_FILES = 5;
const MAX_SIZE = 100 * 1024 * 1024; // 100MB
const ALLOWED = [
  'pdf','doc','docx','xls','xlsx','ppt','pptx','txt','csv',
  'jpg','jpeg','png','gif','webp',
  'mp4','mov','webm','avi','mkv'
];

const input = document.getElementById('file');
const list = document.getElementById('fileList');
const errBox = document.getElementById('error');
let files = [];

document.getElementById('addBtn').onclick = () => input.click();

input.addEventListener('change', () => {
  const errors = [];

  for (const f of input.files) {
    const ext = f.name.split('.').pop().toLowerCase();

    if (files.length >= MAX_FILES) {
      errors.push(`เพิ่ม "${f.name}" ไม่ได้: ครบ ${MAX_FILES} ไฟล์แล้ว`);
    } else if (!ALLOWED.includes(ext)) {
      errors.push(`เพิ่ม "${f.name}" ไม่ได้: ไม่รองรับไฟล์ประเภท .${ext}`);
    } else if (f.size > MAX_SIZE) {
      errors.push(`เพิ่ม "${f.name}" ไม่ได้: ขนาด ${formatSize(f.size)} เกิน 100MB`);
    } else if (files.some(x => x.name === f.name && x.size === f.size && x.lastModified === f.lastModified)) {
      errors.push(`เพิ่ม "${f.name}" ไม่ได้: เลือกไฟล์นี้ไปแล้ว`);
    } else {
      files.push(f);
    }
  }

  errBox.innerHTML = errors.join('<br>');
  input.value = ''; // เคลียร์ เพื่อให้เลือกไฟล์เดิมซ้ำได้หลังลบ
  render();
});

function render() {
  list.innerHTML = '';
  files.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.innerHTML = `<span>${escapeHtml(f.name)} <small class="file-size">(${formatSize(f.size)})</small></span>`;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn-remove';
    del.textContent = '✕';
    del.title = 'ลบไฟล์';
    del.setAttribute('aria-label', `ลบไฟล์ ${f.name}`);
    del.onclick = () => {
      files.splice(i, 1);
      errBox.textContent = '';
      render();
    };

    li.appendChild(del);
    list.appendChild(li);
  });

  const dt = new DataTransfer();
  files.forEach(f => dt.items.add(f));
  input.files = dt.files;
}

function formatSize(b) {
  return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderExistingFiles() {
  if (!existingList) return;
  existingList.innerHTML = '';
  
  existingAttachments.forEach((key, i) => {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.style.backgroundColor = '#f0f8ff'; // ทำสีพื้นหลังให้ต่างจากไฟล์ใหม่นิดนึง จะได้แยกออก
    li.innerHTML = `<span>📎 ${getRealFileName(key)} <small>(ไฟล์เดิม)</small></span>`;

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn-remove';
    del.textContent = '✕';
    del.title = 'ลบไฟล์นี้';
    del.onclick = () => {
      // ตัดไฟล์นี้ออกจาก array
      existingAttachments.splice(i, 1);
      renderExistingFiles(); // วาดใหม่
    };

    li.appendChild(del);
    existingList.appendChild(li);
  });
}

//Edit
function editClaim(claimId) {
  const claim = globalClaims.find(c => c.claimId === claimId);
  if (!claim) return;

  if (claim.status !== "DRAFT") {
    alert("แก้ไขได้เฉพาะคำขอที่เป็นแบบร่างเท่านั้นครับ!");
    return;
  }

  currentEditClaimId = claimId;
  existingAttachments = claim.attachments || [];
  renderExistingFiles();
  // เอาข้อมูลมาใส่ฟอร์มให้ตรงกับ id ในหน้าเว็บ
  $("name").value = claim.claimantName;
  $("role").value = claim.role;
  $("typeSelect").value = claim.typeId;
  $("course").value = claim.course;
  $("term").value = claim.term;
  $("date").value = claim.date;
  $("hours").value = claim.hours;

  // เลื่อนหน้าจอไปที่ส่วนของ id="claim" แบบนุ่มนวล
  const claimSection = document.getElementById("claim");
  if (claimSection) {
    claimSection.scrollIntoView({ behavior: "smooth" });
  }
}
//Delete
async function deleteClaim(claimId) {
  if (!confirm("คุณแน่ใจหรือไม่ว่าต้องการลบคำขอแบบร่างนี้ทิ้ง?")) return;

  try {
    await api("/claims", {
      method: "DELETE",
      body: JSON.stringify({ claimId: claimId })
    });
    // โหลดข้อมูลตารางใหม่ทันทีที่ลบเสร็จ
    loadClaims(); 
  } catch (e) {
    alert("ไม่สามารถลบข้อมูลได้: " + e.message);
  }
}