package dev.ashamray.blueprint

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented test, which will execute on an Android device.
 *
 * @see <a href="http://d.android.com/tools/testing">Testing documentation</a>
 */
@RunWith(AndroidJUnit4::class)
class ExampleInstrumentedTest {

    @Test
    fun useAppContext() {
        // Context of the app under test.
        val appContext = InstrumentationRegistry.getInstrumentation().targetContext

        // dev.ashamray.blueprint, not the template's com.getcapacitor.app:
        // app/build.gradle sets that applicationId, so the generated
        // assertion failed every connected run. CI never runs connected
        // tests, which is why `assembleDebug` stayed green over a test that
        // could not pass.
        assertEquals("dev.ashamray.blueprint", appContext.packageName)
    }
}
