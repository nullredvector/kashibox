import SwiftUI
import UIKit

enum RemoteDirection { case up, down, left, right }

/// Reads the Siri Remote directly so a swipe on the touch surface and a click on its edge are different things
/// (SwiftUI reports both as the same "move" command).
struct RemoteInput: UIViewRepresentable {
    var onSwipe: (RemoteDirection) -> Void
    var onClick: (RemoteDirection) -> Void
    var onSelect: () -> Void
    var onLongSelect: () -> Void
    var onPlayPause: () -> Void

    func makeUIView(context: Context) -> RemoteInputView {
        let view = RemoteInputView()
        update(view)
        return view
    }

    func updateUIView(_ view: RemoteInputView, context: Context) { update(view) }

    private func update(_ view: RemoteInputView) {
        view.onSwipe = onSwipe
        view.onClick = onClick
        view.onSelect = onSelect
        view.onLongSelect = onLongSelect
        view.onPlayPause = onPlayPause
    }
}

private final class DirectionTap: UITapGestureRecognizer {
    var direction: RemoteDirection = .up
}

final class RemoteInputView: UIView {
    var onSwipe: ((RemoteDirection) -> Void)?
    var onClick: ((RemoteDirection) -> Void)?
    var onSelect: (() -> Void)?
    var onLongSelect: (() -> Void)?
    var onPlayPause: (() -> Void)?

    private var swiped = false
    private let swipeDistance: CGFloat = 120

    override var canBecomeFocused: Bool { true }

    override init(frame: CGRect) {
        super.init(frame: frame)

        let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        pan.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirect.rawValue)]
        addGestureRecognizer(pan)

        let arrows: [(UIPress.PressType, RemoteDirection)] = [(.upArrow, .up), (.downArrow, .down), (.leftArrow, .left), (.rightArrow, .right)]
        for (type, direction) in arrows {
            let tap = DirectionTap(target: self, action: #selector(clicked(_:)))
            tap.direction = direction
            tap.allowedPressTypes = [NSNumber(value: type.rawValue)]
            tap.allowedTouchTypes = []
            addGestureRecognizer(tap)
        }

        let long = UILongPressGestureRecognizer(target: self, action: #selector(longPressed(_:)))
        long.allowedPressTypes = [NSNumber(value: UIPress.PressType.select.rawValue)]
        long.allowedTouchTypes = []
        long.minimumPressDuration = 0.7
        addGestureRecognizer(long)

        let select = UITapGestureRecognizer(target: self, action: #selector(selected))
        select.allowedPressTypes = [NSNumber(value: UIPress.PressType.select.rawValue)]
        select.allowedTouchTypes = []
        select.require(toFail: long)
        addGestureRecognizer(select)

        let playPause = UITapGestureRecognizer(target: self, action: #selector(playPaused))
        playPause.allowedPressTypes = [NSNumber(value: UIPress.PressType.playPause.rawValue)]
        playPause.allowedTouchTypes = []
        addGestureRecognizer(playPause)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// One step per swipe, once the finger has travelled far enough.
    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        switch pan.state {
        case .began:
            swiped = false
        case .changed:
            guard !swiped else { return }
            let t = pan.translation(in: self)
            guard abs(t.x) > swipeDistance || abs(t.y) > swipeDistance else { return }
            swiped = true
            if abs(t.x) > abs(t.y) { onSwipe?(t.x > 0 ? .right : .left) } else { onSwipe?(t.y > 0 ? .down : .up) }
        default:
            swiped = false
        }
    }

    @objc private func clicked(_ tap: DirectionTap) { onClick?(tap.direction) }
    @objc private func selected() { onSelect?() }
    @objc private func longPressed(_ press: UILongPressGestureRecognizer) { if press.state == .began { onLongSelect?() } }
    @objc private func playPaused() { onPlayPause?() }
}
