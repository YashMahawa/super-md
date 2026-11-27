"""Agent connection/jump chrome state and inactive-tab draft staging & recovery helpers for Studio."""
from __future__ import annotations

import concurrent.futures, contextlib, copy, hashlib, json, threading, uuid
from pathlib import Path

if __package__:
    from .agent_documents import apply_patch_operations_detailed
    from .core.latest_writes import ExactWriteAborted
    from .documents import atomic_json, atomic_write, stage_atomic_json
else:
    from agent_documents import apply_patch_operations_detailed
    from core.latest_writes import ExactWriteAborted
    from documents import atomic_json, atomic_write, stage_atomic_json

MAX_AGENT_EDIT_STEPS = 60
MAX_AGENT_EDIT_BYTES = 2_000_000
MAX_PATCH_OPERATIONS = 100
MAX_PATCH_PAYLOAD_BYTES = 64_000

RECOVERY_ERROR_FAILED = "Could not save draft recovery snapshot for the agent patch; retry the patch"
RECOVERY_ERROR_SUPERSEDED = "Could not confirm draft recovery snapshot for the agent patch because the recovery write was superseded; retry the patch"
RECOVERY_NOTICE = "Couldn't save draft recovery data. Keep Super MD open and retry."
WINDOW_CLOSED_ERROR = "The target desktop window was closed"
TAB_CLOSED_ERROR = "The requested live tab is no longer open"
TAB_REVISION_ERROR = "Live tab revision changed; inspect it again before editing"

def _ensure_attr(obj, name: str, factory):
    if (val := getattr(obj, name, None)) is None:
        val = factory()
        setattr(obj, name, val)
    return val

def _call_own(studio_obj, method_name: str, *args, fallback_fn, **fallback_kwargs):
    fn = getattr(studio_obj, method_name, None)
    return fn(*args) if callable(fn) else fallback_fn(studio_obj, *args, **fallback_kwargs)

def _snapshot_tab_fallback(tab: dict, *, include_view_state: bool = True) -> dict:
    return {
        k: (dict(v) if k in ("assets", "saved_assets") and isinstance(v, dict) else (v if isinstance(v, (str, int, float, bool)) or v is None else copy.deepcopy(v)))
        for k, v in tab.items() if include_view_state or k != "viewState"
    }

def _is_tab_dirty(studio_obj, tab: dict) -> bool:
    if callable(checker := getattr(studio_obj, "_is_dirty", None)):
        return bool(checker(tab))
    if tab.get("content") != tab.get("saved") or tab.get("assets_dirty"):
        return True
    return bool(tab.get("path") and "saved_assets" in tab and tab.get("assets", {}) != tab.get("saved_assets", {}))

def _window_recovery_drafts(studio_obj, tabs=None, *, snapshot_tab_state_fn=_snapshot_tab_fallback) -> list[dict]:
    if callable(fn := getattr(studio_obj, "_window_recovery_drafts", None)):
        return fn() if tabs is None else fn(tabs)
    source_tabs = getattr(studio_obj, "tabs", ()) if tabs is None else tabs
    return [
        snapshot_tab_state_fn(t, include_view_state=False) for t in source_tabs
        if (_is_tab_dirty(studio_obj, t) or t.get("agent_staged") or t.get("agent_unreviewed"))
        and (t.get("path") or t.get("content", "").strip() or t.get("assets") or t.get("agent_staged") or t.get("agent_unreviewed"))
    ]

def _rename_state_lock(studio_obj):
    lock = getattr(getattr(studio_obj, "session", None), "_rename_state_lock", None)
    return lock if lock is not None else contextlib.nullcontext()

def _combined_recovery_drafts(studio_obj, window_drafts: list[dict], *, snapshot_tab_state_fn=_snapshot_tab_fallback) -> list[dict]:
    if callable(fn := getattr(studio_obj, "_combined_recovery_drafts", None)):
        return fn(window_drafts)
    if not isinstance(drafts_map := getattr(getattr(studio_obj, "session", None), "drafts", None), dict):
        return [snapshot_tab_state_fn(t, include_view_state=False) for t in window_drafts]
    with _rename_state_lock(studio_obj):
        wid, combined, replaced = getattr(studio_obj, "window_id", "main"), [], False
        for k, tabs in drafts_map.items():
            combined.extend(snapshot_tab_state_fn(t, include_view_state=False) for t in (window_drafts if k == wid else tabs))
            replaced = replaced or k == wid
        if not replaced:
            combined.extend(snapshot_tab_state_fn(t, include_view_state=False) for t in window_drafts)
        return combined

