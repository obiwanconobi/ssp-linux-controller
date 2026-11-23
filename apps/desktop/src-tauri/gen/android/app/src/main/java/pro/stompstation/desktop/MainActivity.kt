package pro.stompstation.desktop

import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import java.io.File
import java.io.IOException

class MainActivity : TauriActivity() {
  companion object {
    private const val LOCAL_NETWORK_PERMISSION =
      "android.permission.ACCESS_LOCAL_NETWORK"
    private const val MAX_PICKED_FILE_BYTES = 16L * 1024L * 1024L
  }

  private var multicastLock: WifiManager.MulticastLock? = null
  private var contentWebView: WebView? = null
  private var pendingLocalNetworkGrant: Boolean? = null
  private var permissionDispatchInFlight = false

  // Wry's default callback navigates WebView history. This app uses
  // replaceState for view changes and renders overlays as React dialogs, so
  // give the web UI first refusal and only finish when no overlay is open.
  override val handleBackNavigation: Boolean = false

  private val localNetworkPermissionLauncher =
    registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      notifyLocalNetworkPermission(granted)
    }

  override fun onWebViewCreate(webView: WebView) {
    contentWebView = webView
    webView.addJavascriptInterface(AndroidFileBridge(), "StompAndroid")
    dispatchPendingLocalNetworkPermission()
  }

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

    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          val webView = contentWebView
          if (webView == null) {
            finish()
            return
          }
          webView.evaluateJavascript(
            "(window.__stompHandleBack && window.__stompHandleBack()) === true"
          ) { result ->
            if (result != "true") finish()
          }
        }
      },
    )

    // Android 17 (SDK 37) requires this runtime permission before opening LAN
    // TCP or mDNS sockets. Ask before discovery; the web handler retries the
    // connection scan when the dialog is accepted.
    if (
      Build.VERSION.SDK_INT >= 37 &&
      checkSelfPermission(LOCAL_NETWORK_PERMISSION) != PackageManager.PERMISSION_GRANTED
    ) {
      localNetworkPermissionLauncher.launch(LOCAL_NETWORK_PERMISSION)
    }
  }

  override fun onResume() {
    super.onResume()
    // The WebView may be destroyed/recreated while the activity is backgrounded.
    // Re-dispatch permission state, then ask the React shell to refresh or
    // reconnect the device session.
    dispatchPendingLocalNetworkPermission()
    contentWebView?.evaluateJavascript(
      "(window.__stompOnResume && window.__stompOnResume()) === true",
      null,
    )
  }

  override fun onDestroy() {
    contentWebView?.removeJavascriptInterface("StompAndroid")
    contentWebView = null
    multicastLock?.let { lock ->
      if (lock.isHeld) lock.release()
    }
    multicastLock = null
    super.onDestroy()
  }

  private fun notifyLocalNetworkPermission(granted: Boolean) {
    pendingLocalNetworkGrant = granted
    dispatchPendingLocalNetworkPermission()
  }

  private fun dispatchPendingLocalNetworkPermission() {
    val granted = pendingLocalNetworkGrant ?: return
    val webView = contentWebView ?: return
    if (permissionDispatchInFlight) return
    permissionDispatchInFlight = true
    webView.post {
      // Re-check after the post: a previous dispatch may already have delivered
      // the same result while this one was queued.
      if (pendingLocalNetworkGrant != granted) {
        permissionDispatchInFlight = false
        return@post
      }
      webView.evaluateJavascript(
        "typeof window.__stompLocalNetworkPermission === 'function'"
      ) { result ->
        if (result == "true" && pendingLocalNetworkGrant == granted) {
          webView.evaluateJavascript(
            "window.__stompLocalNetworkPermission($granted)",
            null,
          )
          pendingLocalNetworkGrant = null
        }
        permissionDispatchInFlight = false
      }
    }
  }

  /**
   * Bridge for Android's document picker. Tauri's dialog plugin returns
   * content:// URIs, which the Rust uploader cannot read with std::fs. Copy the
   * selected content into app cache and hand the shell a real path.
   */
  inner class AndroidFileBridge {
    @JavascriptInterface
    fun resolveFileUri(uriString: String): String {
      return try {
        val uri = Uri.parse(uriString)
        when (uri.scheme) {
          "file" -> uri.path?.takeIf { File(it).isFile } ?: ""
          "content" -> {
            val name = queryDisplayName(uri) ?: uri.lastPathSegment ?: "capture"
            val destination = File(cachePathForName(name))
            contentResolver.openInputStream(uri)?.use { input ->
              destination.outputStream().use { output ->
                boundedCopy(input, output)
              }
            } ?: return ""
            destination.absolutePath
          }
          else -> ""
        }
      } catch (error: Exception) {
        ""
      }
    }

    @JavascriptInterface
    fun cachePathForName(name: String): String {
      val directory = File(cacheDir, "picked-files").apply { mkdirs() }
      return File(directory, sanitizeFileName(name)).absolutePath
    }

    @JavascriptInterface
    fun copyFileToUri(sourcePath: String, uriString: String): Boolean {
      return try {
        val source = File(sourcePath).canonicalFile
        val cacheRoot = cacheDir.canonicalFile
        if (!source.path.startsWith(cacheRoot.path + File.separator)) return false
        if (!source.isFile) return false
        val uri = Uri.parse(uriString)
        if (uri.scheme != "content") return false
        val output = contentResolver.openOutputStream(uri) ?: return false
        output.use { target ->
          source.inputStream().use { input ->
            boundedCopy(input, target)
          }
        }
        true
      } catch (error: Exception) {
        false
      }
    }

    private fun queryDisplayName(uri: Uri): String? {
      return try {
        contentResolver.query(
          uri,
          arrayOf(OpenableColumns.DISPLAY_NAME),
          null,
          null,
          null,
        )?.use { cursor ->
          if (cursor.moveToFirst()) cursor.getString(0) else null
        }
      } catch (error: Exception) {
        null
      }
    }
  }

  private fun sanitizeFileName(name: String): String {
    val cleaned = name
      .replace(Regex("[^A-Za-z0-9._ ()-]"), "_")
      .trim()
      .trim('.')
      .take(120)
    return cleaned.ifBlank { "capture" }
  }

  private fun boundedCopy(input: java.io.InputStream, output: java.io.OutputStream) {
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
      val count = input.read(buffer)
      if (count < 0) break
      total += count
      if (total > MAX_PICKED_FILE_BYTES) {
        throw IOException("selected file is larger than 16 MiB")
      }
      output.write(buffer, 0, count)
    }
  }
}
