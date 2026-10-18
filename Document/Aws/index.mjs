// ฟังก์ชันที่ต้องเพิ่ม/แทรกเข้า Lambda เดิมของ V2 (ตาราง ClaimHistory: PK claimId, SK at)
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const CLAIMS = process.env.CLAIMS_TABLE || "Claims";
const HISTORY = process.env.HISTORY_TABLE || "ClaimHistory";
const reply = (code, body) => ({ statusCode: code, headers: { "Content-Type": "application/json" /* + cors เดิม */ }, body: JSON.stringify(body) });

// ---------- 1) ตัวตนมาจาก token ที่ API Gateway ตรวจแล้วเท่านั้น (ไม่อ่านจาก body) ----------
export function getUser(event) {
  const c = event.requestContext?.authorizer?.jwt?.claims;
  if (!c) return null;
  let g = c["cognito:groups"] || [];
  // HTTP API ส่งกลุ่มมาเป็นสตริงเช่น "[Teacher Officer]" ต้องแปลงเอง
  if (typeof g === "string") g = g.replace(/[\[\]]/g, "").split(/[\s,]+/).filter(Boolean);
  return { sub: c.sub, name: c.email || c["cognito:username"], groups: g };
}
export const has = (u, ...gs) => gs.some((g) => u.groups.includes(g));
const STAFF = ["Officer", "Approver", "Admin"];

// ---------- 2) กันดูข้อมูลคนอื่น (BOLA): เจ้าของ หรือเจ้าหน้าที่ (เห็นเฉพาะที่ไม่ใช่ร่าง) ----------
export const canView = (u, claim) =>
  claim.ownerSub === u.sub || (has(u, ...STAFF) && claim.status !== "DRAFT");

export const filterVisible = (u, claims) => claims.filter((c) => canView(u, c));

// ใช้ใน createClaim / deleteClaim เดิม: แก้/ลบได้เฉพาะเจ้าของ และสถานะ DRAFT หรือ RETURNED
export function assertCanEdit(u, claim) {
  if (claim.ownerSub !== u.sub) return reply(404, { message: "ไม่พบคำขอ" });
  if (!["DRAFT", "RETURNED"].includes(claim.status)) return reply(409, { message: "สถานะนี้แก้ไขไม่ได้" });
  return null;
}
// ใน createClaim: ownerSub = u.sub, claimantName = u.name, role = has(u,"TA") ? "TA" : "อาจารย์"
// และอนุญาตเฉพาะ has(u,"Teacher","TA") ส่วน role ที่ส่งมาใน body ให้เมินทิ้ง

// ---------- 3) Workflow: ตารางที่อนุญาตให้เปลี่ยนสถานะ ----------
const FLOW = {
  SUBMITTED: {
    VERIFY: { to: "VERIFIED", group: "Officer" },
    RETURN: { to: "RETURNED", group: "Officer" },
  },
  VERIFIED: {
    APPROVE: { to: "APPROVED", group: "Approver" },
    REJECT: { to: "REJECTED", group: "Approver" },
    RETURN: { to: "RETURNED", group: "Approver" },
  },
};

export async function claimAction(user, claimId, body) {
  const { Item: claim } = await db.send(new GetCommand({ TableName: CLAIMS, Key: { claimId } }));
  if (!claim || !canView(user, claim)) return reply(404, { message: "ไม่พบคำขอ" });

  const rule = FLOW[claim.status]?.[body.action];
  if (!rule) return reply(409, { message: `สถานะ ${claim.status} ไม่สามารถ ${body.action} ได้` });
  if (!has(user, rule.group)) return reply(403, { message: "ไม่มีสิทธิ์ทำรายการนี้" });
  if (claim.ownerSub === user.sub) return reply(403, { message: "ห้ามตรวจ/อนุมัติคำขอของตนเอง" });
  if (["RETURN", "REJECT"].includes(body.action) && !body.comment?.trim())
    return reply(400, { message: "กรุณาระบุเหตุผล" });

  const at = new Date().toISOString();
  try {
    await db.send(new TransactWriteCommand({ TransactItems: [
      { Update: { // เงื่อนไข #s = :from กันสองคนกดพร้อมกัน
        TableName: CLAIMS, Key: { claimId },
        UpdateExpression: "SET #s = :to, updatedAt = :at",
        ConditionExpression: "#s = :from",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":to": rule.to, ":from": claim.status, ":at": at },
      } },
      { Put: { TableName: HISTORY, Item: {
        claimId, at, actorSub: user.sub, actorName: user.name,
        action: body.action, from: claim.status, to: rule.to, comment: body.comment?.trim() || "",
      } } },
    ] }));
  } catch (e) {
    if (e.name === "TransactionCanceledException") return reply(409, { message: "สถานะเปลี่ยนไปแล้ว กรุณารีเฟรช" });
    throw e;
  }
  return reply(200, { claimId, status: rule.to });
}

// บันทึกประวัติสำหรับ SUBMIT/สร้าง/แก้ไข ที่ createClaim เดิมเรียกหลัง PutCommand
export const writeHistory = (item) =>
  db.send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: HISTORY, Item: item } }] }));

export async function getHistory(user, claimId) {
  const { Item: claim } = await db.send(new GetCommand({ TableName: CLAIMS, Key: { claimId } }));
  if (!claim || !canView(user, claim)) return reply(404, { message: "ไม่พบคำขอ" });
  const { Items } = await db.send(new QueryCommand({
    TableName: HISTORY, KeyConditionExpression: "claimId = :c", ExpressionAttributeValues: { ":c": claimId } }));
  return reply(200, Items);
}

// download: ต้องส่ง claimId มาด้วย แล้วตรวจว่า fileKey อยู่ในคำขอนั้น และผู้ขอดูได้
export async function assertCanDownload(user, claimId, fileKey) {
  const { Item: claim } = await db.send(new GetCommand({ TableName: CLAIMS, Key: { claimId } }));
  if (!claim || !canView(user, claim) || !(claim.attachments || []).includes(fileKey))
    return reply(404, { message: "ไม่พบไฟล์" });
  return null;
}

// ---------- 4) ส่วนที่แก้ใน handler ----------
// const user = getUser(event);
// if (path !== "/types" && !user) return reply(401, { message: "ต้องเข้าสู่ระบบ" });
// const m = path.match(/^\/claims\/([^/]+)\/(action|history)$/);
// if (m && m[2] === "action"  && method === "POST") return claimAction(user, m[1], JSON.parse(event.body || "{}"));
// if (m && m[2] === "history" && method === "GET")  return getHistory(user, m[1]);
// GET /claims → listClaims(...) แล้วตามด้วย filterVisible(user, items)
// POST /get-upload-url → ให้เฉพาะ has(user,"Teacher","TA") และตั้ง key เป็น `uploads/${user.sub}/${uuid}-${fileName}`