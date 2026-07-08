/* =========================================================
   MEDTRACK 推播通知後端（Cloud Functions）

   三個觸發點，都是 onCreate（不監聽 update，「時間地點更新」實際上是指
   每一筆任務進度回報，本身就是新增一筆 events 文件，不是修改 tasks
   文件本身）：
   1) tasks 新增 → 通知「新增勤務」（涵蓋一般勤務／待命車／洽公，待命車
      續約時 renewStandbyTask() 也會建立新的 tasks 文件，一樣會觸發）
   2) events 新增 → 通知任務進度回報（出勤/抵達現場/離開現場/返營/抵達
      營區，或洽公對應的出發/抵達/離開/返營）
   3) vitals 新增 → 若生命徵象任一項落在「danger」等級，通知生命徵象異常

   收件人規則（跟前端 RBAC 一致）：高勤官／admin 收全單位的通知；
   主官管／一般成員只收自己單位的通知。三種觸發共用同一套規則。
   ========================================================= */
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const logger = require("firebase-functions/logger");

initializeApp();
const db = getFirestore();

// 跟 Firestore Hosting/Rules 同一個地區設定即可，Cloud Functions 預設
// us-central1，這裡沒有特別理由要換区域，維持預設降低設定複雜度。
setGlobalOptions({ maxInstances: 10 });

// 舊資料可能還留著角色模型改版前的 "company_commander"，前端一律用
// normalizeRole() 轉成 "commander" 再判斷，這裡要跟著做，不然舊帳號
// 會漏掉收不到通知。
function normalizeRole(role) { return role === "company_commander" ? "commander" : role; }

/* =========================================================
   共用：依角色/單位規則找出這個單位的任務該通知誰的 fcmTokens
   ========================================================= */
async function resolveRecipientTokens(taskUnit) {
  const snap = await db.collection("users").get();
  const tokens = new Set();
  snap.forEach((doc) => {
    const u = doc.data();
    if (!Array.isArray(u.fcmTokens) || !u.fcmTokens.length) return;
    const role = normalizeRole(u.role);
    const isBroad = role === "admin" || role === "duty_officer";
    const isUnitScoped = (role === "commander" || role === "member") && u.unit === taskUnit;
    if (isBroad || isUnitScoped) {
      u.fcmTokens.forEach((t) => tokens.add(t));
    }
  });
  return [...tokens];
}

/* =========================================================
   共用：實際送出推播＋清掉失效的 token（使用者解除安裝、清除瀏覽器
   資料、手動關閉通知權限等情況都會讓 token 失效，不清掉的話下次還是
   會白工嘗試送到同一個死掉的 token）
   ========================================================= */
async function sendPush(tokens, title, body) {
  if (!tokens.length) return;
  const messaging = getMessaging();
  let resp;
  try {
    // 故意用 data（純資料）而不是 notification 欄位：背景/鎖屏收到帶
    // notification 欄位的訊息時，瀏覽器本身會自動跳出一則通知，我們的
    // service worker 的 onBackgroundMessage 又會自己再呼叫一次
    // showNotification()，兩邊各顯示一次，同一則推播會變成兩則通知。
    // 全部改成純 data，交給 service worker 自己顯示，只會顯示一次。
    resp = await messaging.sendEachForMulticast({ tokens, data: { title, body } });
  } catch (e) {
    logger.error("推播傳送失敗", e);
    return;
  }
  const invalidTokens = [];
  resp.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error && r.error.code;
      if (code === "messaging/registration-token-not-registered" || code === "messaging/invalid-registration-token") {
        invalidTokens.push(tokens[i]);
      }
    }
  });
  if (invalidTokens.length) await removeInvalidTokens(invalidTokens);
}
async function removeInvalidTokens(invalidTokens) {
  // array-contains-any 一次最多比對 10 個值，保守起見分批查詢。
  for (let i = 0; i < invalidTokens.length; i += 10) {
    const chunk = invalidTokens.slice(i, i + 10);
    try {
      const snap = await db.collection("users").where("fcmTokens", "array-contains-any", chunk).get();
      const batch = db.batch();
      snap.forEach((doc) => {
        const u = doc.data();
        const updated = (u.fcmTokens || []).filter((t) => !invalidTokens.includes(t));
        batch.update(doc.ref, { fcmTokens: updated });
      });
      await batch.commit();
    } catch (e) {
      logger.error("清除失效 token 失敗", e);
    }
  }
}

/* =========================================================
   Eventarc/Pub-Sub 底層是「至少送達一次」，同一個事件在函式冷啟動、處理
   稍微慢一點等情況下可能被重複投遞，導致同一次新增/回報被推播兩三次。
   用 event.id（同一個底層事件重複投遞時這個 id 是同一組）搭配 Firestore
   .create() 的原子性「搶佔」語意做冪等防護：第二次進來時 .create() 一定
   會因為文件已存在而丟出 ALREADY_EXISTS，直接跳過即可。
   ========================================================= */
