import Foundation

enum Config {
    static let server = URL(string: "https://kashibox.fexel.net")!

    static var streamURL: URL { server.appendingPathComponent("api/tv/stream") }

    static func authorURL(for videoUrl: String) -> URL? {
        var c = URLComponents(url: server.appendingPathComponent("api/tv/author"), resolvingAgainstBaseURL: false)
        c?.queryItems = [URLQueryItem(name: "v", value: videoUrl)]
        return c?.url
    }

    static var sessionsURL: URL { server.appendingPathComponent("api/tv/sessions") }
    static var sessionURL: URL { server.appendingPathComponent("api/tv/session") }
    static var removeURL: URL { server.appendingPathComponent("api/tv/remove") }
    static var selectURL: URL { server.appendingPathComponent("api/tv/select") }
    static var starURL: URL { server.appendingPathComponent("api/tv/star") }

    static func starredURL(for videoUrls: [String]) -> URL? {
        var c = URLComponents(url: server.appendingPathComponent("api/tv/starred"), resolvingAgainstBaseURL: false)
        c?.queryItems = videoUrls.map { URLQueryItem(name: "v", value: $0) }
        return c?.url
    }

    static func url(_ path: String) -> URL? {
        path.isEmpty ? nil : URL(string: path, relativeTo: server)?.absoluteURL
    }
}
