// โหลดหลัง app.js และ auth.js — ใช้ $, api, baht จาก app.js
const REVIEW = {
  SUBMITTED: { role: "Officer", actions: [["VERIFY", "ตรวจผ่าน"], ["RETURN", "ส่งกลับ"]] },
  VERIFIED: { role: "Approver", actions: [["APPROVE", "อนุมัติ"], ["REJECT", "ไม่อนุมัติ"], ["RETURN", "ส่งกลับ"]] },
};
const NEED_REASON = ["RETURN", "REJECT"];
const ACTION_TH = { SUBMIT: "ยื่นคำขอ", VERIFY: "ตรวจผ่าน", APPROVE: "อนุมัติ", REJECT: "ไม่อนุมัติ", RETURN: "ส่งกลับ" };

async function loadReview() {
  if (!hasRole("Officer", "Approver")) return;
  const status = hasRole("Officer") ? "SUBMITTED" : "VERIFIED"; // Officer+Approver พร้อมกัน: ดูคิวตรวจก่อน
  try {
    const rows = await api("/claims?status=" + status);
    const acts = REVIEW[status].actions;
    $("reviewRows").innerHTML = rows.length
      ? rows.map((c) => `<tr>
          <td>${c.claimId.slice(0, 8)}</td><td>${c.claimantName}</td><td>${c.typeName}</td>
          <td>${c.course} (${c.term})</td><td>${c.hours}</td><td class="rate">${baht(c.amount)}</td>
          <td>${acts.map(([a, t]) => `<button class="btn small ${a === "APPROVE" || a === "VERIFY" ? "" : "ghost"}"
                onclick="doAction('${c.claimId}','${a}')">${t}</button>`).join(" ")}
              <button class="btn small ghost" onclick="showHistory('${c.claimId}')">ประวัติ</button></td></tr>`).join("")
      : '<tr><td colspan="7">ไม่มีคำขอรอดำเนินการ</td></tr>';
  } catch (e) {
    $("reviewRows").innerHTML = `<tr><td colspan="7">โหลดข้อมูลไม่ได้: ${e.message}</td></tr>`;
  }
}

async function doAction(claimId, action) {
  let comment = "";
  if (NEED_REASON.includes(action)) {
    comment = prompt("ระบุเหตุผล (จำเป็น)") || "";
    if (!comment.trim()) return;
  }
  try {
    await api(`/claims/${claimId}/action`, { method: "POST", body: JSON.stringify({ action, comment }) });
    loadReview();
    loadClaims();
  } catch (e) {
    alert(e.message);
  }
}

async function showHistory(claimId) {
  try {
    const rows = await api(`/claims/${claimId}/history`);
    $("histBody").innerHTML = rows.length
      ? rows.map((h) => `<li><strong>${ACTION_TH[h.action] || h.action}</strong> โดย ${h.actorName}
          <small>(${new Date(h.at).toLocaleString("th-TH")})</small>${h.comment ? `<br>เหตุผล: ${escapeHtml(h.comment)}` : ""}</li>`).join("")
      : "<li>ยังไม่มีประวัติ</li>";
    $("histDlg").showModal();
  } catch (e) {
    alert(e.message);
  }
}

document.addEventListener("auth-ready", () => {
  if (ME) { loadClaims(); loadReview(); }
});