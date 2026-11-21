package pro.stompstation.desktop

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  private var multicastLock: WifiManager.MulticastLock? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    // mDNS replies are multicast. Android filters multicast unless the app
    // holds a MulticastLock, so acquire one before Tauri starts the webview
    // and its Wi-Fi discovery pass.
    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    multicastLock = wifi?.createMulticastLock("stompstation-mdns")?.apply {
      setReferenceCounted(false)
      acquire()
    }
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onDestroy() {
    multicastLock?.let { lock ->
      if (lock.isHeld) lock.release()
    }
    multicastLock = null
    super.onDestroy()
  }
}
