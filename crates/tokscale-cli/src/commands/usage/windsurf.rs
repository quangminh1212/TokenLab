use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::Command;
use std::time::Duration;

use super::{UsageMetric, UsageOutput};

#[derive(Debug, Deserialize)]
struct WindsurfAuthStatus {
    #[serde(rename = "apiKey")]
    api_key: Option<String>,
}

fn windsurf_db_paths() -> Vec<std::path::PathBuf> {
    let mut paths = Vec::new();
    if let Some(config) = dirs::config_dir() {
        paths.push(
            config
                .join("Windsurf")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
        );
        paths.push(
            config
                .join("Windsurf - Next")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
        );
    }
    paths
}

fn read_api_key() -> Result<String> {
    for db_path in windsurf_db_paths() {
        if !db_path.exists() {
            continue;
        }
        let Ok(conn) = rusqlite::Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) else {
            continue;
        };
        let Ok(value) = conn.query_row(
            "SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'",
            [],
            |row| row.get::<_, String>(0),
        ) else {
            continue;
        };
        if let Ok(auth) = serde_json::from_str::<WindsurfAuthStatus>(&value) {
            if let Some(key) = auth.api_key {
                if key.starts_with("sk-ws-") && !key.is_empty() {
                    return Ok(key);
                }
            }
        }
    }
    anyhow::bail!("No Windsurf API key found. Install Windsurf and sign in.")
}

pub fn has_credentials() -> bool {
    read_api_key().is_ok()
}

fn build_metrics(plan_status: &serde_json::Value) -> Vec<UsageMetric> {
    let plan_end = plan_status
        .get("planEnd")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let mut metrics = Vec::new();

    if let Some(metric) = build_credit_metric(plan_status, "Prompt Credits", "availablePromptCredits", "usedPromptCredits", &plan_end) {
        metrics.push(metric);
    }

    if let Some(metric) = build_credit_metric(plan_status, "Flex Credits", "availableFlexCredits", "usedFlexCredits", &plan_end) {
        metrics.push(metric);
    }

    metrics
}

fn build_credit_metric(
    plan_status: &serde_json::Value,
    label: &str,
    available_key: &str,
    used_key: &str,
    plan_end: &Option<String>,
) -> Option<UsageMetric> {
    let available_raw = plan_status.get(available_key).and_then(|v| v.as_i64())?;
    if available_raw < 0 {
        return None;
    }
    let used_raw = plan_status
        .get(used_key)
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    if used_raw < 0 {
        return None;
    }
    let total_raw = available_raw + used_raw;
    if total_raw == 0 {
        return None;
    }

    let used_pct = (used_raw as f64 / total_raw as f64 * 100.0).clamp(0.0, 100.0);
    let remaining_pct = (100.0 - used_pct).clamp(0.0, 100.0);
    let available_display = available_raw as f64 / 100.0;
    let total_display = total_raw as f64 / 100.0;

    Some(UsageMetric {
        label: label.into(),
        used_percent: used_pct,
        remaining_percent: remaining_pct,
        remaining_label: Some(format!("{available_display:.0} / {total_display:.0} credits")),
        resets_at: plan_end.clone(),
    })
}

async fn fetch_model_analytics(
    client: &reqwest::Client,
    api_key: &str,
) -> Result<HashMap<String, f64>> {
    let resp = client
        .post("https://web-backend.windsurf.com/exa.user_analytics_pb.UserAnalyticsService/GetAnalytics")
        .header("Content-Type", "application/json")
        .header("Connect-Protocol-Version", "1")
        .json(&serde_json::json!({
            "metadata": {
                "apiKey": api_key,
                "ideName": "windsurf",
                "ideVersion": "0.0.0",
                "extensionName": "windsurf",
                "extensionVersion": "0.0.0",
                "locale": "en"
            },
            "queryRequests": [
                {"cascadeRuns": {}}
            ]
        }))
        .send()
        .await;

    let resp = match resp {
        Ok(r) => r,
        Err(_) => return Ok(HashMap::new()),
    };

    if !resp.status().is_success() {
        return Ok(HashMap::new());
    }

    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);

    let mut model_credits: HashMap<String, f64> = HashMap::new();

    if let Some(results) = body.get("queryResults").and_then(|v| v.as_array()) {
        for result in results {
            if let Some(runs) = result
                .get("cascadeRuns")
                .and_then(|v| v.get("cascadeRuns"))
                .and_then(|v| v.as_array())
            {
                for run in runs {
                    let model = run
                        .get("model")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown");
                    let prompts_used = run
                        .get("promptsUsed")
                        .and_then(|v| v.as_str())
                        .and_then(|s| s.parse::<f64>().ok())
                        .or_else(|| run.get("promptsUsed").and_then(|v| v.as_f64()))
                        .unwrap_or(0.0);
                    *model_credits.entry(model.to_string()).or_insert(0.0) += prompts_used / 100.0;
                }
            }
        }
    }

    Ok(model_credits)
}

