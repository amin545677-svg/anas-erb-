package dz.anaserp.mobile

import android.content.Context
import android.util.Base64
import android.webkit.JavascriptInterface
import java.nio.charset.StandardCharsets
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties

/**
 * Encrypted backing store for the ANAS ERP WebView localStorage API.
 * Values are AES-256-GCM encrypted; the AES key is non-exportable in Android Keystore.
 */
internal class EncryptedWebStorage(context: Context) {
    private val prefs = context.getSharedPreferences("anas_secure_web_storage", Context.MODE_PRIVATE)
    private val keyAlias = "anas_erp_web_storage_aes_gcm_v1"
    @Volatile private var healthy = true

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build()
        )
        return generator.generateKey()
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val encrypted = cipher.doFinal(value.toByteArray(StandardCharsets.UTF_8))
        return Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(encrypted, Base64.NO_WRAP)
    }

    private fun decrypt(value: String): String {
        val parts = value.split(":", limit = 2)
        require(parts.size == 2) { "Encrypted value format is invalid" }
        val iv = Base64.decode(parts[0], Base64.NO_WRAP)
        val encrypted = Base64.decode(parts[1], Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
        return String(cipher.doFinal(encrypted), StandardCharsets.UTF_8)
    }

    /** Called before loading any ERP page; fails closed if an existing value cannot be decrypted. */
    @Synchronized
    fun validateExistingData() {
        healthy = false
        secretKey()
        prefs.all.values.forEach { raw ->
            if (raw is String) decrypt(raw)
        }
        healthy = true
    }

    @JavascriptInterface
    @Synchronized
    fun getItem(key: String): String? {
        if (!healthy) return null
        val raw = prefs.getString(key, null) ?: return null
        return try { decrypt(raw) } catch (_: Exception) { healthy = false; null }
    }

    @JavascriptInterface
    @Synchronized
    fun setItem(key: String, value: String): Boolean {
        if (!healthy || key.length > 512 || value.toByteArray(StandardCharsets.UTF_8).size > 2_000_000) return false
        return try { prefs.edit().putString(key, encrypt(value)).commit() } catch (_: Exception) {
            healthy = false
            false
        }
    }

    @JavascriptInterface
    @Synchronized
    fun removeItem(key: String): Boolean {
        if (!healthy) return false
        return try { prefs.edit().remove(key).commit() } catch (_: Exception) { false }
    }

    @JavascriptInterface
    @Synchronized
    fun clear(): Boolean {
        if (!healthy) return false
        return try { prefs.edit().clear().commit() } catch (_: Exception) { false }
    }

    @JavascriptInterface
    @Synchronized
    fun key(index: Int): String? {
        if (index < 0) return null
        return prefs.all.keys.sorted().getOrNull(index)
    }

    @JavascriptInterface
    @Synchronized
    fun length(): Int = prefs.all.size

    @JavascriptInterface
    fun isHealthy(): Boolean = healthy
}
