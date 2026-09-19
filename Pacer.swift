// Pacer — menu-bar pace for your AI coding subscriptions (Claude Code, Codex). Reads ~/.claude/pacer/status.json
// (written by `pacer.mjs tick`, launchd every 10 min). Menu bar = two speed rings (session, week);
// speed = projected percent at reset, 100 = you run out exactly at reset. Build: ./build.sh
import Cocoa

let dir = NSString(string: "~/.claude/pacer").expandingTildeInPath
let statusPath = dir + "/status.json"
/// Past this a reading is not live: grey rings, "last checked". `pacer.mjs status` uses the same 30 minutes.
let staleAfterMs: Double = 30 * 60 * 1000

struct Window { let key: String; let percent: Double; let projected: Double; let speed: Double; let allowed: Double; let hoursLeft: Double?; let long: Bool; let rate: Double }
/// One subscription seen on this machine. `current` = the login its provider is using right now;
/// the rest are remembered readings, already rolled past any reset by `pacer.mjs`.
struct Account { let id: String; let provider: String; let vendor: String; let title: String?; let via: String?; let email: String?; let plan: String?; let current: Bool; let asOf: Double; let windows: [Window]; let advice: String? }
struct Status {
    var pace: Int?; var level = "unknown"; var worst = ""; var t: Double = 0; var error: String?
    var windows: [Window] = []
    var accounts: [Account] = []
    var acct: String?   // the login the TOP LEVEL is pinned to — NOT necessarily accounts[0], which is the one used last
    var stamp: Double = 0   // moves on EVERY tick, failed ones included (`t` deliberately does not)
    var accountsT: Double = 0   // when `accounts` were read; differs from `t` only while the Claude read is failing
    var nextReset: Double?   // epoch seconds of the soonest reset among live logins
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
    s.acct = j["acct"] as? String
    s.advice = j["advice"] as? String
    if let c = j["cost"] as? [String: Any] {
        s.costDay = (c["day"] as? [String: Any])?["total"] as? Double ?? 0
        s.costWeek = (c["week"] as? [String: Any])?["total"] as? Double ?? 0
    }
    func window(_ w: [String: Any]) -> Window {
        Window(key: w["key"] as? String ?? "", percent: w["percent"] as? Double ?? 0, projected: w["projected"] as? Double ?? 0,
                                speed: w["speed"] as? Double ?? 0, allowed: w["allowedPerHour"] as? Double ?? 0,
                                hoursLeft: (w["minutesLeft"] as? Double).map { $0 / 60 }, long: w["long"] as? Bool ?? false, rate: w["rate"] as? Double ?? 0)
    }
    s.windows = (j["windows"] as? [[String: Any]] ?? []).map(window)
    for a in j["accounts"] as? [[String: Any]] ?? [] {
        s.accounts.append(Account(id: a["id"] as? String ?? "", provider: a["provider"] as? String ?? "claude", vendor: a["vendor"] as? String ?? (a["provider"] as? String ?? "claude"), title: a["title"] as? String, via: a["via"] as? String, email: a["email"] as? String, plan: a["plan"] as? String,
                                  current: a["current"] as? Bool ?? false, asOf: a["asOf"] as? Double ?? s.t, windows: (a["windows"] as? [[String: Any]] ?? []).map(window), advice: a["advice"] as? String))
    }
    // A reset that has passed since the tick is a fact the file cannot know yet: zero that window here, so the
    // rings and rows turn over at the minute it happens, not at the next sample.
    s.accountsT = j["accountsAt"] as? Double ?? s.t
    s.stamp = max(s.t, s.accountsT, j["errorAt"] as? Double ?? 0)
    let nowMs = Date().timeIntervalSince1970 * 1000
    // Keep in step with `rolled()` in pacer.mjs, which applies the same rule at tick time.
    func rolled(_ ws: [Window], _ readAt: Double) -> [Window] {
        ws.map { w in
            guard let h = w.hoursLeft, h - (nowMs - readAt) / 3600000 <= 0 else { return w }
            return Window(key: w.key, percent: 0, projected: 0, speed: 0, allowed: w.allowed, hoursLeft: nil, long: w.long, rate: 0)
        }
    }
    var resets: [Double] = s.windows.compactMap { $0.hoursLeft }.map { s.t / 1000 + $0 * 3600 }
    for a in s.accounts where a.current { resets += a.windows.compactMap { $0.hoursLeft }.map { s.accountsT / 1000 + $0 * 3600 } }
    // Every hoursLeft is ahead of the read that wrote it, so a reset that has passed SINCE stays the target until
    // a newer read lands — dropping it the moment it passes would leave the reset poll nothing to aim at.
    if let at = resets.min() { s.nextReset = at.rounded() }
    s.windows = rolled(s.windows, s.t)
    s.accounts = s.accounts.map { Account(id: $0.id, provider: $0.provider, vendor: $0.vendor, title: $0.title, via: $0.via, email: $0.email, plan: $0.plan, current: $0.current, asOf: $0.asOf, windows: rolled($0.windows, s.accountsT), advice: $0.advice) }
    // A status.json written before accounts existed still draws: it is one account, the live one.
    if s.accounts.isEmpty { s.accounts = [Account(id: "", provider: "claude", vendor: "claude", title: nil, via: nil, email: nil, plan: nil, current: true, asOf: s.t, windows: s.windows, advice: s.advice)] }
    return s
}

