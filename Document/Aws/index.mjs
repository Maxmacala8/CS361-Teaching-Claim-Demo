// Lambda (Node.js 20) สำหรับ CS361 Teaching Claim V2
// Routes (API Gateway HTTP API, payload v2):
//   GET  /types   -> อ่านประเภทค่าตอบแทนจาก DynamoDB
//   GET  /claims  -> รายการคำขอ (กรอง ?term= & ?status= ได้)
//   POST /claims  -> บันทึกร่าง / ยื่นคำขอ พร้อมตรวจกฎ
//   OPTIONS /{proxy+} -> preflight (CORS ตั้งที่ API Gateway)
//
// หมายเหตุ: ไม่ใส่ header CORS ในโค้ดนี้ ให้ตั้งที่ API Gateway ที่เดียว
// เพื่อไม่ให้ header ซ้ำกัน

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  QueryCommand,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const TYPES_TABLE = process.env.TYPES_TABLE || "CompensationTypes";
const CLAIMS_TABLE = process.env.CLAIMS_TABLE || "Claims";
const TERM_INDEX = "term-index";

const TERMS = ["1/2569", "2/2569", "ฤดูร้อน/2569"];
const STATUSES = ["DRAFT", "SUBMITTED"];
const ROLES = ["อาจารย์", "TA"];
const DEFAULT_MAX_HOURS = 8; // ใช้เมื่อประเภทนั้นไม่ได้กำหนด maxHoursPerDay

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

// ---------- GET /types ----------
async function listTypes() {
  const out = await db.send(new ScanCommand({ TableName: TYPES_TABLE }));
  return (out.Items || []).sort((a, b) => a.typeId.localeCompare(b.typeId));
}

// ---------- GET /claims ----------
async function listClaims(qs = {}) {
  const { term, status } = qs;
  let items;

  if (term) {
    // ใช้ GSI: term-index (PK = term)
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
    const out = await db.send(new ScanCommand({ TableName: CLAIMS_TABLE }));
    items = out.Items || [];
  }

  if (status) items = items.filter((c) => c.status === status);
  return items.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

// ---------- POST /claims ----------
function parseBody(event) {
  try {
    return JSON.parse(event.body || "{}");
  } catch {
    throw new HttpError(400, "รูปแบบข้อมูลไม่ถูกต้อง");
  }
}

function validateInput(b) {
  if (!STATUSES.includes(b.status)) throw new HttpError(400, "สถานะไม่ถูกต้อง");
  if (!b.claimantName || !String(b.claimantName).trim())
    throw new HttpError(400, "กรุณากรอกชื่อผู้ขอเบิก");
  if (!ROLES.includes(b.role)) throw new HttpError(400, "บทบาทไม่ถูกต้อง");
  if (!b.typeId) throw new HttpError(400, "กรุณาเลือกประเภทค่าตอบแทน");
  if (!b.course || !String(b.course).trim()) throw new HttpError(400, "กรุณากรอกรายวิชา");
  if (!TERMS.includes(b.term)) throw new HttpError(400, "ภาคการศึกษาไม่ถูกต้อง");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || "") || Number.isNaN(Date.parse(b.date)))
    throw new HttpError(400, "กรุณาระบุวันที่ปฏิบัติงานให้ถูกต้อง");

  const h = Number(b.hours);
  if (!Number.isFinite(h) || h <= 0) throw new HttpError(400, "จำนวนชั่วโมงต้องมากกว่า 0");
  if ((h * 2) % 1 !== 0) throw new HttpError(400, "จำนวนชั่วโมงต้องเป็นทวีคูณของ 0.5");
}

async function createClaim(event) {
  const b = parseBody(event);
  validateInput(b);

  // 1) ประเภทค่าตอบแทนต้องมีอยู่จริง (กฎอยู่ใน DB ไม่ได้ฝังในโค้ด)
  const t = (
    await db.send(new GetCommand({ TableName: TYPES_TABLE, Key: { typeId: b.typeId } }))
  ).Item;
  if (!t) throw new HttpError(400, "ไม่พบประเภทค่าตอบแทนที่เลือก");

  // 2) บทบาทต้องมีสิทธิ์
  if (!(t.roles || []).includes(b.role))
    throw new HttpError(400, `บทบาท "${b.role}" ไม่มีสิทธิ์เบิกประเภท "${t.name}"`);

  // 3) ชั่วโมงต้องไม่เกินเพดานต่อวัน
  const hours = Number(b.hours);
  const maxHours = Number(t.maxHoursPerDay || DEFAULT_MAX_HOURS);
  if (hours > maxHours)
    throw new HttpError(400, `ชั่วโมงเกินเกณฑ์ ประเภทนี้เบิกได้ไม่เกิน ${maxHours} ชั่วโมงต่อวัน`);

  // 4) ตรวจคำขอซ้ำ (เฉพาะตอน "ยื่น")
  //    ซ้ำ = ผู้ขอ + ประเภท + วิชา + ภาค + วันที่ เหมือนกัน และเคยยื่นแล้ว
  const name = String(b.claimantName).trim();
  const course = String(b.course).trim();

  if (b.status === "SUBMITTED") {
    const existing = await listClaims({ term: b.term, status: "SUBMITTED" });
    const dup = existing.find(
      (c) =>
        c.claimantName === name &&
        c.typeId === b.typeId &&
        c.course === course &&
        c.date === b.date
    );
    if (dup) throw new HttpError(409, "คำขอซ้ำ: เคยยื่นรายการนี้แล้ว (ผู้ขอ/ประเภท/วิชา/วันที่ตรงกัน)");
  }

  // 5) คำนวณยอดที่ฝั่งเซิร์ฟเวอร์ (ไม่เชื่อค่าจากหน้าเว็บ)
  const amount = Number(t.rate) * hours;

  const claim = {
    claimId: randomUUID(),
    status: b.status,
    claimantName: name,
    role: b.role,
    typeId: t.typeId,
    typeName: t.name,
    rate: Number(t.rate),
    course,
    term: b.term,
    date: b.date,
    hours,
    amount,
    createdAt: new Date().toISOString(),
  };

  await db.send(new PutCommand({ TableName: CLAIMS_TABLE, Item: claim }));
  return claim;
}

// ---------- entry ----------
export const handler = async (event) => {
  const route = event.routeKey || "";
  try {
    if (route.startsWith("OPTIONS")) return { statusCode: 204 };
    if (route === "GET /types") return json(200, await listTypes());
    if (route === "GET /claims") return json(200, await listClaims(event.queryStringParameters || {}));
    if (route === "POST /claims") return json(201, await createClaim(event));
    return json(404, { message: "ไม่พบเส้นทางนี้" });
  } catch (e) {
    if (e instanceof HttpError) return json(e.statusCode, { message: e.message });
    console.error("UNEXPECTED", e); // ไปดูได้ใน CloudWatch Logs
    return json(500, { message: "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์" });
  }
};
