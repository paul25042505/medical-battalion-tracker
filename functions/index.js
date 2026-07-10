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

/* =========================================================
   4) 預先建立人員帳號：管理員可以先幫還沒登入過的成員預建一筆資料
   （role:"unclaimed"，含 email），對方第一次用該 email 登入時，前端會在
   users/{uid} 建立一筆 role:"pending" 的新帳號（見 index.html 的
   onAuthStateChanged）。這裡監聽 users 新增，只處理「使用者自己登入建立
   的 pending 帳號」這種情況（role:"unclaimed" 的預建文件本身被建立時
   也會觸發這個 trigger，用 role !== "pending" 直接跳過，避免處理到自己）：
   比對 email 找有沒有相符的 role:"unclaimed" 預建資料，有的話直接把
   單位/階級/電話/EMT證照寫回這個新帳號、角色設成一般成員，不用等管理員
   手動審核；同時刪掉那筆預建文件（人員名冊與帳號已經合併成同一份
   users 集合，不用再另外維護一份 mirror）。

   一定要用 client 端無法做到的方式（Cloud Function 的後台權限）才能查
   其他 unclaimed 文件：一個全新、還沒被指派單位的帳號，依 firestore.rules
   （sameUnit() 需要先有單位才能讀取其他人的 users 文件），沒有權限自己
   查有沒有預建資料，只能靠後端用 Admin SDK（不受安全規則限制）代為比對。

   信箱比對前先轉小寫、去頭尾空白，避免大小寫或多打空格造成配對不到；
   有重複信箱的預建資料只會取第一筆，不特別擋（表單目前也沒做唯一性
   檢查）。沒有 unit 的預建資料理論上不會發生（新增人員的表單一定要選
   單位），這裡不另外防呆。 ========================================= */
exports.onUserCreated = onDocumentCreated("users/{uid}", async (event) => {
  if (!(await claimEventOnce(event.id))) return;
  const snap = event.data;
  if (!snap) return;
  const uid = event.params.uid;
  const u = snap.data();
  if (!u || u.role !== "pending") return;
  const email = u.email ? String(u.email).trim().toLowerCase() : "";
  if (!email) return;
  const match = await db.collection("users").where("role", "==", "unclaimed").where("email", "==", email).limit(1).get();
  if (match.empty) return;
  const doc = match.docs[0];
  const person = doc.data();
  const batch = db.batch();
  batch.set(db.collection("users").doc(uid), {
    role: "member",
    unit: person.unit || "",
    rank: person.rank || "",
    phone: person.phone || "",
    emtLevel: person.emtLevel || "",
    displayName: u.displayName || person.displayName || "",
  }, { merge: true });
  batch.delete(doc.ref);
  await batch.commit();
  logger.info(`帳號 ${uid}（${email}）比對到預建人員資料，已自動指派單位 ${person.unit}`);
});

/* =========================================================
   5)【一次性遷移，跑完後要整支移除】把合併前的 personnel 集合資料轉進
   users 集合。只能由 admin 呼叫：帶 Authorization: Bearer <Firebase ID
   token>（登入後在瀏覽器 devtools 執行
   `await firebase.auth().currentUser.getIdToken()` 取得），函式會驗證
   token 並確認呼叫者在 users 集合裡的 role 是 "admin" 才會執行——不需要
   額外另外設定密鑰，直接沿用既有的帳號權限模型。

   對每一筆 personnel 文件：
   - 文件 id 已經有對應的 users/{uid} 帳號（早期 syncPersonnelFromUsers
     產生、id 就是真實 uid）→ 把名冊欄位併回那筆帳號文件，不動 role/email。
   - 沒有對應帳號（純花名冊資料）→ 用同一個文件 id 在 users 建一筆
     role:"unclaimed" 的新文件，等本人之後登入被上面的 onUserCreated 認領。
   處理完就把原本的 personnel 文件刪掉。
   ========================================================= */
const { onRequest } = require("firebase-functions/v2/https");
const { getAuth } = require("firebase-admin/auth");
exports.migratePersonnelToUsers = onRequest(async (req, res) => {
  try {
    const authHeader = req.get("Authorization") || "";
    const m = /^Bearer (.+)$/.exec(authHeader);
    if (!m) { res.status(401).send("missing bearer token"); return; }
    const decoded = await getAuth().verifyIdToken(m[1]);
    const callerDoc = await db.collection("users").doc(decoded.uid).get();
    if (!callerDoc.exists || callerDoc.data().role !== "admin") {
      res.status(403).send("admin only");
      return;
    }
    const personnelSnap = await db.collection("personnel").get();
    let merged = 0, createdUnclaimed = 0;
    for (const doc of personnelSnap.docs) {
      const p = doc.data();
      const existing = await db.collection("users").doc(doc.id).get();
      if (existing.exists) {
        await db.collection("users").doc(doc.id).set({
          displayName: p.name || existing.data().displayName || "",
          rank: p.title || "",
          phone: p.phone || "",
          emtLevel: p.emtLevel || "",
        }, { merge: true });
        merged++;
      } else {
        await db.collection("users").doc(doc.id).set({
          displayName: p.name || "",
          rank: p.title || "",
          phone: p.phone || "",
          emtLevel: p.emtLevel || "",
          unit: p.unit || "",
          email: p.email ? String(p.email).trim().toLowerCase() : "",
          role: "unclaimed",
          fcmTokens: [],
          createdAt: new Date(),
        });
        createdUnclaimed++;
      }
      await doc.ref.delete();
    }
    res.status(200).json({ ok: true, merged, createdUnclaimed, total: personnelSnap.size });
  } catch (e) {
    logger.error("人員資料遷移失敗", e);
    res.status(500).send(String(e && e.message || e));
  }
});

// 純函式/資料存取邏輯額外匯出一份，方便寫單元測試直接呼叫驗證（不會
// 影響部署——firebase deploy 只認得用 onDocumentCreated 等 v2 trigger
// builder 包起來的 exports，這個純物件會被忽略，不會變成多一個雲端函式）。
exports._internal = { normalizeRole, resolveRecipientTokens, isVitalsDanger, gcsTotalFromString, claimEventOnce };
