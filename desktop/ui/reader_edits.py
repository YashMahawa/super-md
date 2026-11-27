"""Renderer edit sessions; offsets are explicitly UTF-16, not Python indices."""
from collections import OrderedDict
import hashlib


def _patch_proof(changes):
    if not isinstance(changes,list) or not 0<len(changes)<=16384:return None
    digest=hashlib.sha256()
    for change in changes:
        if not isinstance(change,dict):return None
        start,stop,text=change.get("from"),change.get("to"),change.get("insert")
        if type(start) is not int or type(stop) is not int or not isinstance(text,str):return None
        digest.update(f"{start},{stop},{len(text)}:".encode("ascii"))
        for index in range(0,len(text),4096):digest.update(text[index:index+4096].encode("utf-16-le",errors="surrogatepass"))
        digest.update(b";")
    return digest.digest()


class ReaderEdits:
    def __init__(self):
        self.sessions = OrderedDict()

    def clear(self, note_id):
        self.sessions.pop(note_id, None)

    def apply(self, command, args, current, commit):
        rejected = {"accepted": False, "reason": "conflict"}
        note_id, epoch = args.get("id"), args.get("epoch")
        revision = args.get("revision")
        if current is None or not isinstance(note_id, str) or not isinstance(epoch, str) or not 0 < len(epoch) <= 256:
            return rejected
        if type(revision) is not int or revision < 0:
            return rejected
        previous = self.sessions.get(note_id)
        if command == "document_sync":
            if revision != 0 or args.get("content") != current:
                return rejected
            self.sessions[note_id] = (epoch, 0, current, None)
        elif command == "document_resync":
            bases, content = args.get("bases"), args.get("content")
            if revision != 0 or not isinstance(content, str) or not isinstance(bases, list) or not 1 <= len(bases) <= 2 or not all(isinstance(b, str) for b in bases) or current not in bases:
                return rejected
            commit(content)
            self.sessions[note_id] = (epoch, 0, content, None)
        elif command == "document_patch":
            base, changes = args.get("baseRevision"), args.get("changes")
            if not previous or previous[0] != epoch or type(base) is not int:
                return rejected
            if current != previous[2]:
                return rejected
            proof=_patch_proof(changes)
            if proof is None:return rejected
            if revision == previous[1] and (base, proof) == previous[3]:
                return {"accepted": True, "revision": revision}
            if base != previous[1] or revision != base + 1 or current != previous[2] or not isinstance(changes, list) or not 0 < len(changes) <= 16384:
                return rejected
            encoded = current.encode("utf-16-le", errors="surrogatepass")
            length, end, pieces = len(encoded) // 2, 0, []

            def boundary(offset):
                if not 0 < offset < length:
                    return True
                left = int.from_bytes(encoded[(offset - 1) * 2:offset * 2], "little")
                right = int.from_bytes(encoded[offset * 2:(offset + 1) * 2], "little")
                return not (0xD800 <= left <= 0xDBFF and 0xDC00 <= right <= 0xDFFF)

            for change in changes:
                if not isinstance(change, dict):
                    return rejected
                start, stop, insertion = change.get("from"), change.get("to"), change.get("insert")
                if type(start) is not int or type(stop) is not int or not isinstance(insertion, str) or not end <= start <= stop <= length or not boundary(start) or not boundary(stop):
                    return rejected
                pieces.extend((encoded[end * 2:start * 2], insertion.encode("utf-16-le", errors="surrogatepass")))
                end = stop
            pieces.append(encoded[end * 2:])
            content = b"".join(pieces).decode("utf-16-le", errors="surrogatepass")
            commit(content)  # No revision advance if the authoritative commit fails.
            self.sessions[note_id] = (epoch, revision, content, (base, proof))
        else:
            return rejected
        self.sessions.move_to_end(note_id)
        while len(self.sessions) > 40:
            self.sessions.popitem(last=False)
        return {"accepted": True, "revision": revision}