def _is_window_closed(studio_obj) -> bool:
    return bool(getattr(studio_obj, "retired", False) or getattr(getattr(studio_obj, "writes", None), "_shutdown", False))

def _find_open_tab(studio_obj, tab_id) -> dict | None:
    tab = next((item for item in getattr(studio_obj, "tabs", ()) if item["id"] == tab_id), None)
    return None if (tab is None or tab_id in getattr(studio_obj, "_closing_tabs", ())) else tab

def _revision_conflict_message(content: str, *, bridge_json: bool, current_revision: str | None = None) -> str:
    if not bridge_json:
        return TAB_REVISION_ERROR
    rev = current_revision or hashlib.sha256(content.encode("utf-8")).hexdigest()
    return json.dumps({"error": "Revision conflict; inspect the current note before retrying", "currentRevision": rev, "sourceLength": len(content)})

def _pause_recovery_timer(studio_obj, had_recovery_timer: bool) -> bool:
    if (timer := getattr(studio_obj, "recovery_timer", None)) is not None and timer.isActive():
        timer.stop()
        return True
    return had_recovery_timer

def _try_timeout_attempt(decision_lock: threading.Lock, attempt_state: dict) -> bool:
    with decision_lock:
        if not attempt_state["decided"]:
            attempt_state["decided"], attempt_state["outcome"] = True, "timed_out"
        return attempt_state["outcome"] == "published"

def _rollback_staged_recovery(studio_obj, *, any_wrote_candidate: bool, had_recovery_timer: bool = False, allow_retired_recover: bool = False) -> None:
    retired, shutdown = bool(getattr(studio_obj, "retired", False)), bool(getattr(getattr(studio_obj, "writes", None), "_shutdown", False))
    if any_wrote_candidate and not shutdown and (allow_retired_recover or not retired):
        if callable(recover_fn := getattr(studio_obj, "_recover", None)):
            recover_fn()
    elif had_recovery_timer and not retired and (timer := getattr(studio_obj, "recovery_timer", None)) is not None:
        timer.start(800)

def _verify_stage_target_tab(
    studio_obj, tab_id: str, previous: str, *, any_wrote_candidate: bool, bridge_revision_json: bool, rollback_on_retired: bool = False
) -> tuple[dict | None, str | None]:
    if _is_window_closed(studio_obj):
        if rollback_on_retired:
            _rollback_staged_recovery(studio_obj, any_wrote_candidate=any_wrote_candidate, allow_retired_recover=True)
        return None, WINDOW_CLOSED_ERROR
    if (tab := _find_open_tab(studio_obj, tab_id)) is None:
        _rollback_staged_recovery(studio_obj, any_wrote_candidate=any_wrote_candidate)
        return None, TAB_CLOSED_ERROR
    if tab["content"] != previous:
        _rollback_staged_recovery(studio_obj, any_wrote_candidate=any_wrote_candidate)
        return None, _revision_conflict_message(tab["content"], bridge_json=bridge_revision_json)
    return tab, None

def _prepare_stage_attempt(
    studio_obj, tab_id: str, current_tab: dict, previous: str, edited: str, changed: bool, *,
    on_ready=None, stage_atomic_json_fn=stage_atomic_json, atomic_json_fn=atomic_json,
    atomic_write_fn=atomic_write, exact_write_aborted_cls=ExactWriteAborted,
    snapshot_tab_state_fn=_snapshot_tab_fallback, bound_agent_edits_fn=None,
):
    candidate_path = current_tab.get("path", "")
    all_drafts, candidate_edits, next_seq = _call_own(
        studio_obj, "_build_staged_recovery_candidate", tab_id, current_tab, previous, edited, changed,
        fallback_fn=build_staged_recovery_candidate, snapshot_tab_state_fn=snapshot_tab_state_fn, bound_agent_edits_fn=bound_agent_edits_fn,
    )
    decision_lock, attempt_state, rev_holder, wrote_holder = threading.Lock(), {"decided": False, "outcome": None}, [0], [False]
    if on_ready is not None and not on_ready(decision_lock, attempt_state):
        return None
    write_action = _call_own(
        studio_obj, "_make_staged_recovery_write_action", tab_id, previous, candidate_path, all_drafts, decision_lock, attempt_state, rev_holder, wrote_holder,
        fallback_fn=make_staged_recovery_write_action, stage_atomic_json_fn=stage_atomic_json_fn,
        atomic_json_fn=atomic_json_fn, atomic_write_fn=atomic_write_fn, exact_write_aborted_cls=exact_write_aborted_cls,
    )
    return candidate_path, candidate_edits, next_seq, decision_lock, attempt_state, rev_holder, wrote_holder, write_action

