// Lambda (Node.js 20/24) สำหรับ CS361 Teaching Claim V3 (รวม V2 + Workflow + กัน BOLA)
// API Gateway HTTP API (payload v2) + Cognito JWT authorizer
//
// Routes:
//   GET    /types                      สาธารณะ
//   GET    /claims                     เจ้าของเห็นของตัวเอง / เจ้าหน้าที่เห็นที่ไม่ใช่ร่าง
//   POST   /claims                     บันทึกร่าง / ยื่น / แก้ไข (claimId) / dryRun
//   DELETE /claims                     ลบ (เจ้าของ + DRAFT/RETURNED)
//   POST   /get-upload-url             presigned PUT
//   POST   /get-download-url           presigned GET (ตรวจ claimId + fileKey)
//   POST   /claims/{id}/action         VERIFY / RETURN / APPROVE / REJECT
//   GET    /claims/{id}/history        ประวัติ
//
// CORS ตั้งที่ API Gateway ที่เดียว (ไม่ใส่ header ในโค้ดนี้)
// ตัวตนและกลุ่มมาจาก JWT ที่ API Gateway ตรวจแล้วเท่านั้น ไม่เชื่อ body

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  QueryCommand,
  GetCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const TYPES_TABLE = process.env.TYPES_TABLE || "CompensationTypes";
const CLAIMS_TABLE = process.env.CLAIMS_TABLE || "Claims";
const HISTORY_TABLE = process.env.HISTORY_TABLE || "ClaimHistory"; // PK claimId, SK at
const BUCKET = process.env.BUCKET;
const TERM_INDEX = "term-index";

const TERMS = ["1/2569", "2/2569", "ฤดูร้อน/2569"];
const STATUSES = ["DRAFT", "SUBMITTED"]; // สถานะที่เจ้าของส่งเองได้
const EDITABLE = ["DRAFT", "RETURNED"];
const DUP_STATUSES = ["SUBMITTED", "VERIFIED", "APPROVED"]; // ไม่นับ ร่าง/ส่งกลับ/ไม่อนุมัติ
const DEFAULT_MAX_HOURS = 8;
const MAX_FILES = 5;
const ALLOWED_EXT = [
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv",
  "jpg", "jpeg", "png", "gif", "webp", "mp4", "mov", "webm", "avi", "mkv",
];

// ชื่อกลุ่ม Cognito ต้องตรงตัว (เทียบแบบ exact ไม่ใช้ includes)
const STAFF = ["Officer", "Approver", "Admin", "Administrators"];

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

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

const json = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});

// ---------- ตัวตนจาก token ----------
function getUser(event) {
  const c = event.requestContext?.authorizer?.jwt?.claims;
  if (!c || !c.sub) return null;
  let g = c["cognito:groups"] || [];
  // HTTP API ส่งกลุ่มเป็นสตริง เช่น "[Teacher Officer]"
  if (typeof g === "string") g = g.replace(/[\[\]]/g, "").split(/[\s,]+/).filter(Boolean);
  return {
    sub: c.sub,
    name: c.name || c.email || c["cognito:username"] || c.sub,
    groups: g,
  };
}
const has = (u, ...gs) => gs.some((g) => u.groups.includes(g));

// เจ้าของ หรือเจ้าหน้าที่ (เห็นเฉพาะที่ไม่ใช่ร่าง)
const canView = (u, claim) =>
  claim.ownerSub === u.sub || (has(u, ...STAFF) && claim.status !== "DRAFT");

// ---------- helpers ----------
function parseBody(event) {
  try {
    return JSON.parse(event.body || "{}");
  } catch {
    throw new HttpError(400, "รูปแบบข้อมูลไม่ถูกต้อง");
  }
}

async function getClaim(claimId) {
  if (!claimId) return null;
  return (await db.send(new GetCommand({ TableName: CLAIMS_TABLE, Key: { claimId: String(claimId) } }))).Item || null;
}

