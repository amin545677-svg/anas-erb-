package dz.anaserp.mobile

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.fragment.app.FragmentActivity
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : FragmentActivity() {
    companion object {
        private const val APP_HOST = "amin545677-svg.github.io"
        private const val APP_URL = "https://amin545677-svg.github.io/anas-erb-/"
        private const val ALLOWED_ORIGIN_RULE = "https://amin545677-svg.github.io"
        private const val AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL
    }

    private lateinit var root: FrameLayout
    private lateinit var lockPanel: LinearLayout
    private lateinit var message: TextView
    private lateinit var primaryButton: Button
    private lateinit var secureStorage: EncryptedWebStorage
    private var webView: WebView? = null
    private var unlocked = false
    private var authenticationInProgress = false
    private var lastBackgroundAt = 0L
    private var storageInstallationFailed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        window.statusBarColor = Color.rgb(16, 38, 77)
        window.navigationBarColor = Color.rgb(16, 38, 77)
        secureStorage = EncryptedWebStorage(applicationContext)
        buildLockScreen()
    }

    override fun onStart() {
        super.onStart()
        if (webView == null) {
            showLock("يجب التحقق من هويتك قبل فتح بيانات ANAS ERP.")
            authenticate()
        } else if (!unlocked && !authenticationInProgress) {
            showLock("التطبيق مقفل لحماية بياناتك.")
            authenticate()
        } else if (unlocked && lastBackgroundAt > 0L &&
            BiometricSessionPolicy.shouldRelock(lastBackgroundAt, SystemClock.elapsedRealtime())) {
            lockAndAuthenticate()
        }
    }

    override fun onStop() {
        if (unlocked && webView != null) {
            lastBackgroundAt = SystemClock.elapsedRealtime()
            unlocked = false
            webView?.visibility = View.GONE
            showLock("تم قفل التطبيق عند مغادرته. تحقق بالبصمة للمتابعة.")
        }
        super.onStop()
    }

    override fun onPause() {
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        super.onPause()
    }

    private fun buildLockScreen() {
        root = FrameLayout(this).apply { setBackgroundColor(Color.rgb(243, 246, 251)) }
        lockPanel = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(dp(28), dp(28), dp(28), dp(28))
        }
        val title = TextView(this).apply {
            text = "ANAS ERP"
            textSize = 28f
            setTextColor(Color.rgb(16, 38, 77))
            gravity = Gravity.CENTER
            typeface = android.graphics.Typeface.DEFAULT_BOLD
        }
        val subtitle = TextView(this).apply {
            text = "🔐 حماية بصمة الإصبع"
            textSize = 18f
            setTextColor(Color.rgb(15, 118, 110))
            gravity = Gravity.CENTER
            setPadding(0, dp(12), 0, dp(12))
        }
        message = TextView(this).apply {
            textSize = 15f
            setTextColor(Color.rgb(51, 65, 85))
            gravity = Gravity.CENTER
            setPadding(0, dp(8), 0, dp(16))
        }
        val progress = ProgressBar(this)
        primaryButton = Button(this).apply {
            text = "إعادة التحقق بالبصمة"
            setOnClickListener { authenticate() }
        }
        val settingsButton = Button(this).apply {
            text = "إعدادات أمان الهاتف"
            setOnClickListener { startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS)) }
        }
        lockPanel.addView(title, matchWrap())
        lockPanel.addView(subtitle, matchWrap())
        lockPanel.addView(message, matchWrap())
        lockPanel.addView(progress, LinearLayout.LayoutParams(dp(42), dp(42)).apply {
            gravity = Gravity.CENTER
            bottomMargin = dp(12)
        })
        lockPanel.addView(primaryButton, matchWrap())
        lockPanel.addView(settingsButton, matchWrap())
        root.addView(lockPanel, FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ))
        setContentView(root)
        primaryButton.visibility = View.GONE
    }

    private fun showLock(text: String, allowRetry: Boolean = true) {
        message.text = text
        primaryButton.visibility = if (allowRetry) View.VISIBLE else View.GONE
        lockPanel.visibility = View.VISIBLE
    }

    private fun lockAndAuthenticate() {
        unlocked = false
        webView?.visibility = View.GONE
        showLock("التطبيق مقفل لحماية بياناتك. استخدم البصمة للمتابعة.")
        authenticate()
    }

    private fun authenticate() {
        if (authenticationInProgress) return
        val manager = BiometricManager.from(this)
        val capability = manager.canAuthenticate(AUTHENTICATORS)
        if (capability != BiometricManager.BIOMETRIC_SUCCESS) {
            val reason = when (capability) {
                BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "هذا الجهاز لا يحتوي على مستشعر بصمة/قياسات حيوية قوية مدعومة."
                BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "مستشعر البصمة غير متاح الآن. أعد المحاولة لاحقًا."
                BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "فعّل بصمة الإصبع أو قفل الشاشة من إعدادات الهاتف أولًا."
                BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED -> "يلزم تحديث أمان الهاتف قبل استخدام التحقق الحيوي."
                else -> "تعذر التحقق الحيوي. افحص إعدادات أمان الهاتف."
            }
            showLock(reason)
            return
        }

        authenticationInProgress = true
        primaryButton.visibility = View.GONE
        showLock("ضع إصبعك على المستشعر أو استخدم وسيلة قفل الجهاز.", false)
        val prompt = BiometricPrompt(this, ContextCompat.getMainExecutor(this),
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                    authenticationInProgress = false
                    try {
                        secureStorage.validateExistingData()
                        unlockAndShowApp()
                    } catch (e: Exception) {
                        storageInstallationFailed = true
                        unlocked = false
                        showLock("توقفت الحماية: تعذر فك تشفير بيانات محفوظة. لم تُمسح البيانات. لا تحذف بيانات التطبيق؛ تواصل مع الدعم لاستعادتها.", true)
                    }
                }

                override fun onAuthenticationFailed() {
                    showLock("لم يتم التعرف على البصمة. حاول مرة أخرى.")
                }

                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                    authenticationInProgress = false
                    if (!unlocked) showLock("لم يُفتح التطبيق: $errString", true)
                }
            })
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(getString(R.string.biometric_title))
            .setSubtitle(getString(R.string.biometric_subtitle))
            .setAllowedAuthenticators(AUTHENTICATORS)
            .build()
        prompt.authenticate(info)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun unlockAndShowApp() {
        if (storageInstallationFailed) return
        if (webView == null) {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                showLock("إصدار Android System WebView قديم ولا يدعم تركيب التخزين المشفر بأمان. حدّث Android System WebView وChrome ثم أعد المحاولة.")
                return
            }
            val view = WebView(this)
            view.setBackgroundColor(Color.WHITE)
            view.settings.javaScriptEnabled = true
            view.settings.domStorageEnabled = true
            view.settings.allowFileAccess = false
            view.settings.allowContentAccess = false
            view.settings.javaScriptCanOpenWindowsAutomatically = false
            view.settings.setSupportMultipleWindows(false)
            view.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
            view.settings.safeBrowsingEnabled = true
            view.isSaveEnabled = false
            view.addJavascriptInterface(secureStorage, "AnasSecureStorage")

            val storageShim = """
                (() => {
                  const bridge = window.AnasSecureStorage;
                  if (!bridge) { window.__anasSecureStorageReady = false; return; }
                  const storage = {
                    getItem: key => bridge.getItem(String(key)),
                    setItem: (key, value) => {
                      if (!bridge.setItem(String(key), String(value))) {
                        throw new DOMException('تعذر حفظ البيانات المشفرة', 'QuotaExceededError');
                      }
                    },
                    removeItem: key => { if (!bridge.removeItem(String(key))) throw new Error('تعذر حذف القيمة المشفرة'); },
                    clear: () => { if (!bridge.clear()) throw new Error('تعذر مسح التخزين المشفر'); },
                    key: index => bridge.key(Number(index)),
                    get length() { return bridge.length(); }
                  };
                  try {
                    Object.defineProperty(window, 'localStorage', {
                      configurable: true, enumerable: true, get: () => storage
                    });
                    window.__anasSecureStorageReady = window.localStorage === storage && bridge.isHealthy();
                  } catch (_) { window.__anasSecureStorageReady = false; }
                })();
            """.trimIndent()
            WebViewCompat.addDocumentStartJavaScript(view, storageShim, setOf(ALLOWED_ORIGIN_RULE))
            view.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val uri = request.url
                    if (uri.scheme == "https" && uri.host == APP_HOST) return false
                    if (request.isForMainFrame && (uri.scheme == "https" || uri.scheme == "http")) {
                        startActivity(Intent(Intent.ACTION_VIEW, uri))
                    }
                    return true
                }

                override fun onPageFinished(view: WebView, url: String) {
                    super.onPageFinished(view, url)
                    if (Uri.parse(url).host != APP_HOST) {
                        showLock("تم إيقاف صفحة خارج النطاق الموثوق.")
                        return
                    }
                    view.evaluateJavascript("Boolean(window.__anasSecureStorageReady === true && window.AnasSecureStorage && window.AnasSecureStorage.isHealthy())") { result ->
                        if (result == "true") {
                            unlocked = true
                            lastBackgroundAt = 0L
                            lockPanel.visibility = View.GONE
                            view.visibility = View.VISIBLE
                            if (view.parent == null) root.addView(view, FrameLayout.LayoutParams(
                                FrameLayout.LayoutParams.MATCH_PARENT,
                                FrameLayout.LayoutParams.MATCH_PARENT
                            ))
                        } else {
                            unlocked = false
                            view.visibility = View.GONE
                            showLock("لم يتم تفعيل التخزين المشفر؛ أُوقف فتح النظام لحماية البيانات. حدّث Android System WebView ثم أعد المحاولة.")
                        }
                    }
                }
            }
            webView = view
            root.addView(view, FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            ))
            view.visibility = View.GONE
            view.loadUrl(APP_URL)
        } else {
            unlocked = true
            lastBackgroundAt = 0L
            lockPanel.visibility = View.GONE
            webView?.visibility = View.VISIBLE
        }
    }

    override fun onBackPressed() {
        val view = webView
        if (unlocked && view != null && view.canGoBack()) {
            view.goBack()
        } else {
            super.onBackPressed()
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
    private fun matchWrap() = LinearLayout.LayoutParams(
        LinearLayout.LayoutParams.MATCH_PARENT,
        LinearLayout.LayoutParams.WRAP_CONTENT
    )
}
