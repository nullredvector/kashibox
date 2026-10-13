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
    private var task: Task<Void, Never>?
    private var byID: [String: PanelModel] = [:]
    private var lastItems: [TVItem] = []

    func start() {
        guard task == nil else { return }
        task = Task { await self.run() }
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
                    if event.items != lastItems { apply(event.items) }
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
                byID[item.id] = panel
                next.append(panel)
                fresh.append(panel)
            }
        }
        let keep = Set(items.map(\.id))
        byID = byID.filter { keep.contains($0.key) }
        panels = next
        for panel in fresh { Task { await panel.loadAuthorFeed() } }
    }
}