func levelColor(_ projected: Double) -> NSColor { projected > 100 ? .systemRed : projected > 80 ? .systemOrange : .systemGreen }
func usedColor(_ percent: Double) -> NSColor { percent >= 90 ? .systemRed : percent >= 70 ? .systemOrange : .systemGreen }
func countdown(_ hours: Double) -> String {
    let m = Int((hours * 60).rounded())
    let d = m / 1440, h = (m % 1440) / 60, mm = m % 60
    if d > 0 { return "\(d)d \(h)h" }
    if h > 0 { return "\(h)h \(mm)m" }
    return "\(mm)m"
}

/// One ring. A live login shows SPEED (projected % at reset; past 100 = solid red disc). A remembered
/// one shows what is USED, since nothing is being spent there — and a window that has reset since
/// draws as a full green outline, which is the signal to switch back.
/// Identifies a reset CYCLE by the absolute instant it ends — read time plus what is left — so it is constant
/// within a cycle and jumps by a whole window at a turnover. Never derive this from a countdown: `hoursLeft`
/// shrinks between reads, which is what let the 90% warning re-arm every ~3 hours. Extracted so a check can
/// compile it without the app (see test.mjs).
func cycleId(_ readAtMs: Double, _ hoursLeft: Double) -> Int { Int(readAtMs / 1000 + hoursLeft * 3600) }

