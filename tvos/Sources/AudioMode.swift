import AVFoundation

/// Muted videos must not interrupt music playing in the background (Spotify and the like), so while everything is
/// muted the app uses an ambient session that mixes with other audio. A video that is unmuted takes a playback session,
/// which pauses the other app; when it is muted again the app lets go and tells the other app it may carry on.
enum AudioMode {
    static func set(audible: Bool) {
        let session = AVAudioSession.sharedInstance()
        do {
            if audible {
                try session.setCategory(.playback, mode: .moviePlayback)
                try session.setActive(true)
            } else {
                try session.setCategory(.ambient, mode: .default, options: [.mixWithOthers])
                try? session.setActive(false, options: .notifyOthersOnDeactivation)
                try session.setActive(true)
            }
        } catch {
            // the videos still play; only the sharing with other audio is lost
        }
    }
}
