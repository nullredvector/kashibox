import Capacitor
import GoogleCast

@objc(KashiboxCastPlugin)
public class KashiboxCastPlugin: CAPPlugin, GCKSessionManagerListener, GCKRemoteMediaClientListener, GCKLoggerDelegate {

    let namespace = "urn:x-cast:net.fexel.kashibox"

    public override func load() {
        print("⚡️ KashiboxCast: load() running")
        let filter = GCKLoggerFilter()
        filter.minimumLevel = .debug
        GCKLogger.sharedInstance().filter = filter
        GCKLogger.sharedInstance().delegate = self
        let criteria = GCKDiscoveryCriteria(applicationID: "5B3E2EFF")
        let options  = GCKCastOptions(discoveryCriteria: criteria)
        options.startDiscoveryAfterFirstTapOnCastButton = false
        GCKCastContext.setSharedInstanceWith(options)
        GCKCastContext.sharedInstance().sessionManager.add(self)
        GCKCastContext.sharedInstance().discoveryManager.startDiscovery()
        print("⚡️ KashiboxCast: discovery started, castState=\(GCKCastContext.sharedInstance().castState.rawValue)")
        NotificationCenter.default.addObserver(forName: .gckCastStateDidChange, object: nil, queue: .main) { [weak self] _ in
            guard let self = self else { return }
            let state = GCKCastContext.sharedInstance().castState
            self.notifyListeners("castStateChanged", data: ["state": self.stateName(state)])
        }
    }

    public func logMessage(_ message: String, at level: GCKLoggerLevel, fromFunction function: String, location: String) {
        print("CASTLOG \(function): \(message)")
    }

    // MARK: - JS-callable methods

    // The Cast SDK insists on the main thread (it throws otherwise), but Capacitor calls plugin methods on its own queue.

    @objc func getState(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let state = GCKCastContext.sharedInstance().castState
            call.resolve(["state": self.stateName(state)])
        }
    }

    @objc func requestSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            GCKCastContext.sharedInstance().presentCastDialog()
            call.resolve()
        }
    }

    @objc func sendMessage(_ call: CAPPluginCall) {
        guard let data = call.getObject("data") else {
            call.reject("data required")
            return
        }
        DispatchQueue.main.async {
            guard let session = GCKCastContext.sharedInstance().sessionManager.currentCastSession else {
                call.reject("no session")
                return
            }
            if self.channel == nil || self.channel?.isConnected == false { self.attachChannel(to: session) }
            guard let channel = self.channel else {
                call.reject("no channel")
                return
            }
            do {
                let json = try JSONSerialization.data(withJSONObject: data)
                let text = String(data: json, encoding: .utf8) ?? "{}"
                channel.sendTextMessage(text, error: nil)
                call.resolve()
            } catch {
                call.reject(error.localizedDescription)
            }
        }
    }

    @objc func endSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            GCKCastContext.sharedInstance().sessionManager.endSessionAndStopCasting(true)
            call.resolve()
        }
    }

    // MARK: - GCKSessionManagerListener (called on the main thread)

    public func sessionManager(_ sessionManager: GCKSessionManager, didStart session: GCKSession) {
        notifyListeners("castStateChanged", data: ["state": "connected"])
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, didStart session: GCKCastSession) {
        attachChannel(to: session)
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, didEnd session: GCKSession, withError error: Error?) {
        channel = nil
        notifyListeners("castStateChanged", data: ["state": "notConnected"])
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, didResumeCastSession session: GCKCastSession) {
        attachChannel(to: session)
        notifyListeners("castStateChanged", data: ["state": "connected"])
    }

    // MARK: - Helpers

    // One channel for our namespace per session, created on the main thread and kept for as long as the session lasts.
    private var channel: GCKGenericChannel?

    private func attachChannel(to session: GCKCastSession) {
        let ch = GCKGenericChannel(namespace: namespace)
        if session.add(ch) { channel = ch }
    }

    private func stateName(_ state: GCKCastState) -> String {
        switch state {
        case .noDevicesAvailable: return "noDevicesAvailable"
        case .notConnected:       return "notConnected"
        case .connecting:         return "connecting"
        case .connected:          return "connected"
        @unknown default:         return "unknown"
        }
    }
}
