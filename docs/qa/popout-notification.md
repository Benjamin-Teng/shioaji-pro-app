# 原生子視窗初始化 — #111

macOS arm64 原生 QA 在 public `a5891bc9`／private `409c0d1` 捕捉到熱圖小視窗錯誤：`notification.is_permission_granted not allowed on window popout-depthmap-4`。這與 #106 的 canvas 尺寸問題不同。

Tauri notification 2.3.3 注入每個 WebView 的初始化腳本會查詢 OS 通知權限狀態。macOS/Linux 這條 Promise 沒有 catch，原先只允許 main 的 capability 使子視窗被 ACL 拒絕；若首次渲染較慢，前端啟動防護會顯示錯誤遮罩。

Private PR [#11](https://github.com/Yvictor/shioaji-pro-desktop/pull/11) 在既有 local popout、tray、agent-approval 加入單一唯讀 permission-status 查詢，不擴大通知、OS 授權請求、shell、交易或 HTTP scope，也不吞掉全域錯誤。Public 只 pin 精確 private SHA；private merge 後必須 repin merge SHA 並重跑 Linux/Windows composite。

驗證：

- Claude CLI 實作，獨立 security review APPROVE；7 個 Rust capability 測試、cargo fmt 與 macOS dev build 通過。
- 修正後原生冷開 QA 與真正 desktop-ci／public composite 結果記錄於 paired PR；尚未完成前不能當作通過。
- Linux/Windows 實機、乾淨機器未驗證，CI 不代替原生 QA；不使用真實下單，不發布。
