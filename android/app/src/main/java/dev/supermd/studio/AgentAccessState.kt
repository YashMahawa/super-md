package dev.supermd.studio

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class AgentAccessConfig(
    val serverOrigin: String,
    val groupId: String,
    val deviceId: String,
    val deviceKey: String,
    val pairingKey: String,
    val connectorKey: String,
    val displayName: String,
    val platform: String,
) {
    val mcpUrl: String get() = "${serverOrigin.trimEnd('/')}/mcp/$groupId/$connectorKey"
}

/** Encrypted per-install device and workspace credentials for Live Agent Access. */
class AgentAccessState(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val secretBox = AgentSecretBox()
    val enabled: Boolean get() = prefs.getBoolean(KEY_ENABLED, false)

    /** Creates a new workspace pairing file and pairs this Android installation. */
    @Synchronized fun createPairingFile(serverOrigin: String, displayName: String = "Super MD Android"): String {
        val origin = validateOrigin(serverOrigin)
        val pairingKey = randomToken()
        val connectorKey = randomToken()
        val config = AgentAccessConfig(
            origin, groupIdFor(pairingKey, connectorKey), UUID.randomUUID().toString(), randomToken(),
            pairingKey, connectorKey, displayName.take(80), "android",
        )
        removeWorkspaceConfigs()
        save(config)
        return pairingJson(config)
    }

    /** Joins this device to a trusted pairing file exported by another Super MD device. */
    @Synchronized fun joinPairingFile(raw: String, displayName: String = "Super MD Android"): AgentAccessConfig {
        require(raw.toByteArray(Charsets.UTF_8).size <= 8 * 1024) { "Pairing file is too large" }
        val json = JSONObject(raw)
        require(json.optString("format") == "supermd-agent-pairing" && json.optInt("version") == 1) { "Unsupported pairing file" }
        val origin = validateOrigin(json.getString("serverOrigin"))
        val pairingKey = json.getString("pairingKey").also { require(TOKEN.matches(it)) }
        val connectorKey = json.getString("connectorKey").also { require(TOKEN.matches(it)) }
        val groupId = json.getString("groupId")
        require(groupId == groupIdFor(pairingKey, connectorKey)) { "Pairing file authentication failed" }
        val config = AgentAccessConfig(origin, groupId, UUID.randomUUID().toString(), randomToken(), pairingKey, connectorKey, displayName.take(80), "android")
        removeWorkspaceConfigs()
        save(config)
        return config
    }

    @Synchronized fun currentConfig(): AgentAccessConfig? {
        val stored = prefs.getString(KEY_CREDENTIALS, null) ?: return null
        return runCatching { decode(secretBox.open(stored)) }.getOrNull()
    }

    /** Every encrypted activity-window identity in this workspace, for explicit server-side revocation. */
    @Synchronized fun allConfigs(): List<AgentAccessConfig> = buildList {
        currentConfig()?.let(::add)
        prefs.all.filterKeys { it.startsWith(KEY_WORKSPACE_PREFIX) }.values.forEach { value ->
            (value as? String)?.let { encoded -> runCatching { decode(secretBox.open(encoded)) }.getOrNull()?.let(::add) }
        }
    }.distinctBy { it.groupId to it.deviceId }

    /** Each activity workspace gets a distinct relay identity so open windows never evict each other. */
    @Synchronized fun configForWorkspace(workspaceKey: String): AgentAccessConfig? {
        val base = currentConfig() ?: return null
        require(workspaceKey == "main" || runCatching { UUID.fromString(workspaceKey) }.isSuccess)
        if (workspaceKey == "main") return base
        val key = KEY_WORKSPACE_PREFIX + MessageDigest.getInstance("SHA-256")
            .digest(workspaceKey.toByteArray(Charsets.UTF_8)).take(8).joinToString("") { "%02x".format(it) }
        prefs.getString(key, null)?.let { encoded -> return runCatching { decode(secretBox.open(encoded)) }.getOrNull() }
        val next = base.copy(
            deviceId = UUID.randomUUID().toString(), deviceKey = randomToken(),
            displayName = "${base.displayName.take(48)} · window ${workspaceKey.take(4)}",
        )
        check(prefs.edit().putString(key, secretBox.seal(configJson(next))).commit()) { "Could not save this workspace's device credentials" }
        return next
    }

    /** Recreate the trusted pairing JSON only after an explicit user request. */
    @Synchronized fun currentPairingFile(): String? = currentConfig()?.let(::pairingJson)

    fun setEnabled(value: Boolean) {
        check(prefs.edit().putBoolean(KEY_ENABLED, value).commit()) { "Could not save Live Agent access setting" }
    }

    @Synchronized fun revoke() {
        val edit = prefs.edit().remove(KEY_CREDENTIALS).putBoolean(KEY_ENABLED, false)
        prefs.all.keys.filter { it.startsWith(KEY_WORKSPACE_PREFIX) }.forEach(edit::remove)
        edit.commit()
        secretBox.clearKey()
    }

    private fun save(config: AgentAccessConfig) {
        check(prefs.edit().putString(KEY_CREDENTIALS, secretBox.seal(configJson(config))).commit()) {
            "Could not save Live Agent credentials"
        }
    }

    private fun configJson(config: AgentAccessConfig): String = JSONObject().put("serverOrigin", config.serverOrigin).put("groupId", config.groupId)
            .put("deviceId", config.deviceId).put("deviceKey", config.deviceKey)
            .put("pairingKey", config.pairingKey).put("connectorKey", config.connectorKey)
            .put("displayName", config.displayName).put("platform", config.platform).toString()

    private fun pairingJson(config: AgentAccessConfig): String = JSONObject()
        .put("format", "supermd-agent-pairing").put("version", 1)
        .put("serverOrigin", config.serverOrigin).put("groupId", config.groupId)
        .put("pairingKey", config.pairingKey).put("connectorKey", config.connectorKey).toString(2)

    private fun removeWorkspaceConfigs() {
        val edit = prefs.edit().putBoolean(KEY_ENABLED, false)
        prefs.all.keys.filter { it.startsWith(KEY_WORKSPACE_PREFIX) }.forEach(edit::remove)
        edit.apply()
    }

    private fun decode(raw: String): AgentAccessConfig {
        val json = JSONObject(raw)
        val pairingKey = json.getString("pairingKey").also { require(TOKEN.matches(it)) }
        val connectorKey = json.getString("connectorKey").also { require(TOKEN.matches(it)) }
        val origin = validateOrigin(json.getString("serverOrigin"))
        val groupId = json.getString("groupId")
        require(groupId == groupIdFor(pairingKey, connectorKey))
        return AgentAccessConfig(
            origin, groupId, UUID.fromString(json.getString("deviceId")).toString(),
            json.getString("deviceKey").also { require(TOKEN.matches(it)) }, pairingKey, connectorKey,
            json.optString("displayName", "Super MD Android").take(80), "android",
        )
    }

    companion object {
        private const val PREFERENCES = "live_agent_access"
        private const val KEY_ENABLED = "enabled"
        private const val KEY_CREDENTIALS = "encrypted_credentials"
        private const val KEY_WORKSPACE_PREFIX = "encrypted_workspace_device_"
        private val TOKEN = Regex("^[A-Za-z0-9_-]{40,128}$")

        fun validateOrigin(value: String): String {
            val uri = android.net.Uri.parse(value.trim().trimEnd('/'))
            require(uri.scheme == "https" && !uri.host.isNullOrBlank()) {
                "Use the HTTPS origin of your Super MD relay, such as https://relay.example.com"
            }
            require(uri.userInfo == null && uri.query == null && uri.fragment == null && uri.path.isNullOrEmpty()) {
                "Enter only the relay origin, without a path, credentials, query, or fragment"
            }
            return "https://${uri.host!!.lowercase()}${if (uri.port != -1 && uri.port != 443) ":${uri.port}" else ""}"
        }

        fun groupIdFor(pairingKey: String, connectorKey: String): String {
            val connectorHash = sha256(connectorKey)
            return MessageDigest.getInstance("SHA-256")
                .digest("supermd-group-v1\u0000$pairingKey\u0000$connectorHash".toByteArray(Charsets.UTF_8))
                .take(16).joinToString("") { "%02x".format(it) }
        }

        private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

        private fun randomToken(): String {
            val bytes = ByteArray(32).also(SecureRandom()::nextBytes)
            return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        }
    }
}

private class AgentSecretBox {
    fun seal(plaintext: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        val envelope = ByteArray(cipher.iv.size + encrypted.size)
        cipher.iv.copyInto(envelope)
        encrypted.copyInto(envelope, cipher.iv.size)
        return Base64.encodeToString(envelope, Base64.NO_WRAP or Base64.NO_PADDING)
    }

    fun open(encoded: String): String {
        val envelope = Base64.decode(encoded, Base64.NO_WRAP or Base64.NO_PADDING)
        require(envelope.size > IV_BYTES + TAG_BYTES) { "Encrypted credentials are invalid" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BYTES * 8, envelope.copyOfRange(0, IV_BYTES)))
        return cipher.doFinal(envelope.copyOfRange(IV_BYTES, envelope.size)).toString(Charsets.UTF_8)
    }

    fun clearKey() {
        runCatching {
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            store.deleteEntry(KEY_ALIAS)
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build())
            generateKey()
        }
    }

    private companion object {
        const val KEY_ALIAS = "supermd.live-agent.credentials.v1"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BYTES = 16
    }
}