async function claimEventOnce(eventId) {
  try {
    await db.collection("_pushEventDedup").doc(eventId).create({ processedAt: new Date() });
    return true;
  } catch (e) {
    if (e.code === 6) return false; // ALREADY_EXISTS
    throw e;
  }
}

/* =========================================================
   1) 任務新增
   ========================================================= */
exports.onTaskCreated = onDocumentCreated("tasks/{taskId}", async (event) => {
  if (!(await claimEventOnce(event.id))) return;
  const snap = event.data;
  if (!snap) return;
  const t = snap.data();
  if (!t || !t.unit) return;
  const tokens = await resolveRecipientTokens(t.unit);
  const typeLabel = t.type === "liaison" ? "洽公" : (t.erStandbyKey ? "待命車" : "勤務");
  const title = `新增${typeLabel}`;
  const body = [t.title, t.location].filter(Boolean).join("：") || `已建立新的${typeLabel}`;
  await sendPush(tokens, title, body);
});

/* =========================================================
   2) 任務進度回報（events 新增）
   ========================================================= */
const EVENT_LABELS = {
  DISPATCH: "出勤",
  ARRIVED_SCENE: "抵達現場",
  DEPART_SCENE: "離開現場",
  RETURNING: "返營",
  COMPLETED: "抵達營區",
};
exports.onEventCreated = onDocumentCreated("events/{eventId}", async (event) => {
  if (!(await claimEventOnce(event.id))) return;
  const snap = event.data;
  if (!snap) return;
  const e = snap.data();
  if (!e || !e.taskId) return;
  const taskSnap = await db.doc(`tasks/${e.taskId}`).get();
  if (!taskSnap.exists) return;
  const t = taskSnap.data();
  const tokens = await resolveRecipientTokens(t.unit);
  const label = EVENT_LABELS[e.type] || e.type;
  const title = `${t.title || "勤務"} - ${label}`;
  const body = [t.vehicle, e.location || e.hospital].filter(Boolean).join(" @ ") || t.location || "";
  await sendPush(tokens, title, body);
});

/* =========================================================
   3) 患者生命徵象危急異常（vitals 新增）
   門檻值照抄前端 index.html 的 hrSeverity/rrSeverity/spo2Severity/
   bpSeverity/tempSeverity/gcsSeverity/consciousnessSeverity，兩邊
   如果以後要調整危急門檻，記得兩邊要一起改。
   ========================================================= */
function hrDanger(n) { return !isNaN(n) && !(n >= 50 && n <= 120); }
function rrDanger(n) { return !isNaN(n) && !(n >= 8 && n <= 24); }
function spo2Danger(n) { return !isNaN(n) && n < 90; }
function tempDanger(n) { return !isNaN(n) && !(n >= 35 && n <= 38.5); }
function bpDanger(bpStr) {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec((bpStr || "").trim());
  if (!m) return false;
  const sys = Number(m[1]), dia = Number(m[2]);
  return !(sys >= 80 && sys < 160) || !(dia >= 50 && dia < 100);
}
function gcsTotalFromString(gcsStr) {
  const s = gcsStr || "";
  const totalMatch = /(\d+)\s*分/.exec(s);
  if (totalMatch) return Number(totalMatch[1]);
  const evm = /E(\d).*V(\d).*M(\d)/.exec(s);
  if (evm) return Number(evm[1]) + Number(evm[2]) + Number(evm[3]);
  if (/^\d+$/.test(s.trim())) return Number(s.trim());
  return NaN;
}
function gcsDanger(gcsStr) {
  const total = gcsTotalFromString(gcsStr);
  return !isNaN(total) && total < 9;
}
function consciousnessDanger(c) { return c === "否"; }
function isVitalsDanger(v) {
  return (
    consciousnessDanger(v.consciousness) ||
    bpDanger(v.bp) ||
    hrDanger(Number(v.hr)) ||
    spo2Danger(Number(v.spo2)) ||
    rrDanger(Number(v.rr)) ||
    tempDanger(Number(v.temp)) ||
    gcsDanger(v.gcs)
  );
}
exports.onVitalsCreated = onDocumentCreated("vitals/{vitalsId}", async (event) => {
  if (!(await claimEventOnce(event.id))) return;
  const snap = event.data;
  if (!snap) return;
  const v = snap.data();
  if (!v || !v.taskId || !isVitalsDanger(v)) return;
  const taskSnap = await db.doc(`tasks/${v.taskId}`).get();
  if (!taskSnap.exists) return;
  const t = taskSnap.data();
  const tokens = await resolveRecipientTokens(t.unit);
  await sendPush(tokens, "患者生命徵象異常", `${t.title || "勤務"}：患者生命徵象出現危急異常，請留意`);
});

// 純函式/資料存取邏輯額外匯出一份，方便寫單元測試直接呼叫驗證（不會
// 影響部署——firebase deploy 只認得用 onDocumentCreated 等 v2 trigger
// builder 包起來的 exports，這個純物件會被忽略，不會變成多一個雲端函式）。
exports._internal = { normalizeRole, resolveRecipientTokens, isVitalsDanger, gcsTotalFromString, claimEventOnce };