def _evaluate_stage_attempt_outcome(
    studio_obj, tab_id: str, previous: str, candidate_path: str, edited: str, operation_results: list, changed: bool,
    candidate_edits: list[dict], next_seq: int, status: str, rev: int, write_error, *,
    attempt: int, max_attempts: int, any_wrote_candidate: bool, had_recovery_timer: bool,
    bridge_revision_json: bool, snapshot_tab_state_fn=_snapshot_tab_fallback,
) -> tuple[str, dict | str | None]:
    now_tab, target_err = _verify_stage_target_tab(
        studio_obj, tab_id, previous, any_wrote_candidate=any_wrote_candidate, bridge_revision_json=bridge_revision_json
    )
    if target_err is not None or now_tab is None:
        return "target_error", target_err or TAB_CLOSED_ERROR
    if status == "failed" or write_error is not None:
        _rollback_staged_recovery(studio_obj, any_wrote_candidate=any_wrote_candidate, had_recovery_timer=had_recovery_timer)
        return "write_failed", getattr(studio_obj, "_RECOVERY_ERROR_FAILED", RECOVERY_ERROR_FAILED)
    writes = studio_obj.writes
    if (
        status == "committed"
        and writes.committed_revision("recovery") == rev
        and writes.latest_revision("recovery") == rev
        and now_tab.get("path", "") == candidate_path
    ):
        return "committed", _call_own(
            studio_obj, "_commit_staged_patch_tab", now_tab, tab_id, edited, operation_results, changed, candidate_edits, next_seq,
            fallback_fn=commit_staged_patch_tab, snapshot_tab_state_fn=snapshot_tab_state_fn,
        )
    if attempt + 1 < max_attempts:
        return "retry", None
    _rollback_staged_recovery(studio_obj, any_wrote_candidate=any_wrote_candidate, had_recovery_timer=had_recovery_timer)
    return "superseded", getattr(studio_obj, "_RECOVERY_ERROR_SUPERSEDED", RECOVERY_ERROR_SUPERSEDED)

def bound_agent_edits(edits: list[dict]) -> list[dict]:
    bounded = list(edits[-MAX_AGENT_EDIT_STEPS:])
    while len(bounded) > 1 and sum(len(it["before"].encode("utf-8")) + len(it["after"].encode("utf-8")) for it in bounded) > MAX_AGENT_EDIT_BYTES:
        bounded.pop(0)
    return bounded

def append_agent_edit(studio_obj, tab: dict, before: str, after: str, *, bound_agent_edits_fn=None) -> None:
    edits = list(tab.get("agent_edits") or [])
    studio_obj._agent_edit_seq = max(getattr(studio_obj, "_agent_edit_seq", 0), max((int(item.get("seq", 0)) for item in edits), default=0)) + 1
    edits.append({"seq": studio_obj._agent_edit_seq, "before": before, "after": after})
    tab["agent_edits"] = (getattr(studio_obj, "_bound_agent_edits", None) or bound_agent_edits_fn or bound_agent_edits)(edits)

def activate_tab_state(studio_obj, tab: dict | None) -> None:
    if tab is None:
        return
    if getattr(studio_obj, "_agent_jump_tab_id", "") == tab["id"]:
        studio_obj._agent_jump_tab_id = ""
    if tab.get("agent_staged"):
        tab["agent_staged"] = False
        if getattr(studio_obj, "settings", {}).get("autosave") and tab.get("path") and _is_tab_dirty(studio_obj, tab) and not tab.get("conflict"):
            studio_obj.autosave_timer.start(900)

