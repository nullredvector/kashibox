import SwiftUI

private let gap: CGFloat = 16
private let margin: CGFloat = 40
private let singleRowUnits = 4

/// Panels keep their order. A portrait video takes one pane of room, a landscape one takes two. Up to four panes sit in
/// one row; beyond that there are two rows, split as evenly as possible (the first row the longer when it ties). Panes are
/// 9:16 and as big as fit; a two-pane panel is as tall as the others and spans two panes (and the gap between them).
private func layoutSlots(_ weights: [Int], in size: CGSize) -> [CGRect] {
    let n = weights.count
    guard n > 0 else { return [] }
    let total = weights.reduce(0, +)

    var rows: [Range<Int>] = [0..<n]
    if total > singleRowUnits && n > 1 {
        var bestSplit = 1, bestMax = Int.max
        for k in 1..<n {
            let first = weights[..<k].reduce(0, +)
            let widest = max(first, total - first)
            if widest < bestMax || (widest == bestMax && first >= total - first) { bestMax = widest; bestSplit = k }
        }
        rows = [0..<bestSplit, bestSplit..<n]
    }

    let rowUnits = rows.map { range in range.reduce(0) { $0 + weights[$1] } }
    let maxUnits = rowUnits.max() ?? 1
    let rowCount = CGFloat(rows.count)
    let availW = size.width - 2 * margin
    let availH = size.height - 2 * margin
    let byWidth = (availW - gap * CGFloat(maxUnits - 1)) / CGFloat(maxUnits)
    let byHeight = ((availH - gap * (rowCount - 1)) / rowCount) * 9 / 16
    let unit = min(byWidth, byHeight)
    let height = unit * 16 / 9
    let totalHeight = rowCount * height + (rowCount - 1) * gap

    var rects = [CGRect](repeating: .zero, count: n)
    for (r, range) in rows.enumerated() {
        let rowWidth = CGFloat(rowUnits[r]) * unit + CGFloat(rowUnits[r] - 1) * gap
        var x = (size.width - rowWidth) / 2
        let y = (size.height - totalHeight) / 2 + CGFloat(r) * (height + gap)
        for i in range {
            let width = CGFloat(weights[i]) * unit + CGFloat(weights[i] - 1) * gap
            rects[i] = CGRect(x: x, y: y, width: width, height: height)
            x += width + gap
        }
    }
    return rects
}

struct ContentView: View {
    @EnvironmentObject private var store: TVStore
    @State private var audibleID: String?
    @State private var selectedID: String?
    @State private var showSelection = false
    @State private var hideTask: Task<Void, Never>?
    @State private var pickerIndex = 0
    @State private var reportTask: Task<Void, Never>?
    @State private var lastRemoval = Date.distantPast

    var body: some View {
        GeometryReader { geo in
            let panels = store.panels
            let count = panels.count
            let rects = layoutSlots(panels.map { $0.isWide ? 2 : 1 }, in: geo.size)

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
                    let rect = rects[index]
                    TileView(panel: panel,
                             selected: showSelection && panel.id == selectedID,
                             audible: panel.id == audibleID)
                        .frame(width: rect.width, height: rect.height)
                        .position(x: rect.midX, y: rect.midY)
                }
            }
            .animation(.easeInOut(duration: 0.35), value: panels.map { "\($0.id)\($0.isWide)" })
        }
        .ignoresSafeArea()
        .background(
            RemoteInput(onSwipe: handleSwipe, onClick: handleClick, onSelect: handleSelect,
                        onLongSelect: handleRemove, onPlayPause: handlePlayPause)
        )
        .onChange(of: store.panels.map(\.id)) { old, new in followPanels(old: old, new: new) }
        .onChange(of: selectedID) { _, _ in report() }
        .onChange(of: showSelection) { _, _ in report() }
        .onChange(of: anyAudible) { _, audible in AudioMode.set(audible: audible) }
    }

    // When the selected panel's video is replaced by a new one (the grid was full), the selection stays on that slot.
    private func followPanels(old: [String], new: [String]) {
        if new.isEmpty { selectedID = nil; return }
        guard let selected = selectedID, !new.contains(selected), let slot = old.firstIndex(of: selected) else { return }
        selectedID = new[min(slot, new.count - 1)]
        touch()
    }

    // The server needs to know which panel is highlighted (the pink outline is showing): a video sent from a phone
    // replaces that panel instead of being added.
    private func report() {
        let highlighted = showSelection ? selectedID : nil
        reportTask?.cancel()
        reportTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if !Task.isCancelled { await API.select(panelID: highlighted) }
        }
    }

    // True while some video on the grid is unmuted
    private var anyAudible: Bool { store.panels.contains { $0.id == audibleID } }

    private var selectedPanel: PanelModel? {
        store.panels.first { $0.id == selectedID } ?? store.panels.last
    }

    // Swipe: left / right move the selection through the panels; up / down page through the selected panel's author
    // (its own videos). With an empty grid they move through the session list instead.
    private func handleSwipe(_ direction: RemoteDirection) {
        switch direction {
        case .left:  moveSelection(by: -1)
        case .right: moveSelection(by: 1)
        case .up:    vertical(1, viaClick: false)
        case .down:  vertical(-1, viaClick: false)
        }
    }

    // Click on the edge of the clickpad: left / right move the selection too; up / down move the selected panel along the
    // Home feed, like scrolling it.
    private func handleClick(_ direction: RemoteDirection) {
        switch direction {
        case .left:  moveSelection(by: -1)
        case .right: moveSelection(by: 1)
        case .up:    vertical(1, viaClick: true)
        case .down:  vertical(-1, viaClick: true)
        }
    }

    private func moveSelection(by delta: Int) {
        let panels = store.panels
        guard !panels.isEmpty else { return }
        let current = panels.firstIndex { $0.id == selectedID } ?? (panels.count - 1)
        selectedID = panels[min(max(current + delta, 0), panels.count - 1)].id
        touch()
    }

    private func vertical(_ delta: Int, viaClick: Bool) {
        let panels = store.panels
        if panels.isEmpty {
            pickerIndex = min(max(pickerIndex - delta, 0), max(store.sessions.count - 1, 0))   // up = toward the top of the list
            return
        }
        let current = panels.firstIndex { $0.id == selectedID } ?? (panels.count - 1)
        let panel = panels[current]
        selectedID = panel.id
        if viaClick {
            Task { panel.feedStep(delta, in: await store.feedList()) }
        } else {
            panel.step(delta)
        }
        touch()
    }

    // Click: star or un-star the selected video (with an empty grid: open the highlighted session).
    private func handleSelect() {
        if Date().timeIntervalSince(lastRemoval) < 1 { return }   // the release after a long press is not a click
        if store.panels.isEmpty {
            openSession()
            return
        }
        guard let panel = selectedPanel else { return }
        selectedID = panel.id
        panel.toggleStar()
        touch()
    }

    // Long click: take the highlighted video off the grid. Without a visible highlight it only shows where the selection is.
    private func handleRemove() {
        guard !store.panels.isEmpty else { return }
        guard showSelection, let panel = selectedPanel else { touch(); return }
        lastRemoval = Date()
        Task { await API.remove(panelID: panel.id) }
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
            try? await Task.sleep(nanoseconds: 10_000_000_000)
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
                        Text("\(session.count) video\(session.count == 1 ? "" : "s") · \(session.lastUsed)")
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
            Text("Swipe up or down, then click. Videos you send from your phone are saved as a session.")
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
