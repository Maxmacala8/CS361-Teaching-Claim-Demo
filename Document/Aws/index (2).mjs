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
//   POST   /get-slip-upload-url        presigned PUT สลิปโอนเงิน (Admin, คำขอ APPROVED)
//   POST   /claims/{id}/action         VERIFY / RETURN / APPROVE / REJECT / PAY
//   GET    /claims/{id}/history        ประวัติ
//   GET    /terms                      สาธารณะ (ตาราง Terms)
//   GET    /me/bank  POST /me/bank      บัญชีรับเงินของฉัน (เก็บเฉพาะเลขปกปิด)
//   GET    /courses/{id}/summary       สรุปชั่วโมงตามรอบ (เจ้าของวิชา / เจ้าหน้าที่)
//   GET    /assistant-hours            ชั่วโมงนักศึกษาช่วยงาน
//   POST   /assistant-hours/{id}/action CONFIRM / VERIFY / ISSUE_DOC / RECEIVE_EVIDENCE
//   POST   /admin/reset                รีเซ็ตข้อมูลทดสอบกลับ baseline (Administrators)
//
// CORS ตั้งที่ API Gateway ที่เดียว (ไม่ใส่ header ในโค้ดนี้)
// ตัวตนและกลุ่มมาจาก JWT ที่ API Gateway ตรวจแล้วเท่านั้น ไม่เชื่อ body

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  QueryCommand,
  GetCommand,
  PutCommand,
  DeleteCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { CognitoIdentityProviderClient, ListUsersCommand } from "@aws-sdk/client-cognito-identity-provider";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "node:crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});
const cognito = new CognitoIdentityProviderClient({});

const TYPES_TABLE = process.env.TYPES_TABLE || "CompensationTypes";
const CLAIMS_TABLE = process.env.CLAIMS_TABLE || "Claims";
const HISTORY_TABLE = process.env.HISTORY_TABLE || "ClaimHistory"; // PK claimId, SK at
const BUCKET = process.env.BUCKET;
const TERM_INDEX = "term-index";
const TERMS_TABLE = process.env.TERMS_TABLE || "Terms";
const BANK_TABLE = process.env.BANK_TABLE || "BankAccounts";
const COURSES_TABLE = process.env.COURSES_TABLE || "Courses";
const ASSIST_TABLE = process.env.ASSIST_TABLE || "AssistantHours";
const USER_POOL_ID = process.env.USER_POOL_ID || "us-east-1_ey84ylA4I";

const TERMS = ["1/2569", "2/2569", "ฤดูร้อน/2569"];
const STATUSES = ["DRAFT", "SUBMITTED"]; // สถานะที่เจ้าของส่งเองได้
const EDITABLE = ["DRAFT", "RETURNED"];
const DUP_STATUSES = ["SUBMITTED", "VERIFIED", "APPROVED", "SIGNED_DOCS_RECEIVED", "PAID"]; // ไม่นับ ร่าง/ส่งกลับ/ไม่อนุมัติ
const DEFAULT_MAX_HOURS = 8;
const MAX_FILES = 5;
const ALLOWED_EXT = [
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv",
  "jpg", "jpeg", "png", "gif", "webp", "mp4", "mov", "webm", "avi", "mkv",
];

