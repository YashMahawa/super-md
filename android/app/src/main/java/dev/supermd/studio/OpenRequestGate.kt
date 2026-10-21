package dev.supermd.studio

import java.util.concurrent.atomic.AtomicLong

/** Keeps delayed document loads from stealing focus from a newer user action. */
internal class OpenRequestGate {
    private val generation = AtomicLong()

    fun begin(): Long = generation.incrementAndGet()
    fun isCurrent(request: Long): Boolean = generation.get() == request
    fun invalidate() { generation.incrementAndGet() }
}

/** Retains pending files in latest-activation order until the reader bridge is ready. */
internal class OpenIntentDispatcher<T> {
    data class Request<T>(val target: T, val relative: String? = null)
    fun interface Handler<T> { fun open(target: T, relative: String?) }

    private var handler: Handler<T>? = null
    private val pending = mutableListOf<Request<T>>()

    fun request(target: T, relative: String? = null) {
        val current = handler
        if (current != null) {
            current.open(target, relative)
            return
        }
        val duplicate = pending.indexOfFirst { it.target == target }
        val request = Request(target, relative)
        if (duplicate >= 0) pending.removeAt(duplicate)
        pending += request
    }

    fun attach(next: Handler<T>?) {
        handler = next
        if (next != null) {
            val queued = pending.toList()
            pending.clear()
            queued.forEach { next.open(it.target, it.relative) }
        }
    }

    fun detach(expected: Handler<T>) {
        if (handler === expected) handler = null
    }
}
