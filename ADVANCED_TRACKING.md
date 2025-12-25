# TokenSage - Advanced Usage Tracking Guide

## 🎯 Mục tiêu: Track usage của Cursor AI built-in và Antigravity/Gemini

Cả hai đều sử dụng internal APIs không đi qua HTTP proxy thông thường:
- **Cursor AI**: `api2.cursor.sh` (gRPC/HTTP2)
- **Antigravity/Gemini**: Internal Google API

---

## 📊 PHƯƠNG PHÁP 1: Online Dashboards (Đơn giản nhất)

### Cursor Usage
1. Truy cập: https://cursor.com/dashboard
2. Đăng nhập với tài khoản Cursor
3. Xem: Usage, Requests, Billing

### Gemini/Antigravity Usage
1. Truy cập: https://aistudio.google.com
2. Đăng nhập với Google Account
3. Vào: Dashboard > Usage and Billing

---

## 🔧 PHƯƠNG PHÁP 2: System-Wide Proxy với Fiddler (Khuyên dùng)

### Bước 1: Cài Fiddler Everywhere
```powershell
# Download từ https://www.telerik.com/download/fiddler-everywhere
# Hoặc dùng winget:
winget install Telerik.Fiddler.Everywhere
```

### Bước 2: Cấu hình Fiddler
1. Mở Fiddler Everywhere
2. Vào Settings > HTTPS > Enable "Capture HTTPS traffic"
3. Trust Fiddler certificate
4. Bật "System Proxy" trong Traffic pane

### Bước 3: Xem Traffic
- Tất cả requests từ Cursor, Antigravity sẽ hiển thị
- Filter: `api2.cursor.sh` cho Cursor AI
- Filter: `generativelanguage.googleapis.com` cho Gemini

---

## 🔧 PHƯƠNG PHÁP 3: mitmproxy (Advanced - Free)

### Bước 1: Cài mitmproxy
```powershell
pip install mitmproxy
```

### Bước 2: Chạy mitmproxy với gRPC support
```powershell
# Chạy với transparent mode
mitmweb --mode regular --listen-port 8080

# Hoặc chạy CLI mode với gRPC decode
mitmdump --mode regular -p 8080 --set flow_detail=3
```

### Bước 3: Cấu hình Windows Proxy
```powershell
# Set system proxy
netsh winhttp set proxy 127.0.0.1:8080

# Hoặc trong Settings > Network > Proxy
# Manual proxy: 127.0.0.1:8080
```

### Bước 4: Trust mitmproxy certificate
1. Truy cập http://mitm.it trong browser
2. Download certificate cho Windows
3. Install vào Trusted Root Certification Authorities

### Lưu ý quan trọng:
- Một số apps như Cursor có thể bypass system proxy
- Cần verify certificate trust

---

## 🔧 PHƯƠNG PHÁP 4: Proxifier (Force All Apps Through Proxy)

Proxifier có thể buộc TẤT CẢ applications đi qua proxy, kể cả những app không respect system proxy.

### Bước 1: Download Proxifier
- https://www.proxifier.com/ (Paid, có trial)

### Bước 2: Cấu hình
1. Add Proxy Server: 127.0.0.1:4000 (TokenSage) hoặc 127.0.0.1:8080 (mitmproxy)
2. Create Rule: 
   - Application: Cursor.exe, Antigravity.exe
   - Action: Direct qua proxy đã thêm

---

## 🔧 PHƯƠNG PHÁP 5: DNS-Level Interception (Advanced)

### Sử dụng Pi-hole hoặc local DNS
1. Redirect `api2.cursor.sh` → localhost
2. Chạy reverse proxy capture ở localhost

**Không khuyên dùng**: Phức tạp và có thể break functionality.

---

## 📊 PHƯƠNG PHÁP 6: Custom TokenSage với gRPC Support

Nâng cấp TokenSage để hỗ trợ gRPC proxy:

```typescript
// Cần thêm grpc-tools và grpc-js
// Tạo gRPC reverse proxy
```

---

## ✅ KHUYẾN NGHỊ

| Nhu cầu | Phương pháp |
|---------|------------|
| Đơn giản, nhanh | Online Dashboards |
| Xem chi tiết requests | Fiddler Everywhere |
| Free, advanced | mitmproxy |
| Force tất cả apps | Proxifier + mitmproxy |

---

## 🚀 Quick Start với Fiddler

1. Download: https://www.telerik.com/download/fiddler-everywhere
2. Install & Run
3. Enable System Proxy
4. Dùng Cursor/Antigravity bình thường
5. Xem traffic trong Fiddler

Fiddler là cách dễ nhất để track TẤT CẢ traffic bao gồm gRPC!
