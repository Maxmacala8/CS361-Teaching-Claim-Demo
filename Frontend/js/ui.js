// ui.js — ส่วนแสดงผลแดชบอร์ด (เพิ่มเติมเท่านั้น)
// - อ่านข้อมูลจาก globalClaims ที่ app.js โหลดไว้แล้ว ไม่เรียก API เอง ไม่แก้ข้อมูลใด ๆ
// - ใช้ textContent ทั้งหมด (ไม่ใช้ innerHTML กับข้อมูลจากผู้ใช้)
// - ถ้าไฟล์นี้ error หรือถูกลบ ส่วนอื่นของระบบ (ยื่นคำขอ ตรวจสอบ อนุมัติ ประวัติ) ยังทำงานปกติ
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const COUNTED = ["SUBMITTED", "VERIFIED", "APPROVED", "PAID"];   // นับเป็นยอดคำขอที่ยื่นแล้ว
  const PENDING = ["SUBMITTED", "VERIFIED", "APPROVED"];           // กำลังดำเนินการ (ยังไม่จ่าย)
  const STATUS_ORDER = ["DRAFT", "SUBMITTED", "VERIFIED", "APPROVED", "PAID", "RETURNED", "REJECTED"];
  const STATUS_TH = {
    DRAFT: "ร่าง", SUBMITTED: "ยื่นแล้ว", VERIFIED: "ตรวจแล้ว", APPROVED: "อนุมัติ (รอจ่าย)",
    PAID: "จ่ายแล้ว", RETURNED: "ส่งกลับแก้ไข", REJECTED: "ไม่อนุมัติ",
  };
  const MON_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
  const MON_FULL = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];

  const fmt = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const setText = (id, t) => { const el = $(id); if (el) el.textContent = t; };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  function getClaims() {
    return typeof globalClaims !== "undefined" && Array.isArray(globalClaims) ? globalClaims : [];
  }

  function amountNode(value, cls) {                  // ฿1,234 + ทศนิยมสีจาง
    const [int, dec] = fmt(value).split(".");
    const p = el("p", cls);
    p.append("฿" + int);
    p.append(el("span", "dec", "." + dec));
    return p;
  }

  /* ---------- ชื่อผู้ใช้ ---------- */
  function renderGreeting() {
    const email = typeof ME !== "undefined" && ME ? ME.email || "" : "";
    setText("dashName", email ? email.split("@")[0] : "ผู้ใช้");
  }

  /* ---------- กราฟรายเดือน ---------- */
  function niceMax(v) {
    if (v <= 0) return 1000;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 4 : n <= 8 ? 8 : 10;   // หารสี่ส่วนลงตัว
    return m * p;
  }
  const short = (v) => (v >= 1000 ? String(Math.round((v / 1000) * 100) / 100) + "k" : String(Math.round(v)));

  function yearsOf(items) {
    const ys = new Set();
    items.forEach((c) => { const y = String(c.date || "").slice(0, 4); if (/^\d{4}$/.test(y)) ys.add(y); });
    return [...ys].sort().reverse();
  }

  function syncYearSelect(years) {
    const sel = $("chartYear");
    if (!sel) return null;
    const cur = sel.value;
    const list = years.length ? years : [String(new Date().getFullYear())];
    const key = list.join(",");
    if (sel.dataset.years !== key) {
      sel.textContent = "";
      list.forEach((y) => { const o = el("option", "", String(Number(y) + 543)); o.value = y; sel.append(o); });
      sel.dataset.years = key;
      sel.value = list.includes(cur) ? cur : list[0];
    }
    return sel.value;
  }

  function renderChart(counted, year) {
    const plot = $("chartPlot"), months = $("chartMonths");
    if (!plot || !months) return;
    const sums = Array(12).fill(0), counts = Array(12).fill(0);
    counted.forEach((c) => {
      const d = String(c.date || "");
      if (!d.startsWith(year + "-")) return;
      const m = Number(d.slice(5, 7)) - 1;
      if (m >= 0 && m < 12) { sums[m] += Number(c.amount) || 0; counts[m]++; }
    });
    const top = niceMax(Math.max(...sums));

    plot.textContent = "";
    for (let i = 0; i <= 4; i++) {                       // เส้นกริด + ตัวเลขแกน
      const g = el("div", "gridline");
      g.style.bottom = (i * 25) + "%";
      g.append(el("span", "", short((top * i) / 4)));
      plot.append(g);
    }
    const bars = el("div", "bars");
    sums.forEach((v, m) => {
      const col = el("div", "col");
      const bar = el("button", "bar" + (v ? "" : " empty"));
      bar.type = "button";
      bar.style.height = v ? Math.max((v / top) * 100, 2) + "%" : "3px";
      const label = `${MON_FULL[m]} ${Number(year) + 543}: ฿${fmt(v)} (${counts[m]} คำขอ)`;
      bar.setAttribute("aria-label", label);
      const tip = el("span", "tip");
      tip.append(el("strong", "", "฿" + fmt(v)));
      tip.append(`${MON_FULL[m]} ${Number(year) + 543} · ${counts[m]} คำขอ`);
      bar.append(tip);
      col.append(bar);
      bars.append(col);
    });
    plot.append(bars);

    if (!months.childElementCount) MON_SHORT.forEach((m) => months.append(el("span", "", m)));
    setText("chartEmpty", counted.length ? "" : "ยังไม่มีคำขอที่ยื่นแล้วในรายการนี้");
  }

  /* ---------- สถานะ + ประเภท ---------- */
  function renderStatus(all) {
    const list = $("statusList");
    if (!list) return;
    const n = {};
    all.forEach((c) => { n[c.status] = (n[c.status] || 0) + 1; });
    list.textContent = "";
    STATUS_ORDER.filter((s) => n[s]).forEach((s) => {
      const li = el("li");
      li.append(el("span", "", STATUS_TH[s]));
      li.append(el("b", "", String(n[s])));
      list.append(li);
    });
    if (!list.childElementCount) list.append(el("li", "", "ยังไม่มีคำขอ"));
    setText("pendingCount", String(all.filter((c) => PENDING.includes(c.status)).length));
  }

  function renderTypes(counted) {
    const box = $("typeCards");
    if (!box) return;
    const by = new Map();
    counted.forEach((c) => {
      const k = String(c.typeName || c.typeId || "-");
      const cur = by.get(k) || { amount: 0, n: 0 };
      cur.amount += Number(c.amount) || 0; cur.n++;
      by.set(k, cur);
    });
    box.textContent = "";
    [...by.entries()].sort((a, b) => b[1].amount - a[1].amount).slice(0, 4).forEach(([name, v]) => {
      const card = el("article", "mini");
      card.append(el("h3", "", name));
      card.append(amountNode(v.amount, "amt"));
      card.append(el("p", "meta", `${v.n} คำขอ`));
      box.append(card);
    });
    if (!box.childElementCount) box.append(el("p", "type-empty", "ยังไม่มีคำขอที่ยื่นแล้วให้สรุปตามประเภท"));
  }

  /* ---------- รวม ---------- */
  function render() {
    const dash = $("dashboard");
    if (!dash || dash.hidden) return;
    const all = getClaims();
    const counted = all.filter((c) => COUNTED.includes(c.status));
    const total = counted.reduce((s, c) => s + (Number(c.amount) || 0), 0);
    const [int, dec] = fmt(total).split(".");
    setText("kpiInt", int);
    setText("kpiDec", "." + dec);
    setText("kpiCount", `${counted.length} คำขอที่ยื่นแล้ว`);
    renderStatus(all);
    renderTypes(counted);
    const year = syncYearSelect(yearsOf(counted.length ? counted : all));
    if (year) renderChart(counted, year);
  }

  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; try { render(); } catch (e) { console.warn("ui.js:", e); } });
  };

  /* ---------- เมนูแคปซูล: ไฮไลต์ส่วนที่กำลังดู ---------- */
  function setupSpy() {
    const links = [...document.querySelectorAll(".pill-nav a[href^='#']")];
    const map = new Map(links.map((a) => [a.getAttribute("href").slice(1), a]));
    const targets = [...map.keys()].map($).filter(Boolean);
    if (!("IntersectionObserver" in window) || !targets.length) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        links.forEach((a) => { a.classList.remove("active"); a.removeAttribute("aria-current"); });
        const a = map.get(e.target.id);
        if (a) { a.classList.add("active"); a.setAttribute("aria-current", "true"); }
      });
    }, { rootMargin: "-25% 0px -65% 0px" });
    targets.forEach((t) => io.observe(t));
  }

  function init() {
    try {
      setupSpy();
      const rows = $("claimRows");
      if (rows) new MutationObserver(schedule).observe(rows, { childList: true });
      const sel = $("chartYear");
      if (sel) sel.addEventListener("change", schedule);
    } catch (e) { console.warn("ui.js init:", e); }
  }

  document.addEventListener("auth-ready", () => { try { renderGreeting(); schedule(); } catch (e) { console.warn("ui.js:", e); } });

  document.addEventListener("bank-updated", (e) => {      // app.js ส่งอีเวนต์นี้หลังโหลด/บันทึกบัญชี
    try {
      const b = e.detail;
      const ok = !!(b && b.registered);
      setText("dashBankCode", ok ? b.bankCode : "ยังไม่ได้บันทึกบัญชีรับเงิน");
      setText("dashBankMask", ok ? b.accountMask : "—");
      setText("dashBankName", ok ? b.accountName : "เพิ่มบัญชีได้ที่เมนู บัญชีรับเงิน");
    } catch (err) { console.warn("ui.js:", err); }
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
