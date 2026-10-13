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
    @Published var starred = false
    /// Counts presses that starred a video (drives the burst animation, which must not play for videos that were already starred).
    @Published private(set) var starPresses = 0
    /// Called when the video on show changes, so the star state can be looked up again.
    var onVideoChange: (() -> Void)?

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
        if current != shown { onVideoChange?() }
    }

    /// +1 = next video, -1 = previous; wraps around at the ends.
    func step(_ delta: Int) {
        guard videos.count > 1 else { return }
        index = (index + delta + videos.count) % videos.count
        onVideoChange?()
    }

    /// Stars or un-stars the video on show: the badge changes at once, the server's answer settles it.
    func toggleStar() {
        let video = current
        let target = !starred
        starred = target
        if target { starPresses += 1 }
        Task {
            let result = await API.setStar(videoUrl: video.videoUrl, starred: target)
            if current == video { starred = result ?? !target }
        }
    }
}
