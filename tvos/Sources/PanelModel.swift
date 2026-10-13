import Foundation

struct VideoRef: Decodable, Equatable {
    let videoUrl: String
    let coverUrl: String
}

private struct AuthorFeed: Decodable {
    let videos: [VideoRef]
    let index: Int
}

/// One panel on the grid: the video that was sent, plus (once the server answers) the rest of that author's videos
/// so the remote can page through them like a feed.
@MainActor
final class PanelModel: ObservableObject, Identifiable {
    let id: String
    @Published private(set) var videos: [VideoRef]
    @Published private(set) var index = 0

    var current: VideoRef { videos[min(index, videos.count - 1)] }

    init(_ item: TVItem) {
        id = item.id
        videos = [VideoRef(videoUrl: item.videoUrl, coverUrl: item.coverUrl)]
    }

    func loadAuthorFeed() async {
        guard let url = Config.authorURL(for: videos[0].videoUrl),
              let (data, _) = try? await URLSession.shared.data(from: url),
              let feed = try? JSONDecoder().decode(AuthorFeed.self, from: data),
              !feed.videos.isEmpty else { return }
        let shown = current
        videos = feed.videos
        index = videos.firstIndex(of: shown) ?? min(feed.index, videos.count - 1)
    }

    /// +1 = next video, -1 = previous; wraps around at the ends.
    func step(_ delta: Int) {
        guard videos.count > 1 else { return }
        index = (index + delta + videos.count) % videos.count
    }
}
