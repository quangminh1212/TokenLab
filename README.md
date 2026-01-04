# TokenSage - AI Usage Tracker

Ứng dụng Windows để theo dõi token usage và chi phí khi sử dụng các AI IDE như Cursor, Windsurf, Kiro, Copilot...

## Tính năng

- 📊 Dashboard realtime theo dõi usage
- 💰 Tính chi phí tự động cho 350+ models
- 📈 Thống kê theo ngày/tổng
- 📋 Live Log panel
- 🌐 Auto intercept tất cả AI requests (mitmproxy)

## Cài đặt

1. Cài đặt [Node.js 18+](https://nodejs.org/)
2. Cài đặt mitmproxy: `pip install mitmproxy`
3. Chạy `setup.bat`

## Sử dụng

```
run.bat
```

**Lần đầu sử dụng** (cài certificate):
1. Chạy `run.bat`
2. Mở browser, vào http://mitm.it
3. Tải và cài certificate Windows

## Dừng

```
stop.bat
```
hoặc nhấn `Ctrl+C`

## Dashboard

http://localhost:4001

## Data

Dữ liệu lưu trong `data/usage_history.json`
