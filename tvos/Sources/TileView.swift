import SwiftUI

/// The picture of one video: the cover stays up until the first frame is on screen.
private struct VideoSurface: View {
    let video: VideoRef
    let paused: Bool
    let muted: Bool
    @State private var ready = false

    var body: some View {
        ZStack {
            LoopingPlayer(url: Config.url(video.videoUrl), paused: paused, muted: muted) {
                withAnimation(.easeOut(duration: 0.5)) { ready = true }
            }
            if !ready, let cover = Config.url(video.coverUrl) {
                AsyncImage(url: cover) { image in
                    image.resizable().aspectRatio(contentMode: .fill)
                } placeholder: {
                    Color.clear
                }
                .transition(.opacity)
            }
        }
    }
}

struct TileView: View {
    @ObservedObject var panel: PanelModel
    let paused: Bool
    let selected: Bool
    let sound: Bool
    @State private var flash = true

    var body: some View {
        ZStack {
            Color(white: 0.07)
            VideoSurface(video: panel.current, paused: paused, muted: !(selected && sound))
                .id(panel.current.videoUrl)
                .transition(.opacity)
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color.white.opacity(0.9), lineWidth: 5)
                .opacity(flash ? 1 : 0)
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color(red: 1.0, green: 0.62, blue: 0.77), lineWidth: 9)
                .opacity(selected ? 1 : 0)
            if selected {
                VStack {
                    Spacer()
                    HStack(spacing: 12) {
                        if sound { Image(systemName: "speaker.wave.2.fill") }
                        if panel.videos.count > 1 { Text("\(panel.index + 1) / \(panel.videos.count)") }
                    }
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundColor(.white)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 8)
                    .background(Capsule().fill(Color.black.opacity(0.6)))
                    .padding(.bottom, 18)
                    .opacity(sound || panel.videos.count > 1 ? 1 : 0)
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .animation(.easeInOut(duration: 0.15), value: selected)
        .onAppear { withAnimation(.easeOut(duration: 0.9)) { flash = false } }
    }
}
