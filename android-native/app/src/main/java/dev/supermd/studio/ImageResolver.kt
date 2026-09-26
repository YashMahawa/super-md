package dev.supermd.studio

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile

/** Resolve ordinary Markdown paths against a folder chosen by the user, without rewriting the note. */
fun resolveImageUri(context: Context, reference: String, folderUri: Uri?): Uri? {
    val parsed = Uri.parse(reference)
    if (parsed.scheme == "content" || parsed.scheme == "file") return parsed
    if (parsed.scheme != null || folderUri == null) return null
    val components = Uri.decode(reference.substringBefore('#').substringBefore('?')).split('/')
        .filter { it.isNotBlank() && it != "." }
    if (components.isEmpty() || components.any { it == ".." || '\\' in it }) return null
    var document = DocumentFile.fromTreeUri(context, folderUri) ?: return null
    for (component in components) document = document.findFile(component) ?: return null
    return document.takeIf { it.isFile }?.uri
}
