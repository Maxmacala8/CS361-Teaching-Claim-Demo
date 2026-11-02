// โหลดหลัง app.js และ auth.js — ใช้ $, api, baht, escapeHtml จาก app.js 
const REVIEW = {
  SUBMITTED: { role: "Officer", actions: [["VERIFY", "ตรวจผ่าน"], ["RETURN", "ส่งกลับ"]] }, 
  VERIFIED: { role: "Approver", actions: [["APPROVE", "อนุมัติ"], ["REJECT", "ไม่อนุมัติ"], ["RETURN", "ส่งกลับ"]] }, 
};
const NEED_REASON = ["RETURN", "REJECT"]; 
const ACTION_TH = { 
  SUBMIT: "ยื่นคำขอ", SAVE_DRAFT: "บันทึกร่าง", DELETE: "ลบคำขอ", 
  VERIFY: "ตรวจผ่าน", APPROVE: "อนุมัติ", REJECT: "ไม่อนุมัติ", RETURN: "ส่งกลับ" 
}; 

let rawReviewClaims = [];

async function loadReview() {
  if (!hasRole("Officer", "Approver")) return;
  const status = hasRole("Officer") ? "SUBMITTED" : "VERIFIED"; 
  try {
    rawReviewClaims = await api("/claims?status=" + status);
    
    // สกัดตัวเลือกประเภท / ภาค / Role ใส่ Dynamic Filter
    if (typeof buildFilterMastersFromData === "function") {
      buildFilterMastersFromData(rawReviewClaims);
    }
    
    applyReviewFilters();
  } catch (e) {
    if ($("reviewRows")) {
      $("reviewRows").innerHTML = `<tr><td colspan="9">โหลดข้อมูลไม่ได้: ${escapeHtml(e.message)}</td></tr>`; 
    }
  }
}

function applyReviewFilters() {
  const status = hasRole("Officer") ? "SUBMITTED" : "VERIFIED";
  const acts = REVIEW[status]?.actions || [];

  const container = $("activeFilters");
  let filtered = [...rawReviewClaims];

  if (container) {
    const filterElements = container.querySelectorAll(".filter-chip");
    
    const selectedTypes = [];
    const selectedTerms = [];
    const selectedRoles = [];
    const selectedDateRanges = [];

    // 1. อ่านค่าและจัดกลุ่มตามหมวดหมู่ตัวกรอง
    filterElements.forEach((el) => {
      const type = el.dataset.type;
      if (type === "type") {
        const val = el.querySelector(".f-val")?.value;
        if (val) selectedTypes.push(val);
      } else if (type === "term") {
        const val = el.querySelector(".f-val")?.value;
        if (val) selectedTerms.push(val);
      } else if (type === "role") {
        const val = el.querySelector(".f-val")?.value;
        if (val) selectedRoles.push(val);
      } else if (type === "dateRange") {
        const from = el.querySelector(".f-date-from")?.value;
        const to = el.querySelector(".f-date-to")?.value;
        if (from || to) selectedDateRanges.push({ from, to });
      }
    });

    // 2. กรองข้อมูล: OR ในหมวดเดียวกัน + AND ข้ามหมวดหมู่
    filtered = rawReviewClaims.filter((c) => {
      // หมวดประเภทคำขอ (OR ในหมวด)
      const matchType = selectedTypes.length === 0 || selectedTypes.includes(String(c.typeId));

      // หมวดภาคการศึกษา (OR ในหมวด)
      const matchTerm = selectedTerms.length === 0 || selectedTerms.includes(c.term);

      // หมวดบทบาทผู้ขอ (OR ในหมวด)
      const matchRole = selectedRoles.length === 0 || selectedRoles.includes(c.role);

      // หมวดช่วงวันที่จาก createdAt (OR ในหมวด)
      const itemCreatedDate = c.createdAt ? String(c.createdAt).slice(0, 10) : "";
      const matchDate = selectedDateRanges.length === 0 || (
        Boolean(itemCreatedDate) && selectedDateRanges.some((df) => {
          const afterFrom = !df.from || itemCreatedDate >= df.from;
          const beforeTo = !df.to || itemCreatedDate <= df.to;
          return afterFrom && beforeTo;
        })
      );

      // ต้องผ่านเงื่อนไขครบทุกหมวดหมู่ (AND ข้ามหมวด)
      return matchType && matchTerm && matchRole && matchDate;
    });
  }

  const tbody = $("reviewRows");
  if (!tbody) return;

  tbody.innerHTML = filtered.length
    ? filtered.map((c) => {
        const fileLinks = (c.attachments || []).map((key) => {
          const name = typeof getRealFileName === "function" ? getRealFileName(key) : key.split("/").pop();
          const short = name.length > 15 ? name.slice(0, 12) + "..." + name.split(".").pop() : name;
          const iconHtml = typeof getFileIcon === "function" ? getFileIcon(name) : "📎 ";
          return `<a href="#" class="file-link" onclick="openFile('${c.claimId}', '${escapeHtml(key)}'); return false;" title="${escapeHtml(name)}">
            ${iconHtml}<span>${escapeHtml(short)}</span></a>`;
        }).join("") || "-";

        const btnActions = acts.map(([a, t]) => 
          `<button class="btn small ${a === "APPROVE" || a === "VERIFY" ? "" : "ghost"}"
            onclick="doAction('${c.claimId}','${a}')">${t}</button>`
        ).join(" ");

        return `<tr>
          <td>${escapeHtml(c.claimId.slice(0, 8))}</td>
          <td>${escapeHtml(c.claimantName)} <small>(${escapeHtml(c.role || "")})</small></td>
          <td>${escapeHtml(c.typeName)}</td>
          <td>${escapeHtml(c.course)}</td>
          <td>${escapeHtml(c.term)}</td>
          <td>${c.hours}</td>
          <td class="rate">${baht(c.amount)}</td>
          <td>${fileLinks}</td>
          <td>
            ${btnActions}
            <button class="btn small ghost" onclick="showHistory('${c.claimId}')">ประวัติ</button>
          </td>
        </tr>`;
      }).join("")
    : '<tr><td colspan="9" style="text-align:center;">ไม่มีคำขอรอดำเนินการ</td></tr>';
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
    if (typeof loadClaims === "function") loadClaims(); 
  } catch (e) {
    alert(e.message); 
  }
}

async function showHistory(claimId) {
  try {
    const rows = await api(`/claims/${claimId}/history`); 
    $("histBody").innerHTML = rows.length
      ? rows.map((h) => `<li><strong>${escapeHtml(ACTION_TH[h.action] || h.action)}</strong> โดย ${escapeHtml(h.actorName)}
          <small>(${new Date(h.at).toLocaleString("th-TH")})</small>${h.comment ? `<br>เหตุผล: ${escapeHtml(h.comment)}` : ""}</li>`).join("") 
      : "<li>ยังไม่มีประวัติ</li>"; 
    $("histDlg").showModal(); 
  } catch (e) {
    alert(e.message); 
  }
}

document.addEventListener("auth-ready", () => {
  if (ME) { 
    if (typeof loadClaims === "function") loadClaims(); 
    loadReview(); 
  }
});