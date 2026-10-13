import Foundation

enum Config {
    static let server = URL(string: "https://kashibox.fexel.net")!

    static var streamURL: URL { server.appendingPathComponent("api/tv/stream") }

    static func url(_ path: String) -> URL? {
        path.isEmpty ? nil : URL(string: path, relativeTo: server)?.absoluteURL
    }
}
