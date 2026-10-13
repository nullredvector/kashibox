import SwiftUI

@main
struct KashiboxTVApp: App {
    @StateObject private var store = TVStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .preferredColorScheme(.dark)
                .onAppear {
                    UIApplication.shared.isIdleTimerDisabled = true
                    store.start()
                }
        }
    }
}
