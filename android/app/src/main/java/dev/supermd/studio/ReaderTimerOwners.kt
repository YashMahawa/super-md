package dev.supermd.studio

/** Tracks started reader owners because WebView timer controls affect every WebView in-process. */
internal class ReaderTimerOwners {
    enum class GlobalAction { NONE, PAUSE, RESUME }

    private val owners = mutableMapOf<Any, Boolean>()
    private var timersPaused = false

    @Synchronized
    fun acquire(owner: Any, started: Boolean): GlobalAction {
        owners[owner] = started
        return reconcile()
    }

    @Synchronized
    fun setStarted(owner: Any, started: Boolean): GlobalAction {
        if (owner !in owners) return acquire(owner, started)
        owners[owner] = started
        return reconcile()
    }

    @Synchronized
    fun release(owner: Any): GlobalAction {
        owners.remove(owner)
        // With no owner there is no visible reader to keep timers running.
        // A newly created started reader will explicitly resume them.
        return reconcile()
    }

    @Synchronized
    internal fun startedOwnerCount(): Int = owners.values.count { it }

    @Synchronized
    internal fun ownerCount(): Int = owners.size

    private fun reconcile(): GlobalAction {
        val shouldPause = owners.values.none { it }
        if (shouldPause == timersPaused) return GlobalAction.NONE
        timersPaused = shouldPause
        return if (shouldPause) GlobalAction.PAUSE else GlobalAction.RESUME
    }

    companion object {
        /** Shared by activities in this app process. */
        val process = ReaderTimerOwners()
    }
}
