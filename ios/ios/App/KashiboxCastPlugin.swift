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

    @objc func getState(_ call: CAPPluginCall) {
        let state = GCKCastContext.sharedInstance().castState
        call.resolve(["state": stateName(state)])
    }

    @objc func requestSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            GCKCastContext.sharedInstance().presentCastDialog()
        }
        call.resolve()
    }

    @objc func sendMessage(_ call: CAPPluginCall) {
        guard let data = call.getObject("data") else {
            call.reject("data required")
            return
        }
        guard let channel = currentChannel() else {
            call.reject("no session")
            return
        }
        do {
            let json = try JSONSerialization.data(withJSONObject: data)
            let str  = String(data: json, encoding: .utf8) ?? "{}"
            channel.sendTextMessage(str, error: nil)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func endSession(_ call: CAPPluginCall) {
        GCKCastContext.sharedInstance().sessionManager.endSessionAndStopCasting(true)
        call.resolve()
    }

    // MARK: - GCKSessionManagerListener

    public func sessionManager(_ sessionManager: GCKSessionManager, didStart session: GCKSession) {
        notifyListeners("castStateChanged", data: ["state": "connected"])
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, didEnd session: GCKSession, withError error: Error?) {
        notifyListeners("castStateChanged", data: ["state": "notConnected"])
    }

    public func sessionManager(_ sessionManager: GCKSessionManager, didResumeCastSession session: GCKCastSession) {
        notifyListeners("castStateChanged", data: ["state": "connected"])
    }

    // MARK: - Helpers

    private func currentChannel() -> GCKGenericChannel? {
        guard let session = GCKCastContext.sharedInstance().sessionManager.currentCastSession else { return nil }
        // Use a generic channel on our namespace
        let ch = GCKGenericChannel(namespace: namespace)
        session.add(ch)
        return ch
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