fn build_model_metrics(model_credits: &HashMap<String, f64>) -> Vec<UsageMetric> {
    if model_credits.is_empty() {
        return Vec::new();
    }

    let total: f64 = model_credits.values().sum();
    if total <= 0.0 {
        return Vec::new();
    }

    let mut entries: Vec<(String, f64)> =
        model_credits.iter().map(|(k, v)| (k.clone(), *v)).collect();
    entries.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    entries
        .into_iter()
        .map(|(model, credits)| {
            let pct = (credits / total * 100.0).clamp(0.0, 100.0);
            UsageMetric {
                label: format!("Model: {model}"),
                used_percent: pct,
                remaining_percent: (100.0 - pct).clamp(0.0, 100.0),
                remaining_label: Some(format!("{credits:.1} credits")),
                resets_at: None,
            }
        })
        .collect()
}

// --- Local process discovery (Cockpit-style bridge) ---
// Discover running Windsurf language server, connect via TCP,
// and call GetUserStatus locally instead of cloud API.

struct WindsurfConnection {
    port: u16,
    csrf_token: String,
}

fn is_windsurf_process(command: &str) -> bool {
    let lower = command.to_lowercase();
    (lower.contains("language_server") && lower.contains("windsurf"))
        || lower.contains("--app_data_dir windsurf")
        || lower.contains("\\windsurf\\")
        || lower.contains("/windsurf/")
}

fn extract_csrf_token(command: &str) -> Option<String> {
    for part in command.split_whitespace() {
        if let Some(value) = part.strip_prefix("--csrf_token=") {
            if value.len() >= 16 {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn extract_declared_port(command: &str) -> Option<u16> {
    for part in command.split_whitespace() {
        if let Some(value) = part.strip_prefix("--extension_server_port=") {
            if let Ok(port) = value.parse::<u16>() {
                return Some(port);
            }
        }
    }
    None
}

fn discover_windsurf_processes() -> Vec<(u32, Option<u16>, String)> {
    let output = if cfg!(target_os = "windows") {
        Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
            ])
            .output()
    } else {
        Command::new("ps")
            .args(["-ww", "-eo", "pid,args"])
            .output()
    };

    let output = match output {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).to_string(),
        _ => return Vec::new(),
    };

    let mut candidates = Vec::new();

    if cfg!(target_os = "windows") {
        let value: serde_json::Value = match serde_json::from_str(output.trim()) {
            Ok(v) => v,
            Err(_) => return Vec::new(),
        };
        let items: Vec<&serde_json::Value> = match &value {
            serde_json::Value::Array(arr) => arr.iter().collect(),
            serde_json::Value::Object(_) => vec![&value],
            _ => return Vec::new(),
        };
        for item in items {
            let pid = item.get("ProcessId").and_then(|v| v.as_u64()).and_then(|v| u32::try_from(v).ok());
            let command = item.get("CommandLine").and_then(|v| v.as_str()).unwrap_or_default();
            if let Some(pid) = pid {
                if is_windsurf_process(command) {
                    if let Some(csrf) = extract_csrf_token(command) {
                        let port = extract_declared_port(command);
                        candidates.push((pid, port, csrf));
                    }
                }
            }
        }
    } else {
        for line in output.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() < 2 { continue; }
            let Ok(pid) = parts[0].parse::<u32>() else { continue };
            let command = parts[1..].join(" ");
            if is_windsurf_process(&command) {
                if let Some(csrf) = extract_csrf_token(&command) {
                    let port = extract_declared_port(&command);
                    candidates.push((pid, port, csrf));
                }
            }
        }
    }

    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    candidates.dedup_by(|a, b| a.0 == b.0);
    candidates
}

