// V3 / Project 6 — รายวิชา (สรุปรอบเบิก), นักศึกษาช่วยงาน, รีเซ็ตข้อมูลทดสอบ
// โหลดหลัง auth.js และ app.js — ใช้ $, api, baht, escapeHtml, hasRole, ME
const SEED_COURSE = "CS361-SP-1-2569";
const STATE_TH = { PAID: "จ่ายแล้ว", PENDING: "ยื่นแล้ว รอจ่าย", UNCLAIMED: "ยังไม่ยื่น" };
const ASSIST_TH = {
  RECORDED: "กรอกแล้ว", VERIFIED: "อาจารย์รับรองแล้ว", DOC_ISSUED: "ออกเอกสารให้ลงนามแล้ว",
  SIGNED_DOCS_RECEIVED: "บันทึกการรับหลักฐานแล้ว",
};
const thDate = (d) => new Date(d + "T00:00:00").toLocaleDateString("th-TH", { day: "numeric", month: "short" });

// ---------- สรุปรายวิชาตามรอบ ----------
async function loadCourseSummary() {
  const box = $("courseBox");
  const id = $("courseId").value.trim() || SEED_COURSE;
  const round = $("courseRound").value;
  box.innerHTML = "<p>กำลังโหลด...</p>";
  try {
    const s = await api(`/courses/${encodeURIComponent(id)}/summary?round=${encodeURIComponent(round)}`);
    const t = s.totals;
    const rows = s.sessions.map((r) => `<tr><td>${thDate(r.date)}</td><td>${r.hours}</td>
        <td><span class="status ${r.state === "PAID" ? "PAID" : r.state === "PENDING" ? "SUBMITTED" : ""}">${STATE_TH[r.state]}</span></td>
        <td>${escapeHtml(r.claimId || "-")}</td></tr>`).join("");
    const paid = s.paidClaims.map((c) => `<tr><td>${escapeHtml(c.claimId)}</td><td>${c.sessions.map(thDate).join(", ")}</td>
        <td>${c.hours}</td><td class="rate">${baht(c.amount)}</td>
        <td>${c.bank ? `${escapeHtml(c.bank.bankCode)} • ${escapeHtml(c.bank.accountMask)}` : "ยังไม่บันทึกบัญชี"}</td>
        <td>${c.paidAt ? new Date(c.paidAt).toLocaleDateString("th-TH") : "-"}</td></tr>`).join("");
    box.innerHTML = `
      <p><strong>${escapeHtml(s.course.code)} ${escapeHtml(s.course.name)}</strong> ${escapeHtml(s.course.section || "")} ${escapeHtml(s.course.term)}
        • ผู้สอน ${escapeHtml(s.course.ownerUsername)} • รอบ ${escapeHtml(s.round || "ทั้งหมด")}</p>
      <div class="type-grid">
        <article class="type-card"><span class="type-tag">ตามตาราง</span><h3>${t.scheduled} ชม.</h3></article>
        <article class="type-card"><span class="type-tag">จ่ายแล้ว</span><h3>${t.paid} ชม.</h3></article>
        <article class="type-card"><span class="type-tag">ยื่นแล้ว รอจ่าย</span><h3>${t.pending} ชม.</h3></article>
        <article class="type-card"><span class="type-tag">ยังไม่ยื่น</span><h3>${t.unclaimed} ชม.</h3></article>
      </div>
      <p class="section-lede">${t.scheduled} = ${t.paid} + ${t.pending} + ${t.unclaimed} (คาบหนึ่งนับครั้งเดียว ไม่รวมคาบของรอบอื่น)</p>
      <div class="table-card"><table>
        <thead><tr><th>คาบสอน</th><th>ชม.</th><th>สถานะ</th><th>คำขอ</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4">ไม่มีคาบสอนในรอบนี้</td></tr>'}</tbody></table></div>
      <h3>รายการที่จ่ายแล้ว</h3>
      <div class="table-card"><table>
        <thead><tr><th>คำขอ</th><th>คาบ</th><th>ชม.</th><th>ยอด</th><th>บัญชีปลายทาง (ปกปิด)</th><th>วันที่จ่าย</th></tr></thead>
        <tbody>${paid || '<tr><td colspan="6">ยังไม่มีรายการจ่าย</td></tr>'}</tbody></table></div>`;
  } catch (e) {
    box.innerHTML = `<p class="msg err">โหลดข้อมูลไม่ได้: ${escapeHtml(e.message)}</p>`;
  }
}