def clear_agent_staging(studio_obj, tab: dict | None) -> None:
    if tab is None:
        return
    tab["agent_staged"] = False
    tab["agent_unreviewed"] = False
    if getattr(studio_obj, "_agent_jump_tab_id", "") == tab.get("id"):
        studio_obj._agent_jump_tab_id = ""

def agent_connection_snapshot(studio_obj) -> dict:
    bridge = getattr(getattr(studio_obj, "session", None), "agent_bridge", None)
    cloud_enabled = bool(bridge and getattr(bridge, "cloudClient", None) and bridge.cloudClient.enabled)
    cloud_opt_in = bool(getattr(studio_obj, "settings", {}).get("cloudAgentEnabled"))
    cloud_status = getattr(studio_obj, "cloudAgentStatus", "")
    if getattr(studio_obj, "_cloud_revocation_pending", False):
        return {"visible": True, "state": "connecting", "label": "Disconnecting…", "detail": cloud_status}
    if cloud_enabled or (cloud_opt_in and getattr(studio_obj, "_agent_cloud_error", "")):
        if cloud_status == "Connected to relay":
            return {"visible": True, "state": "connected", "label": "AI connected", "detail": cloud_status}
        if cloud_status.startswith("Connecting"):
            return {"visible": True, "state": "connecting", "label": "AI connecting…", "detail": cloud_status}
        return {"visible": True, "state": "retrying", "label": "AI retrying…", "detail": cloud_status}
    if bool(bridge and bridge.enabled):
        return {"visible": True, "state": "local", "label": "AI live", "detail": getattr(studio_obj, "agentAccessStatus", "")}
    return {"visible": False, "state": "off", "label": "", "detail": ""}

def agent_jump_snapshot(studio_obj) -> dict | None:
    jump_id = getattr(studio_obj, "_agent_jump_tab_id", "")
    if not jump_id or jump_id == getattr(studio_obj, "active", ""):
        return None
    target = next((t for t in getattr(studio_obj, "tabs", ()) if t["id"] == jump_id), None)
    return None if target is None else {"id": target["id"], "name": target["name"]}

def dismiss_agent_jump(studio_obj) -> None:
    if getattr(studio_obj, "_agent_jump_tab_id", ""):
        studio_obj._agent_jump_tab_id = ""
        if callable(emit_fn := getattr(studio_obj, "_emit", None)):
            emit_fn(False)

def validate_and_compute_patch_tab(studio_obj, args, *, bridge_revision_json: bool = False, apply_patch_fn=apply_patch_operations_detailed):
    tab_id = args.get("tabId")
    if (tab := _find_open_tab(studio_obj, tab_id)) is None:
        raise ValueError(TAB_CLOSED_ERROR)
    if (staging_tabs := getattr(studio_obj, "_staging_tabs", None)) is not None and tab_id in staging_tabs:
        raise ValueError("An agent patch is already staging for this tab; retry after it finishes")
    if (saving := getattr(studio_obj, "saving", None)) is not None and tab_id in saving:
        raise ValueError("A save is already in progress for this tab; retry after it finishes")
    expected, previous = args.get("expectedRevision"), tab["content"]
    revision = hashlib.sha256(previous.encode("utf-8")).hexdigest()
    if not isinstance(expected, str) or expected != revision:
        raise ValueError(_revision_conflict_message(previous, bridge_json=bool(bridge_revision_json and expected is not None), current_revision=revision))
    operations = args.get("operations")
    if not isinstance(operations, list) or len(operations) > MAX_PATCH_OPERATIONS:
        raise ValueError("operations must contain at most 100 edits")
    if len(json.dumps(operations, ensure_ascii=False).encode("utf-8")) > MAX_PATCH_PAYLOAD_BYTES:
        raise ValueError("Patch operations exceed the 64 KB limit")
    edited, operation_results = apply_patch_fn(previous, operations)
    return tab, tab_id, previous, revision, edited, operation_results, edited != previous

