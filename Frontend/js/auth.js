// ตั้งค่าจาก Cognito (User Pool > App integration)
const AUTH = {
  domain: "https://cs361-claim-g13.auth.us-east-1.amazoncognito.com",
  clientId: "5qljmkmpa1o4kb0sl1c1u129fa",
  redirect: location.origin + location.pathname, // ต้องตรงกับ Callback URL ใน App client (ต้องเป็น HTTPS)
};

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function login() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  sessionStorage.setItem("pkce", verifier);
  location.href =
    `${AUTH.domain}/oauth2/authorize?response_type=code&client_id=${AUTH.clientId}` +
    `&redirect_uri=${encodeURIComponent(AUTH.redirect)}&scope=openid+email&code_challenge_method=S256&code_challenge=${challenge}`;
}

function logout() {
  sessionStorage.clear();
  location.href = `${AUTH.domain}/logout?client_id=${AUTH.clientId}&logout_uri=${encodeURIComponent(AUTH.redirect)}`;
}

async function handleCallback() {
  const code = new URLSearchParams(location.search).get("code");
  if (!code) return;
  const res = await fetch(`${AUTH.domain}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: AUTH.clientId,
      code,
      redirect_uri: AUTH.redirect,
      code_verifier: sessionStorage.getItem("pkce") || "",
    }),
  });
  if (res.ok) sessionStorage.setItem("id_token", (await res.json()).id_token);
  history.replaceState({}, "", AUTH.redirect); // ลบ ?code= ออกจาก URL
}

// ข้อมูลผู้ใช้จาก token (ใช้แสดงผลเท่านั้น ห้ามใช้ตัดสินสิทธิ์จริง)
function currentUser() {
  const t = sessionStorage.getItem("id_token");
  if (!t) return null;
  try {
    const p = JSON.parse(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (p.exp * 1000 < Date.now()) { sessionStorage.removeItem("id_token"); return null; }
    return { sub: p.sub, email: p.email, groups: p["cognito:groups"] || [] };
  } catch { return null; }
}

let ME = null;
const hasRole = (...r) => !!ME && r.some((x) => ME.groups.includes(x));

// แสดง/ซ่อนส่วนของหน้าตามกลุ่ม (เพื่อความสะดวกของผู้ใช้ — การบังคับสิทธิ์จริงอยู่ที่ Lambda)
function applyRoles() {
  document.querySelectorAll("[data-roles]").forEach((el) => {
    el.hidden = !hasRole(...el.dataset.roles.split(" "));
  });
  const box = document.getElementById("userBox");
  box.innerHTML = ME
    ? `<span>${ME.email} (${ME.groups.join(", ") || "ไม่มีกลุ่ม"})</span> <button class="btn ghost small" onclick="logout()">ออกจากระบบ</button>`
    : `<button class="btn small" onclick="login()">เข้าสู่ระบบ</button>`;
}

(async () => {
  await handleCallback();
  ME = currentUser();
  applyRoles();
  document.dispatchEvent(new Event("auth-ready"));
})();