// ---------- นักศึกษาช่วยงาน ----------
async function loadAssist() {
  try {
    const rows = await api("/assistant-hours");
    $("assistRows").innerHTML = rows.length ? rows.map(assistRow).join("") : '<tr><td colspan="8">ไม่มีรายการ</td></tr>';
  } catch (e) {
    $("assistRows").innerHTML = `<tr><td colspan="8">โหลดข้อมูลไม่ได้: ${escapeHtml(e.message)}</td></tr>`;
  }
}

function assistRow(r) {
  const btn = (act, label, ghost = true) =>
    `<button class="btn small ${ghost ? "ghost" : ""}" data-aact="${act}" data-id="${escapeHtml(r.recordId)}">${label}</button>`;
  const acts = [];
  if (ME && r.studentSub === ME.sub) acts.push(btn("CONFIRM", "ยืนยันชั่วโมง"));
  if (ME && r.instructorSub === ME.sub) acts.push(btn("VERIFY", "รับรองชั่วโมง", false));
  if (hasRole("Staff")) {
    acts.push(btn("ISSUE_DOC", "ออกเอกสารให้ลงนาม"));
    if (r.doc) acts.push(btn("RECEIVE_EVIDENCE", "บันทึกการรับหลักฐาน", false));
  }
  acts.push(`<button class="btn small ghost" onclick="showHistory('${escapeHtml(r.recordId)}')">ประวัติ</button>`);
  const ev = r.evidence
    ? `${escapeHtml(r.evidence.docNo)}<br><small>ผู้ลงนาม ${escapeHtml(r.evidence.signerUsername)} • รับโดย ${escapeHtml(r.evidence.receivedBy)}</small>`
    : r.doc ? `${escapeHtml(r.doc.docNo)}<br><small>รอหลักฐานลงนามจริงจาก ${escapeHtml(r.doc.signer)}</small>` : "-";
  return `<tr><td>${escapeHtml(r.studentUsername)}</td><td>${escapeHtml(r.courseId)}</td>
    <td>${r.recordedHours}</td><td>${r.verifiedHours || 0}</td><td>${r.pendingHours}</td>
    <td><span class="status">${ASSIST_TH[r.status] || escapeHtml(r.status)}</span></td><td>${ev}</td><td>${acts.join(" ")}</td></tr>`;
}

$("assistRows").addEventListener("click", async (e) => {
  const el = e.target.closest("[data-aact]");
  if (!el) return;
  const { aact, id } = el.dataset;
  const body = { action: aact };
  if (aact === "CONFIRM") {
    const h = prompt("จำนวนชั่วโมงที่ช่วยงาน (ยืนยัน)");
    if (!h) return;
    body.hours = Number(h);
  } else if (aact === "VERIFY") {
    const h = prompt("จำนวนชั่วโมงที่รับรอง (ไม่เกินชั่วโมงที่กรอก)");
    if (h === null || h === "") return;
    body.hours = Number(h);
  } else if (aact === "RECEIVE_EVIDENCE") {
    const s = prompt("ชื่อผู้ลงนามในเอกสารกระดาษ (ต้องเป็นอาจารย์เจ้าของรายวิชา)");
    if (!s) return;
    body.signerUsername = s;
    body.note = prompt("หมายเหตุหลักฐาน (เช่น เลขที่รับเอกสาร)") || "";
  }
  try {
    await api(`/assistant-hours/${encodeURIComponent(id)}/action`, { method: "POST", body: JSON.stringify(body) });
    loadAssist();
  } catch (err) {
    alert(err.message);
  }
});

// ---------- รีเซ็ตข้อมูลทดสอบ ----------
$("btnReset").addEventListener("click", async () => {
  if (!confirm("รีเซ็ตข้อมูลทดสอบ (CLAIM-601/602/603, รายวิชา CS361 ภาคพิเศษ, STU-A) กลับ baseline?")) return;
  const msg = $("resetMsg");
  msg.className = "msg";
  msg.textContent = "กำลังรีเซ็ต...";
  try {
    const r = await api("/admin/reset", { method: "POST" });
    msg.textContent = `รีเซ็ตแล้ว: ${r.claims.join(", ")}` + (r.missingOptional.length ? ` (ยังไม่มีบัญชี ${r.missingOptional.join(", ")})` : "");
    msg.classList.add("ok");
    loadClaims(); loadCourseSummary(); loadAssist();
  } catch (e) {
    msg.textContent = e.message;
    msg.classList.add("err");
  }
});

$("btnCourse").addEventListener("click", loadCourseSummary);

document.addEventListener("auth-ready", () => {
  if (!ME) return;
  if (hasRole("Teacher", "Staff", "Officer", "Approver", "Admin", "Administrators")) loadCourseSummary();
  if (hasRole("Student", "Teacher", "Staff", "Admin", "Administrators")) loadAssist();
});