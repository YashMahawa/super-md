package dev.supermd.studio

import org.junit.Assert.assertEquals
import org.junit.Test

class ReaderTimerOwnersTest {
    private fun owners() = ReaderTimerOwners()

    @Test fun stoppingOneReaderDoesNotPauseAnotherStartedReader() {
        val timers = owners()
        val first = Any()
        val second = Any()

        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.acquire(first, started = true))
        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.acquire(second, started = true))
        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.setStarted(first, started = false))
        assertEquals(1, timers.startedOwnerCount())
    }

    @Test fun bothActivityLifecycleOrderingsPauseOnlyAfterLastOwnerStops() {
        for (stopOrder in listOf(listOf(0, 1), listOf(1, 0))) {
            val timers = owners()
            val readers = listOf(Any(), Any())
            assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.acquire(readers[0], started = true))
            assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.acquire(readers[1], started = true))

            assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.setStarted(readers[stopOrder[0]], false))
            assertEquals(ReaderTimerOwners.GlobalAction.PAUSE, timers.setStarted(readers[stopOrder[1]], false))
            assertEquals(0, timers.startedOwnerCount())
        }
    }

    @Test fun backgroundStopsTimersAndForegroundResumesThem() {
        val timers = owners()
        val reader = Any()

        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.acquire(reader, started = true))
        assertEquals(ReaderTimerOwners.GlobalAction.PAUSE, timers.setStarted(reader, started = false))
        assertEquals(ReaderTimerOwners.GlobalAction.RESUME, timers.setStarted(reader, started = true))
    }

    @Test fun readerCreatedWhileStoppedPausesImmediatelyAndCanResumeLater() {
        val timers = owners()
        val stoppedActivityView = Any()

        assertEquals(ReaderTimerOwners.GlobalAction.PAUSE, timers.acquire(stoppedActivityView, started = false))
        assertEquals(1, timers.ownerCount())
        assertEquals(0, timers.startedOwnerCount())
        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.setStarted(stoppedActivityView, started = false))
        assertEquals(ReaderTimerOwners.GlobalAction.RESUME, timers.setStarted(stoppedActivityView, started = true))
        assertEquals(ReaderTimerOwners.GlobalAction.PAUSE, timers.setStarted(stoppedActivityView, started = false))
        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.release(stoppedActivityView))
        assertEquals(0, timers.ownerCount())
        // The paused process state survives disposal until a replacement view
        // acquires ownership with a started lifecycle.
        assertEquals(ReaderTimerOwners.GlobalAction.RESUME, timers.acquire(Any(), started = true))
    }

    @Test fun nullWebViewDoesNotCreateAnOwner() {
        // The Compose integration skips acquire entirely when it has no WebView;
        // this documents the registry invariant that such a gap is not an owner.
        val timers = owners()
        assertEquals(0, timers.ownerCount())
        assertEquals(0, timers.startedOwnerCount())
    }

    @Test fun rotationAndViewDisposalDoNotLeaveStaleOwners() {
        val timers = owners()
        val oldView = Any()
        val newView = Any()

        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.acquire(oldView, started = true))
        assertEquals(ReaderTimerOwners.GlobalAction.PAUSE, timers.setStarted(oldView, started = false))
        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.release(oldView))
        assertEquals(ReaderTimerOwners.GlobalAction.RESUME, timers.acquire(newView, started = true))
        assertEquals(ReaderTimerOwners.GlobalAction.PAUSE, timers.release(newView))
        assertEquals(0, timers.startedOwnerCount())
    }

    @Test fun disposingLastStartedReaderPausesAnyRemainingStoppedReaders() {
        val timers = owners()
        val visible = Any()
        val stopped = Any()

        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.acquire(visible, started = true))
        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.acquire(stopped, started = false))
        assertEquals(ReaderTimerOwners.GlobalAction.PAUSE, timers.release(visible))
        assertEquals(0, timers.startedOwnerCount())
    }

    @Test fun duplicateLifecycleEventsAndReleaseAreIdempotent() {
        val timers = owners()
        val reader = Any()

        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.acquire(reader, started = true))
        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.setStarted(reader, started = true))
        assertEquals(ReaderTimerOwners.GlobalAction.PAUSE, timers.setStarted(reader, started = false))
        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.setStarted(reader, started = false))
        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.release(reader))
        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.release(reader))
    }

    @Test fun releasingLastStartedReaderPausesUntilReplacementStarts() {
        val timers = owners()
        val reader = Any()
        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.acquire(reader, started = true))
        assertEquals(ReaderTimerOwners.GlobalAction.PAUSE, timers.release(reader))
        assertEquals(0, timers.ownerCount())
        val replacement = Any()
        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.acquire(replacement, started = false))
        assertEquals(ReaderTimerOwners.GlobalAction.RESUME, timers.setStarted(replacement, started = true))
    }

    @Test fun readerRecreatedStoppedAlongsideVisibleWindowKeepsGlobalTimersRunning() {
        val timers = owners()
        val visible = Any()
        val recreatedStopped = Any()

        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.acquire(visible, started = true))
        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.acquire(recreatedStopped, started = false))
        assertEquals(1, timers.startedOwnerCount())
        assertEquals(ReaderTimerOwners.GlobalAction.PAUSE, timers.setStarted(visible, started = false))
        assertEquals(ReaderTimerOwners.GlobalAction.NONE, timers.setStarted(recreatedStopped, started = false))
    }
}
