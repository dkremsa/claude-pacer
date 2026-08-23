// Claude Pacer — menu-bar pace for the Claude subscription. Reads ~/.claude/pacer/status.json
// (written by `pacer.mjs tick`, launchd every 10 min) and shows the worst window's projected
// percent at reset. 100 = you run out exactly at reset. Build: ./build.sh
import Cocoa

let dir = NSString(string: "~/.claude/pacer").expandingTildeInPath
let statusPath = dir + "/status.json"

struct Window { let key: String; let percent: Double; let projected: Double; let speed: Double; let allowed: Double; let hoursLeft: Double; let long: Bool; let rate: Double }
struct Status {
    var pace: Int?; var level = "unknown"; var worst = ""; var t: Double = 0; var error: String?
    var windows: [Window] = []
    var advice: String?; var costDay = 0.0; var costWeek = 0.0
}

func loadStatus() -> Status {
    var s = Status()
    guard let data = FileManager.default.contents(atPath: statusPath),
          let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { s.error = "no status.json — run pacer tick"; return s }
    s.pace = j["pace"] as? Int
    s.level = j["level"] as? String ?? "unknown"
    s.worst = j["worst"] as? String ?? ""
    s.t = j["t"] as? Double ?? 0
    s.error = j["error"] as? String
    s.advice = j["advice"] as? String
    if let c = j["cost"] as? [String: Any] {
        s.costDay = (c["day"] as? [String: Any])?["total"] as? Double ?? 0
        s.costWeek = (c["week"] as? [String: Any])?["total"] as? Double ?? 0
    }
    for w in j["windows"] as? [[String: Any]] ?? [] {
        s.windows.append(Window(key: w["key"] as? String ?? "", percent: w["percent"] as? Double ?? 0, projected: w["projected"] as? Double ?? 0,
                                speed: w["speed"] as? Double ?? 0, allowed: w["allowedPerHour"] as? Double ?? 0,
                                hoursLeft: (w["minutesLeft"] as? Double ?? 0) / 60, long: w["long"] as? Bool ?? false, rate: w["rate"] as? Double ?? 0))
    }
    return s
}