async function queryClaims({ term, status } = {}) {
  let items;
  if (term) {
    const out = await db.send(
      new QueryCommand({
        TableName: CLAIMS_TABLE,
        IndexName: TERM_INDEX,
        KeyConditionExpression: "#t = :t",
        ExpressionAttributeNames: { "#t": "term" },
        ExpressionAttributeValues: { ":t": term },
      })
    );
    items = out.Items || [];
  } else {
    items = (await db.send(new ScanCommand({ TableName: CLAIMS_TABLE }))).Items || [];
  }
  if (status) items = items.filter((c) => c.status === status);
  return items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

async function transact(items) {
  try {
    await db.send(new TransactWriteCommand({ TransactItems: items }));
  } catch (e) {
    if (e.name === "TransactionCanceledException")
      throw new HttpError(409, "ข้อมูลถูกเปลี่ยนแปลงระหว่างบันทึก กรุณารีเฟรชแล้วลองอีกครั้ง");
    throw e;
  }
}

const historyItem = (claimId, at, user, action, from, to, comment = "") => ({
  claimId, at, actorSub: user.sub, actorName: user.name,
  action, from: from || null, to: to || null, comment,
});

// ---------- GET /types ----------
async function listTypes() {
  const out = await db.send(new ScanCommand({ TableName: TYPES_TABLE }));
  return (out.Items || []).sort((a, b) => a.typeId.localeCompare(b.typeId));
}

// ---------- GET /claims ----------
async function listClaims(user, qs = {}) {
  const items = await queryClaims({ term: qs.term, status: qs.status });
  return items.filter((c) => canView(user, c));
}

// ---------- POST /claims ----------
function validateInput(b) {
  if (!STATUSES.includes(b.status)) throw new HttpError(400, "สถานะไม่ถูกต้อง");
  if (!b.typeId) throw new HttpError(400, "กรุณาเลือกประเภทค่าตอบแทน");
  if (!b.course || !String(b.course).trim()) throw new HttpError(400, "กรุณากรอกรายวิชา");
  if (!TERMS.includes(b.term)) throw new HttpError(400, "ภาคการศึกษาไม่ถูกต้อง");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || "") || Number.isNaN(Date.parse(b.date)))
    throw new HttpError(400, "กรุณาระบุวันที่ปฏิบัติงานให้ถูกต้อง");
  const h = Number(b.hours);
  if (!Number.isFinite(h) || h <= 0) throw new HttpError(400, "จำนวนชั่วโมงต้องมากกว่า 0");
  if ((h * 2) % 1 !== 0) throw new HttpError(400, "จำนวนชั่วโมงต้องเป็นทวีคูณของ 0.5");
  if (b.attachments !== undefined && !Array.isArray(b.attachments))
    throw new HttpError(400, "รูปแบบไฟล์แนบไม่ถูกต้อง");
  if ((b.attachments || []).length > MAX_FILES)
    throw new HttpError(400, `แนบไฟล์ได้ไม่เกิน ${MAX_FILES} ไฟล์`);
}

// ไฟล์แนบต้องเป็น key ที่ระบบออกให้ผู้ใช้คนนี้เท่านั้น
function validateAttachments(list, user) {
  for (const k of list) {
    if (typeof k !== "string" || !k.startsWith(`uploads/${user.sub}/`) || k.includes(".."))
      throw new HttpError(400, "ไฟล์แนบไม่ถูกต้อง");
  }
}