func drawRing(_ w: Window?, live: Bool, stale: Bool, center c: NSPoint, radius r: CGFloat, line: CGFloat) {
    let value = live ? (w?.projected ?? 0) : (w?.percent ?? 0)
    if w != nil, !stale, live ? value > 100 : value >= 100 {
        NSColor.systemRed.setFill()
        NSBezierPath(ovalIn: NSRect(x: c.x - r - line / 2, y: c.y - r - line / 2, width: r * 2 + line, height: r * 2 + line)).fill()
        return
    }
    let track = NSBezierPath(ovalIn: NSRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
    track.lineWidth = line
    let fresh = !live && w != nil && value == 0
    (fresh ? NSColor.systemGreen.withAlphaComponent(0.85) : NSColor.labelColor.withAlphaComponent(0.25)).setStroke(); track.stroke()
    guard w != nil, value > 0 else { return }
    let arc = NSBezierPath()
    arc.appendArc(withCenter: c, radius: r, startAngle: 90, endAngle: 90 - 360 * min(value, 100) / 100, clockwise: true)
    arc.lineWidth = line; arc.lineCapStyle = .round
    (stale ? NSColor.secondaryLabelColor : live ? levelColor(value) : usedColor(value)).setStroke(); arc.stroke()
}
/// Session then week where a provider has them; otherwise its own first two windows (a month, a day's model quotas).
func ringPair(_ ws: [Window]) -> [Window?] {
    let named = ["session", "weekly_all"].map { k in ws.first { $0.key == k } }
    if named.contains(where: { $0 != nil }) { return named }
    return [ws.first, ws.count > 1 ? ws[1] : nil]
}
let providerNames = ["claude": "Claude", "codex": "Codex", "cursor": "Cursor", "gemini": "Gemini", "antigravity": "Antigravity", "copilot": "Copilot"]
/// Whose MODEL is being spent, as a mark: Claude's burst, OpenAI's blossom, Gemini's four-point star, drawn here
/// (no logo files ship); an SF Symbol for the rest. Symmetric on purpose — it is drawn in flipped and unflipped contexts.
func drawIcon(_ vendor: String, in r: NSRect) {
    let c = NSPoint(x: r.midX, y: r.midY), u = min(r.width, r.height) / 2
    switch vendor {
    case "claude":
        let rays = NSBezierPath(); rays.lineWidth = max(1.3, u * 0.28); rays.lineCapStyle = .round
        for k in 0..<6 {
            let t = CGFloat(k) * .pi / 6
            rays.move(to: NSPoint(x: c.x - cos(t) * u * 0.9, y: c.y - sin(t) * u * 0.9)); rays.line(to: NSPoint(x: c.x + cos(t) * u * 0.9, y: c.y + sin(t) * u * 0.9))
        }
        NSColor(srgbRed: 0.85, green: 0.47, blue: 0.34, alpha: 1).setStroke(); rays.stroke()
    case "openai":
        NSColor.labelColor.setStroke()
        for k in 0..<6 {
            let t = CGFloat(k) * .pi / 3 + .pi / 6, q = u * 0.46
            let petal = NSBezierPath(ovalIn: NSRect(x: c.x + cos(t) * q - q, y: c.y + sin(t) * q - q, width: q * 2, height: q * 2))
            petal.lineWidth = max(1, u * 0.16); petal.stroke()
        }
    case "gemini":
        let star = NSBezierPath()
        let pts = [NSPoint(x: c.x, y: c.y + u), NSPoint(x: c.x + u, y: c.y), NSPoint(x: c.x, y: c.y - u), NSPoint(x: c.x - u, y: c.y)]
        star.move(to: pts[3])
        var prev = pts[3]
        for p in pts {   // control points a quarter of the way out: the star's waist, fat enough to read at 11 px
            star.curve(to: p, controlPoint1: NSPoint(x: c.x + (prev.x - c.x) * 0.25, y: c.y + (prev.y - c.y) * 0.25), controlPoint2: NSPoint(x: c.x + (p.x - c.x) * 0.25, y: c.y + (p.y - c.y) * 0.25))
            prev = p
        }
        NSColor(srgbRed: 0.31, green: 0.55, blue: 0.97, alpha: 1).setFill(); star.fill()
    default:
        let symbol = ["cursor": "cursorarrow", "copilot": "airplane"][vendor] ?? "sparkles"
        guard let img = NSImage(systemSymbolName: symbol, accessibilityDescription: vendor)?.withSymbolConfiguration(.init(pointSize: u * 1.7, weight: .semibold)) else { return }
        let tinted = NSImage(size: r.size, flipped: false) { b in img.draw(in: b); NSColor.labelColor.set(); b.fill(using: .sourceAtop); return true }
        tinted.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }
}

/// The dropdown, drawn like Letterknife's usage card: label + figures, a bar, the reset, then the
/// recommendation. Beside the title, one tab per subscription — just its pair of rings. A click on a
/// tab shows that subscription; a click anywhere else polls fresh stats.
final class PanelView: NSView {
    static let width: CGFloat = 320
    /// Darkens (or in light mode lightens) the footer behind the text without making it opaque — see `draw`.
    static let scrim = NSColor(name: "pacerScrim") { ap in
        ap.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? NSColor(white: 0, alpha: 0.4) : NSColor(white: 1, alpha: 0.55)
    }
    var status = Status() { didSet { if !status.accounts.contains(where: { $0.id == selectedId }) { selectedId = status.accounts.first?.id ?? "" }; layoutPanel() } }
    var polling = false { didSet { needsDisplay = true } }
    var selectedId = ""
    var onClick: (() -> Void)?
    var onSelect: (() -> Void)?
    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func mouseUp(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        if let i = tabRects().firstIndex(where: { $0.insetBy(dx: -2, dy: -4).contains(p) }) { selectedId = status.accounts[i].id; needsDisplay = true; onSelect?(); return }
        onClick?()
    }

    private let pad: CGFloat = 14
    /// Air between the last window and the recommendation — the two are read separately, so they are spaced apart.
    /// `layoutPanel` and `draw` must use the same number or the panel is sized for a gap it does not draw.
    private let adviceGap: CGFloat = 18
    private var inner: CGFloat { PanelView.width - pad * 2 }
    /// Which account this card — and, through `App.refresh`, the menu bar — is showing. ONE home: the icon and
    /// its tooltip must never name a different subscription from the one the card is open on.
    var account: Account? { status.accounts.first { $0.id == selectedId } ?? status.accounts.first }
    /// Tabs always get rows of their own under the title and wrap: icon + ring pair each, a hairline between them.
    private let tabW: CGFloat = 52, tabGap: CGFloat = 13
    private var tabsPerRow: Int { max(1, Int((inner + tabGap) / (tabW + tabGap))) }
    /// (row, column) per account: a row fills left to right, and a wrapper's resold models start a row of their own.
    private func tabSlots() -> [(Int, Int)] {
        var out: [(Int, Int)] = [], row = 0, col = 0
        for (i, a) in status.accounts.enumerated() {
            if i > 0, col >= tabsPerRow || a.via != status.accounts[i - 1].via { row += 1; col = 0 }
            out.append((row, col)); col += 1
        }
        return out
    }
    private var tabRows: Int { status.accounts.count > 1 ? (tabSlots().last?.0 ?? 0) + 1 : 0 }
    private func tabRects() -> [NSRect] {
        guard status.accounts.count > 1 else { return [] }
        return tabSlots().map { NSRect(x: pad - 4 + CGFloat($0.1) * (tabW + tabGap), y: 40 + CGFloat($0.0) * 28, width: tabW, height: 22) }
    }
    private func title(_ key: String) -> String {
        if key == "session" { return "Session (5h)" }
        if key == "weekly_all" { return "Week · all models" }
        if key.hasPrefix("weekly_scoped:") { return "Week · " + key.dropFirst(14) }
        if key == "monthly" { return "Month" }
        if key.hasPrefix("quota:") { return String(key.dropFirst(6)) }
        if key.hasPrefix("daily") { return "Today" + (key.count > 6 ? " · " + key.dropFirst(6) : "") }
        return key
    }
    private func advice(_ a: Account) -> NSAttributedString {
        let on = (a.advice ?? "").isEmpty
        let text = on ? "On pace — nothing to change" : a.advice!.prefix(1).uppercased() + a.advice!.dropFirst()
        return NSAttributedString(string: text, attributes: [.font: NSFont.systemFont(ofSize: 12.5, weight: .semibold), .foregroundColor: on || text.hasPrefix("Ready") ? NSColor.systemGreen : NSColor.labelColor])
    }
    private func adviceHeight(_ a: Account) -> CGFloat { ceil(advice(a).boundingRect(with: NSSize(width: inner, height: 400), options: [.usesLineFragmentOrigin]).height) }
    private func isStale(_ a: Account) -> Bool { !a.current || Date().timeIntervalSince1970 * 1000 - a.asOf > staleAfterMs }
    /// Cost (the live Claude login only), who, and — when the reading is not live — when it was taken.
    private func footerLines(_ a: Account) -> Int { (a.id == status.accounts.first?.id ? 1 : 0) + 1 + (isStale(a) ? 1 : 0) }
    /// The tallest account sets the height, so switching tabs never resizes an open menu.
    private func layoutPanel() {
        let fixed: CGFloat = 36 + CGFloat(tabRows) * 28 + (status.error != nil ? 22 : 0) + adviceGap + 10 + 1 + 9 + 8
        let h: CGFloat = status.accounts.map { (a: Account) -> CGFloat in fixed + CGFloat(a.windows.count) * 55 + adviceHeight(a) + CGFloat(footerLines(a)) * 18 }.max() ?? 100
        setFrameSize(NSSize(width: PanelView.width, height: h)); needsDisplay = true
    }

    override func draw(_ dirty: NSRect) {
        guard let a = account else { return }
        // `mut` is `secondaryLabelColor`'s job at an alpha that survives a translucent menu over a light window.
        let mut = NSColor.labelColor.withAlphaComponent(0.72)
        let now = Date().timeIntervalSince1970 * 1000
        func text(_ s: String, _ font: NSFont, _ color: NSColor) -> NSAttributedString { NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: color]) }
        var y: CGFloat = 12
        text((a.title ?? providerNames[a.provider] ?? a.provider.capitalized) + (polling ? " · updating…" : " usage"), .systemFont(ofSize: 15, weight: .bold), .labelColor).draw(at: NSPoint(x: pad + 22, y: y))
        drawIcon(a.vendor, in: NSRect(x: pad, y: y + 1, width: 16, height: 16))
        let slots = tabSlots()
        for (i, r) in tabRects().enumerated() {
            let t = status.accounts[i]
            if t.id == a.id { NSColor.labelColor.withAlphaComponent(0.14).setFill(); NSBezierPath(roundedRect: r, xRadius: 7, yRadius: 7).fill() }
            drawIcon(t.vendor, in: NSRect(x: r.minX + 5, y: r.midY - 5.5, width: 11, height: 11))
            for (k, w) in ringPair(t.windows).enumerated() {
                drawRing(w, live: t.current, stale: false, center: NSPoint(x: r.minX + 27 + CGFloat(k) * 14, y: r.midY), radius: 4.5, line: 2.4)
            }
            if i + 1 < slots.count, slots[i + 1].0 == slots[i].0 {
                NSColor.separatorColor.setFill(); NSRect(x: r.maxX + tabGap / 2, y: r.minY + 4, width: 1, height: r.height - 8).fill()
            }
        }
        y += 24 + CGFloat(tabRows) * 28
        if let e = status.error { text("⚠︎ " + e, .systemFont(ofSize: 12), .systemOrange).draw(at: NSPoint(x: pad, y: y)); y += 22 }
        let num = NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
        for w in a.windows {
            y += 8
            text(title(w.key), .systemFont(ofSize: 13, weight: .semibold), .labelColor).draw(at: NSPoint(x: pad, y: y))
            let right = NSMutableAttributedString()
            right.append(text(String(format: "%.0f%%", w.percent), num, .labelColor))
            if a.current {
                right.append(text("  speed ", .systemFont(ofSize: 13), mut))
                right.append(text(String(format: "%.0f", w.projected), num, levelColor(w.projected)))
            }
            right.draw(at: NSPoint(x: pad + inner - right.size().width, y: y))
            y += 21
            NSColor.labelColor.withAlphaComponent(0.12).setFill()
            NSBezierPath(roundedRect: NSRect(x: pad, y: y, width: inner, height: 6), xRadius: 3, yRadius: 3).fill()
            let p = max(0, min(100, w.percent))
            if p > 0 {
                usedColor(p).setFill()
                NSBezierPath(roundedRect: NSRect(x: pad, y: y, width: max(6, inner * p / 100), height: 6), xRadius: 3, yRadius: 3).fill()
            }
            y += 9
            // Hours left were true at the tick; a remembered account can be read long after, so count from now.
            text(w.hoursLeft.map { "resets in " + countdown(max(0, $0 - (now - status.accountsT) / 3600000)) } ?? (a.current ? "idle" : "reset — ready"), .systemFont(ofSize: 13), w.hoursLeft == nil && !a.current ? .systemGreen : mut).draw(at: NSPoint(x: pad, y: y))
            y += 17
        }
        y += adviceGap
        let ah = adviceHeight(a)
        advice(a).draw(with: NSRect(x: pad, y: y, width: inner, height: ah), options: [.usesLineFragmentOrigin])
        let sepY = bounds.height - 8 - CGFloat(footerLines(a)) * 18 - 10
        // The menu is translucent on purpose, but a light window behind it washed the footer out — these lines are
        // the quietest on the card and the lowest, where the menu has least of its own material. A scrim gives them
        // a floor, and it separates the footer well enough on its own: there is deliberately no rule above it.
        PanelView.scrim.setFill()
        NSBezierPath(roundedRect: NSRect(x: pad - 6, y: sepY + 4, width: inner + 12, height: bounds.height - sepY - 8), xRadius: 7, yRadius: 7).fill()
        y = sepY + 10
        if a.id == status.accounts.first?.id {
            text(String(format: "API-equiv $%.0f today · $%.0f this week", status.costDay, status.costWeek), .systemFont(ofSize: 13), mut).draw(at: NSPoint(x: pad, y: y))
            y += 18
        }
        // The dot says whether this is a live login, so no line is spent on saying it.
        (a.current ? NSColor.systemGreen : NSColor.tertiaryLabelColor).setFill()
        NSBezierPath(ovalIn: NSRect(x: pad, y: y + 5, width: 7, height: 7)).fill()
        text([a.email ?? "earlier account", a.plan, a.via.map { "via " + $0 }].compactMap { $0 }.joined(separator: " · "), .systemFont(ofSize: 13), mut).draw(at: NSPoint(x: pad + 13, y: y))
        y += 18
        if isStale(a) {
            let df = DateFormatter(); df.dateFormat = "MMM d, HH:mm"
            text("last checked: " + df.string(from: Date(timeIntervalSince1970: a.asOf / 1000)), .systemFont(ofSize: 13), mut).draw(at: NSPoint(x: pad + 13, y: y))
        }
    }
}