def build_staged_recovery_candidate(
    studio_obj, tab_id: str, current_tab: dict, previous: str, edited: str, changed: bool, *,
    snapshot_tab_state_fn=_snapshot_tab_fallback, bound_agent_edits_fn=None,
):
    existing_edits = list(current_tab.get("agent_edits") or [])
    if changed:
        next_seq = max(getattr(studio_obj, "_agent_edit_seq", 0), max((int(it.get("seq", 0)) for it in existing_edits if isinstance(it, dict)), default=0)) + 1
        bound_fn = getattr(studio_obj, "_bound_agent_edits", None) or bound_agent_edits_fn or bound_agent_edits
        candidate_edits = bound_fn(existing_edits + [{"seq": next_seq, "before": previous, "after": edited}])
        candidate_tab = {**current_tab, "content": edited, "agent_staged": True, "agent_unreviewed": True, "agent_edits": candidate_edits}
    else:
        next_seq, candidate_edits, candidate_tab = getattr(studio_obj, "_agent_edit_seq", 0), existing_edits, dict(current_tab)
    with _rename_state_lock(studio_obj):
        replaced_tabs = [candidate_tab if item["id"] == tab_id else item for item in studio_obj.tabs]
        window_drafts = _window_recovery_drafts(studio_obj, replaced_tabs, snapshot_tab_state_fn=snapshot_tab_state_fn)
        all_drafts = _combined_recovery_drafts(studio_obj, window_drafts, snapshot_tab_state_fn=snapshot_tab_state_fn)
    return all_drafts, candidate_edits, next_seq

def commit_staged_patch_tab(
    studio_obj, current_tab: dict, tab_id: str, edited: str, operation_results: list, changed: bool,
    candidate_edits: list[dict], next_seq: int, *, snapshot_tab_state_fn=_snapshot_tab_fallback,
) -> dict:
    is_active = getattr(studio_obj, "active", "") == tab_id
    if changed:
        current_tab["content"] = edited
        studio_obj._agent_edit_seq = max(getattr(studio_obj, "_agent_edit_seq", 0), next_seq)
        current_tab["agent_edits"] = candidate_edits
        current_tab["agent_unreviewed"] = True
        if not is_active:
            current_tab["agent_staged"] = True
            studio_obj._agent_jump_tab_id = tab_id
        else:
            current_tab["agent_staged"] = False
            autosave_timer = getattr(studio_obj, "autosave_timer", None)
            if (
                autosave_timer is not None and getattr(studio_obj, "settings", {}).get("autosave")
                and current_tab.get("path") and _is_tab_dirty(studio_obj, current_tab) and not current_tab.get("conflict")
            ):
                autosave_timer.start(900)
    if getattr(studio_obj, "message", "") == getattr(studio_obj, "_RECOVERY_NOTICE", RECOVERY_NOTICE):
        studio_obj.message = ""
    window_id = getattr(studio_obj, "window_id", "main")
    if (session := getattr(studio_obj, "session", None)) is not None and isinstance(getattr(session, "drafts", None), dict):
        with _rename_state_lock(studio_obj):
            session.drafts[window_id] = _window_recovery_drafts(studio_obj, snapshot_tab_state_fn=snapshot_tab_state_fn)
    if callable(hook := getattr(studio_obj, "_recover" if (changed and is_active) else "_submit_startup_snapshot", None)):
        hook()
    if changed and callable(emit_fn := getattr(studio_obj, "_emit", None)):
        if callable(getattr(studio_obj, "_submit", None)):
            emit_fn(load=is_active)
        else:
            try:
                emit_fn(load=is_active)
            except TypeError:
                emit_fn()
    return {
        "tabId": tab_id, "windowId": window_id, "revision": hashlib.sha256(edited.encode("utf-8")).hexdigest(),
        "sourceLength": len(edited), "changed": changed, "applied": len(operation_results),
        "operation_results": operation_results, "isDirty": edited != current_tab["saved"],
    }