final class App: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()

    func applicationDidFinishLaunching(_ n: Notification) {
        item.menu = menu
        refresh()
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { _ in self.refresh() }
    }

    func color(_ level: String) -> NSColor {
        switch level {
        case "green": return NSColor.systemGreen
        case "amber": return NSColor.systemOrange
        case "red": return NSColor.systemRed
        default: return NSColor.secondaryLabelColor
        }
    }

    func refresh() {
        let s = loadStatus()
        let stale = Date().timeIntervalSince1970 * 1000 - s.t > 30 * 60 * 1000
        let text = s.pace.map { String($0) } ?? "—"
        let attrs: [NSAttributedString.Key: Any] = [
            .foregroundColor: stale ? NSColor.secondaryLabelColor : color(s.level),
            .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .semibold),
        ]
        item.button?.attributedTitle = NSAttributedString(string: "⏱ " + text, attributes: attrs)
        item.button?.toolTip = "Claude Pacer — projected % of the worst limit at its reset (100 = runs out)"
        if !stale { notifyIfNeeded(s) }

        menu.removeAllItems()
        menu.autoenablesItems = false
        let para = NSMutableParagraphStyle()
        para.tabStops = [NSTextTab(textAlignment: .left, location: 110), NSTextTab(textAlignment: .right, location: 170), NSTextTab(textAlignment: .left, location: 185)]
        para.defaultTabInterval = 60
        func add(_ a: NSAttributedString) { let i = NSMenuItem(title: a.string, action: nil, keyEquivalent: ""); i.attributedTitle = a; i.isEnabled = true; menu.addItem(i) }
        let base: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedDigitSystemFont(ofSize: 14, weight: .regular), .foregroundColor: NSColor.labelColor, .paragraphStyle: para]
        let bold: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedDigitSystemFont(ofSize: 14, weight: .bold), .foregroundColor: NSColor.labelColor, .paragraphStyle: para]
        let dim: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.secondaryLabelColor, .paragraphStyle: para]
        if let e = s.error { add(NSAttributedString(string: "⚠︎ " + e, attributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: NSColor.systemOrange])) }
        for w in s.windows {
            let c = color(w.projected > 100 ? "red" : w.projected > 80 ? "amber" : "green")
            let a = NSMutableAttributedString(string: "●  ", attributes: [.font: NSFont.systemFont(ofSize: 14), .foregroundColor: c, .paragraphStyle: para])
            a.append(NSAttributedString(string: name(w.key) + "\t", attributes: base))
            a.append(NSAttributedString(string: String(format: "%.0f%% used", w.percent) + "\t", attributes: base))
            a.append(NSAttributedString(string: String(format: "%.0f", w.projected), attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 14, weight: .bold), .foregroundColor: c, .paragraphStyle: para]))
            a.append(NSAttributedString(string: "\tat reset", attributes: dim))
            add(a)
        }
        menu.addItem(.separator())
        if let adv = s.advice, !adv.isEmpty { add(NSAttributedString(string: adv.prefix(1).uppercased() + adv.dropFirst(), attributes: bold)) }
        else { add(NSAttributedString(string: "On pace — nothing to change", attributes: [.font: NSFont.systemFont(ofSize: 14, weight: .bold), .foregroundColor: NSColor.systemGreen])) }
        menu.addItem(.separator())
        add(NSAttributedString(string: String(format: "On the API this would have cost  $%.0f today · $%.0f this week", s.costDay, s.costWeek), attributes: dim))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Refresh", action: #selector(sampleNow), keyEquivalent: "r"))
        menu.addItem(NSMenuItem(title: "Quit Claude Pacer", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        for i in menu.items where i.action != nil { i.target = self }
    }

    // Thresholds, each fired once per crossing: pace goes over 100 / comes back under; a window passes 90% used (once per reset).
    func notifyIfNeeded(_ s: Status) {
        let d = UserDefaults.standard
        if let pace = s.pace {
            let over = pace > 100
            if over != d.bool(forKey: "overPace") {
                d.set(over, forKey: "overPace")
                if over { notify("Off pace: \(pace)", s.advice.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? "You will run out before the reset") }
                else if d.bool(forKey: "everOver") { notify("Back on pace: \(pace)", "Current speed fits the limits again") }
            }
            if over { d.set(true, forKey: "everOver") }
        }
        for w in s.windows {
            let key = "warned90:" + w.key
            let resetKey = "reset:" + w.key
            let resetAt = Int(w.hoursLeft * 60) // coarse id of this reset cycle
            if abs(d.integer(forKey: resetKey) - resetAt) > 180 { d.set(false, forKey: key); d.set(resetAt, forKey: resetKey) }
            if w.percent >= 90 && !d.bool(forKey: key) {
                d.set(true, forKey: key)
                notify("\(name(w.key)) at \(Int(w.percent))%", String(format: "Resets in %.1fh", w.hoursLeft))
            }
        }
    }
    func name(_ key: String) -> String {
        if key == "session" { return "Session" }
        if key == "weekly_all" { return "Week" }
        if key.hasPrefix("weekly_scoped:") { return String(key.dropFirst(14)) + " week" }
        return key
    }
    func notify(_ title: String, _ body: String) {
        let esc = { (x: String) in x.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        p.arguments = ["-e", "display notification \"\(esc(body))\" with title \"Claude Pacer\" subtitle \"\(esc(title))\""]
        try? p.run()
    }

    @objc func sampleNow() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "node \"\(dir)/pacer.mjs\" tick"]
        p.terminationHandler = { _ in DispatchQueue.main.async { self.refresh() } }
        try? p.run()
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = App()
app.delegate = delegate
app.run()
