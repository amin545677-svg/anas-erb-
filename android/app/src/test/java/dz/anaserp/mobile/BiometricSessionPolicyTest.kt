package dz.anaserp.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BiometricSessionPolicyTest {
    @Test fun locksOnColdStartOrMissingTimestamp() {
        assertTrue(BiometricSessionPolicy.shouldRelock(0L, 10_000L))
    }

    @Test fun doesNotRelockInsideShortBackgroundWindow() {
        assertFalse(BiometricSessionPolicy.shouldRelock(10_000L, 39_999L))
    }

    @Test fun relocksAtThirtySeconds() {
        assertTrue(BiometricSessionPolicy.shouldRelock(10_000L, 40_000L))
    }

    @Test fun relocksIfClockMovesBackwardsOrTimeoutIsInvalid() {
        assertTrue(BiometricSessionPolicy.shouldRelock(10_000L, 9_000L))
        assertTrue(BiometricSessionPolicy.shouldRelock(10_000L, 11_000L, -1L))
    }
}
