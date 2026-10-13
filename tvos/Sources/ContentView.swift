import SwiftUI

private let gap: CGFloat = 16
private let margin: CGFloat = 40
private let columns = 4

/// Up to four panels sit in one row; from the fifth on a second row is added. Tiles are 9:16 and as big as fit.
private func layoutFor(count: Int, in size: CGSize) -> (rows: Int, tile: CGSize) {
    let rows = count > columns ? 2 : 1
    let perRow = rows == 1 ? max(count, 1) : columns
    let availW = size.width - 2 * margin
    let availH = size.height - 2 * margin
    let w = (availW - gap * CGFloat(perRow - 1)) / CGFloat(perRow)
    let h = (availH - gap * CGFloat(rows - 1)) / CGFloat(rows)
    let tw = min(w, h * 9 / 16)
    return (rows, CGSize(width: tw, height: tw * 16 / 9))
}

struct ContentView: View {
    @EnvironmentObject private var store: TVStore
    @FocusState private var focused: Bool
    @State private var paused = false
    @State private var sound = false
    @State private var selectedID: String?
    @State private var showSelection = false
    @State private var hideTask: Task<Void, Never>?

    var body: some View {
        GeometryReader { geo in
            let panels = store.panels
            let count = panels.count
            let layout = layoutFor(count: count, in: geo.size)
            let totalH = CGFloat(layout.rows) * layout.tile.height + CGFloat(layout.rows - 1) * gap

            ZStack {
                Color(white: 0.02)
                if count == 0 { IdleView(connected: store.connected) }
                ForEach(Array(panels.enumerated()), id: \.element.id) { index, panel in
                    let row = index / columns
                    let col = index % columns
                    let inRow = min(columns, count - row * columns)
                    let rowW = CGFloat(inRow) * layout.tile.width + CGFloat(inRow - 1) * gap
                    TileView(panel: panel, paused: paused,
                             selected: showSelection && panel.id == selectedID, sound: sound)
                        .frame(width: layout.tile.width, height: layout.tile.height)
                        .position(
                            x: (geo.size.width - rowW) / 2 + CGFloat(col) * (layout.tile.width + gap) + layout.tile.width / 2,
                            y: (geo.size.height - totalH) / 2 + CGFloat(row) * (layout.tile.height + gap) + layout.tile.height / 2
                        )
                }
            }
            .animation(.easeInOut(duration: 0.35), value: panels.map(\.id))
        }
        .ignoresSafeArea()
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .onAppear { focused = true }
        .onMoveCommand(perform: handleMove)
        .onTapGesture { sound.toggle(); touch() }
        .onPlayPauseCommand { paused.toggle() }
    }

    // Left / right move the selection through the panels. Up / down page through the selected panel's author feed.
    private func handleMove(_ direction: MoveCommandDirection) {
        let panels = store.panels
        guard !panels.isEmpty else { return }
        var current = panels.firstIndex { $0.id == selectedID } ?? (panels.count - 1)
        switch direction {
        case .left:  current = max(0, current - 1)
        case .right: current = min(panels.count - 1, current + 1)
        case .up:    withAnimation(.easeInOut(duration: 0.25)) { panels[current].step(1) }
        case .down:  withAnimation(.easeInOut(duration: 0.25)) { panels[current].step(-1) }
        @unknown default: break
        }
        selectedID = panels[current].id
        touch()
    }

    private func touch() {
        if selectedID == nil || !store.panels.contains(where: { $0.id == selectedID }) {
            selectedID = store.panels.last?.id
        }
        showSelection = true
        hideTask?.cancel()
        hideTask = Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if !Task.isCancelled { showSelection = false }
        }
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