async function saveClaim(event, user) {
  const b = parseBody(event);
  validateInput(b);

  // เฉพาะ Teacher / TA ยื่นได้ ส่วน role ใน body ถูกเมินทิ้ง
  if (!has(user, "Teacher", "TA")) throw new HttpError(403, "บัญชีนี้ไม่มีสิทธิ์ยื่นคำขอเบิกค่าตอบแทน");
  const role = has(user, "TA") ? "TA" : "อาจารย์";

  // แก้ไขคำขอเดิม: เจ้าของเท่านั้น และสถานะต้องแก้ได้
  let existing = null;
  if (b.claimId) {
    existing = await getClaim(b.claimId);
    if (!existing || existing.ownerSub !== user.sub) throw new HttpError(404, "ไม่พบคำขอ");
    if (!EDITABLE.includes(existing.status)) throw new HttpError(409, "สถานะนี้แก้ไขไม่ได้");
  }

  // 1) ประเภทต้องมีจริง
  const t = (await db.send(new GetCommand({ TableName: TYPES_TABLE, Key: { typeId: b.typeId } }))).Item;
  if (!t) throw new HttpError(400, "ไม่พบประเภทค่าตอบแทนที่เลือก");

  // 2) บทบาทมีสิทธิ์เบิกประเภทนี้
  if (!(t.roles || []).includes(role))
    throw new HttpError(400, `บทบาท "${role}" ไม่มีสิทธิ์เบิกประเภท "${t.name}"`);

  // 3) ชั่วโมงไม่เกินเพดาน
  const hours = Number(b.hours);
  const maxHours = Number(t.maxHoursPerDay || DEFAULT_MAX_HOURS);
  if (hours > maxHours)
    throw new HttpError(400, `ชั่วโมงเกินเกณฑ์ ประเภทนี้เบิกได้ไม่เกิน ${maxHours} ชั่วโมงต่อวัน`);

  const course = String(b.course).trim();
  const attachments = b.attachments || [];
  validateAttachments(attachments, user);

  // 4) ตอนยื่น: ต้องแนบเอกสารถ้าประเภทนี้กำหนด requiredDocs และห้ามซ้ำ
  if (b.status === "SUBMITTED") {
    if ((t.requiredDocs || []).length > 0 && attachments.length === 0)
      throw new HttpError(400, "กรุณาแนบเอกสารประกอบก่อนยื่นคำขอ");

    const sameTerm = await queryClaims({ term: b.term });
    const dup = sameTerm.find(
      (c) =>
        c.claimId !== b.claimId &&
        c.ownerSub === user.sub &&
        DUP_STATUSES.includes(c.status) &&
        c.typeId === b.typeId &&
        c.course === course &&
        c.date === b.date
    );
    if (dup) throw new HttpError(409, "คำขอซ้ำ: เคยยื่นรายการนี้แล้ว (ประเภท/วิชา/วันที่ตรงกัน)");
  }

  // dryRun: ตรวจเงื่อนไขอย่างเดียว ไม่บันทึก
  if (b.dryRun === true) return { statusCode: 200, body: { ok: true } };

  // 5) คำนวณยอดที่เซิร์ฟเวอร์
  const amount = Number(t.rate) * hours;
  const now = new Date().toISOString();
  const claimId = existing ? existing.claimId : randomUUID();

  const claim = {
    ...(existing || {}),
    claimId,
    ownerSub: user.sub,
    status: b.status,
    claimantName: user.name,
    role,
    typeId: t.typeId,
    typeName: t.name,
    rate: Number(t.rate),
    course,
    term: b.term,
    date: b.date,
    hours,
    amount,
    attachments,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
  };

  const put = { TableName: CLAIMS_TABLE, Item: claim };
  if (existing) {
    put.ConditionExpression = "ownerSub = :o AND (#s = :d OR #s = :r)";
    put.ExpressionAttributeNames = { "#s": "status" };
    put.ExpressionAttributeValues = { ":o": user.sub, ":d": "DRAFT", ":r": "RETURNED" };
  } else {
    put.ConditionExpression = "attribute_not_exists(claimId)";
  }

  const action = b.status === "SUBMITTED" ? "SUBMIT" : "SAVE_DRAFT";
  await transact([
    { Put: put },
    { Put: { TableName: HISTORY_TABLE, Item: historyItem(claimId, now, user, action, existing?.status, b.status) } },
  ]);

  return { statusCode: existing ? 200 : 201, body: claim };
}

// ---------- DELETE /claims ----------
async function deleteClaim(event, user) {
  const { claimId } = parseBody(event);
  const c = await getClaim(claimId);
  if (!c || c.ownerSub !== user.sub) throw new HttpError(404, "ไม่พบคำขอ");
  if (!EDITABLE.includes(c.status)) throw new HttpError(409, "สถานะนี้ลบไม่ได้");

  const now = new Date().toISOString();
  await transact([
    {
      Delete: {
        TableName: CLAIMS_TABLE,
        Key: { claimId: c.claimId },
        ConditionExpression: "ownerSub = :o AND (#s = :d OR #s = :r)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":o": user.sub, ":d": "DRAFT", ":r": "RETURNED" },
      },
    },
    { Put: { TableName: HISTORY_TABLE, Item: historyItem(c.claimId, now, user, "DELETE", c.status, null) } },
  ]);
  return { ok: true };
}

// ---------- POST /claims/{id}/action ----------
async function claimAction(user, claimId, body) {
  const claim = await getClaim(claimId);
  if (!claim || !canView(user, claim)) throw new HttpError(404, "ไม่พบคำขอ");

  const rule = FLOW[claim.status]?.[body.action];
  if (!rule) throw new HttpError(409, `สถานะ ${claim.status} ไม่สามารถ ${body.action} ได้`);
  if (!has(user, rule.group)) throw new HttpError(403, "ไม่มีสิทธิ์ทำรายการนี้");
  if (claim.ownerSub === user.sub) throw new HttpError(403, "ห้ามตรวจ/อนุมัติคำขอของตนเอง");
  if (["RETURN", "REJECT"].includes(body.action) && !String(body.comment || "").trim())
    throw new HttpError(400, "กรุณาระบุเหตุผล");

  const at = new Date().toISOString();
  const comment = String(body.comment || "").trim();
  await transact([
    {
      Update: {
        TableName: CLAIMS_TABLE,
        Key: { claimId: claim.claimId },
        UpdateExpression: "SET #s = :to, updatedAt = :at",
        ConditionExpression: "#s = :from", // กันสองคนกดพร้อมกัน
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":to": rule.to, ":from": claim.status, ":at": at },
      },
    },
    { Put: { TableName: HISTORY_TABLE, Item: historyItem(claim.claimId, at, user, body.action, claim.status, rule.to, comment) } },
  ]);
  return { claimId: claim.claimId, status: rule.to };
}