def make_staged_recovery_write_action(
    studio_obj, tab_id: str, previous: str, candidate_path: str, snapshot: list, decision_lock: threading.Lock,
    attempt_state: dict, rev_holder: list[int], wrote_holder: list[bool], *,
    stage_atomic_json_fn=stage_atomic_json, atomic_json_fn=atomic_json,
    atomic_write_fn=atomic_write, exact_write_aborted_cls=ExactWriteAborted,
):
    recovery_path = Path(studio_obj.data) / "recovery.json"

    def should_abort_locked() -> bool:
        if attempt_state["decided"] or _is_window_closed(studio_obj) or studio_obj.writes.latest_revision("recovery") != rev_holder[0]:
            return True
        live_tab = _find_open_tab(studio_obj, tab_id)
        return live_tab is None or live_tab["content"] != previous or live_tab.get("path", "") != candidate_path

    def mark_aborted_locked():
        if not attempt_state["decided"]:
            attempt_state["decided"], attempt_state["outcome"] = True, "aborted"
        raise exact_write_aborted_cls()

    def should_abort() -> bool:
        with decision_lock:
            return should_abort_locked()

    def write_action() -> None:
        with decision_lock:
            if should_abort_locked():
                mark_aborted_locked()
        prior_bytes = recovery_path.read_bytes() if recovery_path.exists() else None
        with stage_atomic_json_fn(recovery_path, abort_check=should_abort) as staged:
            atomic_json_fn(recovery_path, snapshot)
            with decision_lock:
                if should_abort_locked():
                    if staged.intercepted:
                        staged.discard()
                    elif prior_bytes is None:
                        if recovery_path.exists():
                            recovery_path.unlink()
                    else:
                        atomic_write_fn(recovery_path, prior_bytes)
                    mark_aborted_locked()
                if staged.intercepted:
                    staged.publish(recovery_path)
                attempt_state["decided"], attempt_state["outcome"] = True, "published"
                wrote_holder[0] = True

    return write_action

def stage_inactive_patch_tab_sync(
    studio_obj, tab_id: str, previous: str, edited: str, operation_results: list, changed: bool, *,
    stage_atomic_json_fn=stage_atomic_json, atomic_json_fn=atomic_json,
    atomic_write_fn=atomic_write, exact_write_aborted_cls=ExactWriteAborted,
    snapshot_tab_state_fn=_snapshot_tab_fallback, bound_agent_edits_fn=None,
) -> dict:
    if _is_window_closed(studio_obj):
        raise ValueError(WINDOW_CLOSED_ERROR)
    max_attempts = max(1, int(getattr(studio_obj, "_max_agent_stage_attempts", 3)))
    timeout = float(getattr(studio_obj, "_agent_stage_sync_timeout", 10.0))
    had_recovery_timer, any_wrote_candidate = _pause_recovery_timer(studio_obj, False), False
    staging_tabs = _ensure_attr(studio_obj, "_staging_tabs", set)
    staging_tabs.add(tab_id)
    err_failed = getattr(studio_obj, "_RECOVERY_ERROR_FAILED", RECOVERY_ERROR_FAILED)
    try:
        for attempt in range(max_attempts):
            current_tab, target_err = _verify_stage_target_tab(
                studio_obj, tab_id, previous, any_wrote_candidate=any_wrote_candidate, bridge_revision_json=False, rollback_on_retired=True
            )
            if target_err is not None or current_tab is None:
                raise ValueError(target_err or TAB_CLOSED_ERROR)
            had_recovery_timer = _pause_recovery_timer(studio_obj, had_recovery_timer)
            candidate_path, candidate_edits, next_seq, decision_lock, attempt_state, rev_holder, wrote_holder, write_action = _prepare_stage_attempt(
                studio_obj, tab_id, current_tab, previous, edited, changed,
                stage_atomic_json_fn=stage_atomic_json_fn, atomic_json_fn=atomic_json_fn,
                atomic_write_fn=atomic_write_fn, exact_write_aborted_cls=exact_write_aborted_cls,
                snapshot_tab_state_fn=snapshot_tab_state_fn, bound_agent_edits_fn=bound_agent_edits_fn,
            )
            rev, outcome = studio_obj.writes.submit_latest_exact(
                "recovery", write_action, on_enqueued=lambda assigned_rev, box=rev_holder: box.__setitem__(0, assigned_rev)
            )
            try:
                status, _done_rev, write_error = outcome.result(timeout=timeout)
            except concurrent.futures.TimeoutError as exc:
                if not _try_timeout_attempt(decision_lock, attempt_state):
                    _rollback_staged_recovery(studio_obj, any_wrote_candidate=any_wrote_candidate, had_recovery_timer=had_recovery_timer)
                    raise RuntimeError(err_failed) from exc
                try:
                    status, _done_rev, write_error = outcome.result(timeout=2.0)
                except concurrent.futures.TimeoutError as post_exc:
                    _rollback_staged_recovery(studio_obj, any_wrote_candidate=True)
                    raise RuntimeError(err_failed) from post_exc
            any_wrote_candidate = any_wrote_candidate or wrote_holder[0]
            verdict, payload = _evaluate_stage_attempt_outcome(
                studio_obj, tab_id, previous, candidate_path, edited, operation_results, changed, candidate_edits, next_seq,
                status, rev, write_error, attempt=attempt, max_attempts=max_attempts,
                any_wrote_candidate=any_wrote_candidate, had_recovery_timer=had_recovery_timer,
                bridge_revision_json=False, snapshot_tab_state_fn=snapshot_tab_state_fn,
            )
            if verdict == "committed":
                return payload  # type: ignore[return-value]
            if verdict == "retry":
                continue
            if verdict == "target_error":
                raise ValueError(str(payload))
            if verdict == "write_failed":
                raise RuntimeError(str(payload)) from write_error
            raise RuntimeError(str(payload))
        raise RuntimeError(getattr(studio_obj, "_RECOVERY_ERROR_SUPERSEDED", RECOVERY_ERROR_SUPERSEDED))
    finally:
        staging_tabs.discard(tab_id)

