// Renders the Pacer icon: dark indigo squircle, a 270° pace gauge (green→amber→red), a needle.
import Cocoa
func render(_ px: CGFloat, to path: String) {
    let img = NSImage(size: NSSize(width: px, height: px))
    img.lockFocus()
    let ctx = NSGraphicsContext.current!.cgContext
    let s = px / 1024
    // macOS icons: the squircle is ~80% of the canvas, centred.
    let inset = 100 * s
    let rect = CGRect(x: inset, y: inset, width: px - 2 * inset, height: px - 2 * inset)
    let bg = NSBezierPath(roundedRect: rect, xRadius: 185 * s, yRadius: 185 * s)
    NSGradient(colors: [NSColor(calibratedRed: 0.16, green: 0.17, blue: 0.30, alpha: 1), NSColor(calibratedRed: 0.07, green: 0.08, blue: 0.16, alpha: 1)])!.draw(in: bg, angle: -90)
    let c = CGPoint(x: px / 2, y: px / 2 - 30 * s)
    let r = 270 * s, lw = 64 * s
    // gauge arc: 225° (left-bottom) clockwise to -45° (right-bottom)
    func arc(_ from: CGFloat, _ to: CGFloat, _ color: NSColor) {
        ctx.setStrokeColor(color.cgColor); ctx.setLineWidth(lw); ctx.setLineCap(.round)
        ctx.addArc(center: c, radius: r, startAngle: from * .pi / 180, endAngle: to * .pi / 180, clockwise: true)
        ctx.strokePath()
    }
    arc(225, 100, NSColor(calibratedRed: 0.30, green: 0.82, blue: 0.50, alpha: 1))
    arc(100, 10, NSColor(calibratedRed: 0.98, green: 0.70, blue: 0.22, alpha: 1))
    arc(10, -45, NSColor(calibratedRed: 0.95, green: 0.30, blue: 0.32, alpha: 1))
    // needle, pointing into the amber zone
    let ang: CGFloat = 60 * .pi / 180
    ctx.setStrokeColor(NSColor.white.cgColor); ctx.setLineWidth(40 * s); ctx.setLineCap(.round)
    ctx.move(to: c); ctx.addLine(to: CGPoint(x: c.x + cos(ang) * (r - 40 * s), y: c.y + sin(ang) * (r - 40 * s))); ctx.strokePath()
    ctx.setFillColor(NSColor.white.cgColor)
    ctx.fillEllipse(in: CGRect(x: c.x - 48 * s, y: c.y - 48 * s, width: 96 * s, height: 96 * s))
    ctx.setFillColor(NSColor(calibratedRed: 0.10, green: 0.11, blue: 0.22, alpha: 1).cgColor)
    ctx.fillEllipse(in: CGRect(x: c.x - 22 * s, y: c.y - 22 * s, width: 44 * s, height: 44 * s))
    img.unlockFocus()
    let tiff = img.tiffRepresentation!, rep = NSBitmapImageRep(data: tiff)!
    rep.size = NSSize(width: px, height: px)
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}
let out = CommandLine.arguments[1]
for (name, px) in [("icon_16x16", 16), ("icon_16x16@2x", 32), ("icon_32x32", 32), ("icon_32x32@2x", 64), ("icon_128x128", 128), ("icon_128x128@2x", 256), ("icon_256x256", 256), ("icon_256x256@2x", 512), ("icon_512x512", 512), ("icon_512x512@2x", 1024)] {
    render(CGFloat(px), to: "\(out)/\(name).png")
}
