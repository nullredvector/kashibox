import Capacitor

class ViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        print("⚡️ CastBridgeVC: registering KashiboxCast")
        bridge?.registerPluginType(KashiboxCastPlugin.self)
        print("⚡️ CastBridgeVC: done, bridge=\(String(describing: bridge))")
    }
}