def stage_inactive_patch_tab_async(
    studio_obj, args, on_complete, *, register_cancel=None, is_cancelled=None,
    stage_atomic_json_fn=stage_atomic_json, atomic_json_fn=atomic_json,
    atomic_write_fn=atomic_write, exact_write_aborted_cls=ExactWriteAborted,
    snapshot_tab_state_fn=_snapshot_tab_fallback, bound_agent_edits_fn=None,
) -> None:
    validate_fn = getattr(studio_obj, "_validate_and_compute_patch_tab", None)
    tab, tab_id, previous, revision, edited, operation_results, changed = (
        validate_fn(args, bridge_revision_json=True) if callable(validate_fn)
        else validate_and_compute_patch_tab(studio_obj, args, bridge_revision_json=True)
    )
    if _is_window_closed(studio_obj):
        raise ValueError(WINDOW_CLOSED_ERROR)
    if tab_id == getattr(studio_obj, "active", ""):
        on_complete(studio_obj._agent_document_action(args), None)
        return
    if not changed and not (_is_tab_dirty(studio_obj, tab) or tab.get("agent_staged") or tab.get("agent_unreviewed")):
        on_complete({
            "tabId": tab_id, "windowId": getattr(studio_obj, "window_id", "main"), "revision": revision,
            "sourceLength": len(edited), "changed": False, "applied": len(operation_results),
            "operation_results": operation_results, "isDirty": False,
        }, None)
        return

    max_attempts = max(1, int(getattr(studio_obj, "_max_agent_stage_attempts", 3)))
    err_failed = getattr(studio_obj, "_RECOVERY_ERROR_FAILED", RECOVERY_ERROR_FAILED)
    queue_token = uuid.uuid4().hex
    finished_flag = active_in_queue = had_recovery_timer = any_wrote_candidate = stage_cancelled = False
    stage_lock = threading.Lock()
    current_attempt: tuple[threading.Lock, dict] | None = None
    staging_tabs = _ensure_attr(studio_obj, "_staging_tabs", set)
    staging_tabs.add(tab_id)
    callback_lock = _ensure_attr(studio_obj, "_write_callback_lock", threading.Lock)
    retirements = _ensure_attr(studio_obj, "_pending_write_retirements", dict)

    def is_stage_cancelled_locked() -> bool:
        return stage_cancelled or (callable(is_cancelled) and bool(is_cancelled()))

    def finish_stage(result, error):
        nonlocal finished_flag
        if finished_flag:
            return
        finished_flag = True
        with callback_lock:
            retirements.pop(queue_token, None)
        staging_tabs.discard(tab_id)
        if active_in_queue and callable(adv_fn := getattr(getattr(studio_obj, "session", None), "_advance_agent_stage_queue", None)):
            adv_fn()
        on_complete(result, error)

    def finish_cancelled_on_ui(_result=None, _error=None):
        if not finished_flag:
            _rollback_staged_recovery(studio_obj, any_wrote_candidate=any_wrote_candidate, had_recovery_timer=had_recovery_timer)
            finish_stage(None, err_failed)

    def abort_if_cancelled() -> bool:
        with stage_lock:
            cancelled = is_stage_cancelled_locked()
        if cancelled:
            finish_cancelled_on_ui()
        return cancelled

    def register_attempt_ready(decision_lock: threading.Lock, attempt_state: dict) -> bool:
        nonlocal current_attempt
        with stage_lock:
            if is_stage_cancelled_locked():
                cancelled = True
            else:
                current_attempt, cancelled = (decision_lock, attempt_state), False
        if cancelled:
            finish_cancelled_on_ui()
        return not cancelled

    def cancel_stage() -> bool:
        nonlocal stage_cancelled
        with stage_lock:
            published = False if current_attempt is None else _try_timeout_attempt(*current_attempt)
            if not published:
                stage_cancelled = True
        if not published:
            if (completed_sig := getattr(studio_obj, "completed", None)) is not None:
                try:
                    completed_sig.emit((finish_cancelled_on_ui, None, None, False))
                except RuntimeError:
                    pass
            else:
                finish_cancelled_on_ui()
        return published

    if callable(register_cancel):
        register_cancel(cancel_stage)
    with callback_lock:
        retirements[queue_token] = lambda: finish_stage(None, WINDOW_CLOSED_ERROR)

    def run_attempt(attempt: int) -> None:
        nonlocal had_recovery_timer, any_wrote_candidate
        if finished_flag or abort_if_cancelled():
            return
        current_tab, target_err = _verify_stage_target_tab(
            studio_obj, tab_id, previous, any_wrote_candidate=any_wrote_candidate, bridge_revision_json=True, rollback_on_retired=True
        )
        if target_err is not None or current_tab is None:
            finish_stage(None, target_err or TAB_CLOSED_ERROR)
            return
        had_recovery_timer = _pause_recovery_timer(studio_obj, had_recovery_timer)
        prepared = _prepare_stage_attempt(
            studio_obj, tab_id, current_tab, previous, edited, changed, on_ready=register_attempt_ready,
            stage_atomic_json_fn=stage_atomic_json_fn, atomic_json_fn=atomic_json_fn,
            atomic_write_fn=atomic_write_fn, exact_write_aborted_cls=exact_write_aborted_cls,
            snapshot_tab_state_fn=snapshot_tab_state_fn, bound_agent_edits_fn=bound_agent_edits_fn,
        )
        if prepared is None:
            return
        candidate_path, candidate_edits, next_seq, _decision_lock, _attempt_state, rev_holder, wrote_holder, write_action = prepared

        def on_write_done(outcome_tuple, _err_str):
            nonlocal any_wrote_candidate
            if finished_flag:
                return
            status, rev, write_error = outcome_tuple
            any_wrote_candidate = any_wrote_candidate or wrote_holder[0]
            if abort_if_cancelled():
                return
            verdict, payload = _evaluate_stage_attempt_outcome(
                studio_obj, tab_id, previous, candidate_path, edited, operation_results, changed, candidate_edits, next_seq,
                status, rev, write_error, attempt=attempt, max_attempts=max_attempts,
                any_wrote_candidate=any_wrote_candidate, had_recovery_timer=had_recovery_timer,
                bridge_revision_json=True, snapshot_tab_state_fn=snapshot_tab_state_fn,
            )
            if verdict == "committed":
                finish_stage(payload, None)
            elif verdict == "retry":
                run_attempt(attempt + 1)
            else:
                finish_stage(None, str(payload))

        on_enqueued = lambda assigned_rev, box=rev_holder: box.__setitem__(0, assigned_rev)
        if callable(submit_fn := getattr(studio_obj, "_submit_exact_recovery_write", None)):
            submit_fn(write_action, on_write_done, on_retired=lambda: finish_stage(None, WINDOW_CLOSED_ERROR), on_enqueued=on_enqueued)
        else:
            studio_obj.writes.submit_latest_exact(
                "recovery", write_action, None, lambda status, rev, err: on_write_done((status, rev, err), None), on_enqueued=on_enqueued
            )

    def start_queued() -> bool:
        nonlocal active_in_queue
        if finished_flag or abort_if_cancelled():
            return False
        with callback_lock:
            retirements.pop(queue_token, None)
        active_in_queue = True
        run_attempt(0)
        return not finished_flag

    if callable(enqueue_fn := getattr(getattr(studio_obj, "session", None), "_enqueue_agent_stage", None)):
        enqueue_fn(start_queued)
    else:
        start_queued()