fn find_listening_ports(pid: u32) -> Vec<u16> {
    if cfg!(target_os = "windows") {
        let output = Command::new("netstat")
            .args(["-ano", "-p", "TCP"])
            .output();
        let output = match output {
            Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
            Err(_) => return Vec::new(),
        };
        let pid_str = pid.to_string();
        let mut ports = Vec::new();
        for line in output.lines() {
            let trimmed = line.trim();
            if !trimmed.contains("LISTENING") { continue; }
            if !trimmed.ends_with(&pid_str) { continue; }
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            if parts.len() < 4 { continue; }
            if let Some(addr) = parts.get(1) {
                if let Some(port_str) = addr.rsplit(':').next() {
                    if let Ok(port) = port_str.parse::<u16>() {
                        if !ports.contains(&port) {
                            ports.push(port);
                        }
                    }
                }
            }
        }
        ports
    } else {
        let output = Command::new("lsof")
            .args(["-iTCP", "-sTCP:LISTEN", "-P", "-n"])
            .output();
        let output = match output {
            Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
            Err(_) => return Vec::new(),
        };
        let pid_str = pid.to_string();
        let mut ports = Vec::new();
        for line in output.lines() {
            if !line.contains(&pid_str) { continue; }
            if let Some(addr_part) = line.split_whitespace().nth(8) {
                if let Some(port_str) = addr_part.rsplit(':').next() {
                    if let Ok(port) = port_str.parse::<u16>() {
                        if !ports.contains(&port) {
                            ports.push(port);
                        }
                    }
                }
            }
        }
        ports
    }
}

fn probe_windsurf_heartbeat(port: u16, csrf_token: &str) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    let Ok(socket_addr) = addr.parse::<std::net::SocketAddr>() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&socket_addr, Duration::from_secs(2)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));

    let body = r#"{"uuid":"00000000-0000-0000-0000-000000000000"}"#;
    let request = format!(
        "POST /exa.language_server_pb.LanguageServerService/Heartbeat HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnect-Protocol-Version: 1\r\nX-Codeium-Csrf-Token: {}\r\nConnection: close\r\n\r\n{}",
        port, body.len(), csrf_token, body
    );

    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }

    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    if reader.read_line(&mut status_line).is_err() {
        return false;
    }

    status_line
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse::<u16>().ok())
        .is_some_and(|s| s == 200)
}

fn discover_windsurf_connections() -> Vec<WindsurfConnection> {
    let processes = discover_windsurf_processes();
    let mut connections = Vec::new();

    for (pid, declared_port, csrf_token) in processes {
        let mut ports = find_listening_ports(pid);
        if let Some(dp) = declared_port {
            if !ports.contains(&dp) {
                ports.insert(0, dp);
            }
        }

        for port in ports {
            if probe_windsurf_heartbeat(port, &csrf_token) {
                connections.push(WindsurfConnection { port, csrf_token });
                break;
            }
        }
    }

    connections
}

fn local_rpc_get_user_status(conn: &WindsurfConnection, api_key: &str) -> Result<serde_json::Value> {
    let mut stream = TcpStream::connect(("127.0.0.1", conn.port))
        .with_context(|| format!("Failed to connect to Windsurf RPC on port {}", conn.port))?;
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;

    let body = serde_json::json!({
        "metadata": {
            "apiKey": api_key,
            "ideName": "windsurf",
            "ideVersion": "0.0.0",
            "extensionName": "windsurf",
            "extensionVersion": "0.0.0",
            "locale": "en"
        }
    });
    let body_text = serde_json::to_string(&body)?;
    let request = format!(
        "POST /exa.seat_management_pb.SeatManagementService/GetUserStatus HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnect-Protocol-Version: 1\r\nX-Codeium-Csrf-Token: {}\r\nConnection: close\r\n\r\n{}",
        conn.port, body_text.len(), conn.csrf_token, body_text
    );

    stream.write_all(request.as_bytes())?;

    let mut reader = BufReader::new(stream);
    let mut status_line = String::new();
    reader.read_line(&mut status_line)?;

    let status_code = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse::<u16>().ok())
        .ok_or_else(|| anyhow::anyhow!("Malformed HTTP response from Windsurf RPC"))?;

    let mut content_length: Option<usize> = None;
    let mut chunked = false;
    loop {
        let mut header = String::new();
        reader.read_line(&mut header)?;
        let trimmed = header.trim();
        if trimmed.is_empty() { break; }
        let lower = trimmed.to_ascii_lowercase();
        if let Some(value) = lower.strip_prefix("content-length:") {
            content_length = value.trim().parse::<usize>().ok();
        }
        if lower.contains("transfer-encoding") && lower.contains("chunked") {
            chunked = true;
        }
    }

    let response_body = if chunked {
        read_chunked_body(&mut reader)?
    } else if let Some(length) = content_length {
        let mut bytes = vec![0_u8; length];
        reader.read_exact(&mut bytes)?;
        String::from_utf8(bytes)?
    } else {
        let mut text = String::new();
        reader.by_ref().take(1024 * 1024).read_to_string(&mut text)?;
        text
    };

    if status_code != 200 {
        anyhow::bail!("Windsurf local RPC failed with status {}: {}", status_code, response_body);
    }

    Ok(serde_json::from_str(&response_body)?)
}

