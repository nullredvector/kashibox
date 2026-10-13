import Foundation

struct TVItem: Decodable, Identifiable, Equatable {
    let id: String
    let videoUrl: String
    let coverUrl: String
}

private struct TVEvent: Decodable {
    let type: String
    let items: [TVItem]
}

/// Keeps one long-lived connection to the server and mirrors the grid it announces.
@MainActor
final class TVStore: ObservableObject {
    @Published private(set) var panels: [PanelModel] = []
    @Published private(set) var connected = false
    @Published private(set) var sessions: [TVSession] = []
    @Published private(set) var startingSession = false
    private var task: Task<Void, Never>?
    private var byID: [String: PanelModel] = [:]
    private var lastItems: [TVItem] = []
    private var gotFirstState = false

    func start() {
        guard task == nil else { return }
        task = Task { await self.run() }
        Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                await refreshStars()
            }
        }
    }

    func loadSessions() async {
        if let list = await API.sessions() { sessions = list }
    }

    func startSession(_ session: TVSession) {
        startingSession = true
        Task {
            _ = await API.startSession(id: session.id)
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            startingSession = false
        }
    }

    /// Looks up which of the videos on show are starred (after a change, and every so often for stars set elsewhere).
    func refreshStars() async {
        let shown = panels.map { ($0, $0.current.videoUrl) }
        guard let starred = await API.starred(among: shown.map { $0.1 }) else { return }
        for (panel, url) in shown where panel.current.videoUrl == url { panel.starred = starred.contains(url) }
    }

    private func run() async {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 45          // the server sends a heartbeat every 15 s
        cfg.timeoutIntervalForResource = 60 * 60 * 24 * 365
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        let session = URLSession(configuration: cfg)

        while !Task.isCancelled {
            do {
                var req = URLRequest(url: Config.streamURL)
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                let (bytes, resp) = try await session.bytes(for: req)
                guard (resp as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
                connected = true
                for try await line in bytes.lines {
                    guard line.hasPrefix("data:") else { continue }
                    let json = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                    guard let data = json.data(using: .utf8),
                          let event = try? JSONDecoder().decode(TVEvent.self, from: data),
                          event.type == "state" else { continue }
                    if !gotFirstState || event.items != lastItems { gotFirstState = true; apply(event.items) }
                }
            } catch {
                // fall through and reconnect
            }
            connected = false
            try? await Task.sleep(nanoseconds: 3_000_000_000)
        }
    }

    private func apply(_ items: [TVItem]) {
        lastItems = items
        var next: [PanelModel] = []
        var fresh: [PanelModel] = []
        for item in items {
            if let panel = byID[item.id] {
                next.append(panel)
            } else {
                let panel = PanelModel(item)
                panel.onVideoChange = { [weak self] in Task { await self?.refreshStars() } }
                byID[item.id] = panel
                next.append(panel)
                fresh.append(panel)
            }
        }
        let keep = Set(items.map(\.id))
        byID = byID.filter { keep.contains($0.key) }
        panels = next
        if !next.isEmpty { startingSession = false }
        for panel in fresh { Task { await panel.loadAuthorFeed() } }
        Task { await refreshStars() }
        if next.isEmpty { Task { await loadSessions() } }
    }
}
