//! Kalble desktop app: opening it starts `bun run scripts/duo.ts` (dry-run bots + dashboard),
//! the window shows the compare dashboard, quitting stops everything. Log: ~/kalble/data/duo.log
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use std::path::Path;

static DUO: AtomicU32 = AtomicU32::new(0);

fn repo() -> String { format!("{}/kalble", std::env::var("HOME").unwrap_or_default()) }
fn path() -> String { format!("/opt/homebrew/bin:/usr/local/bin:{}", std::env::var("PATH").unwrap_or_default()) }

fn start_duo() {
    let repo = repo();
    // one duo at a time: stop one started elsewhere (old launcher, terminal), give it a moment to free the ports
    if Command::new("pkill").args(["-f", "scripts/duo.ts"]).status().map(|s| s.success()).unwrap_or(false) {
        std::thread::sleep(std::time::Duration::from_secs(3));
    }
    let _ = std::fs::remove_dir_all(format!("{repo}/web/.next")); // stale build after a hard stop = every route 404
    let log = std::fs::File::create(format!("{repo}/data/duo.log")).expect("data/duo.log");
    let child = Command::new("bun")
        .args(["run", "scripts/duo.ts"])
        .current_dir(&repo)
        .env("PATH", path())
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .stdin(Stdio::null())
        .spawn()
        .expect("could not start bun (is it in /opt/homebrew/bin?)");
    DUO.store(child.id(), Ordering::SeqCst);
}

fn stop_duo() {
    let pid = DUO.swap(0, Ordering::SeqCst);
    if pid != 0 { let _ = Command::new("kill").arg(pid.to_string()).status(); } // SIGTERM: duo stops both bots and the dashboard
}

/// Same call the dashboard's kill switch button makes. The bots only accept it from a localhost origin.
fn halt(on: bool) {
    for port in 3001..=3070 { // game bots 3001-3024, long-dated 3051/3053/3055, Kalshi MM 3052, Kalshi LIP 3061-3063; a port with no bot just fails fast
        let _ = Command::new("curl")
            .args(["-s", "-X", "POST", "-H", "content-type: application/json", "-H", "origin: http://localhost:3000",
                   "-d", &format!("{{\"halt\":{on}}}"), &format!("http://localhost:{port}/settings")])
            .stdout(Stdio::null())
            .status();
    }
}

const STRATS: [(&str, &str, bool); 7] = [
    ("farmer", "Reward farmer", false), ("longdated", "Long-dated", true), ("odds", "Odds-anchored", false),
    ("kalshi", "Kalshi MM", false), ("lip", "Kalshi LIP", true), ("jev", "Jev", false), ("gaps", "Gap logger", true),
];

/// Read data/strategies.json (flat booleans); missing file or keys fall back to the defaults.
fn read_strats(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    let mut m: serde_json::Map<String, serde_json::Value> = std::fs::read_to_string(path).ok()
        .and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    for (k, _, d) in STRATS { m.entry(k).or_insert(serde_json::Value::Bool(d)); }
    m
}

/// Flip one strategy and rewrite the file; returns the new value.
fn toggle_strat(path: &Path, key: &str) -> bool {
    let mut m = read_strats(path);
    let v = !m.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
    m.insert(key.to_string(), serde_json::Value::Bool(v));
    let _ = std::fs::write(path, serde_json::to_string(&m).unwrap());
    v
}

fn strat_file() -> std::path::PathBuf { Path::new(&repo()).join("data/strategies.json") }

fn main() {
    std::thread::spawn(start_duo);
    tauri::Builder::default()
        .setup(|app| {
            let app_menu = SubmenuBuilder::new(app, "Kalble").about(None).separator().hide().quit().build()?;
            // Edit menu is what makes Cmd+C / Cmd+V work in the webview (pasting the TypeSafe key)
            let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
            let cur = read_strats(&strat_file());
            let mut strat = SubmenuBuilder::new(app, "Strategies");
            for (k, label, _) in STRATS {
                let on = cur.get(k).and_then(|v| v.as_bool()).unwrap_or(false);
                strat = strat.item(&CheckMenuItemBuilder::with_id(format!("strat:{k}"), label).checked(on).build(app)?);
            }
            let strat = strat.build()?;
            let bots = SubmenuBuilder::new(app, "Bots")
                .item(&MenuItemBuilder::with_id("kill", "Kill switch (pull quotes, exit positions)").accelerator("CmdOrCtrl+K").build(app)?)
                .item(&MenuItemBuilder::with_id("resume", "Resume quoting").build(app)?)
                .separator()
                .item(&strat)
                .separator()
                .item(&MenuItemBuilder::with_id("reload", "Reload dashboard").accelerator("CmdOrCtrl+R").build(app)?)
                .item(&MenuItemBuilder::with_id("log", "Open log").build(app)?)
                .build()?;
            app.set_menu(MenuBuilder::new(app).items(&[&app_menu, &edit, &bots]).build()?)?;
            Ok(())
        })
        .on_menu_event(|app, e| match e.id().as_ref() {
            "kill" => halt(true),
            "resume" => halt(false),
            "log" => { let _ = Command::new("open").args(["-a", "Console", &format!("{}/data/duo.log", repo())]).status(); }
            "reload" => {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") { let _ = w.eval("location.reload()"); }
            }
            id if id.starts_with("strat:") => { toggle_strat(&strat_file(), &id[6..]); } // CheckMenuItem flips its own tick
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("tauri app")
        .run(|_, event| if let tauri::RunEvent::Exit = event { stop_duo() });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn strat_defaults_and_toggle() {
        let p = std::env::temp_dir().join(format!("strat-test-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&p);
        let m = read_strats(&p);
        assert_eq!(m["farmer"], false); // games can't be farmed under a $25 day
        assert_eq!(m["lip"], true);
        assert_eq!(m["odds"], false);
        assert_eq!(toggle_strat(&p, "longdated"), false);
        let m: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&p).unwrap()).unwrap();
        assert_eq!(m["longdated"], false);
        assert_eq!((m["farmer"].as_bool(), m["gaps"].as_bool(), m["kalshi"].as_bool()), (Some(false), Some(true), Some(false)));
        let _ = std::fs::remove_file(&p);
    }
}
