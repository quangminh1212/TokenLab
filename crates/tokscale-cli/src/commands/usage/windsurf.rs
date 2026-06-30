use anyhow::Result;
use serde::Deserialize;
use std::collections::HashMap;

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

pub fn fetch() -> Result<UsageOutput> {
    let api_key = read_api_key()?;

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
            account: None,
            plan: Some(plan_name.to_string()),
            email: None,
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
