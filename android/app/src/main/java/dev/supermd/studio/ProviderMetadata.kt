package dev.supermd.studio

import java.io.FileNotFoundException

internal sealed interface ProviderMetadata {
    data class Found(val name:String?):ProviderMetadata
    data object Missing:ProviderMetadata
    data object Unavailable:ProviderMetadata
}

internal fun queryProviderMetadata(query:()->ProviderMetadata?):ProviderMetadata = try {
    query() ?: ProviderMetadata.Unavailable
} catch (_:FileNotFoundException) {
    ProviderMetadata.Missing
} catch (_:Exception) {
    ProviderMetadata.Unavailable
}
