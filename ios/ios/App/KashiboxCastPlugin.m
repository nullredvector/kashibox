#import <Capacitor/Capacitor.h>

CAP_PLUGIN(KashiboxCastPlugin, "KashiboxCast",
    CAP_PLUGIN_METHOD(getState,      CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(requestSession, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(sendMessage,   CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(endSession,    CAPPluginReturnPromise);
)