final class App: NSObject, NSApplicationDelegate, NSMenuDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    let menu = NSMenu()
    let panel = PanelView(frame: NSRect(x: 0, y: 0, width: PanelView.width, height: 100))
    var pollTimer: Timer?
    var resetTimer: Timer?
    var armedFor: Double?
    var errorPolls = 0            // consecutive failed reads we have already asked about
    var lastErrorPoll = 0.0

    func applicationDidFinishLaunching(_ n: Notification) {
        let holder = NSMenuItem(); holder.view = panel
        menu.addItem(holder)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Pacer", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        menu.delegate = self
        item.menu = menu
        panel.onClick = { [weak self] in self?.poll() }
        panel.onSelect = { [weak self] in self?.refresh() }   // the icon follows the tab
        refresh()
        let t = Timer(timeInterval: 60, repeats: true) { _ in self.refresh() }
        RunLoop.main.add(t, forMode: .common)
    }
    func menuWillOpen(_ menu: NSMenu) { refresh() }

    /// Two rings, session then week, for the account whose TAB is open — the tab outlives the menu, so the
    /// menu bar and the card say the same thing rather than the icon silently meaning a different subscription.
    /// A remembered login shows what is used, exactly as its tab does. (`status.json`'s top level stays pinned
    /// to the default Claude login regardless: that is roam's contract, not this icon's.)
    func rings(_ a: Account?, _ s: Status, live: Bool) -> NSImage {
        let pick = ringPair(a?.windows ?? s.windows)
        let vendor = a?.vendor ?? "claude"
        let stale = live && Date().timeIntervalSince1970 * 1000 - (a?.asOf ?? s.t) > staleAfterMs
        return NSImage(size: NSSize(width: 56, height: 18), flipped: false) { _ in
            drawIcon(vendor, in: NSRect(x: 1, y: 2, width: 14, height: 14))
            for (i, w) in pick.enumerated() { drawRing(w, live: live, stale: stale, center: NSPoint(x: 28 + CGFloat(i) * 19, y: 9), radius: 6, line: 3) }
            return true
        }
    }

    func refresh() {
        let s = loadStatus()
        let stale = Date().timeIntervalSince1970 * 1000 - s.t > staleAfterMs
        panel.status = s   // before the icon: it reads the tab, and a tab whose account is gone is reset here
        // ONE `live`, feeding both the drawing and the words: a remembered login has no speed, so `drawRing`
        // fills its rings with what was USED and colours them on a different ladder. Deriving the tooltip from the
        // same flag is what stops it explaining a red ring on a scale the ring was not drawn to.
        let shown = panel.account
        let live = shown?.current ?? true
        item.button?.attributedTitle = NSAttributedString(string: "")
        item.button?.image = rings(shown, s, live: live)
        let scale = live ? "session and week speed (projected % at reset; solid red = runs out first)"
                         : "session and week used at the last check (green = it has reset since; solid red = used up)"
        item.button?.toolTip = [shown?.title ?? providerNames[shown?.provider ?? "claude"], shown?.email]
            .compactMap { $0 }.joined(separator: " · ") + " — " + scale
        if !stale { notifyIfNeeded(s) }
        scheduleResetPoll(s)
        retryFailedRead(s)
    }

    /// launchd fires the tick on a fixed 600 s interval, so a tick that failed OUTRIGHT — a 429 outliving its
    /// in-tick retries, the network down — left the figure untouched for a full ten minutes. The app is already
    /// awake and already re-reading every 60 s, so it is the right place to ask again sooner. The FIRST failure
    /// is asked about at once (that is the common case — most failures in the log are a single tick), and only a
    /// run of them backs off: 120 → 240 → 480 → 600 and never further, so a persistently failing endpoint is asked no more often
    /// than launchd would have asked anyway, so this can add load only while a failure is still new. A read that
    /// succeeds resets it, and `poll()` kicks the ONE launchd tick rather than sampling separately.
    func retryFailedRead(_ s: Status) {
        guard s.error != nil else { errorPolls = 0; return }
        guard !panel.polling else { return }   // one already in flight: it will refresh us when it lands
        let now = Date().timeIntervalSince1970
        let wait = min(600, 60 * pow(2, Double(errorPolls)))
        guard now - lastErrorPoll >= wait else { return }
        lastErrorPoll = now
        errorPolls += 1
        poll()
    }

    /// Claude Code learns of a reset from the headers on its next request; Pacer only samples every 10 minutes.
    /// So it asks again right after each reset it knows is coming. If the server has not turned the window over
    /// yet, the fresh status still carries that reset and this re-arms — never faster than once a minute.
    func scheduleResetPoll(_ s: Status) {
        // refresh() runs every minute: re-arming each time would kill the timer before it is ever due.
        // Arm once per distinct reset; a poll that lands a newer tick changes `nextReset` and arms the next one.
        guard s.nextReset != armedFor else { return }
        resetTimer?.invalidate(); resetTimer = nil
        armedFor = s.nextReset
        guard let at = s.nextReset else { return }
        let t = Timer(timeInterval: max(5, at + 15 - Date().timeIntervalSince1970), repeats: false) { [weak self] _ in self?.poll() }
        resetTimer = t
        RunLoop.main.add(t, forMode: .common)
    }

    /// Click-to-poll: kick the one launchd tick (never a second sampler) and wait for status.json to move.
    func poll() {
        guard !panel.polling else { return }
        panel.polling = true
        let before = loadStatus().stamp
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        p.arguments = ["kickstart", "gui/\(getuid())/com.claude-pacer.tick"]
        try? p.run()
        let started = Date()
        pollTimer?.invalidate()
        let t = Timer(timeInterval: 0.5, repeats: true) { [weak self] timer in
            guard let self = self else { timer.invalidate(); return }
            if loadStatus().stamp != before || Date().timeIntervalSince(started) > 45 {
                timer.invalidate(); self.panel.polling = false; self.refresh()
            }
        }
        pollTimer = t
        RunLoop.main.add(t, forMode: .common) // .common: the menu's tracking loop would starve a default-mode timer
    }

    // Thresholds, each fired once per crossing: pace goes over 100 / comes back under; a window passes 90% used (once per reset).
    func notifyIfNeeded(_ s: Status) {
        let d = UserDefaults.standard
        // These read s.pace / s.windows — the login `acct` pins the top level to — while the menu bar now follows
        // whichever tab is open. With more than one account the notification has to say whose figure it is.
        let pinned = s.accounts.first { $0.id == s.acct } ?? s.accounts.first
        let whose = s.accounts.count > 1 ? (pinned?.email ?? pinned?.title).map { " · " + $0 } ?? "" : ""
        if let pace = s.pace {
            let over = pace > 100
            if over != d.bool(forKey: "overPace") {
                d.set(over, forKey: "overPace")
                if over { notify("Off pace: \(pace)" + whose, s.advice.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? "You will run out before the reset") }
                else if d.bool(forKey: "everOver") { notify("Back on pace: \(pace)" + whose, "Current speed fits the limits again") }
            }
            if over { d.set(true, forKey: "everOver") }
        }
        for w in s.windows {
            // A cycle is identified by the absolute moment it ENDS, never by how long is LEFT. `hoursLeft`
            // counts down, so the old id drifted away from the stored one inside a single cycle: once the gap
            // passed the tolerance it cleared the latch and warned again, every ~3 hours, about a window the
            // owner had already acknowledged. Read time plus remaining is constant within a cycle (to a few
            // seconds of jitter between reads) and jumps by the whole window at a real reset, so 10 minutes of
            // tolerance is far beyond any drift and far short of any genuine turnover.
            d.removeObject(forKey: "reset:" + w.key)   // the countdown-keyed id this replaced; before the
            // guard, or an idle window's stale key would sit there until that window next runs
            guard let h = w.hoursLeft else { continue }   // idle, or reset since the read: nothing to warn about
            let key = "warned90:" + w.key
            let cycleKey = "cycle:" + w.key
            let endsAt = cycleId(s.t, h)
            if d.object(forKey: cycleKey) == nil {
                // First run after the fix: adopt this cycle WITHOUT clearing, or upgrading would fire one
                // more notification for the very window the old bug had been repeating.
                d.set(endsAt, forKey: cycleKey)
            } else if abs(d.integer(forKey: cycleKey) - endsAt) > 600 {
                d.set(false, forKey: key); d.set(endsAt, forKey: cycleKey)
            }
            if w.percent >= 90 && !d.bool(forKey: key) {
                d.set(true, forKey: key)
                notify("\(name(w.key)) at \(Int(w.percent))%" + whose, "Resets in " + countdown(h))
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
        p.arguments = ["-e", "display notification \"\(esc(body))\" with title \"Pacer\" subtitle \"\(esc(title))\""]
        try? p.run()
    }

}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = App()
app.delegate = delegate
app.run()