// ชื่อกลุ่ม Cognito ต้องตรงตัว (เทียบแบบ exact ไม่ใช้ includes)
const STAFF = ["Officer", "Approver", "Admin", "Administrators", "Staff"];
const FINANCE = ["Admin", "Administrators"];

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
  APPROVED: {
    PAY: { to: "PAID", group: ["Admin", "Administrators"] },
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
    username: c["cognito:username"] || "",
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

// บันทึกการกระทำที่ไม่เปลี่ยนสถานะ (เปิดไฟล์ / แก้บัญชี / รับหลักฐาน) ลง ClaimHistory
async function audit(claimId, user, action, comment = "") {
  await db.send(new PutCommand({
    TableName: HISTORY_TABLE,
    Item: historyItem(claimId, new Date().toISOString(), user, action, null, null, comment),
  }));
}

// ---------- GET /types ----------
async function listTypes() {
  const out = await db.send(new ScanCommand({ TableName: TYPES_TABLE }));
  return (out.Items || []).sort((a, b) => a.typeId.localeCompare(b.typeId));
}

// ---------- GET /terms (สาธารณะ) + รอบเบิก ----------
async function listTerms() {
  const out = await db.send(new ScanCommand({ TableName: TERMS_TABLE }));
  return (out.Items || []).sort((a, b) => String(a.termId).localeCompare(String(b.termId), "th"));
}

async function termExists(termId) {
  if (typeof termId !== "string" || !termId) return false;
  return !!(await db.send(new GetCommand({ TableName: TERMS_TABLE, Key: { termId } }))).Item;
}

// 2026-10-03 -> OCT-2569 (เดือนย่อภาษาอังกฤษ + ปี พ.ศ.)
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const roundOf = (date) => {
  const [y, m] = String(date).split("-").map(Number);
  return `${MONTHS[m - 1]}-${y + 543}`;
};
const sessionsOf = (c) => (Array.isArray(c.sessions) && c.sessions.length ? c.sessions : [c.date]);

// ---------- GET /claims ----------
async function listClaims(user, qs = {}) {
  const items = (await queryClaims({ term: qs.term, status: qs.status })).filter((c) => canView(user, c));
  // แนบบัญชีปลายทาง (ปกปิด) ให้ฝ่ายการเงิน หรือเจ้าของคำขอ เฉพาะคำขอที่อนุมัติ/จ่ายแล้ว
  const cache = {};
  for (const c of items) {
    if (!["APPROVED", "PAID"].includes(c.status)) continue;
    if (!(has(user, ...FINANCE) || c.ownerSub === user.sub)) continue;
    if (!(c.ownerSub in cache)) cache[c.ownerSub] = await getBank(c.ownerSub);
    if (cache[c.ownerSub]) c.bankInfo = cache[c.ownerSub];
  }
  return items;
}

// ---------- POST /claims ----------
function validateInput(b) {
  if (!STATUSES.includes(b.status)) throw new HttpError(400, "สถานะไม่ถูกต้อง");
  if (!b.typeId) throw new HttpError(400, "กรุณาเลือกประเภทค่าตอบแทน");
  if (!b.course || !String(b.course).trim()) throw new HttpError(400, "กรุณากรอกรายวิชา");
  if (typeof b.term !== "string" || !b.term) throw new HttpError(400, "ภาคการศึกษาไม่ถูกต้อง");
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
  if (!(await termExists(b.term))) throw new HttpError(400, "ภาคการศึกษาไม่ถูกต้อง");

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

  // รวมชั่วโมงทุกคำขอของวันเดียวกัน ประเภทเดียวกัน ต้องไม่เกินเพดาน
  const COUNTED = ["SUBMITTED", "VERIFIED", "APPROVED", "SIGNED_DOCS_RECEIVED", "PAID"];
  const sameDay = (await queryClaims({ term: b.term })).filter(
    (c) => c.claimId !== b.claimId && c.ownerSub === user.sub &&
           c.typeId === b.typeId && sessionsOf(c).includes(b.date) && COUNTED.includes(c.status)
  );
  const already = sameDay.reduce((sum, c) => sum + Number(c.hours) / sessionsOf(c).length, 0);
  if (already + hours > maxHours)
    throw new HttpError(400, `ชั่วโมงรวมของวันนี้เกินเกณฑ์ (เบิกไปแล้ว ${already} + ${hours} เกิน ${maxHours} ชม./วัน)`);

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
        sessionsOf(c).includes(b.date)
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
    round: roundOf(b.date),
    courseId: await findCourseId(course, b.term, user.sub),
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

// เคยทำ action เหล่านี้กับรายการนี้มาก่อนหรือไม่ (maker-checker)
async function actedBefore(claimId, sub, actions) {
  const out = await db.send(new QueryCommand({
    TableName: HISTORY_TABLE,
    KeyConditionExpression: "claimId = :c",
    ExpressionAttributeValues: { ":c": claimId },
  }));
  return (out.Items || []).some((h) => h.actorSub === sub && actions.includes(h.action));
}

// ---------- POST /claims/{id}/action ----------
async function claimAction(user, claimId, body) {
  const claim = await getClaim(claimId);
  if (!claim || !canView(user, claim)) throw new HttpError(404, "ไม่พบคำขอ");

  const rule = FLOW[claim.status]?.[body.action];
  if (!rule) throw new HttpError(409, `สถานะ ${claim.status} ไม่สามารถ ${body.action} ได้`);
  if (!has(user, ...[].concat(rule.group))) throw new HttpError(403, "ไม่มีสิทธิ์ทำรายการนี้");
  if (claim.ownerSub === user.sub) throw new HttpError(403, "ห้ามตรวจ/อนุมัติคำขอของตนเอง");
  if (["APPROVE", "REJECT"].includes(body.action) && (await actedBefore(claim.claimId, user.sub, ["VERIFY"])))
    throw new HttpError(403, "ผู้ตรวจและผู้อนุมัติต้องเป็นคนละคน");
  if (body.action === "PAY" && (await actedBefore(claim.claimId, user.sub, ["VERIFY", "APPROVE"])))
    throw new HttpError(403, "ผู้จ่ายเงินต้องไม่ใช่ผู้ตรวจหรือผู้อนุมัติคำขอนี้");
  if (["RETURN", "REJECT"].includes(body.action) && !String(body.comment || "").trim())
    throw new HttpError(400, "กรุณาระบุเหตุผล");

  const at = new Date().toISOString();
  const comment = String(body.comment || "").trim();
  let update = "SET #s = :to, updatedAt = :at";
  const values = { ":to": rule.to, ":from": claim.status, ":at": at };
  if (body.action === "PAY") {
    // สลิปต้องเป็นไฟล์ที่ออก URL ให้คำขอนี้เท่านั้น
    const key = String(body.paymentSlipKey || "");
    if (!key.startsWith(`slips/${claim.claimId}/`)) throw new HttpError(400, "กรุณาแนบสลิปการโอนเงิน");
    update += ", paymentSlipKey = :slip, paidAt = :at, paidBy = :by";
    values[":slip"] = key;
    values[":by"] = user.name;
  }
  await transact([
    {
      Update: {
        TableName: CLAIMS_TABLE,
        Key: { claimId: claim.claimId },
        UpdateExpression: update,
        ConditionExpression: "#s = :from", // กันสองคนกดพร้อมกัน
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: values,
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

// สลิปโอนเงิน: Admin เท่านั้น และคำขอต้องอนุมัติแล้ว
async function getSlipUploadUrl(event, user) {
  if (!has(user, "Admin", "Administrators")) throw new HttpError(403, "บัญชีนี้ไม่มีสิทธิ์บันทึกการจ่ายเงิน");
  if (!BUCKET) throw new Error("BUCKET env var is not set");
  const b = parseBody(event);
  const claim = await getClaim(b.claimId);
  if (!claim) throw new HttpError(404, "ไม่พบคำขอ");
  if (claim.status !== "APPROVED") throw new HttpError(409, "คำขอนี้ยังไม่อยู่ในสถานะอนุมัติ");
  const fileName = safeName(b.fileName);
  const ext = fileName.split(".").pop().toLowerCase();
  if (!["pdf", "jpg", "jpeg", "png", "webp"].includes(ext)) throw new HttpError(400, `ไม่รองรับไฟล์ .${ext}`);

  const fileKey = `slips/${claim.claimId}/${randomUUID()}-${fileName}`;
  const cmd = { Bucket: BUCKET, Key: fileKey };
  if (b.fileType) cmd.ContentType = String(b.fileType);
  const uploadURL = await getSignedUrl(s3, new PutObjectCommand(cmd), { expiresIn: 300 });
  return { uploadURL, fileKey };
}

async function getDownloadUrl(event, user) {
  if (!BUCKET) throw new Error("BUCKET env var is not set");
  const { claimId, fileKey } = parseBody(event);
  const claim = await getClaim(claimId);
  const isSlip = !!claim && !!claim.paymentSlipKey && fileKey === claim.paymentSlipKey &&
    (claim.ownerSub === user.sub || has(user, ...FINANCE));
  if (!claim || !canView(user, claim) || !((claim.attachments || []).includes(fileKey) || isSlip))
    throw new HttpError(404, "ไม่พบไฟล์");
  await audit(claim.claimId, user, "VIEW_FILE", String(fileKey).split("/").pop());
  const downloadURL = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: fileKey }),
    { expiresIn: 300 }
  );
  return { downloadURL };
}

// ---------- บัญชีรับเงิน (เก็บเฉพาะเลขปกปิด ไม่เก็บเลขเต็ม) ----------
async function getBank(sub) {
  const it = (await db.send(new GetCommand({ TableName: BANK_TABLE, Key: { userSub: sub } }))).Item;
  return it ? { bankCode: it.bankCode, accountMask: it.accountMask, accountName: it.accountName } : null;
}

async function getMyBank(user) {
  const b = await getBank(user.sub);
  return b ? { registered: true, ...b } : { registered: false };
}

async function saveMyBank(event, user) {
  if (!has(user, "Teacher", "TA")) throw new HttpError(403, "บัญชีนี้ไม่มีสิทธิ์บันทึกบัญชีรับเงิน");
  const b = parseBody(event);
  const bankCode = String(b.bankCode || "").trim().slice(0, 20);
  const accountName = String(b.accountName || "").trim().slice(0, 100);
  const digits = String(b.accountNumber || "").replace(/\D/g, "");
  if (!bankCode || !accountName) throw new HttpError(400, "กรุณากรอกธนาคารและชื่อบัญชี");
  if (digits.length < 10 || digits.length > 12) throw new HttpError(400, "เลขบัญชีต้องเป็นตัวเลข 10-12 หลัก");
  const accountMask = `xxx-x-x${digits.slice(-5, -1)}-x`;
  await db.send(new PutCommand({
    TableName: BANK_TABLE,
    Item: { userSub: user.sub, bankCode, accountMask, accountName, updatedAt: new Date().toISOString() },
  }));
  await audit("BANK#" + user.sub, user, "BANK_UPDATE"); // ไม่เก็บเลขใน log
  return { registered: true, bankCode, accountMask, accountName };
}

// ---------- รายวิชา: สรุปชั่วโมงตามรอบ (12 = จ่ายแล้ว + รอจ่าย + ยังไม่ยื่น) ----------
const PAID = ["PAID"];
const PENDING = ["SUBMITTED", "VERIFIED", "APPROVED", "SIGNED_DOCS_RECEIVED"];

async function courseSummary(user, courseId, qs = {}) {
  const course = (await db.send(new GetCommand({ TableName: COURSES_TABLE, Key: { courseId: String(courseId) } }))).Item;
  if (!course) throw new HttpError(404, "ไม่พบรายวิชา");
  const isOwner = course.ownerSub === user.sub;
  if (!isOwner && !has(user, ...STAFF)) throw new HttpError(404, "ไม่พบรายวิชา");

  const round = qs.round || null;
  const sessions = (course.sessions || []).filter((s) => !round || roundOf(s.date) === round);
  const claims = (await queryClaims({ term: course.term })).filter(
    (c) => c.courseId === course.courseId && c.ownerSub === course.ownerSub && !["DRAFT", "REJECTED", "RETURNED"].includes(c.status)
  );

  // จับคู่คาบสอนกับคำขอ: คาบหนึ่งนับได้ครั้งเดียว
  const used = new Set();
  const rows = sessions.map((s) => {
    const c = claims.find((x) => sessionsOf(x).includes(s.date));
    const state = !c ? "UNCLAIMED" : PAID.includes(c.status) ? "PAID" : PENDING.includes(c.status) ? "PENDING" : "UNCLAIMED";
    if (c) used.add(c.claimId);
    return { date: s.date, hours: Number(s.hours), round: roundOf(s.date), claimId: c ? c.claimId : null, claimStatus: c ? c.status : null, state };
  });
  const sum = (st) => rows.filter((r) => r.state === st).reduce((a, r) => a + r.hours, 0);

  const bank = isOwner || has(user, ...FINANCE) ? await getBank(course.ownerSub) : null;
  const paidClaims = claims
    .filter((c) => used.has(c.claimId) && c.status === "PAID")
    .map((c) => ({
      claimId: c.claimId, sessions: sessionsOf(c), hours: c.hours, amount: c.amount, round: c.round,
      paidAt: c.paidAt || null, paidBy: c.paidBy || null, bank, // บัญชีของเจ้าของวิชาเท่านั้น (ปกปิด)
    }));

  return {
    course: { courseId: course.courseId, code: course.code, name: course.name, term: course.term, section: course.section, ownerUsername: course.ownerUsername },
    round,
    totals: { scheduled: rows.reduce((a, r) => a + r.hours, 0), paid: sum("PAID"), pending: sum("PENDING"), unclaimed: sum("UNCLAIMED") },
    sessions: rows,
    paidClaims,
  };
}

// ผูกคำขอกับรายวิชาในตาราง Courses (รหัสวิชา + ภาค + เจ้าของ) เพื่อให้นับในสรุปได้
async function findCourseId(code, term, ownerSub) {
  const items = (await db.send(new ScanCommand({ TableName: COURSES_TABLE }))).Items || [];
  const c = items.find((x) => x.code === code && x.term === term && x.ownerSub === ownerSub);
  return c ? c.courseId : null;
}

// ---------- นักศึกษาช่วยงาน: กรอก / รับรอง / รอตรวจ แยกกัน ----------
async function getCourse(courseId) {
  return (await db.send(new GetCommand({ TableName: COURSES_TABLE, Key: { courseId: String(courseId) } }))).Item || null;
}

const assistView = (r) => ({
  ...r,
  pendingHours: Math.max(0, Number(r.recordedHours || 0) - Number(r.verifiedHours || 0)),
});

async function listAssistantHours(user) {
  const items = (await db.send(new ScanCommand({ TableName: ASSIST_TABLE }))).Items || [];
  return items.filter((r) => r.studentSub === user.sub || r.instructorSub === user.sub || has(user, ...STAFF)).map(assistView);
}

async function assistantAction(user, recordId, body) {
  const r = (await db.send(new GetCommand({ TableName: ASSIST_TABLE, Key: { recordId: String(recordId) } }))).Item;
  if (!r || !(r.studentSub === user.sub || r.instructorSub === user.sub || has(user, ...STAFF)))
    throw new HttpError(404, "ไม่พบรายการ");
  const at = new Date().toISOString();
  const upd = { ...r, updatedAt: at };
  let comment = "";

  switch (body.action) {
    case "CONFIRM": { // นักศึกษายืนยันชั่วโมงที่กรอก
      if (r.studentSub !== user.sub) throw new HttpError(403, "เฉพาะนักศึกษาเจ้าของรายการ");
      const h = Number(body.hours ?? r.recordedHours);
      if (!Number.isFinite(h) || h <= 0 || (h * 2) % 1 !== 0) throw new HttpError(400, "จำนวนชั่วโมงไม่ถูกต้อง");
      if (Number(r.verifiedHours || 0) > h) throw new HttpError(409, "ชั่วโมงที่กรอกต้องไม่น้อยกว่าชั่วโมงที่รับรองแล้ว");
      upd.recordedHours = h; upd.studentConfirmedAt = at; upd.status = "RECORDED";
      comment = `กรอก ${h} ชม.`;
      break;
    }
    case "VERIFY": { // อาจารย์เจ้าของวิชารับรอง (ไม่ใช่ลายเซ็นจริง)
      if (r.instructorSub !== user.sub) throw new HttpError(403, "เฉพาะอาจารย์เจ้าของรายวิชา");
      const h = Number(body.hours);
      if (!Number.isFinite(h) || h < 0 || (h * 2) % 1 !== 0 || h > Number(r.recordedHours))
        throw new HttpError(400, "ชั่วโมงที่รับรองต้องไม่เกินชั่วโมงที่กรอก");
      upd.verifiedHours = h; upd.verifiedAt = at; upd.status = "VERIFIED";
      comment = `รับรอง ${h} / กรอก ${r.recordedHours} ชม.`;
      break;
    }
    case "ISSUE_DOC": { // เจ้าหน้าที่ออกเอกสารให้อาจารย์ลงนามจริงบนกระดาษ
      if (!has(user, "Staff")) throw new HttpError(403, "เฉพาะเจ้าหน้าที่ (Staff)");
      if (!Number(r.verifiedHours)) throw new HttpError(409, "ยังไม่มีชั่วโมงที่รับรอง");
      upd.doc = { docNo: `DOC-${r.recordId}-${at.slice(0, 10)}`, issuedAt: at, issuedBy: user.name, hours: Number(r.verifiedHours), signer: r.instructorUsername };
      upd.status = "DOC_ISSUED";
      comment = `ออกเอกสาร ${upd.doc.docNo} (${upd.doc.hours} ชม.) ให้ ${r.instructorUsername} ลงนาม`;
      break;
    }
    case "RECEIVE_EVIDENCE": { // บันทึกการรับหลักฐาน (ไม่ใช่การลงนามในระบบ)
      if (!has(user, "Staff")) throw new HttpError(403, "เฉพาะเจ้าหน้าที่ (Staff)");
      if (!r.doc) throw new HttpError(409, "ยังไม่ได้ออกเอกสาร");
      const course = await getCourse(r.courseId);
      const signer = String(body.signerUsername || "").trim();
      if (!course || signer.toLowerCase() !== String(course.ownerUsername).toLowerCase())
        throw new HttpError(400, "ผู้ลงนามในหลักฐานต้องเป็นอาจารย์เจ้าของรายวิชา");
      upd.evidence = { docNo: r.doc.docNo, signerUsername: course.ownerUsername, note: String(body.note || "").slice(0, 300), receivedAt: at, receivedBy: user.name };
      upd.status = "SIGNED_DOCS_RECEIVED";
      comment = `บันทึกการรับหลักฐาน ${r.doc.docNo} ผู้ลงนาม ${course.ownerUsername}`;
      break;
    }
    default:
      throw new HttpError(400, "การดำเนินการไม่ถูกต้อง");
  }
  await db.send(new PutCommand({ TableName: ASSIST_TABLE, Item: upd }));
  await audit(r.recordId, user, "ASSIST_" + body.action, comment);
  return assistView(upd);
}

// ---------- รีเซ็ตข้อมูลทดสอบ (ไม่แตะรายการที่ไม่ใช่ seed) ----------
async function findSub(username) {
  const out = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Filter: `username = "${username}"`, Limit: 1 }));
  const u = (out.Users || [])[0];
  return u ? (u.Attributes || []).find((a) => a.Name === "sub")?.Value : null;
}

// ลบเฉพาะข้อมูลทดสอบ: seed หรือคำขอที่ผูกกับรายวิชาทดสอบ
async function wipeSeed(table, key) {
  const items = ((await db.send(new ScanCommand({ TableName: table }))).Items || [])
    .filter((x) => x.seed === true || (table === CLAIMS_TABLE && x.courseId === "CS361-SP-1-2569"));
  for (const it of items) await db.send(new DeleteCommand({ TableName: table, Key: { [key]: it[key] } }));
  return items;
}

async function adminReset(user) {
  if (!has(user, ...FINANCE)) throw new HttpError(403, "เฉพาะผู้ดูแลระบบ");
  const names = ["INST-A", "INST-B", "STAFF-1", "STU-A"];
  const sub = {};
  for (const n of names) sub[n] = (await findSub(n)) || null;
  const missing = names.filter((n) => !sub[n]);
  if (missing.includes("INST-A") || missing.includes("STU-A"))
    throw new HttpError(409, `ยังไม่มีบัญชีใน Cognito: ${missing.join(", ")}`);

  // ล้าง seed เดิม + ประวัติของ seed
  const oldClaims = await wipeSeed(CLAIMS_TABLE, "claimId");
  const oldAssist = await wipeSeed(ASSIST_TABLE, "recordId");
  await wipeSeed(COURSES_TABLE, "courseId");
  for (const id of [...oldClaims.map((c) => c.claimId), ...oldAssist.map((a) => a.recordId)]) {
    const h = (await db.send(new QueryCommand({ TableName: HISTORY_TABLE, KeyConditionExpression: "claimId = :c", ExpressionAttributeValues: { ":c": id } }))).Items || [];
    for (const x of h) await db.send(new DeleteCommand({ TableName: HISTORY_TABLE, Key: { claimId: x.claimId, at: x.at } }));
  }

  // ประเภท: ค่าสอนพิเศษ ปริญญาตรี (ถ้าไม่พบใช้ประเภทแรกที่อาจารย์เบิกได้)
  const types = await listTypes();
  const t = types.find((x) => /ปริญญาตรี/.test(x.name)) || types.find((x) => (x.roles || []).includes("อาจารย์")) || types[0];
  const now = new Date().toISOString();
  const courseId = "CS361-SP-1-2569";
  const sched = ["2026-09-05", "2026-09-12", "2026-09-19", "2026-10-03", "2026-10-10", "2026-10-17", "2026-10-24"];

  await db.send(new PutCommand({ TableName: COURSES_TABLE, Item: {
    courseId, seed: true, code: "CS361", name: "Cloud-Based Software Architecting", section: "ภาคพิเศษ",
    term: "1/2569", period: "ส.ค.–พ.ย. 2569", ownerSub: sub["INST-A"], ownerUsername: "INST-A",
    sessions: sched.map((date) => ({ date, hours: 3 })),
  } }));

  const base = { seed: true, ownerSub: sub["INST-A"], claimantName: "INST-A", role: "อาจารย์", typeId: t.typeId, typeName: t.name,
    rate: Number(t.rate), course: "CS361", courseId, term: "1/2569", attachments: [], createdAt: now, updatedAt: now };
  const claims = [
    { claimId: "CLAIM-601", sessions: sched.slice(0, 3), status: "SIGNED_DOCS_RECEIVED", note: "มีเอกสารลงนามจริงจำลอง" },
    { claimId: "CLAIM-602", sessions: sched.slice(3, 5), status: "PAID", paidAt: now, paidBy: "seed" },
    { claimId: "CLAIM-603", sessions: sched.slice(5, 6), status: "SUBMITTED" },
  ];
  for (const c of claims) {
    const hours = 3 * c.sessions.length;
    await db.send(new PutCommand({ TableName: CLAIMS_TABLE, Item: { ...base, ...c, date: c.sessions[0], round: roundOf(c.sessions[0]), hours, amount: Number(t.rate) * hours } }));
    await db.send(new PutCommand({ TableName: HISTORY_TABLE, Item: historyItem(c.claimId, now, user, "SEED", null, c.status, "baseline") }));
  }

  // บัญชีรับเงิน (ปกปิด) — INST-A ใช้ BANK-A เท่านั้น
  await db.send(new PutCommand({ TableName: BANK_TABLE, Item: { userSub: sub["INST-A"], bankCode: "BANK-A", accountMask: "xxx-x-x1234-x", accountName: "INST-A", updatedAt: now } }));
  if (sub["INST-B"])
    await db.send(new PutCommand({ TableName: BANK_TABLE, Item: { userSub: sub["INST-B"], bankCode: "BANK-B", accountMask: "xxx-x-x5678-x", accountName: "INST-B", updatedAt: now } }));

  await db.send(new PutCommand({ TableName: ASSIST_TABLE, Item: {
    recordId: "AH-STU-A-CS361", seed: true, courseId, term: "1/2569",
    studentSub: sub["STU-A"], studentUsername: "STU-A", instructorSub: sub["INST-A"], instructorUsername: "INST-A",
    recordedHours: 8, verifiedHours: 6, status: "VERIFIED", studentConfirmedAt: now, verifiedAt: now, updatedAt: now,
  } }));

  return { ok: true, courseId, claims: claims.map((c) => c.claimId), missingOptional: missing };
}

// ---------- entry ----------
export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "";
  const path = event.rawPath || "";
  try {
    if (method === "OPTIONS") return { statusCode: 204 };

    // เส้นทางสาธารณะ
    if (method === "GET" && /\/types\/?$/.test(path)) return json(200, await listTypes());
    if (method === "GET" && /\/terms\/?$/.test(path)) return json(200, await listTerms());

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
    if (method === "POST" && /\/get-slip-upload-url\/?$/.test(path)) return json(200, await getSlipUploadUrl(event, user));
    if (method === "POST" && /\/get-download-url\/?$/.test(path)) return json(200, await getDownloadUrl(event, user));

    if (/\/me\/bank\/?$/.test(path)) {
      if (method === "GET") return json(200, await getMyBank(user));
      if (method === "POST") return json(200, await saveMyBank(event, user));
    }
    const cs = path.match(/\/courses\/([^/]+)\/summary\/?$/);
    if (cs && method === "GET") return json(200, await courseSummary(user, decodeURIComponent(cs[1]), event.queryStringParameters || {}));
    if (method === "GET" && /\/assistant-hours\/?$/.test(path)) return json(200, await listAssistantHours(user));
    const ah = path.match(/\/assistant-hours\/([^/]+)\/action\/?$/);
    if (ah && method === "POST") return json(200, await assistantAction(user, decodeURIComponent(ah[1]), parseBody(event)));
    if (method === "POST" && /\/admin\/reset\/?$/.test(path)) return json(200, await adminReset(user));

    return json(404, { message: "ไม่พบเส้นทางนี้" });
  } catch (e) {
    if (e instanceof HttpError) return json(e.statusCode, { message: e.message });
    console.error("UNEXPECTED", e); // ดูใน CloudWatch Logs
    return json(500, { message: "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์" });
  }
};