fn read_chunked_body(reader: &mut BufReader<TcpStream>) -> Result<String> {
    let mut body = Vec::new();
    loop {
        let mut size_line = String::new();
        reader.read_line(&mut size_line)?;
        let size = usize::from_str_radix(size_line.trim(), 16).unwrap_or(0);
        if size == 0 { break; }
        let mut chunk = vec![0_u8; size];
        reader.read_exact(&mut chunk)?;
        body.extend_from_slice(&chunk);
        let mut crlf = [0_u8; 2];
        let _ = reader.read_exact(&mut crlf);
    }
    Ok(String::from_utf8(body)?)
}

fn read_account_info() -> Option<(String, String)> {
    for db_path in windsurf_db_paths() {
        if !db_path.exists() { continue; }
        let Ok(conn) = rusqlite::Connection::open_with_flags(
            &db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) else { continue };

        // Try reading email from windsurfAuthStatus
        if let Ok(value) = conn.query_row(
            "SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus'",
            [], |row| row.get::<_, String>(0),
        ) {
            if let Ok(auth) = serde_json::from_str::<serde_json::Value>(&value) {
                let email = auth.get("email").and_then(|v| v.as_str()).map(String::from);
                let name = auth.get("name").and_then(|v| v.as_str()).map(String::from);
                if let Some(email) = email {
                    return Some((email, name.unwrap_or_default()));
                }
            }
        }

        // Try reading from other keys
        for key in ["windsurf.user.email", "windsurf.user.name", "codeium.userEmail"] {
            if let Ok(value) = conn.query_row(
                "SELECT value FROM ItemTable WHERE key = ?",
                [&key], |row| row.get::<_, String>(0),
            ) {
                if !value.is_empty() && value.contains('@') {
                    return Some((value, String::new()));
                }
            }
        }
    }
    None
}

// --- Main fetch with fallback: local RPC → cloud API → SQLite ---

