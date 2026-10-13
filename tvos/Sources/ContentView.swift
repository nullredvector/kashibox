import SwiftUI

private let gap: CGFloat = 16
private let margin: CGFloat = 40

/// Picks the column count that gives the biggest 9:16 tiles for this many videos.
private func bestLayout(count: Int, in size: CGSize) -> (cols: Int, tile: CGSize) {
    let availW = size.width - 2 * margin
    let availH = size.height - 2 * margin
    var best: (cols: Int, tile: CGSize) = (1, .zero)
    for cols in 1...max(count, 1) {
        let rows = Int((Double(count) / Double(cols)).rounded(.up))
        let w = (availW - gap * CGFloat(cols - 1)) / CGFloat(cols)
        let h = (availH - gap * CGFloat(max(rows, 1) - 1)) / CGFloat(max(rows, 1))
        let tw = min(w, h * 9 / 16)
        if tw > best.tile.width { best = (cols, CGSize(width: tw, height: tw * 16 / 9)) }
    }
    return best
}

struct ContentView: View {
    @EnvironmentObject private var store: TVStore
    @State private var paused = false

    var body: some View {
        GeometryReader { geo in
            let count = store.items.count
            let layout = bestLayout(count: count, in: geo.size)
            let rows = max(1, Int((Double(count) / Double(layout.cols)).rounded(.up)))
            let totalH = CGFloat(rows) * layout.tile.height + CGFloat(rows - 1) * gap

            ZStack {
                Color(white: 0.02)
                if count == 0 { IdleView(connected: store.connected) }
                ForEach(Array(store.items.enumerated()), id: \.element.id) { index, item in
                    let row = index / layout.cols
                    let col = index % layout.cols
                    let inRow = min(layout.cols, count - row * layout.cols)
                    let rowW = CGFloat(inRow) * layout.tile.width + CGFloat(inRow - 1) * gap
                    TileView(item: item, paused: paused)
                        .frame(width: layout.tile.width, height: layout.tile.height)
                        .position(
                            x: (geo.size.width - rowW) / 2 + CGFloat(col) * (layout.tile.width + gap) + layout.tile.width / 2,
                            y: (geo.size.height - totalH) / 2 + CGFloat(row) * (layout.tile.height + gap) + layout.tile.height / 2
                        )
                }
            }
            .animation(.easeInOut(duration: 0.35), value: store.items)
        }
        .ignoresSafeArea()
        .onPlayPauseCommand { paused.toggle() }
    }
}

struct IdleView: View {
    let connected: Bool

    var body: some View {
        VStack(spacing: 24) {
            Text("kashibox")
                .font(.system(size: 90, weight: .ultraLight))
                .tracking(14)
                .foregroundColor(Color(white: 0.35))
            Text(connected ? "Open kashibox on your phone and tap the TV button on a video"
                           : "Connecting to the server…")
                .font(.system(size: 30))
                .foregroundColor(Color(white: 0.25))
        }
    }
}
