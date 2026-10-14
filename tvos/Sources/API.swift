import Foundation

struct TVSession: Decodable, Identifiable, Equatable {
    let id: String
    let label: String
    let count: Int
    let updatedAt: Double   // milliseconds since 1970

    var lastUsed: String {
        Date(timeIntervalSince1970: updatedAt / 1000).formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }
}

/// The few calls the TV makes besides the live stream.
enum API {
    private static func post(_ url: URL, _ body: [String: Any]) async -> Data? {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return data
    }

    /// Sets a video's star to an explicit state; returns the state the server ended up with (nil = the call failed).
    static func setStar(videoUrl: String, starred: Bool) async -> Bool? {
        guard let data = await post(Config.starURL, ["videoUrl": videoUrl, "starred": starred]),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return json["starred"] as? Bool
    }

    /// Tells the server which panel is selected on the TV (nil = none), so a new video can take its place once the grid is full.
    static func select(panelID: String?) async {
        _ = await post(Config.selectURL, ["id": panelID as Any? ?? NSNull()])
    }

    /// Takes one panel off the grid; the new grid comes back over the live stream.
    static func remove(panelID: String) async {
        _ = await post(Config.removeURL, ["id": panelID])
    }

    /// Which of these videos are starred right now.
    static func starred(among videoUrls: [String]) async -> Set<String>? {
        guard !videoUrls.isEmpty, let url = Config.starredURL(for: videoUrls),
              let (data, _) = try? await URLSession.shared.data(from: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = json["starred"] as? [String] else { return nil }
        return Set(list)
    }

    /// The Home feed order (what the phone's Home feed shows, or a random mix when no phone has published one).
    static func feed() async -> [VideoRef]? {
        struct Reply: Decodable { let videos: [VideoRef] }
        guard let (data, _) = try? await URLSession.shared.data(from: Config.feedURL),
              let reply = try? JSONDecoder().decode(Reply.self, from: data) else { return nil }
        return reply.videos
    }

    static func sessions() async -> [TVSession]? {
        struct Reply: Decodable { let sessions: [TVSession] }
        guard let (data, _) = try? await URLSession.shared.data(from: Config.sessionsURL),
              let reply = try? JSONDecoder().decode(Reply.self, from: data) else { return nil }
        return reply.sessions
    }

    /// Puts one panel per account of the session on the grid; the grid itself comes back over the live stream.
    static func startSession(id: String) async -> Bool {
        await post(Config.sessionURL, ["id": id]) != nil
    }
}
