package dz.anaserp.mobile

internal object BiometricSessionPolicy {
    const val LOCK_TIMEOUT_MS: Long = 30_000L

    fun shouldRelock(lastBackgroundAt: Long, now: Long, timeoutMs: Long = LOCK_TIMEOUT_MS): Boolean {
        if (lastBackgroundAt <= 0L || now < lastBackgroundAt || timeoutMs < 0L) return true
        return now - lastBackgroundAt >= timeoutMs
    }
}
