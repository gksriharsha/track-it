package com.kgundu1.trackit

import android.app.Activity
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/** The payload sent by the Rust side. Bare RFC 4648 base64 with no data-URL
 * prefix, exactly the convention the app's photo commands already use. */
@InvokeArg
class BackupKeyArgs {
    var dataBase64: String = ""
}

/** The alias the wrapping key is kept under. One key for the life of the
 * install, because it wraps a value the app needs back at every launch. */
internal const val KEY_ALIAS = "trackit.backup.dek"

/** AES-256-GCM with no padding. The transformation string has to match the
 * block mode and padding the key was generated with or the Cipher refuses it. */
internal const val TRANSFORMATION = "AES/GCM/NoPadding"

/** GCM's own nonce length, in bytes, and the tag length, in bits. Both are
 * written down rather than left to the provider's defaults because the wrapped
 * bytes on disk are parsed back by this same code and the split point has to be
 * a constant, not whatever a future Android decides to hand out. */
internal const val IV_BYTES = 12
internal const val TAG_BITS = 128

/** Name what a `KeyInfo` actually reported, never what the builder asked for.
 *
 * Kept as a free function so it can be unit-tested without a keystore: the
 * screen prints this word, and telling somebody their key is in secure hardware
 * when it is in software would be a lie the app told about its own security. */
internal fun securityLevelName(level: Int, insideSecureHardware: Boolean): String = when {
    // Constants rather than the KeyProperties symbols, which only exist from
    // API 31 — this function has to compile and be testable against minSdk 24.
    level == 2 -> "strongbox"     // SECURITY_LEVEL_STRONGBOX
    level == 1 -> "tee"           // SECURITY_LEVEL_TRUSTED_ENVIRONMENT
    level == 0 -> "software"      // SECURITY_LEVEL_SOFTWARE
    // Below API 31 there is no level, only a boolean, and "unknown" is the
    // honest answer for a device that reports neither.
    insideSecureHardware -> "tee"
    else -> "software"
}

/** Strip whitespace a JSON encoder may have wrapped a base64 value in, and
 * refuse anything that is not base64 rather than letting `Base64.decode` return
 * a shorter array than the caller expected. */
internal fun decodeBase64OrNull(value: String): ByteArray? {
    val trimmed = value.filterNot { it.isWhitespace() }
    if (trimmed.isEmpty()) return null
    return try {
        Base64.decode(trimmed, Base64.DEFAULT)
    } catch (_: IllegalArgumentException) {
        null
    }
}

/** Split stored bytes into the nonce and the sealed remainder.
 *
 * Returns null for anything too short to be either, which is what a truncated
 * write or a file from a different version looks like — and a null here becomes
 * a sentence about the passphrase still working, rather than a crash. */
internal fun splitWrapped(bytes: ByteArray): Pair<ByteArray, ByteArray>? {
    // A GCM nonce plus a 16-byte tag plus at least one byte of key material.
    if (bytes.size <= IV_BYTES + TAG_BITS / 8) return null
    return Pair(bytes.copyOfRange(0, IV_BYTES), bytes.copyOfRange(IV_BYTES, bytes.size))
}

/** Android's side of the encrypted log: it holds the key that lets the app open
 * the log at launch without asking for anything.
 *
 * This class deliberately does the smallest possible job. It does not know what
 * the 32 bytes are for, it does not touch the database, and it does not decide
 * anything about backup policy — all of that is in Rust, where it is testable
 * on a developer's machine. What is here is the part that genuinely cannot be:
 * `AndroidKeyStore` is a framework API, and reaching it over hand-rolled JNI
 * would be dozens of unchecked reflection calls instead of code the Kotlin
 * compiler checks.
 *
 * Every reply is a `mapOf` with literal string keys. Release builds set
 * `isMinifyEnabled = true` and the only keep rules that survive are the ones
 * tauri ships for `@TauriPlugin` and `@InvokeArg` classes; a result data class's
 * getters are fair game for R8 to rename, and the Rust side would then fail to
 * deserialise on exactly the build users install. `VisionPlugin` learned this
 * the same way.
 */
@TauriPlugin
class BackupPlugin(activity: Activity) : Plugin(activity) {
    private val app = activity

