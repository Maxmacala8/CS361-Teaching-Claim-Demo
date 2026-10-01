// ใส่ URL ของ API Gateway (Invoke URL) ที่นี่ เช่น https://abc123.execute-api.ap-southeast-1.amazonaws.com
const API = "https://YOUR_API_ID.execute-api.ap-southeast-1.amazonaws.com";

const $ = (id) => document.getElementById(id);
let types = [];

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
  try {
    const body = {
      status,
      claimantName: $("name").value.trim(),
      role: $("role").value,
      typeId: $("typeSelect").value,
      course: $("course").value.trim(),
      term: $("term").value,
      date: $("date").value,
      hours: Number($("hours").value),
    };
    const claim = await api("/claims", { method: "POST", body: JSON.stringify(body) });
    msg.textContent = `บันทึกแล้ว (รหัส ${claim.claimId}) ยอด ${baht(claim.amount)}`;
    msg.classList.add("ok");
    loadClaims();
  } catch (e) {
    msg.textContent = e.message;
    msg.classList.add("err");
  }
}

// ---------- รายการคำขอ + กรอง ----------
const STATUS = { DRAFT: "ร่าง", SUBMITTED: "ยื่นแล้ว" };

async function loadClaims() {
  const q = new URLSearchParams();
  if ($("fTerm").value) q.set("term", $("fTerm").value);
  if ($("fStatus").value) q.set("status", $("fStatus").value);
  try {
    const rows = await api("/claims?" + q);
    $("claimRows").innerHTML = rows.length
      ? rows
          .map(
            (c) => `<tr><td>${c.claimId.slice(0, 8)}</td><td>${c.claimantName}</td>
          <td>${c.typeName}</td><td>${c.course}</td><td>${c.term}</td>
          <td>${c.hours}</td><td class="rate">${baht(c.amount)}</td>
          <td><span class="status ${c.status}">${STATUS[c.status] || c.status}</span></td></tr>`
          )
          .join("")
      : '<tr><td colspan="8">ยังไม่มีคำขอ เริ่มสร้างคำขอแรกจากแบบฟอร์มด้านบน</td></tr>';
  } catch (e) {
    $("claimRows").innerHTML = `<tr><td colspan="8">โหลดข้อมูลไม่ได้: ${e.message}</td></tr>`;
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