"""TLS client context with both platform trust and bundled public roots."""
import ssl

import certifi


def client_context() -> ssl.SSLContext:
    """Build a server-auth context, augmenting platform roots with Mozilla's CA set.

    `create_default_context` preserves system certificates and honors OpenSSL's
    configured CA file/directory. Adding certifi's bundle is additive, so
    packaged Python still has public roots when its compiled default paths are
    absent without overriding an administrator's configured trust roots.
    """
    context = ssl.create_default_context(purpose=ssl.Purpose.SERVER_AUTH)
    context.load_verify_locations(cafile=certifi.where())
    # State the security invariants explicitly: adding roots must never turn
    # hostname checks or peer-certificate verification off.
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return context
