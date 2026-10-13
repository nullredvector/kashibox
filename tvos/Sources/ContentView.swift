import SwiftUI

private let gap: CGFloat = 16
private let margin: CGFloat = 40
private let singleRowMax = 4

/// Up to four panels sit in one row; from the fifth on there are two balanced rows (up to six each).
/// Tiles are 9:16 and as big as fit.
private func layoutFor(count: Int, in size: CGSize) -> (rows: Int, perRow: Int, tile: CGSize) {
    let rows = count > singleRowMax ? 2 : 1
    let perRow = rows == 1 ? max(count, 1) : (count + 1) / 2
    let availW = size.width - 2 * margin
    let availH = size.height - 2 * margin
    let w = (availW - gap * CGFloat(perRow - 1)) / CGFloat(perRow)
    let h = (availH - gap * CGFloat(rows - 1)) / CGFloat(rows)
    let tw = min(w, h * 9 / 16)
    return (rows, perRow, CGSize(width: tw, height: tw * 16 / 9))
}

struct ContentView: View {
    @EnvironmentObject private var store: TVStore
    @FocusState private var focused: Bool
    @State private var audibleID: String?
    @State private var selectedID: String?
    @State private var showSelection = false
    @State private var hideTask: Task<Void, Never>?
    @State private var pickerIndex = 0

    var body: some View {
        GeometryReader { geo in
            let panels = store.panels
            let count = panels.count
            let layout = layoutFor(count: count, in: geo.size)
            let totalH = CGFloat(layout.rows) * layout.tile.height + CGFloat(layout.rows - 1) * gap

            ZStack {
                Color(white: 0.02)
                if count == 0 {
                    if store.connected && !store.sessions.isEmpty {
                        SessionPicker(sessions: store.sessions, selected: min(pickerIndex, store.sessions.count - 1), opening: store.startingSession)
                    } else {
                        IdleView(connected: store.connected)
                    }
                }
                ForEach(Array(panels.enumerated()), id: \.element.id) { index, panel in
                    let row = index / layout.perRow
                    let col = index % layout.perRow
                    let inRow = row == 0 ? min(count, layout.perRow) : count - layout.perRow
                    let rowW = CGFloat(inRow) * layout.tile.width + CGFloat(inRow - 1) * gap
                    TileView(panel: panel,
                             selected: showSelection && panel.id == selectedID,
                             audible: panel.id == audibleID)
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
        .onTapGesture(perform: handleSelect)
        .onPlayPauseCommand(perform: handlePlayPause)
    }

    private var selectedPanel: PanelModel? {
        store.panels.first { $0.id == selectedID } ?? store.panels.last
    }

    // Left / right move the selection through the panels. Up / down page through the selected panel's author feed.
    // With an empty grid they move through the session list instead.
    private func handleMove(_ direction: MoveCommandDirection) {
        let panels = store.panels
        if panels.isEmpty {
            switch direction {
            case .up:   pickerIndex = max(0, pickerIndex - 1)
            case .down: pickerIndex = min(max(store.sessions.count - 1, 0), pickerIndex + 1)
            default: break
            }
            return
        }
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

    // Click: star or un-star the selected video (with an empty grid: open the highlighted session).
    private func handleSelect() {
        if store.panels.isEmpty {
            openSession()
            return
        }
        guard let panel = selectedPanel else { return }
        selectedID = panel.id
        panel.toggleStar()
        touch()
    }

    // Play / Pause: mute or unmute the selected video. Only one video is ever audible:
    // unmuting one mutes whichever was playing sound before.
    private func handlePlayPause() {
        if store.panels.isEmpty {
            openSession()
            return
        }
        guard let panel = selectedPanel else { return }
        selectedID = panel.id
        audibleID = (audibleID == panel.id) ? nil : panel.id
        touch()
    }

    private func openSession() {
        guard store.connected, !store.startingSession, store.sessions.indices.contains(pickerIndex) else { return }
        store.startSession(store.sessions[pickerIndex])
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

struct SessionPicker: View {
    let sessions: [TVSession]
    let selected: Int
    let opening: Bool

    private let rows = 7

    var body: some View {
        let start = max(0, min(selected - rows / 2, sessions.count - rows))
        let end = min(sessions.count, start + rows)
        VStack(spacing: 26) {
            Text("kashibox")
                .font(.system(size: 76, weight: .ultraLight))
                .tracking(12)
                .foregroundColor(Color(white: 0.35))
            Text(opening ? "Opening…" : "Choose a session")
                .font(.system(size: 36))
                .foregroundColor(Color(white: 0.6))
            VStack(spacing: 14) {
                ForEach(start..<end, id: \.self) { index in
                    let session = sessions[index]
                    let isSelected = index == selected
                    HStack {
                        Text(session.label)
                            .lineLimit(1)
                            .font(.system(size: 34, weight: isSelected ? .semibold : .regular))
                        Spacer(minLength: 24)
                        Text("\(session.count) account\(session.count == 1 ? "" : "s")")
                            .font(.system(size: 28))
                            .foregroundColor(Color(white: isSelected ? 0.85 : 0.5))
                    }
                    .foregroundColor(isSelected ? .white : Color(white: 0.7))
                    .padding(.horizontal, 30)
                    .frame(width: 1100, height: 74)
                    .background(
                        RoundedRectangle(cornerRadius: 16)
                            .fill(isSelected ? Color(red: 1.0, green: 0.62, blue: 0.77).opacity(0.28) : Color.white.opacity(0.05))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 16)
                            .strokeBorder(Color(red: 1.0, green: 0.62, blue: 0.77), lineWidth: isSelected ? 5 : 0)
                    )
                    .scaleEffect(isSelected ? 1.03 : 1)
                }
            }
            .animation(.easeInOut(duration: 0.15), value: selected)
            Text("Swipe up or down, then click. You can also send videos from your phone.")
                .font(.system(size: 26))
                .foregroundColor(Color(white: 0.35))
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
