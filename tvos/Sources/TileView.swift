import SwiftUI

private let starYellow = Color(red: 1.0, green: 0.88, blue: 0.4)

/// The picture of one video: the cover stays up until the first frame is on screen.
private struct VideoSurface: View {
    let video: VideoRef
    let muted: Bool
    @State private var ready = false

    var body: some View {
        ZStack {
            LoopingPlayer(url: Config.url(video.videoUrl), muted: muted) {
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

/// A big star that pops in the middle of the tile and fades, shown when a video gets starred.
private struct StarBurst: View {
    let trigger: Int
    @State private var scale: CGFloat = 0.3
    @State private var opacity: Double = 0

    var body: some View {
        Image(systemName: "star.fill")
            .font(.system(size: 150))
            .foregroundColor(starYellow)
            .shadow(color: starYellow.opacity(0.8), radius: 24)
            .scaleEffect(scale)
            .opacity(opacity)
            .onChange(of: trigger) { _ in
                scale = 0.3; opacity = 1
                withAnimation(.spring(response: 0.5, dampingFraction: 0.55)) { scale = 1.25 }
                withAnimation(.easeIn(duration: 0.5).delay(0.35)) { opacity = 0 }
            }
            .allowsHitTesting(false)
    }
}

struct TileView: View {
    @ObservedObject var panel: PanelModel
    let selected: Bool
    let audible: Bool
    @State private var flash = true
    @State private var burst = 0

    var body: some View {
        ZStack {
            Color(white: 0.07)
            VideoSurface(video: panel.current, muted: !audible)
                .id(panel.current.videoUrl)
                .transition(.opacity)
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color.white.opacity(0.9), lineWidth: 5)
                .opacity(flash ? 1 : 0)
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color(red: 1.0, green: 0.62, blue: 0.77), lineWidth: 9)
                .opacity(selected ? 1 : 0)

            StarBurst(trigger: burst)

            VStack {
                HStack(alignment: .top) {
                    if audible {
                        Image(systemName: "speaker.wave.2.fill")
                            .font(.system(size: 26, weight: .semibold))
                            .foregroundColor(.white)
                            .padding(10)
                            .background(Circle().fill(Color.black.opacity(0.55)))
                            .transition(.scale.combined(with: .opacity))
                    }
                    Spacer()
                    if panel.starred {
                        Image(systemName: "star.fill")
                            .font(.system(size: 46))
                            .foregroundColor(starYellow)
                            .shadow(color: .black.opacity(0.6), radius: 6)
                            .transition(.asymmetric(
                                insertion: .scale(scale: 0.1).combined(with: .opacity),
                                removal: .scale(scale: 2.2).combined(with: .opacity)))
                    }
                }
                .padding(14)
                Spacer()
                if selected && panel.videos.count > 1 {
                    Text("\(panel.index + 1) / \(panel.videos.count)")
                        .font(.system(size: 26, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 8)
                        .background(Capsule().fill(Color.black.opacity(0.6)))
                        .padding(.bottom, 18)
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .animation(.spring(response: 0.4, dampingFraction: 0.5), value: panel.starred)
        .animation(.easeInOut(duration: 0.15), value: selected)
        .animation(.easeInOut(duration: 0.2), value: audible)
        .onChange(of: panel.starPresses) { _ in burst += 1 }
        .onAppear { withAnimation(.easeOut(duration: 0.9)) { flash = false } }
    }
}
