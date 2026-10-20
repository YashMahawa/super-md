package dev.supermd.studio

internal const val PDF_EXPORT_CANCELLED = "PDF export cancelled"

internal fun isPdfExportCancellationMessage(message: String?): Boolean = message == PDF_EXPORT_CANCELLED

internal class PdfExportCancelledException : IllegalStateException(PDF_EXPORT_CANCELLED)

/** One bridge-local cancellation gate for a non-preemptible native PDF render. */
internal class PdfExportJob(val id: String, val documentId: String) {
    enum class Phase { RUNNING, CANCELLED, PUBLISHING, SUCCEEDED, FAILED }

    @Volatile
    var phase: Phase = Phase.RUNNING
        private set

    @Synchronized
    fun cancel(): Boolean {
        if (phase != Phase.RUNNING) return false
        phase = Phase.CANCELLED
        return true
    }

    /** This is the atomic boundary after which SAF publication cannot be canceled. */
    @Synchronized
    fun beginPublishing(): Boolean {
        if (phase != Phase.RUNNING) return false
        phase = Phase.PUBLISHING
        return true
    }

    @Synchronized
    fun succeed() {
        if (phase == Phase.PUBLISHING) phase = Phase.SUCCEEDED
    }

    @Synchronized
    fun fail() {
        if (phase == Phase.RUNNING || phase == Phase.PUBLISHING) phase = Phase.FAILED
    }
}
