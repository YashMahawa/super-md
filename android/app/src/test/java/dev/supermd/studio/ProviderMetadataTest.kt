package dev.supermd.studio

import java.io.FileNotFoundException
import org.junit.Assert.*
import org.junit.Test

class ProviderMetadataTest {
    @Test fun nullableNamesAndDeniedOrUnavailableProvidersAreNotDeletedFiles() {
        assertEquals(ProviderMetadata.Found(null),queryProviderMetadata {ProviderMetadata.Found(null)})
        assertEquals(ProviderMetadata.Unavailable,queryProviderMetadata {null})
        assertEquals(ProviderMetadata.Unavailable,queryProviderMetadata {throw SecurityException("Permission revoked")})
        assertEquals(ProviderMetadata.Unavailable,queryProviderMetadata {throw IllegalStateException("Provider offline")})
    }
    @Test fun explicitMissingDocumentAndEmptyResultsAreDeletionEvidence() {
        assertEquals(ProviderMetadata.Missing,queryProviderMetadata {throw FileNotFoundException("No such document")})
        assertEquals(ProviderMetadata.Missing,queryProviderMetadata {ProviderMetadata.Missing})
        assertEquals(ProviderMetadata.Found("Renamed.md"),queryProviderMetadata {ProviderMetadata.Found("Renamed.md")})
    }
}
