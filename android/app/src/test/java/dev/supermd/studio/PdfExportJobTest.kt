package dev.supermd.studio

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean

class PdfExportJobTest {
    @Test fun cancellationNoticeRequiresExactMessage() {
        assertTrue(isPdfExportCancellationMessage("PDF export cancelled"))
        assertFalse(isPdfExportCancellationMessage("Export failed: PDF export cancelled"))
        assertFalse(isPdfExportCancellationMessage("PDF export cancelled by provider"))
    }

    @Test fun cancelBeforePublishSuppressesPublication() {
        val job = PdfExportJob("job", "note")

        assertTrue(job.cancel())
        assertFalse(job.beginPublishing())
        assertFalse(job.cancel())
        assertEquals(PdfExportJob.Phase.CANCELLED, job.phase)
    }

    @Test fun publishingWinsAndCannotBeReportedAsCanceled() {
        val job = PdfExportJob("job", "note")

        assertTrue(job.beginPublishing())
        assertFalse(job.cancel())
        job.succeed()

        assertEquals(PdfExportJob.Phase.SUCCEEDED, job.phase)
    }

    @Test fun simultaneousCancelAndPublishHaveExactlyOneWinner() {
        repeat(100) {
            val job = PdfExportJob("job-$it", "note")
            val start = CountDownLatch(1)
            val cancelWon = AtomicBoolean(false)
            val publishWon = AtomicBoolean(false)
            val cancel = Thread { start.await(); cancelWon.set(job.cancel()) }
            val publish = Thread { start.await(); publishWon.set(job.beginPublishing()) }
            cancel.start()
            publish.start()
            start.countDown()
            cancel.join()
            publish.join()

            assertTrue(cancelWon.get() xor publishWon.get())
            assertEquals(
                if (cancelWon.get()) PdfExportJob.Phase.CANCELLED else PdfExportJob.Phase.PUBLISHING,
                job.phase,
            )
        }
    }

    @Test fun failureBeforeOrDuringPublishingIsTerminal() {
        val renderingFailure = PdfExportJob("render", "note")
        renderingFailure.fail()
        assertFalse(renderingFailure.cancel())
        assertEquals(PdfExportJob.Phase.FAILED, renderingFailure.phase)

        val copyFailure = PdfExportJob("copy", "note")
        assertTrue(copyFailure.beginPublishing())
        copyFailure.fail()
        assertFalse(copyFailure.cancel())
        assertEquals(PdfExportJob.Phase.FAILED, copyFailure.phase)
    }

    @Test fun sameJobIdInDifferentBridgeScopesHasIndependentState() {
        val firstBridge = PdfExportJob("same-id", "note-a")
        val secondBridge = PdfExportJob("same-id", "note-b")

        assertTrue(firstBridge.cancel())
        assertFalse(firstBridge.beginPublishing())
        assertTrue(secondBridge.beginPublishing())
        assertFalse(secondBridge.cancel())
        assertEquals(PdfExportJob.Phase.CANCELLED, firstBridge.phase)
        assertEquals(PdfExportJob.Phase.PUBLISHING, secondBridge.phase)
    }
}
