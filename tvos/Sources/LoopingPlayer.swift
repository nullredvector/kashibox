import SwiftUI
import AVFoundation

final class PlayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

/// A muted, endlessly looping video that fills its frame.
struct LoopingPlayer: UIViewRepresentable {
    let url: URL?
    let paused: Bool
    let onReady: () -> Void

    final class Coordinator {
        var player: AVQueuePlayer?
        var looper: AVPlayerLooper?
        var observation: NSKeyValueObservation?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> PlayerView {
        let view = PlayerView()
        view.playerLayer.videoGravity = .resizeAspectFill
        guard let url else { return view }

        let player = AVQueuePlayer()
        player.isMuted = true
        context.coordinator.looper = AVPlayerLooper(player: player, templateItem: AVPlayerItem(url: url))
        context.coordinator.player = player
        view.playerLayer.player = player

        let ready = onReady
        context.coordinator.observation = view.playerLayer.observe(\.isReadyForDisplay, options: [.initial, .new]) { layer, _ in
            if layer.isReadyForDisplay { DispatchQueue.main.async(execute: ready) }
        }
        player.play()
        return view
    }

    func updateUIView(_ view: PlayerView, context: Context) {
        guard let player = context.coordinator.player else { return }
        if paused { player.pause() } else if player.rate == 0 { player.play() }
    }

    static func dismantleUIView(_ view: PlayerView, coordinator: Coordinator) {
        coordinator.player?.pause()
        coordinator.looper?.disableLooping()
        view.playerLayer.player = nil
    }
}
