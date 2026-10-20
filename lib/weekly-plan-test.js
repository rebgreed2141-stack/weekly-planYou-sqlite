"use strict";

/* You保育園・週案日誌テストAPI。既存の /api/week 等には影響しない。 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const API_ROOT = "/api/weekly-plan-test";
const LOCK_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const FACILITY_CODE = "y"; // You保育園のみ。森、Hohoem館とは混同しない。
const CLASS_NAMES = new Set(["もみじ", "どんぐり", "こぐま", "りす", "のうさぎ", "かもしか"]);
const TEXT_COLUMNS = ["weekly_aim", "child_appearance", "events", "parent_support", "child_reflection", "self_evaluation"];
const DAY_COLUMNS = ["environment", "activity", "consideration", "evaluation", "absence_status"];
const USER_COLS = ["weeklyAim", "childAppearance", "events", "parentSupport", "childReflection", "selfEvaluation"];
const USER_DAY_COLS = ["environment", "activity", "consideration", "evaluation", "absenceStatus"];

function isoDate(value) {
  const s = String(value ?? "").trim();
  let y, m, d;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (match) [, y, m, d] = match;
  else {
    match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (!match) return "";
    [, m, d, y] = match;
  }
  y = Number(y); m = Number(m); d = Number(d);
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() + 1 !== m || utc.getUTCDate() !== d) return "";
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function dbDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}/${y}`;
}
function addDay(iso, offset) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function fy(iso) { return Number(iso.slice(0, 4)) - (Number(iso.slice(5, 7)) < 4 ? 1 : 0); }
function weekSlots(startDate) {
  const result = Array(6).fill("");
  const day = new Date(`${startDate}T12:00:00Z`).getUTCDay();
  const isAprilException = startDate.endsWith("-04-01") && day >= 2 && day <= 6;
  if (day !== 1 && !isAprilException) return null;
  const shift = isAprilException ? day - 1 : 0;
  for (let i = shift; i < 6; i++) {
    const date = addDay(startDate, i - shift);
    if (fy(date) !== fy(startDate)) break;
    result[i] = date;
  }
  return result;
}
function toText(x) { return x == null ? "" : String(x); }
function nowText() {
  const d = new Date();
  return new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Tokyo", year: "numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", second:"2-digit", hourCycle:"h23"}).format(d).replace(", ", " ").replaceAll("/", "-");
}
function cleanLabel(value) { return String(value || "端末").slice(0, 60).replace(/[<>\r\n]/g, ""); }
function keyFromSearch(url) {
  const classKey = String(url.searchParams.get("classKey") || "");
  const startDate = isoDate(url.searchParams.get("startDate"));
  if (!CLASS_NAMES.has(classKey) || !startDate || !weekSlots(startDate)) return null;
  return { classKey, startDate };
}
function keyFromBody(body) {
  const classKey = String(body?.classKey || "");
  const startDate = isoDate(body?.startDate);
  if (!CLASS_NAMES.has(classKey) || !startDate || !weekSlots(startDate)) return null;
  return { classKey, startDate };
}
class ApiError extends Error {
  constructor(status, message, details = {}) { super(message); this.status = status; this.details = details; }
}
function makeHandler({ dbPath, logError = () => {} }) {
  let db = null;
  let bootFailure = null;
  function getDb() {
    if (db) return db;
    // 誤って空の新規DBを作らない。必ず利用者のテストDBをコピーしてから開始。
    if (!fs.existsSync(dbPath)) throw new ApiError(503, `テストDBがありません。${dbPath} にコピーしてください。`);
    try {
      const Database = require("better-sqlite3");
      db = new Database(dbPath, {fileMustExist:true, timeout: 5000});
      db.pragma("foreign_keys = ON");
      db.pragma("busy_timeout = 5000");
      // SQLiteファイルをサーバーのローカルディスクに置くこと。共有ドライブは不可。
      db.pragma("journal_mode = WAL");
      const required = ["facilities", "classes", "weekly_plans", "weekly_plan_days"];
      for (const name of required) {
        const existing = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
        if (!existing) throw new Error(`必要なテーブルがありません: ${name}`);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS weekly_test_edit_locks (
          class_id INTEGER NOT NULL,
          start_date TEXT NOT NULL,
          token TEXT NOT NULL,
          client_id TEXT NOT NULL,
          device_name TEXT NOT NULL,
          last_activity_ms INTEGER NOT NULL,
          PRIMARY KEY (class_id, start_date)
        );
        CREATE TABLE IF NOT EXISTS weekly_test_revisions (
          class_id INTEGER NOT NULL,
          start_date TEXT NOT NULL,
          revision INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (class_id, start_date)
        );
        CREATE INDEX IF NOT EXISTS weekly_test_days_lookup ON weekly_plan_days(weekly_plan_id);
        CREATE INDEX IF NOT EXISTS weekly_test_plans_lookup ON weekly_plans(class_id);
      `);
      return db;
    } catch (err) {
      if (db) { try { db.close(); } catch (_) {} db = null; }
      bootFailure = err;
      throw new ApiError(503, `テストDBを開けません: ${err.message}`);
    }
  }
  function getClassId(sql, classKey) {
    const row = sql.prepare(`SELECT c.class_id FROM classes c JOIN facilities f ON f.facility_id=c.facility_id
      WHERE f.facility_code=? AND c.class_name=?`).all(FACILITY_CODE, classKey);
    if (row.length !== 1) throw new ApiError(409, `You保育園のクラス登録が一意ではありません: ${classKey}`);
    return row[0].class_id;
  }
  function getPlan(sql, classId, date) {
    const matches = sql.prepare("SELECT * FROM weekly_plans WHERE class_id=?").all(classId)
      .filter(row => isoDate(row.start_date) === date);
    if (matches.length > 1) throw new ApiError(409, "同じクラス・週のDBデータが重複しています。自動上書きを中止しました。");
    return matches[0] || null;
  }
  function getRevision(sql, classId, date) {
    const r = sql.prepare("SELECT revision FROM weekly_test_revisions WHERE class_id=? AND start_date=?").get(classId, date);
    return r ? r.revision : 0;
  }
  function activeLock(sql, classId, date) {
    const lock = sql.prepare("SELECT * FROM weekly_test_edit_locks WHERE class_id=? AND start_date=?").get(classId, date);
    if (!lock || Date.now() - lock.last_activity_ms >= LOCK_MS) return null;
    return lock;
  }
  function checkToken(sql, classId, date, token) {
    const lock = activeLock(sql, classId, date);
    if (!token || !lock || lock.token !== token) {
      throw new ApiError(423, "編集権がありません。最新の内容を確認してください。", { lockedBy: lock?.device_name || "", lockExpired: !lock });
    }
    return lock;
  }
  function getWeek(sql, classId, key) {
    const plan = getPlan(sql, classId, key.startDate);
    if (!plan) return null;
    const slots = weekSlots(key.startDate);
    const rows = sql.prepare("SELECT * FROM weekly_plan_days WHERE weekly_plan_id=?").all(plan.weekly_plan_id);
    const byDate = new Map();
    for (const row of rows) {
      const d = isoDate(row.record_date);
      if (byDate.has(d)) throw new ApiError(409, "日誌の同一日付が重複しています。自動処理を中止しました。");
      byDate.set(d, row);
    }
    return {
      classKey: key.classKey, startDate: key.startDate,
      ...Object.fromEntries(USER_COLS.map((name, i) => [name, toText(plan[TEXT_COLUMNS[i]])])),
      journal: slots.map((dateIso) => {
        const row = byDate.get(dateIso) || {};
        return { dateIso, datePretty: "", ...Object.fromEntries(USER_DAY_COLS.map((name, i) => [name, dateIso ? toText(row[DAY_COLUMNS[i]]) : ""])) };
      }),
      updatedAt: plan.updated_at || ""
    };
  }
  const save = (sql) => sql.transaction((key, classId, token, body) => {
    checkToken(sql, classId, key.startDate, token);
    const actualRevision = getRevision(sql, classId, key.startDate);
    if (!Number.isSafeInteger(body.baseRevision) || body.baseRevision !== actualRevision) {
      throw new ApiError(409, "別の保存によって週案が更新されています。上書きを中止しました。", { revision: actualRevision });
    }
    const plan = getPlan(sql, classId, key.startDate);
    const updatedAt = nowText();
    const values = USER_COLS.map(name => toText(body[name]));
    let planId;
    if (plan) {
      sql.prepare(`UPDATE weekly_plans SET ${TEXT_COLUMNS.map(c => `${c}=?`).join(", ")}, updated_at=? WHERE weekly_plan_id=?`)
        .run(...values, updatedAt, plan.weekly_plan_id);
      planId = plan.weekly_plan_id;
    } else {
      const row = sql.prepare(`INSERT INTO weekly_plans(class_id,start_date,${TEXT_COLUMNS.join(",")},updated_at)
        VALUES(?,?,${TEXT_COLUMNS.map(() => "?").join(",")},?)`)
        .run(classId, dbDate(key.startDate), ...values, updatedAt);
      planId = row.lastInsertRowid;
    }
    const rows = sql.prepare("SELECT weekly_plan_day_id,record_date FROM weekly_plan_days WHERE weekly_plan_id=?").all(planId);
    const found = new Map();
    for (const row of rows) {
      const iso = isoDate(row.record_date);
      if (found.has(iso)) throw new ApiError(409, "同じ日のDBデータが重複しています。自動上書きを中止しました。");
      found.set(iso, row);
    }
    const slots = weekSlots(key.startDate);
    const journal = Array.isArray(body.journal) ? body.journal : [];
    if (journal.length !== 6) throw new ApiError(400, "日誌は6枠必要です。");
    for (let i = 0; i < slots.length; i++) {
      const day = journal[i] || {};
      const iso = slots[i];
      if (!iso) {
        if (USER_DAY_COLS.some(c => toText(day[c]).trim())) throw new ApiError(400, "対象外の日に入力内容があります。");
        continue;
      }
      if (day.dateIso && isoDate(day.dateIso) !== iso) throw new ApiError(400, "日誌の日付が週と一致しません。");
      const dv = USER_DAY_COLS.map(c => toText(day[c]));
      const existing = found.get(iso);
      if (existing) {
        sql.prepare(`UPDATE weekly_plan_days SET ${DAY_COLUMNS.map(c => `${c}=?`).join(", ")} WHERE weekly_plan_day_id=?`)
          .run(...dv, existing.weekly_plan_day_id);
      } else {
        sql.prepare(`INSERT INTO weekly_plan_days(weekly_plan_id,record_date,${DAY_COLUMNS.join(",")})
          VALUES(?,?,${DAY_COLUMNS.map(() => "?").join(",")})`)
          .run(planId, dbDate(iso), ...dv);
      }
    }
    const newRevision = actualRevision + 1;
    sql.prepare(`INSERT INTO weekly_test_revisions(class_id,start_date,revision,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(class_id,start_date) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(classId, key.startDate, newRevision, updatedAt);
    return {revision: newRevision, updatedAt};
  });
  const deleteWeek = (sql) => sql.transaction((key, classId, token, baseRevision) => {
    checkToken(sql, classId, key.startDate, token);
    const revision = getRevision(sql, classId, key.startDate);
    if (revision !== baseRevision) throw new ApiError(409, "削除前にほかの保存がありました。削除を中止しました。", {revision});
    const plan = getPlan(sql, classId, key.startDate);
    if (plan) {
      sql.prepare("DELETE FROM weekly_plan_days WHERE weekly_plan_id=?").run(plan.weekly_plan_id);
      sql.prepare("DELETE FROM weekly_plans WHERE weekly_plan_id=?").run(plan.weekly_plan_id);
    }
    const newRevision = revision + 1;
    sql.prepare(`INSERT INTO weekly_test_revisions(class_id,start_date,revision,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(class_id,start_date) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at`)
      .run(classId, key.startDate, newRevision, nowText());
    return {revision: newRevision};
  });
  const acquire = (sql) => sql.transaction((key, classId, body) => {
    const old = activeLock(sql, classId, key.startDate);
    if (old && !(body.token && body.token === old.token) && !(body.clientId && body.clientId === old.client_id)) {
      throw new ApiError(423, "ほかの職員が編集中です。", { lockedBy: old.device_name });
    }
    const token = old ? old.token : crypto.randomUUID();
    sql.prepare(`INSERT INTO weekly_test_edit_locks(class_id,start_date,token,client_id,device_name,last_activity_ms)
      VALUES(?,?,?,?,?,?) ON CONFLICT(class_id,start_date) DO UPDATE SET
      token=excluded.token,client_id=excluded.client_id,device_name=excluded.device_name,last_activity_ms=excluded.last_activity_ms`)
      .run(classId,key.startDate,token,cleanLabel(body.clientId),cleanLabel(body.deviceName),Date.now());
    return {token, expiresAt: new Date(Date.now() + LOCK_MS).toISOString()};
  });

  function send(res, status, value) {
    if (res.writableEnded) return;
    res.setHeader("Cache-Control", "no-store");
    res.writeHead(status, { "Content-Type":"application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }
  function bodyJson(req) {
    return new Promise((resolve,reject) => {
      let total=0, parts=[];
      req.on("data", chunk => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) { reject(new ApiError(413,"送信データが大きすぎます。")); req.destroy(); return; }
        parts.push(chunk);
      });
      req.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")); }
        catch (_) { reject(new ApiError(400,"JSON形式が正しくありません。")); }
      });
      req.on("error", reject);
    });
  }
  async function handle(req, res, url) {
    if (url.pathname !== API_ROOT && !url.pathname.startsWith(API_ROOT + "/")) return false;
    try {
      const sql = getDb();
      const route = url.pathname.slice(API_ROOT.length);
      const body = ["POST","DELETE"].includes(req.method) && req.method === "POST" ? await bodyJson(req) : {};
      const key = req.method === "GET" || req.method === "DELETE" ? keyFromSearch(url) : keyFromBody(body);
      // list, ping do not require a selected week
      if (route === "/ping" && req.method === "GET") return send(res,200,{ok:true, mode:"sqlite-test"}), true;
      if (route === "/weeks" && req.method === "GET") {
        const classRows = sql.prepare(`SELECT c.class_id,c.class_name FROM classes c JOIN facilities f ON f.facility_id=c.facility_id WHERE f.facility_code=?`).all(FACILITY_CODE);
        const items=[];
        for (const c of classRows) {
          if (!CLASS_NAMES.has(c.class_name)) continue;
          const plans = sql.prepare("SELECT start_date FROM weekly_plans WHERE class_id=?").all(c.class_id);
          for (const p of plans) {
            const startDate = isoDate(p.start_date);
            if (!startDate || !weekSlots(startDate)) continue;
            const k={classKey:c.class_name,startDate};
            items.push(getWeek(sql,c.class_id,k));
          }
        }
        return send(res,200,{ok:true,items}),true;
      }
      if (!key) throw new ApiError(400,"クラスまたは週の開始日が正しくありません。");
      const classId = getClassId(sql, key.classKey);
      const token = String(req.headers["x-lock-token"] || body.token || "");
      if (route === "/week" && req.method === "GET") {
        const data = getWeek(sql,classId,key);
        return send(res,200,{ok:true,data,revision:getRevision(sql,classId,key.startDate)}),true;
      }
      if (route === "/status" && req.method === "GET") {
        const lock=activeLock(sql,classId,key.startDate);
        return send(res,200,{ok:true,locked:Boolean(lock),lockedBy:lock?.device_name || "",own:Boolean(lock && token === lock.token),
          expiresAt:lock?new Date(lock.last_activity_ms+LOCK_MS).toISOString():null,
          revision:getRevision(sql,classId,key.startDate)}),true;
      }
      if (route === "/lock" && req.method === "POST") {
        const acquired=acquire(sql)(key,classId,body);
        return send(res,200,{ok:true,...acquired,revision:getRevision(sql,classId,key.startDate)}),true;
      }
      if (route === "/activity" && req.method === "POST") {
        checkToken(sql,classId,key.startDate,token);
        const time=Date.now();
        sql.prepare("UPDATE weekly_test_edit_locks SET last_activity_ms=? WHERE class_id=? AND start_date=? AND token=?")
          .run(time,classId,key.startDate,token);
        return send(res,200,{ok:true,expiresAt:new Date(time+LOCK_MS).toISOString()}),true;
      }
      if (route === "/unlock" && req.method === "POST") {
        sql.prepare("DELETE FROM weekly_test_edit_locks WHERE class_id=? AND start_date=? AND token=?")
          .run(classId,key.startDate,token);
        return send(res,200,{ok:true}),true;
      }
      if (route === "/week" && req.method === "POST") {
        const result=save(sql)(key,classId,token,body);
        return send(res,200,{ok:true,...result}),true;
      }
      if (route === "/week" && req.method === "DELETE") {
        const revision=Number(url.searchParams.get("baseRevision"));
        if (!Number.isSafeInteger(revision) || revision<0) throw new ApiError(400,"更新番号が必要です。");
        const result=deleteWeek(sql)(key,classId,token,revision);
        return send(res,200,{ok:true,...result}),true;
      }
      throw new ApiError(404,"テストAPIが見つかりません。");
    } catch (err) {
      if (!(err instanceof ApiError)) logError("weekly-plan-test API error",err);
      const status=err instanceof ApiError?err.status:500;
      send(res,status,{ok:false,message:err.message||"テストAPIエラー",...(err.details||{})});
      return true;
    }
  }
  return handle;
}
module.exports={makeHandler,isoDate,weekSlots};