    /** What this device's keystore is, and what it is not. */
    @Command
    fun keystoreState(invoke: Invoke) {
        try {
            val key = loadOrCreateKey()
            val factory = SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore")
            val info = factory.getKeySpec(key, KeyInfo::class.java) as KeyInfo
            val hardware = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                securityLevelName(info.securityLevel, false)
            } else {
                @Suppress("DEPRECATION")
                securityLevelName(-1, info.isInsideSecureHardware)
            }
            invoke.resolveObject(
                mapOf(
                    "available" to true,
                    "hardware" to hardware,
                    "note" to null,
                ),
            )
        } catch (error: Exception) {
            // A refusal, not a crash. A phone whose keystore will not hold a key
            // still gets an encrypted log and a working recovery passphrase;
            // what it loses is the silence at launch, and the screen says so.
            invoke.resolveObject(
                mapOf(
                    "available" to false,
                    "hardware" to "unknown",
                    "note" to "this device's keystore would not hold a key, so you will be " +
                        "asked for the passphrase each time",
                ),
            )
        }
    }

    /** Where the one file that may leave this phone is written.
     *
     * `filesDir`, because that is precisely what `domain="file"` addresses in
     * `data_extraction_rules.xml`. Tauri's own `app_data_dir()` is NOT this — on
     * Android it resolves to `activity.dataDir`, one level above — so the path in
     * the rules file is reported from here rather than inferred from a
     * relationship between the two directories that nothing documents. */
    @Command
    fun backupDir(invoke: Invoke) {
        try {
            val dir = File(app.filesDir, "backup")
            if (!dir.exists() && !dir.mkdirs()) {
                invoke.reject("this phone would not create the folder the sealed copy goes in")
                return
            }
            invoke.resolveObject(mapOf("dir" to dir.absolutePath))
        } catch (error: Exception) {
            invoke.reject("could not find where this app's files live", error)
        }
    }

    /** Seal 32 bytes under this device's keystore key. */
    @Command
    fun wrapKey(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(BackupKeyArgs::class.java)
            val plain = decodeBase64OrNull(args.dataBase64)
            if (plain == null) {
                invoke.reject("the key did not arrive as valid base64")
                return
            }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, loadOrCreateKey())
            val sealed = cipher.doFinal(plain)
            // The provider chose the nonce, because the key was generated with
            // setRandomizedEncryptionRequired(true) and would refuse one we
            // supplied. Stored in front of the ciphertext so unwrapping needs
            // nothing but this one file.
            val out = cipher.iv + sealed
            plain.fill(0)
            invoke.resolveObject(mapOf("dataBase64" to Base64.encodeToString(out, Base64.NO_WRAP)))
        } catch (error: Exception) {
            invoke.reject("this phone's keystore would not hold the key", error)
        }
    }

    /** Open what [wrapKey] sealed. */
    @Command
    fun unwrapKey(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(BackupKeyArgs::class.java)
            val stored = decodeBase64OrNull(args.dataBase64)
            val split = stored?.let { splitWrapped(it) }
            if (split == null) {
                invoke.reject("what this phone stored is not a key it can open")
                return
            }
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                loadOrCreateKey(),
                GCMParameterSpec(TAG_BITS, split.first),
            )
            val plain = cipher.doFinal(split.second)
            val encoded = Base64.encodeToString(plain, Base64.NO_WRAP)
            plain.fill(0)
            invoke.resolveObject(mapOf("dataBase64" to encoded))
        } catch (error: Exception) {
            // The one case worth naming precisely: the key is gone, or it was
            // replaced, and the passphrase is the way back. The Rust side turns
            // this into that sentence for the user.
            invoke.reject("this phone's keystore can no longer open the key it stored", error)
        }
    }

    /** The wrapping key, created once and reused.
     *
     * `setUserAuthenticationRequired(false)` is the load-bearing line in this
     * whole file. A key that requires authentication is the one Android
     * INVALIDATES when a fingerprint is enrolled or the lock screen is removed —
     * and this key is what opens the user's log, so an invalidation there would
     * be the operating system destroying a year of somebody's meals as a side
     * effect of them changing their thumb. This key therefore requires nothing,
     * and, deliberately, guards nothing on its own: it wraps a key whose OTHER
     * wrap is the user's recovery passphrase, so the worst a lost keystore can
     * do is make the app ask for that passphrase once.
     *
     * StrongBox is asked for from API 28 and only inside a try, because plenty
     * of shipped phones advertise the API and then refuse the key with
     * `StrongBoxUnavailableException`. Falling back is the difference between a
     * slightly better-protected key and no encryption at all.
     */
    private fun loadOrCreateKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore")
        store.load(null)
        val existing = store.getKey(KEY_ALIAS, null)
        if (existing is SecretKey) return existing

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            try {
                return generate(strongBox = true)
            } catch (_: StrongBoxUnavailableException) {
                // Advertised and refused. Fall through to the ordinary key.
            } catch (_: Exception) {
                // Some vendors throw their own thing here rather than the
                // documented exception, which is exactly why this is a catch
                // and not a capability check.
            }
        }
        return generate(strongBox = false)
    }

    private fun generate(strongBox: Boolean): SecretKey {
        val builder = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(false)
            .setRandomizedEncryptionRequired(true)
        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            builder.setIsStrongBoxBacked(true)
        }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(builder.build())
        return generator.generateKey()
    }
}
