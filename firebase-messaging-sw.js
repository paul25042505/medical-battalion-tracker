// 推播通知背景接收（App 沒開著/手機鎖屏時也要能收到）。這裡是獨立的
// Service Worker context，沒辦法跟 index.html 共用 module scope，firebaseConfig
// 只好重複貼一份——這些都是公開的用戶端設定值，不是密鑰，重複並不會有
// 安全疑慮。改用 Firebase 的 compat SDK（importScripts 載入），因為
// Service Worker 對 ES module worker 的支援度不像一般網頁那麼一致。
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDHJ_ZVLwl9-bD-ZPCTsBcfSjK1A15oJN4",
  authDomain: "medical-battalion-tracker.firebaseapp.com",
  projectId: "medical-battalion-tracker",
  storageBucket: "medical-battalion-tracker.firebasestorage.app",
  messagingSenderId: "442272611220",
  appId: "1:442272611220:web:88ef96f7789200c27ded81"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || "MEDTRACK 通知";
  const body = (payload.notification && payload.notification.body) || "";
  self.registration.showNotification(title, {
    body,
    icon: "icons/apple-touch-icon.png",
    badge: "icons/favicon-32.png"
  });
});

// 點通知時把使用者帶回已經開著的分頁（沒有就開一個新的），不然點了
// 通知常常會誤以為「沒反應」。
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (clients.openWindow) return clients.openWindow("/");
    })
  );
});
