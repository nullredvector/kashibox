import Foundation

enum Config {
    static let server = URL(string: "https://kashibox.fexel.net")!

    static var streamURL: URL { server.appendingPathComponent("api/tv/stream") }

    static func authorURL(for videoUrl: String) -> URL? {
        var c = URLComponents(url: server.appendingPathComponent("api/tv/author"), resolvingAgainstBaseURL: false)
        c?.queryItems = [URLQueryItem(name: "v", value: videoUrl)]
        return c?.url
    }

    static func url(_ path: String) -> URL? {
        path.isEmpty ? nil : URL(string: path, relativeTo: server)?.absoluteURL
    }
}
