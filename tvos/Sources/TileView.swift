import SwiftUI

struct TileView: View {
    let item: TVItem
    let paused: Bool
    @State private var ready = false
    @State private var ring = true

    var body: some View {
        ZStack {
            Color(white: 0.07)
            LoopingPlayer(url: Config.url(item.videoUrl), paused: paused) {
                withAnimation(.easeOut(duration: 0.6)) { ready = true }
            }
            if !ready, let cover = Config.url(item.coverUrl) {
                AsyncImage(url: cover) { image in
                    image.resizable().aspectRatio(contentMode: .fill)
                } placeholder: {
                    Color.clear
                }
                .transition(.opacity)
            }
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color.white.opacity(0.9), lineWidth: 5)
                .opacity(ring ? 1 : 0)
        }
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .onAppear { withAnimation(.easeOut(duration: 0.9)) { ring = false } }
    }
}
