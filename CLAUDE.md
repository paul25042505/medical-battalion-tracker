# 專案筆記

單一 HTML 檔案（`index.html`）的 vanilla JS + Firebase 應用，無建置流程，
透過 GitHub Actions 部署到 Firebase Hosting + Firestore Rules。

## 出貨檢查清單（每次 PR 都要做）

1. 修改 `index.html`
2. Bump `BUILD_TAG`（格式 `"YYYY-MM-DD-NN-短描述"`）
3. 在 `RELEASE_NOTES`（`index.html` 內，`FEEDBACK_CATEGORY_LABEL` 附近）補一筆
   當天的異動摘要——同一天有多筆出貨就更新同一筆日期的 `summary`，不要
   重複開新的日期項目。這樣「關於系統 → 更新紀錄」才會跟著實際出貨內容走。
   - 系統版本／Build／發布日期／最後更新已經改成從 `BUILD_TAG` 自動解析
     （見 `appVersion()`／`buildTagDate()`）。系統版本是「主.次.修訂」
     （`APP_MAJOR_MINOR` + BUILD_TAG 流水號），修訂號每次出貨自動加一，
     主/次版號只有重大改版才需要手動調整 `APP_MAJOR_MINOR`。
4. `node --check` 驗證抽出的 `<script type="module">` 語法
5. 用 Playwright 對照修改到的畫面做離線驗證（複製到 scratchpad、抽掉
   Firebase import、注入 debug hook 後開瀏覽器測試）
6. commit → rebase origin/main → push → 開 PR → squash merge