// ---------- GET /claims/{id}/history ----------
async function getHistory(user, claimId) {
  const claim = await getClaim(claimId);
  if (!claim || !canView(user, claim)) throw new HttpError(404, "ไม่พบคำขอ");
  const out = await db.send(
    new QueryCommand({
      TableName: HISTORY_TABLE,
      KeyConditionExpression: "claimId = :c",
      ExpressionAttributeValues: { ":c": claim.claimId },
      ScanIndexForward: true,
    })
  );
  return out.Items || [];
}

// ---------- ไฟล์แนบ ----------
const safeName = (n) =>
  String(n || "file").split(/[\\/]/).pop().replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120);

async function getUploadUrl(event, user) {
  if (!has(user, "Teacher", "TA")) throw new HttpError(403, "บัญชีนี้ไม่มีสิทธิ์อัปโหลดไฟล์");
  if (!BUCKET) throw new Error("BUCKET env var is not set");
  const b = parseBody(event);
  const fileName = safeName(b.fileName);
  const ext = fileName.split(".").pop().toLowerCase();
  if (!ALLOWED_EXT.includes(ext)) throw new HttpError(400, `ไม่รองรับไฟล์ .${ext}`);

  const fileKey = `uploads/${user.sub}/${randomUUID()}-${fileName}`;
  const cmd = { Bucket: BUCKET, Key: fileKey };
  // ถ้าล็อก Content-Type ไว้ ตอน PUT ต้องส่งค่าเดียวกัน (หน้าเว็บส่ง file.type)
  if (b.fileType) cmd.ContentType = String(b.fileType);
  const uploadURL = await getSignedUrl(s3, new PutObjectCommand(cmd), { expiresIn: 300 });
  return { uploadURL, fileKey };
}

async function getDownloadUrl(event, user) {
  if (!BUCKET) throw new Error("BUCKET env var is not set");
  const { claimId, fileKey } = parseBody(event);
  const claim = await getClaim(claimId);
  if (!claim || !canView(user, claim) || !(claim.attachments || []).includes(fileKey))
    throw new HttpError(404, "ไม่พบไฟล์");
  const downloadURL = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: fileKey }),
    { expiresIn: 300 }
  );
  return { downloadURL };
}

// ---------- entry ----------
export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "";
  const path = event.rawPath || "";
  try {
    if (method === "OPTIONS") return { statusCode: 204 };

    // เส้นทางสาธารณะ
    if (method === "GET" && /\/types\/?$/.test(path)) return json(200, await listTypes());

    // นอกนั้นต้องมีตัวตนจาก token
    const user = getUser(event);
    if (!user) return json(401, { message: "ต้องเข้าสู่ระบบ" });

    const m = path.match(/\/claims\/([^/]+)\/(action|history)\/?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (m[2] === "action" && method === "POST") return json(200, await claimAction(user, id, parseBody(event)));
      if (m[2] === "history" && method === "GET") return json(200, await getHistory(user, id));
    }

    if (/\/claims\/?$/.test(path)) {
      if (method === "GET") return json(200, await listClaims(user, event.queryStringParameters || {}));
      if (method === "POST") {
        const r = await saveClaim(event, user);
        return json(r.statusCode, r.body);
      }
      if (method === "DELETE") return json(200, await deleteClaim(event, user));
    }
    if (method === "POST" && /\/get-upload-url\/?$/.test(path)) return json(200, await getUploadUrl(event, user));
    if (method === "POST" && /\/get-download-url\/?$/.test(path)) return json(200, await getDownloadUrl(event, user));

    return json(404, { message: "ไม่พบเส้นทางนี้" });
  } catch (e) {
    if (e instanceof HttpError) return json(e.statusCode, { message: e.message });
    console.error("UNEXPECTED", e); // ดูใน CloudWatch Logs
    return json(500, { message: "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์" });
  }
};