pub fn fetch() -> Result<UsageOutput> {
    let api_key = read_api_key()?;
    let (email, account_name) = read_account_info().unwrap_or((String::new(), String::new()));

    // Try local RPC first (Cockpit-style: talk to running process)
    let local_connections = discover_windsurf_connections();
    for conn in &local_connections {
        if let Ok(body) = local_rpc_get_user_status(conn, &api_key) {
            if let Some(plan_status) = body.get("userStatus").and_then(|v| v.get("planStatus")) {
                let plan_name = plan_status
                    .get("planInfo")
                    .and_then(|v| v.get("planName"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown");

                let mut metrics = build_metrics(plan_status);
                if !metrics.is_empty() {
                    // Try per-model analytics from cloud (best-effort)
                    let rt = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()?;
                    let model_credits = rt.block_on(async {
                        let client = reqwest::Client::builder()
                            .timeout(std::time::Duration::from_secs(10))
                            .build()
                            .ok()?;
                        fetch_model_analytics(&client, &api_key).await.ok()
                    }).unwrap_or_default();
                    metrics.extend(build_model_metrics(&model_credits));

                    return Ok(UsageOutput {
                        provider: "Windsurf".into(),
                        account: if account_name.is_empty() { None } else { Some(super::UsageAccount {
                            id: email.clone(),
                            label: Some(account_name),
                            is_active: true,
                        }) },
                        plan: Some(plan_name.to_string()),
                        email: if email.is_empty() { None } else { Some(email) },
                        metrics,
                        reset_credits: None,
                        credit_status: None,
                        spend_control: None,
                    });
                }
            }
        }
    }

    // Fallback: cloud API
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;

    rt.block_on(async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()?;

        let resp = client
            .post("https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus")
            .header("Content-Type", "application/json")
            .header("Connect-Protocol-Version", "1")
            .json(&serde_json::json!({
                "metadata": {
                    "apiKey": api_key,
                    "ideName": "windsurf",
                    "ideVersion": "0.0.0",
                    "extensionName": "windsurf",
                    "extensionVersion": "0.0.0",
                    "locale": "en"
                }
            }))
            .send()
            .await?;

        if !resp.status().is_success() {
            anyhow::bail!("Windsurf usage request failed (HTTP {})", resp.status());
        }

        let body: serde_json::Value = resp.json().await?;

        let plan_status = body
            .get("userStatus")
            .and_then(|v| v.get("planStatus"))
            .ok_or_else(|| anyhow::anyhow!("Missing planStatus in Windsurf response"))?;

        let plan_name = plan_status
            .get("planInfo")
            .and_then(|v| v.get("planName"))
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown");

        let mut metrics = build_metrics(plan_status);
        if metrics.is_empty() {
            anyhow::bail!("Windsurf returned no parseable usage data");
        }

        let model_credits = fetch_model_analytics(&client, &api_key).await.unwrap_or_default();
        metrics.extend(build_model_metrics(&model_credits));

        Ok(UsageOutput {
            provider: "Windsurf".into(),
            account: if account_name.is_empty() { None } else { Some(super::UsageAccount {
                id: email.clone(),
                label: Some(account_name),
                is_active: true,
            }) },
            plan: Some(plan_name.to_string()),
            email: if email.is_empty() { None } else { Some(email) },
            metrics,
            reset_credits: None,
            credit_status: None,
            spend_control: None,
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn build_metrics_parses_prompt_and_flex_credits() {
        let plan_status = json!({
            "planInfo": { "planName": "Pro" },
            "planStart": "2026-01-18T09:07:17Z",
            "planEnd": "2026-02-18T09:07:17Z",
            "availablePromptCredits": 45300,
            "usedPromptCredits": 4700,
            "availableFlexCredits": 2679300,
            "usedFlexCredits": 175550
        });

        let metrics = build_metrics(&plan_status);
        assert_eq!(metrics.len(), 2);

        let prompt = &metrics[0];
        assert_eq!(prompt.label, "Prompt Credits");
        assert!((prompt.used_percent - 9.4).abs() < 0.1);
        assert_eq!(prompt.resets_at.as_deref(), Some("2026-02-18T09:07:17Z"));

        let flex = &metrics[1];
        assert_eq!(flex.label, "Flex Credits");
        assert!((flex.used_percent - 6.14).abs() < 0.1);
    }

    #[test]
    fn build_metrics_skips_negative_available() {
        let plan_status = json!({
            "availablePromptCredits": -1,
            "usedPromptCredits": 0,
            "availableFlexCredits": 100,
            "usedFlexCredits": 50
        });

        let metrics = build_metrics(&plan_status);
        assert_eq!(metrics.len(), 1);
        assert_eq!(metrics[0].label, "Flex Credits");
    }

    #[test]
    fn build_metrics_skips_zero_total() {
        let plan_status = json!({
            "availablePromptCredits": 0,
            "usedPromptCredits": 0,
            "availableFlexCredits": 0,
            "usedFlexCredits": 0
        });

        let metrics = build_metrics(&plan_status);
        assert!(metrics.is_empty());
    }

    #[test]
    fn build_metrics_handles_missing_fields() {
        let plan_status = json!({});
        let metrics = build_metrics(&plan_status);
        assert!(metrics.is_empty());
    }

    #[test]
    fn credit_display_divides_by_100() {
        let plan_end = Some("2026-02-18T09:07:17Z".to_string());
        let metric = build_credit_metric(
            &json!({
                "availablePromptCredits": 50000,
                "usedPromptCredits": 0
            }),
            "Prompt Credits",
            "availablePromptCredits",
            "usedPromptCredits",
            &plan_end,
        )
        .unwrap();

        assert_eq!(metric.remaining_label.as_deref(), Some("500 / 500 credits"));
    }

    #[test]
    fn build_model_metrics_aggregates_by_model() {
        let mut credits = HashMap::new();
        credits.insert("claude-sonnet-4".to_string(), 150.0);
        credits.insert("gpt-5".to_string(), 50.0);

        let metrics = build_model_metrics(&credits);
        assert_eq!(metrics.len(), 2);

        // Sorted by credits descending
        assert_eq!(metrics[0].label, "Model: claude-sonnet-4");
        assert!((metrics[0].used_percent - 75.0).abs() < 0.1);
        assert_eq!(metrics[0].remaining_label.as_deref(), Some("150.0 credits"));

        assert_eq!(metrics[1].label, "Model: gpt-5");
        assert!((metrics[1].used_percent - 25.0).abs() < 0.1);
    }

    #[test]
    fn build_model_metrics_empty_returns_empty() {
        let credits: HashMap<String, f64> = HashMap::new();
        let metrics = build_model_metrics(&credits);
        assert!(metrics.is_empty());
    }

    #[test]
    fn build_model_metrics_zero_total_returns_empty() {
        let mut credits = HashMap::new();
        credits.insert("model-a".to_string(), 0.0);
        let metrics = build_model_metrics(&credits);
        assert!(metrics.is_empty());
    }
}
